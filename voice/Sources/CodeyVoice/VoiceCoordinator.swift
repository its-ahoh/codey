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
    private var textInjector: TextInjector
    private var hotkeyManager: HotkeyManager?
    private var statusItem: StatusItem?
    private let hud = HudOverlay()
    private var pollTimer: Timer?
    private var idleUnloadTimer: Timer?
    private let gatewayPort: Int
    private var escMonitorGlobal: Any?
    private var escMonitorLocal: Any?

    init(gatewayPort: Int = 3001) {
        self.gatewayPort = gatewayPort
        self.config = VoiceConfig.default
        self.gateway = GatewayClient(port: gatewayPort)
        self.audioCapture = AudioCapture()
        self.apiEngine = TranscriptionEngine(config: .default)
        self.localEngine = WhisperKitEngine(config: .default)
        self.textInjector = TextInjector(mode: .paste)
    }

    private var activeEngine: TranscriptionEngineProtocol {
        switch config.provider {
        case .local: return localEngine
        case .api: return apiEngine
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

        // Stream mic RMS levels to the HUD waveform meter. Audio tap thread
        // → main hop here. The HUD itself no-ops when not in .recording.
        audioCapture.onLevel = { [weak self] level in
            DispatchQueue.main.async { self?.hud.updateLevel(level) }
        }

        // Check permissions
        checkPermissions()

        // Start polling gateway
        startGatewayPolling()

        // Idle-unload timer: every 15s check if the local pipeline can be released
        idleUnloadTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self = self, self.state == .idle else { return }
            self.localEngine.unloadIfIdle()
        }
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
            statusItem?.updateState(.recording)
            hud.show(.recording)
            installEscMonitor()
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
        audioCapture.stopRecording()
        // onRecordingComplete callback handles the rest
    }

    /// Discard the in-progress recording without transcribing. Triggered by
    /// Esc while in the .recording state.
    private func cancelRecording() {
        guard state == .recording else { return }
        print("cancelRecording: Esc pressed — discarding buffer")
        removeEscMonitor()
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
                let providerLabel = config.provider == .local ? "local(\(config.localModel))" : "api(\(config.apiModel))"
                print("transcribe: starting (language=\(lang.isEmpty ? "auto" : lang), provider=\(providerLabel))")
                let text = try await activeEngine.transcribe(audio: buffer, language: lang)
                print("transcribe: result = \"\(text)\" (\(text.count) chars)")

                let canInject = TextInjector.canInjectAtCurrentFocus()
                if !text.isEmpty && canInject {
                    print("inject: mode=\(config.injection)")
                    textInjector.inject(text)
                    print("inject: dispatched")
                } else if !text.isEmpty {
                    print("inject: no text-capable focus, surfacing in HUD")
                } else {
                    print("inject: skipped (empty transcription)")
                }
                state = .idle
                statusItem?.updateState(.idle)
                await MainActor.run {
                    if text.isEmpty {
                        self.hud.hide()
                    } else if canInject {
                        self.hud.show(.success)
                    } else {
                        // Nowhere to paste: show full text + auto-copy, wait
                        // for click to dismiss.
                        self.hud.show(.dictation(text))
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
        if oldProvider == .local && newConfig.provider != .local {
            localEngine.forceUnload(reason: "provider switched to \(newConfig.provider.rawValue)")
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
    }

    // MARK: - Settings

    private func openSettings() {
        let url = URL(string: "http://127.0.0.1:\(gatewayPort)/config")!
        NSWorkspace.shared.open(url)
    }
}
