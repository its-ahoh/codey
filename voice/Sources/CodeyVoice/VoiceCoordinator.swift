import Cocoa
import Foundation

/// Central coordinator that wires hotkey, audio, transcription, and text injection together.
final class VoiceCoordinator {
    enum State {
        case idle
        case recording
        case transcribing
    }

    private var state: State = .idle
    private var config: VoiceConfig

    private let gateway: GatewayClient
    private let audioCapture: AudioCapture
    private let apiEngine: TranscriptionEngine
    private let localEngine: WhisperKitEngine
    private let realtimeEngine: RealtimeTranscriptionEngine
    private var textInjector: TextInjector
    private var hotkeyManager: HotkeyManager?
    private var statusItem: StatusItem?
    private let hud = HudOverlay()
    private var pollTimer: Timer?
    private var idleUnloadTimer: Timer?
    private let gatewayPort: Int
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

    init(gatewayPort: Int = 3001) {
        self.gatewayPort = gatewayPort
        self.config = VoiceConfig.default
        self.gateway = GatewayClient(port: gatewayPort)
        self.audioCapture = AudioCapture()
        self.apiEngine = TranscriptionEngine(config: .default)
        self.localEngine = WhisperKitEngine(config: .default)
        self.realtimeEngine = RealtimeTranscriptionEngine(config: .default)
        self.textInjector = TextInjector(mode: .paste)
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
        let ok = hotkey.register(hotkey: config.hotkey)
        if !ok {
            statusItem?.updateState(.error("Hotkey '\(config.hotkey)' could not be registered"))
        }
        self.hotkeyManager = hotkey

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
            self.hud.show(.partial(text))
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
            DispatchQueue.main.async { self?.hud.updateLevel(level) }
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
        print("handleToggle: current state=\(state)")
        switch state {
        case .idle:
            startRecording()
        case .recording:
            stopRecording()
        case .transcribing:
            print("handleToggle: ignored, still transcribing")
        }
    }

    private func startRecording() {
        do {
            try audioCapture.startRecording()
            state = .recording
            // Reset partial tracking so an old recording's partial can't
            // surface during this one's stop window.
            lastPartialAt = nil
            lastPartialText = ""
            statusItem?.updateState(.recording)
            hud.show(.recording)
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
        removeEscMonitor()
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
        removeEscMonitor()
        localEngine.stopStreaming()
        audioCapture.onChunk = nil
        realtimeEngine.cancelSession()
        audioCapture.cancelRecording()
        state = .idle
        statusItem?.updateState(.idle)
        hud.hide()
        Task { await gateway.reportStatus("idle") }
    }

    // MARK: - Esc-to-cancel monitor

    /// While recording, watch keyDown globally + locally for Esc. Two monitors
    /// because global doesn't fire when our own (helper) windows are key, and
    /// local doesn't fire when another app is frontmost. Together they cover
    /// both cases.
    private func installEscMonitor() {
        let handler: (NSEvent) -> Void = { [weak self] event in
            guard let self = self, event.keyCode == 0x35 /* kVK_Escape */ else { return }
            DispatchQueue.main.async { self.cancelRecording() }
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

    private func removeEscMonitor() {
        if let m = escMonitorGlobal { NSEvent.removeMonitor(m); escMonitorGlobal = nil }
        if let m = escMonitorLocal { NSEvent.removeMonitor(m); escMonitorLocal = nil }
    }

    // MARK: - Audio → API → Inject pipeline

    private func handleAudioComplete(_ buffer: [Float]) {
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
            state = .idle
            statusItem?.updateState(.idle)
            hud.hide()
            return
        }

        state = .transcribing
        statusItem?.updateState(.transcribing)
        hud.show(.transcribing)
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
                let text = try await activeEngine.transcribe(audio: buffer, language: lang)

                print("transcribe: result = \"\(text)\" (\(text.count) chars)")

                let canInject = TextInjector.canInjectAtCurrentFocus()
                let finalText = text
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
                print("transcribe FAILED: \(error.localizedDescription)")
                state = .idle
                statusItem?.updateState(.error(error.localizedDescription))
                let msg = error.localizedDescription
                await MainActor.run { self.hud.show(.error(msg)) }
                Task { await gateway.reportStatus("error") }
            }
        }
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

        if newConfig.hotkey != oldHotkey, let hk = hotkeyManager {
            let ok = hk.register(hotkey: newConfig.hotkey)
            if !ok {
                statusItem?.updateState(.error("Hotkey '\(newConfig.hotkey)' could not be registered"))
            }
        }
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
        let url = URL(string: "http://127.0.0.1:\(gatewayPort)/config")!
        NSWorkspace.shared.open(url)
    }
}
