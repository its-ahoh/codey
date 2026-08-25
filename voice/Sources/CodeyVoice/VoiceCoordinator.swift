import Cocoa
import Foundation

/// Central coordinator that wires hotkey, audio, transcription, and text injection together.
final class VoiceCoordinator {
    enum State {
        case idle
        case recording
        case transcribing
        /// Converse mode: the reply is streaming back and being played. The
        /// hotkey means barge-in here — see handleToggle.
        case speaking
    }

    private enum CaptureDestination: Equatable {
        case dictation
        case composerDictation
        case conversation

        var composerMode: String? {
            switch self {
            case .dictation: return nil
            case .composerDictation: return "dictate"
            case .conversation: return "converse"
            }
        }
    }

    private var state: State = .idle
    private var captureDestination: CaptureDestination = .dictation
    private var conversationCaptureGeneration = 0
    /// Bumped whenever a turn is abandoned. The transcribe task captures the
    /// value it started with and drops its result if it no longer matches, so
    /// a decode the user gave up on can't inject text or resurrect the HUD
    /// minutes later. Separate from `conversationCaptureGeneration`, which
    /// only covers Conversation turns and also bumps on *start*.
    private var captureGeneration = 0
    /// Whether the conversation turn in progress was started by the hotkey
    /// rather than the composer button. Only hotkey turns get a capsule — if
    /// you clicked the button you are already looking at the window.
    ///
    /// This lives here, not in Electron, because the helper is the side that
    /// starts recording: it can raise the capsule on the same run-loop turn as
    /// the key press instead of waiting for a round trip. Every conversation
    /// event echoes the flag back so Electron's copy can never drift.
    private var conversationFromHotkey = false
    private var config: VoiceConfig

    private let gateway: GatewayClient
    private let audioCapture: AudioCapture
    private let apiEngine: TranscriptionEngine
    private let localEngine: WhisperKitEngine
    private let realtimeEngine: RealtimeTranscriptionEngine
    private var textInjector: TextInjector
    private var hotkeyManager: HotkeyManager?
    /// Second binding for the in-chat spoken conversation. Fires into the Mac
    /// app via the gateway rather than driving this helper's own pipeline.
    private var converseHotkeyManager: HotkeyManager?
    private var statusItem: StatusItem?
    private let hud = HudOverlay()
    private var pollTimer: Timer?
    private var idleUnloadTimer: Timer?
    private let gatewayPort: Int
    /// True while Electron owns the visible half of a conversation turn (the
    /// agent run or the spoken reply). Esc belongs to it in that window.
    private var electronTurnActive = false
    private var escMonitorGlobal: Any?
    private var escMonitorLocal: Any?
    /// Timestamp of the most recent `.partial` HUD push (local streaming).
    /// Used to suppress the `.transcribing` spinner flash on stop when we
    /// already have a fresh partial pill on screen — letting the user keep
    /// reading the running transcript instead of seeing a half-second of
    /// spinner before the success tick.
    private var lastPartialAt: Date?
    /// Latest partial text we pushed to the HUD. Reused on stop to display
    /// `.finalizing(text)` while the final decode finishes, so the pill
    /// content doesn't appear frozen during that window.
    private var lastPartialText: String = ""

    // MARK: Converse mode

    private let converseClient: ConverseClient
    private let speechPlayer = SpeechPlayer()
    /// Stable across turns so the gateway can keep conversation context and
    /// resolve "说详细点" against the previous reply.
    private let conversationId = "voice-\(UUID().uuidString)"
    /// True once the gateway declares it will send audio for this turn.
    private var serverTTSForTurn = false
    /// Text of each seq that has not yet received audio. On a degraded `done`
    /// these get spoken by the system voice so no sentence is silently lost.
    private var pendingSpokenText: [Int: String] = [:]
    /// Whether the NDJSON stream for the current turn has ended. Playback
    /// routinely drains before the next sentence's audio arrives, so an empty
    /// queue alone must not end the turn — only an empty queue *after* the
    /// stream is closed does.
    private var converseStreamEnded = false

    init(gatewayPort: Int = 3001) {
        self.gatewayPort = gatewayPort
        self.config = VoiceConfig.default
        self.gateway = GatewayClient(port: gatewayPort)
        self.audioCapture = AudioCapture()
        self.apiEngine = TranscriptionEngine(config: .default)
        self.localEngine = WhisperKitEngine(config: .default)
        self.realtimeEngine = RealtimeTranscriptionEngine(config: .default)
        self.textInjector = TextInjector(mode: .paste)
        self.converseClient = ConverseClient(port: gatewayPort)
    }

