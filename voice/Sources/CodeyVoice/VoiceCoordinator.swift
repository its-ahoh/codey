import Cocoa
import Foundation

/// Central coordinator that wires hotkey, audio, whisper, and text injection together.
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
    private let whisper: WhisperEngine
    private var textInjector: TextInjector
    private var hotkeyManager: HotkeyManager?
    private var statusItem: StatusItem?
    private var pollTimer: Timer?
    private let gatewayPort: Int

    init(gatewayPort: Int = 3001) {
        self.gatewayPort = gatewayPort
        self.config = VoiceConfig.default
        self.gateway = GatewayClient(port: gatewayPort)
        self.audioCapture = AudioCapture()
        self.whisper = WhisperEngine()
        self.textInjector = TextInjector(mode: .paste)
    }

    func start() {
        // Set up status bar UI
        let item = StatusItem()
        item.onToggle = { [weak self] in self?.handleToggle() }
        item.onSettings = { [weak self] in self?.openSettings() }
        item.onQuit = { NSApp.terminate(nil) }
        self.statusItem = item

        // Register global hotkey
        let hotkey = HotkeyManager { [weak self] in self?.handleToggle() }
        hotkey.register()
        self.hotkeyManager = hotkey

        // Set up audio completion handler
        audioCapture.onRecordingComplete = { [weak self] buffer in
            self?.handleAudioComplete(buffer)
        }

        // Check permissions
        checkPermissions()

        // Load model
        Task {
            await loadModel()
        }

        // Start polling gateway
        startGatewayPolling()
    }

    // MARK: - Toggle handler

    private func handleToggle() {
        switch state {
        case .idle:
            startRecording()
        case .recording:
            stopRecording()
        case .transcribing:
            break // ignore toggle while transcribing
        }
    }

    private func startRecording() {
        do {
            try audioCapture.startRecording()
            state = .recording
            statusItem?.updateState(.recording)
            Task { await gateway.reportStatus("recording") }
        } catch {
            statusItem?.updateState(.error(error.localizedDescription))
        }
    }

    private func stopRecording() {
        audioCapture.stopRecording()
        // onRecordingComplete callback handles the rest
    }

    // MARK: - Audio → Whisper → Inject pipeline

    private func handleAudioComplete(_ buffer: [Float]) {
        guard !buffer.isEmpty else {
            state = .idle
            statusItem?.updateState(.idle)
            return
        }

        state = .transcribing
        statusItem?.updateState(.transcribing)
        Task { await gateway.reportStatus("transcribing") }

        Task {
            do {
                let text = try await whisper.transcribe(audio: buffer, language: config.language)
                if !text.isEmpty {
                    textInjector.inject(text)
                }
                state = .idle
                statusItem?.updateState(.idle)
                Task { await gateway.reportStatus("idle") }
            } catch {
                state = .idle
                statusItem?.updateState(.error(error.localizedDescription))
                Task { await gateway.reportStatus("error") }
            }
        }
    }

    // MARK: - Model loading

    private func loadModel() async {
        let path = config.modelPath
        // Expand ~ in path
        let expandedPath = NSString(string: path).expandingTildeInPath
        guard FileManager.default.fileExists(atPath: expandedPath) else {
            statusItem?.updateState(.error("Model not found: \(expandedPath)"))
            return
        }
        do {
            try whisper.loadModel(at: expandedPath)
        } catch {
            statusItem?.updateState(.error(error.localizedDescription))
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
        let oldPath = config.modelPath
        config = newConfig
        textInjector = TextInjector(mode: newConfig.injection)

        if newConfig.modelPath != oldPath {
            Task { await loadModel() }
        }
    }

    // MARK: - Permissions

    private func checkPermissions() {
        Task {
            var missing: [String] = []

            // Microphone
            let micGranted = await AudioCapture.requestPermission()
            if !micGranted {
                missing.append("Microphone")
            }

            // Accessibility (for hotkey + AX injection)
            let axGranted = AXIsProcessTrusted()
            if !axGranted {
                missing.append("Accessibility")
            }

            if !missing.isEmpty {
                statusItem?.updateState(.permissionsNeeded)
                statusItem?.showPermissionAlert(missing: missing)
            }
        }
    }

    // MARK: - Teardown

    func applicationWillTerminate() {
        pollTimer?.invalidate()
        whisper.shutdown()
    }

    // MARK: - Settings

    private func openSettings() {
        let url = URL(string: "http://127.0.0.1:\(gatewayPort)/config")!
        NSWorkspace.shared.open(url)
    }
}