    private var activeEngine: TranscriptionEngineProtocol {
        switch config.provider {
        case .local: return localEngine
        case .api: return apiEngine
        case .realtime: return realtimeEngine
        }
    }

    func start() {
        // Set up status bar UI
        let item = StatusItem()
        item.onToggle = { [weak self] in self?.handleToggle() }
        item.onSettings = { [weak self] in self?.openSettings() }
        item.onQuit = { NSApp.terminate(nil) }
        self.statusItem = item

        // Register global hotkey using configured binding
        print("VoiceCoordinator.start: initial hotkey=\(config.hotkey)")
        let hotkey = HotkeyManager { [weak self] in self?.handleToggle() }
        if config.dictationEnabled {
            let ok = hotkey.register(hotkey: config.hotkey)
            if !ok {
                statusItem?.updateState(.error("Hotkey '\(config.hotkey)' could not be registered"))
            }
        }
        self.hotkeyManager = hotkey
        registerConverseHotkey(config.converseHotkey)

        // Set up audio completion handler
        audioCapture.onRecordingComplete = { [weak self] buffer in
            self?.handleAudioComplete(buffer)
        }

        // Streaming-capable API engine pushes partial transcripts here. We
        // render partials in both .recording (local streaming, while user is
        // still talking) and .transcribing (API SSE deltas, after stop) so a
        // late chunk that arrives after we've already injected and gone idle
        // can't steal focus from the success/error HUD state.
        let partialHandler: (String) -> Void = { [weak self] text in
            // Only update the HUD with partial text while still recording.
            // Once the user stops, we want a plain spinner — not late partial
            // chunks (from an orphan streaming decode) overwriting it.
            guard let self = self, self.state == .recording else { return }
            self.lastPartialAt = Date()
            self.lastPartialText = text
            if self.captureDestination == .dictation {
                self.hud.show(.partial(text))
            }
        }
        apiEngine.onPartial = partialHandler
        localEngine.onPartial = partialHandler
        realtimeEngine.onPartial = partialHandler

        // Route audio chunks to the realtime engine during recording.
        // The engine's appendAudioChunk is a no-op when no session is open,
        // so this is safe to leave wired permanently.
        audioCapture.onChunk = { [weak self] chunk in
            guard let self = self else { return }
            if self.config.provider == .realtime {
                self.realtimeEngine.appendAudioChunk(chunk)
            }
        }

        // Stream mic RMS levels to the HUD waveform meter. Audio tap thread
        // → main hop here. The HUD itself no-ops when not in .recording.
        audioCapture.onLevel = { [weak self] level in
            DispatchQueue.main.async {
                guard let self else { return }
                if self.captureDestination.composerMode != nil {
                    self.emitConversationEvent(type: "level", payload: ["level": level])
                } else {
                    self.hud.updateLevel(level)
                }
            }
        }

        // Playback draining is what actually ends a converse turn — the HTTP
        // stream usually finishes while the last sentences are still playing.
        speechPlayer.onFinished = { [weak self] in
            guard let self = self, self.state == .speaking else { return }
            // Only after the stream closes — mid-turn the queue empties often,
            // whenever playback outruns the next sentence's synthesis.
            guard self.converseStreamEnded else { return }
            self.endSpeaking()
        }

        // Check permissions
        checkPermissions()

        // Start polling gateway
        startGatewayPolling()

        // Idle-unload timer: every 15s check if the local pipeline or realtime socket can be released
        idleUnloadTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self = self, self.state == .idle else { return }
            self.localEngine.unloadIfIdle()
            self.realtimeEngine.unloadIfIdle()
        }

        // Prewarm WhisperKit so the first hotkey press doesn't pay the model
        // load cost. We only do this when local is the active provider — no
        // sense pulling weights for API-only users.
        if config.provider == .local {
            localEngine.prewarm()
        }
        // Prewarm the audio engine regardless of provider — `engine.prepare()`
        // negotiates the input format with Core Audio so `start()` later on
        // hotkey press is a fast transition rather than a cold open. Also
        // reserves the pcmBuffer capacity once so the audio tap thread
        // doesn't realloc during recording.
        audioCapture.prewarm()
    }

    // MARK: - Toggle handler

    private func handleToggle() {
        guard config.dictationEnabled else { return }
        handleCaptureToggle(destination: .dictation)
    }

    private func handleConverseToggle() {
        guard config.conversationEnabled else { return }
        // API and Realtime capture remain in Electron. On-device capture must
        // stay here so it can reuse the already-warmed WhisperKit pipeline.
        guard config.provider == .local else {
            Task { await gateway.triggerConverseHotkey() }
            return
        }
        conversationFromHotkey = true
        handleCaptureToggle(destination: .conversation)
    }

    /// True while this helper is the one that should be drawing the
    /// conversation capsule: a hotkey-started conversation turn, as opposed to
    /// a composer-button turn (no capsule) or a dictation turn (its own pill).
    private var ownsConversationCapsule: Bool {
        captureDestination == .conversation && conversationFromHotkey
    }

    /// Raise the capsule for `phase` if this turn owns it, otherwise clear the
    /// panel so a composer-button turn doesn't inherit a stale pill.
    private func setConversationCapsule(_ phase: HudOverlay.ConversationPhase) {
        if ownsConversationCapsule {
            hud.show(.conversation(phase))
        } else {
            hud.hide()
        }
    }

    private func handleCaptureToggle(destination: CaptureDestination) {
        print("handleToggle: current state=\(state)")
        switch state {
        case .idle:
            guard localModelReady(for: destination) else { return }
            startRecording(destination: destination)
        case .recording:
            stopRecording()
        case .transcribing:
            // Give up on this turn. A cold CoreML compile can hold the decode
            // for far longer than anyone will wait, and refusing the toggle
            // left the only escape hatch as quitting the app. Abandon rather
            // than restart: the press means "let go of this", and starting a
            // recording the user didn't ask for would be its own surprise.
            print("handleToggle: abandoning in-flight transcription")
            abandonTranscription()
        case .speaking:
            // Barge-in: the user pressed the hotkey while Codey was talking,
            // which means they want to speak now. Kill the turn and start
            // recording in the same gesture rather than making them press
            // twice. (This transition is also where VAD would hook in later:
            // detected speech would trigger the same path.)
            print("handleToggle: barge-in during playback")
            endSpeaking()
            startRecording(destination: destination)
        }
    }

    /// Refuse a press the on-device pipeline can't serve yet, and say so.
    ///
    /// The load is lazy: a few seconds cold, minutes on the first press after
    /// an app update while CoreML recompiles for the Neural Engine. Recording
    /// anyway looked like it worked and then stalled *after* the user had
    /// finished talking, which is the worst moment to discover the wait. Say
    /// "not yet" up front, kick the load, and let them press again.
    private func localModelReady(for destination: CaptureDestination) -> Bool {
        guard config.provider == .local, !localEngine.isReady else { return true }
        print("handleToggle: refused — the on-device model is not loaded yet")
        localEngine.prewarm()
        let message = "Preparing the speech model"
        if destination.composerMode != nil {
            emitConversationEvent(type: "error", payload: ["message": message])
            emitConversationEvent(type: "state", payload: ["state": "idle"])
        }
        // The composer button reports through the event above; only turns the
        // user started away from the window need the pill.
        if destination == .dictation || (destination == .conversation && conversationFromHotkey) {
            hud.show(.notice(message))
        }
        return false
    }

    private func startRecording(destination: CaptureDestination = .dictation) {
        do {
            captureDestination = destination
            if destination.composerMode != nil { conversationCaptureGeneration += 1 }
            try audioCapture.startRecording()
            state = .recording
            // Reset partial tracking so an old recording's partial can't
            // surface during this one's stop window.
            lastPartialAt = nil
            lastPartialText = ""
            statusItem?.updateState(.recording)
            if destination.composerMode != nil {
                // Raise the capsule here rather than waiting for Electron to
                // send `hud-state listening` back: recording has already
                // started, so anything that drops or countermands that round
                // trip leaves a turn recording with nothing on screen.
                setConversationCapsule(.listening)
                emitConversationEvent(type: "state", payload: ["state": "recording"])
            } else {
                hud.show(.recording)
            }
            installEscMonitor()

            // Kick off WhisperKit's sliding-window streaming so the HUD can
            // show partial transcripts while the user is still speaking.
            // API streaming, by contrast, only kicks in after stop because
            // /audio/transcriptions takes a complete clip.
            if config.provider == .local {
                let capture = audioCapture
                localEngine.startStreaming(
                    audioSnapshot: { capture.currentSamplesSnapshot() },
                    language: config.language
                )
            }

            // Start the realtime WebSocket session if using the realtime provider.
            // Audio chunks are already being forwarded to the engine via onChunk
            // (set up in start()). If the session fails to connect, transcribe()
            // falls back to the batch HTTP API.
            if config.provider == .realtime {
                let lang = config.language
                Task {
                    do {
                        try await realtimeEngine.startRealtimeSession(language: lang)
                    } catch {
                        print("startRecording: realtime session failed — \(error.localizedDescription), falling back to batch")
                    }
                }
            }
            print("startRecording: OK, audio engine running")
            Task { await gateway.reportStatus("recording") }
        } catch {
            print("startRecording FAILED: \(error.localizedDescription)")
            statusItem?.updateState(.error(error.localizedDescription))
            hud.show(.error(error.localizedDescription))
        }
    }

    private func stopRecording() {
        print("stopRecording: requesting stop")
        // The monitor deliberately stays up through the decode: a cold CoreML
        // compile can hold `.transcribing` for minutes, which is exactly when
        // someone reaches for Esc. Torn down on the way back to idle instead.
        if captureDestination.composerMode != nil {
            setConversationCapsule(.thinking)
            emitConversationEvent(type: "state", payload: ["state": "transcribing"])
        }
        // Cancel streaming partials before we run the final transcribe so a
        // late partial can't overwrite the success HUD or trigger a duplicate
        // injection.
        localEngine.stopStreaming()
        audioCapture.stopRecording()
        // onRecordingComplete callback handles the rest
    }

    /// Discard the in-progress recording without transcribing. Triggered by
    /// Esc while in the .recording state.
    private func cancelRecording() {
        guard state == .recording else { return }
        print("cancelRecording: Esc pressed — discarding buffer")
        captureGeneration += 1
        removeEscMonitor()
        localEngine.stopStreaming()
        audioCapture.onChunk = nil
        realtimeEngine.cancelSession()
        audioCapture.cancelRecording()
        state = .idle
        statusItem?.updateState(.idle)
        if captureDestination.composerMode != nil {
            conversationCaptureGeneration += 1
            emitConversationEvent(type: "state", payload: ["state": "idle"])
        }
        // Unconditional now that the helper raises the capsule itself: a
        // cancelled turn must take down whatever it put on screen without
        // waiting for Electron to notice.
        hud.hide()
        Task { await gateway.reportStatus("idle") }
    }

    /// Drop an in-flight transcription and return to idle.
    ///
    /// The decode itself cannot be cancelled mid-flight — neither WhisperKit's
    /// CoreML predict nor an HTTP round trip is interruptible here — so the
    /// work runs to completion in the background. What this does is sever the
    /// result: `captureGeneration` moves on, the task sees the mismatch when
    /// it finishes, and drops everything on the floor. The user gets an idle
    /// helper immediately, which is the part that matters.
    private func abandonTranscription() {
        guard state == .transcribing else { return }
        captureGeneration += 1
        removeEscMonitor()
        localEngine.stopStreaming()
        realtimeEngine.cancelSession()
        state = .idle
        statusItem?.updateState(.idle)
        if captureDestination.composerMode != nil {
            conversationCaptureGeneration += 1
            emitConversationEvent(type: "state", payload: ["state": "idle"])
        }
        hud.hide()
        Task { await gateway.reportStatus("idle") }
    }

    /// Commands sent over stdin by the Electron parent. This lets in-chat
    /// controls use the same native capture path as the global hotkey.
    func handleExternalCommand(_ command: String) {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: " ", maxSplits: 1).map(String.init)
        guard let verb = parts.first else { return }
        let argument = parts.count > 1 ? parts[1] : ""

        switch verb {
        // Composer buttons remain available even when their global-hotkey
        // switches are off; those switches only control registration.
        // `conversation-toggle hotkey` marks a turn that should get a capsule;
        // anything else (the composer button) does not. Carried on the command
        // rather than held in Electron so a toggle this helper declines — one
        // arriving mid-transcription, say — can't leave the two sides
        // disagreeing about the next turn.
        case "conversation-toggle":
            conversationFromHotkey = argument == "hotkey"
            handleCaptureToggle(destination: .conversation)
        case "composer-dictation-toggle": handleCaptureToggle(destination: .composerDictation)
        case "conversation-cancel", "composer-dictation-cancel":
            if state == .recording && captureDestination.composerMode != nil {
                cancelRecording()
            } else if state == .transcribing && captureDestination.composerMode != nil {
                // Same teardown as the hotkey path — routed through it so the
                // result guard (`captureGeneration`) can't be skipped here.
                abandonTranscription()
            } else if state == .speaking {
                endSpeaking()
            }
        // Electron drives the capsule's later phases: it is the only side that
        // sees the agent working and the reply being read back. `listening` and
        // the first `thinking` are asserted locally in startRecording /
        // stopRecording, so they don't depend on this round trip.
        case "hud-state": applyConversationHud(argument)
        case "hud-level":
            guard !dictationCaptureInFlight, let level = Float(argument) else { break }
            // Self-heal: the capsule is asserted from three processes, so a
            // stale `hud-state idle` from any of them can hide it mid-turn.
            // The level stream is the one signal still flowing at that point.
            if ownsConversationCapsule, state == .recording, !hud.isOnScreen {
                hud.show(.conversation(.listening))
            }
            hud.updateLevel(level)
        default: break
        }
    }

    /// A dictation capture owns the panel outright. Conversation commands are
    /// dropped while one is running rather than fighting over it — the two
    /// cannot legitimately overlap, since there is one microphone.
    private var dictationCaptureInFlight: Bool {
        captureDestination == .dictation && state != .idle
    }

    private func applyConversationHud(_ raw: String) {
        guard !dictationCaptureInFlight else { return }
        switch raw {
        case "listening": hud.show(.conversation(.listening))
        case "thinking":  hud.show(.conversation(.thinking))
        case "speaking":  hud.show(.conversation(.speaking))
        default:          hud.hide()   // "idle", "hidden", anything unrecognized
        }
        // Esc has to keep working after this helper's part of the turn is over.
        // Capture ends at the transcript, but the turn runs on in Electron for
        // the agent run and the spoken reply — and Electron's own key handler
        // only fires when its window is focused, which in a hotkey turn it
        // usually isn't. So the monitor stays up for as long as the capsule is.
        electronTurnActive = raw == "thinking" || raw == "speaking"
        if electronTurnActive {
            installEscMonitor()
        } else if state == .idle {
            // Never while recording: that turn installed the monitor itself.
            removeEscMonitor()
        }
    }

    /// `modeOverride` exists for the one turn whose destination is decided
    /// after the fact: a hotkey dictation that turns out to be aimed at Codey
    /// itself is captured as `.dictation` but delivered like composer
    /// dictation. Everything else takes the mode from the destination.
    private func emitConversationEvent(type: String, payload: [String: Any] = [:], modeOverride: String? = nil) {
        var body = payload
        body["type"] = type
        body["mode"] = modeOverride ?? captureDestination.composerMode ?? "converse"
        // Echo who started the turn so Electron mirrors this side rather than
        // tracking it independently and drifting.
        if captureDestination == .conversation { body["fromHotkey"] = conversationFromHotkey }
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8) else { return }
        print("CODEY_CONVERSATION_EVENT \(json)")
    }

    // MARK: - Esc-to-cancel monitor

    /// While recording, watch keyDown globally + locally for Esc. Two monitors
    /// because global doesn't fire when our own (helper) windows are key, and
    /// local doesn't fire when another app is frontmost. Together they cover
    /// both cases.
    private func installEscMonitor() {
        guard escMonitorGlobal == nil, escMonitorLocal == nil else { return }
        let handler: (NSEvent) -> Void = { [weak self] event in
            guard let self = self, event.keyCode == 0x35 /* kVK_Escape */ else { return }
            DispatchQueue.main.async {
                // Esc means "stop, and don't do anything with it" in every
                // state: discard the recording, or shut Codey up mid-reply.
                switch self.state {
                case .speaking: self.endSpeaking()
                case .recording: self.cancelRecording()
                // Not cancelRecording: that one guards on `.recording` and so
                // was a silent no-op here, which is why Esc did nothing while
                // "Transcribing" was on screen.
                case .transcribing: self.abandonTranscription()
                default: self.cancelElectronTurn()
                }
            }
        }
        escMonitorGlobal = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: handler)
        escMonitorLocal = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 0x35 {
                handler(event)
                return nil // swallow Esc so it doesn't also reach the focused app
            }
            return event
        }
    }

    /// Esc during the Electron half of a turn — the agent run or the spoken
    /// reply. This helper has nothing of its own left to stop, so it reports
    /// the key and lets Electron drop the playback; the capsule is ours to
    /// take down, and waiting for Electron to say so would leave it up.
    private func cancelElectronTurn() {
        guard electronTurnActive else { return }
        print("cancelElectronTurn: Esc pressed during the Electron half of the turn")
        electronTurnActive = false
        removeEscMonitor()
        hud.hide()
        emitConversationEvent(type: "cancel")
    }

    private func removeEscMonitor() {
        if let m = escMonitorGlobal { NSEvent.removeMonitor(m); escMonitorGlobal = nil }
        if let m = escMonitorLocal { NSEvent.removeMonitor(m); escMonitorLocal = nil }
    }

    // MARK: - Audio → API → Inject pipeline

    private func handleAudioComplete(_ buffer: [Float]) {
        let destination = captureDestination
        let conversationGeneration = conversationCaptureGeneration
        let generation = captureGeneration
        let durationStr = String(format: "%.2f", Double(buffer.count) / 16000.0)
        var peak: Float = 0
        var sumSq: Double = 0
        for s in buffer {
            let a = abs(s)
            if a > peak { peak = a }
            sumSq += Double(s) * Double(s)
        }
        let rms = buffer.isEmpty ? 0.0 : sqrt(sumSq / Double(buffer.count))
        print("handleAudioComplete: \(buffer.count) samples (\(durationStr)s) peak=\(String(format: "%.4f", peak)) rms=\(String(format: "%.4f", rms))")
        guard !buffer.isEmpty else {
            print("handleAudioComplete: EMPTY buffer — nothing to transcribe")
            removeEscMonitor()
            state = .idle
            statusItem?.updateState(.idle)
            if destination.composerMode != nil {
                emitConversationEvent(type: "error", payload: ["message": "The recording was empty"])
                emitConversationEvent(type: "state", payload: ["state": "idle"])
            }
            hud.hide()
            return
        }

        state = .transcribing
        statusItem?.updateState(.transcribing)
        if destination.composerMode != nil {
            setConversationCapsule(.thinking)
            emitConversationEvent(type: "state", payload: ["state": "transcribing"])
        } else {
            hud.show(.transcribing)
        }
        Task { await gateway.reportStatus("transcribing") }

        Task {
            do {
                let lang = config.language
                let providerLabel = config.provider == .local
                    ? "local(\(config.localModel))"
                    : config.provider == .realtime
                    ? "realtime(\(config.realtimeModel))"
                    : "api(\(config.apiModel))"
                print("transcribe: starting (language=\(lang.isEmpty ? "auto" : lang), provider=\(providerLabel))")
                let heard = try await activeEngine.transcribe(audio: buffer, language: lang)

                if generation != self.captureGeneration {
                    print("transcribe: discarded abandoned result")
                    return
                }
                if destination.composerMode != nil && conversationGeneration != conversationCaptureGeneration {
                    print("transcribe: discarded cancelled Conversation result")
                    return
                }

                print("transcribe: result = \"\(heard)\" (\(heard.count) chars)")

                let text = await self.polished(heard, destination: destination)

                // The cleanup is a round trip, so the same two escapes have to
                // be re-checked: the user can abandon the turn while it is in
                // flight, and injecting after that is the exact bug the
                // generation counters exist to prevent.
                if generation != self.captureGeneration {
                    print("polish: discarded abandoned result")
                    return
                }
                if destination.composerMode != nil && conversationGeneration != conversationCaptureGeneration {
                    print("polish: discarded cancelled Conversation result")
                    return
                }

                if destination.composerMode != nil {
                    // Capture is over, so this helper's Esc monitor comes down.
                    // Electron reinstalls it via `hud-state thinking` for the
                    // rest of the turn.
                    await MainActor.run { self.removeEscMonitor() }
                    state = .idle
                    statusItem?.updateState(.idle)
                    if text.isEmpty {
                        emitConversationEvent(type: "error", payload: ["message": "No speech detected."])
                        emitConversationEvent(type: "state", payload: ["state": "idle"])
                        await MainActor.run { self.hud.hide() }
                    } else {
                        // Leave the capsule on `thinking`: the turn now belongs
                        // to the agent, and Electron drives it from here.
                        emitConversationEvent(type: "transcript", payload: ["text": text])
                    }
                    Task { await gateway.reportStatus("idle") }
                    return
                }

                // Dictating into Codey's own window: hand the transcript to
                // the app rather than pasting it. Only that path can compare
                // what was heard against what the user actually sends, which
                // is what teaches the dictionary — pasted text is
                // indistinguishable from typing by the time it lands. The
                // renderer falls back to pasting if no composer is mounted,
                // so nothing is lost when the window is on another tab.
                let finalText = text
                if !finalText.isEmpty && TextInjector.isHostAppFrontmost() {
                    print("dictation: Codey is frontmost, routing to the composer")
                    emitConversationEvent(type: "transcript", payload: ["text": finalText], modeOverride: "dictate")
                    state = .idle
                    statusItem?.updateState(.idle)
                    await MainActor.run { self.removeEscMonitor(); self.hud.show(.success) }
                    Task { await gateway.reportStatus("idle") }
                    return
                }

                let canInject = TextInjector.canInjectAtCurrentFocus()
                if !finalText.isEmpty && canInject {
                    print("inject: mode=\(config.injection)")
                    textInjector.inject(finalText)
                    print("inject: dispatched")
                } else if !finalText.isEmpty {
                    print("inject: no text-capable focus, surfacing in HUD")
                } else {
                    print("inject: skipped (empty transcription)")
                }
                state = .idle
                statusItem?.updateState(.idle)
                await MainActor.run {
                    self.removeEscMonitor()
                    if finalText.isEmpty {
                        self.hud.hide()
                    } else if canInject {
                        self.hud.show(.success)
                    } else {
                        // Nowhere to paste: show full text + auto-copy, wait
                        // for click to dismiss.
                        self.hud.show(.dictation(finalText))
                    }
                }
                Task { await gateway.reportStatus("idle") }
            } catch {
                // Same reasoning as the success path: an abandoned turn must
                // not repaint the HUD with an error the user already moved on
                // from — including the 10s load timeout they just escaped.
                if generation != self.captureGeneration { return }
                if destination.composerMode != nil && conversationGeneration != conversationCaptureGeneration {
                    return
                }
                print("transcribe FAILED: \(error.localizedDescription)")
                state = .idle
                statusItem?.updateState(.error(error.localizedDescription))
                let msg = error.localizedDescription
                await MainActor.run {
                    self.removeEscMonitor()
                    if destination.composerMode != nil {
                        self.emitConversationEvent(type: "error", payload: ["message": msg])
                        self.emitConversationEvent(type: "state", payload: ["state": "idle"])
                        self.hud.hide()
                    } else {
                        self.hud.show(.error(msg))
                    }
                }
                Task { await gateway.reportStatus("error") }
            }
        }
    }

    // MARK: - Converse mode

    /// Runs the transcript through the gateway's cleanup pass when the user
    /// has switched it on, and returns the text to actually use.
    ///
    /// Returns `text` untouched on every unhappy path — switched off, empty,
    /// gateway unreachable, slow, or a rewrite the gateway rejected. The raw
    /// transcript is a correct outcome, so there is nothing here to surface
    /// as an error.
    private func polished(_ text: String, destination: CaptureDestination) async -> String {
        let settings = config.polish
        guard settings.enabled, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return text
        }

        // The conversation capsule is already showing `thinking` and belongs
        // to the turn, not to us; only the dictation pill changes label.
        if destination.composerMode == nil {
            await MainActor.run { self.hud.show(.polishing) }
        }
        Task { await gateway.reportStatus("polishing") }

        let cleaned = await gateway.polish(text, timeoutMs: settings.timeoutMs)
        if cleaned != text {
            print("polish: result = \"\(cleaned)\" (\(cleaned.count) chars)")
        } else {
            print("polish: unchanged")
        }
        return cleaned
    }

    /// Sends the transcript to the gateway and plays the reply as it streams
    /// back. Enters `.speaking` immediately rather than on first audio, so the
    /// hotkey means barge-in for the whole turn — including the long stretch
    /// where the agent is still working.
    private func startConverse(transcript: String) {
        state = .speaking
        serverTTSForTurn = false
        converseStreamEnded = false
        pendingSpokenText.removeAll()
        speechPlayer.languageHint = config.language
        statusItem?.updateState(.transcribing)
        hud.show(.partial(transcript))
        installEscMonitor()
        Task { await gateway.reportStatus("speaking") }

        converseClient.converse(
            transcript: transcript,
            conversationId: conversationId,
            onEvent: { [weak self] event in self?.handleConverseEvent(event) },
            onFinish: { [weak self] in
                guard let self, self.state == .speaking else { return }
                // The stream is done, but queued audio may still be playing.
                // SpeechPlayer.onFinished returns us to idle in that case.
                self.converseStreamEnded = true
                if !self.speechPlayer.isActive { self.endSpeaking() }
            }
        )
    }

    private func handleConverseEvent(_ event: ConverseEvent) {
        guard state == .speaking else { return }
        switch event {
        case .start(let serverTTS):
            serverTTSForTurn = serverTTS

        case .ack(let text), .command(_, let text):
            hud.show(.partial(text))
            speak(text, seq: nil)

        case .text(let seq, let text):
            hud.show(.partial(text))
            // In server mode the audio for this seq is still coming, so hold
            // the text back; a degraded `done` releases whatever never arrived.
            if serverTTSForTurn {
                pendingSpokenText[seq] = text
            } else {
                speak(text, seq: seq)
            }

        case .audio(let seq, let data):
            pendingSpokenText.removeValue(forKey: seq)
            speechPlayer.enqueueAudio(data)

        case .done(let degraded):
            converseStreamEnded = true
            if degraded || !serverTTSForTurn {
                // Speak the tail the gateway couldn't synthesize, in order.
                for seq in pendingSpokenText.keys.sorted() {
                    if let text = pendingSpokenText[seq] { speechPlayer.enqueueSpeech(text) }
                }
            }
            pendingSpokenText.removeAll()
            if !speechPlayer.isActive { endSpeaking() }

        case .error(let message):
            print("converse: error — \(message)")
            speechPlayer.stop()
            hud.show(.error(message))
            state = .idle
            statusItem?.updateState(.error(message))
            removeEscMonitor()
            Task { await gateway.reportStatus("error") }
        }
    }

    private func speak(_ text: String, seq: Int?) {
        if let seq { pendingSpokenText.removeValue(forKey: seq) }
        speechPlayer.enqueueSpeech(text)
    }

    /// Tear down a converse turn: stop playback, drop the stream, return to
    /// idle. Safe to call whether the turn finished, errored or was cut off.
    private func endSpeaking() {
        converseClient.cancel()
        speechPlayer.stop()
        pendingSpokenText.removeAll()
        removeEscMonitor()
        state = .idle
        statusItem?.updateState(.idle)
        hud.hide()
        Task { await gateway.reportStatus("idle") }
    }

    // MARK: - Gateway polling

    private func startGatewayPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            Task {
                let reachable = await self.gateway.checkHealth()
                if !reachable && self.state == .idle {
                    self.statusItem?.updateState(.gatewayDown)
                }

                // Fetch updated config
                if let newConfig = await self.gateway.fetchConfig() {
                    self.applyConfig(newConfig)
                }
            }
        }
        // Fire immediately
        pollTimer?.fire()
    }

    private func applyConfig(_ newConfig: VoiceConfig) {
        let oldHotkey = config.hotkey
        let oldConverseHotkey = config.converseHotkey
        let oldDictationEnabled = config.dictationEnabled
        let oldConversationEnabled = config.conversationEnabled
        let oldProvider = config.provider
        config = newConfig
        textInjector = TextInjector(mode: newConfig.injection)
        apiEngine.updateConfig(newConfig)
        localEngine.updateConfig(newConfig)
        realtimeEngine.updateConfig(newConfig)
        if oldProvider == .local && newConfig.provider != .local {
            localEngine.forceUnload(reason: "provider switched to \(newConfig.provider.rawValue)")
        }
        if oldProvider == .realtime && newConfig.provider != .realtime {
            realtimeEngine.cancelSession()
        }
        if oldProvider != .local && newConfig.provider == .local {
            // User just turned local on (or changed model) — start warming now
            // so the first press is fast.
            localEngine.prewarm()
        }

        if newConfig.converseHotkey != oldConverseHotkey
            || newConfig.conversationEnabled != oldConversationEnabled {
            registerConverseHotkey(newConfig.converseHotkey)
        }

        if newConfig.hotkey != oldHotkey
            || newConfig.dictationEnabled != oldDictationEnabled,
           let hk = hotkeyManager {
            if newConfig.dictationEnabled {
                let ok = hk.register(hotkey: newConfig.hotkey)
                if !ok {
                    statusItem?.updateState(.error("Hotkey '\(newConfig.hotkey)' could not be registered"))
                }
            } else {
                hk.unregister()
            }
        }
    }

    /// (Re)binds the converse hotkey. Electron registers non-Fn combinations
    /// itself, so this only takes over when the binding involves Fn — the one
    /// key Electron's globalShortcut cannot bind.
    private func registerConverseHotkey(_ spec: String) {
        converseHotkeyManager = nil
        guard config.conversationEnabled else { return }
        let trimmed = spec.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.lowercased().hasSuffix("fn") else { return }
        let manager = HotkeyManager { [weak self] in
            self?.handleConverseToggle()
        }
        let ok = manager.register(hotkey: trimmed)
        print("Converse hotkey '\(trimmed)' registered: \(ok)")
        if ok { converseHotkeyManager = manager }
    }

    // MARK: - Permissions

    private func checkPermissions() {
        // Microphone + Accessibility prompts are owned by the parent Codey.app
        // (the helper is a sibling Mach-O without a bundle, so TCC won't show
        // a dialog for it). We just surface a status hint if Accessibility is
        // still missing — without it the Fn monitor can't fire.
        let axGranted = AXIsProcessTrusted()
        if !axGranted {
            statusItem?.updateState(.permissionsNeeded)
            statusItem?.showPermissionAlert(missing: ["Accessibility"])
        }
    }

    // MARK: - Teardown

    func applicationWillTerminate() {
        pollTimer?.invalidate()
        idleUnloadTimer?.invalidate()
        localEngine.forceUnload(reason: "app terminating")
        realtimeEngine.cancelSession()
    }

    // MARK: - Settings

    private func openSettings() {
        Task { await gateway.openSettings() }
    }
}
