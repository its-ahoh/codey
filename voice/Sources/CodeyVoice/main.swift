import Cocoa
import Darwin
import WhisperKit

final class ExitCodeBox: @unchecked Sendable {
    var code: Int32 = 0
}

// Unbuffered stdout/stderr so Electron's pipe sees logs in real time
// instead of waiting for the helper to exit.
setbuf(stdout, nil)
setbuf(stderr, nil)

// One-shot download mode: spawn helper with `--download-model NAME` to fetch a
// WhisperKit variant from HuggingFace without starting hotkey/audio. Progress
// is emitted as `download:progress <fraction>` lines so the parent (Electron
// main) can stream a progress bar to the UI.
let cliArgs = CommandLine.arguments
if let dlIdx = cliArgs.firstIndex(of: "--download-model"), dlIdx + 1 < cliArgs.count {
    // WhisperKit's HF lookup uses glob `*openai*<variant>/*`, so the variant
    // must be the bare model name (e.g. `large-v3-turbo`), not the full repo
    // folder name (`openai_whisper-large-v3-turbo`). Strip the prefix if the
    // UI passed the long form.
    let variant = normalizeVariant(cliArgs[dlIdx + 1])
    print("download:start \(variant)")
    let sema = DispatchSemaphore(value: 0)
    let exitCodeBox = ExitCodeBox()
    Task {
        do {
            let folder = try await WhisperKit.download(variant: variant) { progress in
                let pct = progress.fractionCompleted
                print(String(format: "download:progress %.4f", pct))
            }
            print("download:done \(folder.path)")
        } catch {
            print("download:error \(String(describing: error))")
            exitCodeBox.code = 1
        }
        sema.signal()
    }
    sema.wait()
    exit(exitCodeBox.code)
}

// One-shot warm mode: load WhisperKit + run a dummy 0.5s silent transcribe to
// force CoreML's per-machine compile to complete and land in
// ~/Library/Caches/com.apple.e5rt.*. After warm completes once, subsequent
// app launches load the model in ~200ms (mmap) instead of 30-90s.
if let wIdx = cliArgs.firstIndex(of: "--warm-model"), wIdx + 1 < cliArgs.count {
    let variant = normalizeVariant(cliArgs[wIdx + 1])
    print("warm:start \(variant)")
    let sema = DispatchSemaphore(value: 0)
    let exitCodeBox = ExitCodeBox()
    Task {
        let t0 = Date()
        do {
            let kitConfig = WhisperKitConfig(
                model: variant,
                verbose: false,
                logLevel: .info,
                prewarm: false,
                load: true,
                download: false
            )
            let pipe = try await WhisperKit(kitConfig)
            // Force encoder + decoder mlmodelc to compile by running a real
            // (silent) inference. WhisperKit's `load: true` only loads weights;
            // the per-machine CoreML compile happens lazily on first predict.
            let silence = [Float](repeating: 0, count: 16000)
            var options = DecodingOptions()
            options.task = .transcribe
            options.temperature = 0.0
            options.sampleLength = 32
            _ = try await pipe.transcribe(audioArray: silence, decodeOptions: options)
            let elapsed = Date().timeIntervalSince(t0)
            print(String(format: "warm:done %.2f", elapsed))
        } catch {
            print("warm:error \(String(describing: error))")
            exitCodeBox.code = 1
        }
        sema.signal()
    }
    sema.wait()
    exit(exitCodeBox.code)
}

print("CodeyVoice helper starting (pid \(ProcessInfo.processInfo.processIdentifier))")

/// Resolve gateway port: CLI arg > env var > UserDefaults > default.
func resolveGatewayPort() -> Int {
    let args = CommandLine.arguments
    if let idx = args.firstIndex(of: "--gateway-port"), idx + 1 < args.count, let port = Int(args[idx + 1]) {
        UserDefaults.standard.set(port, forKey: "gatewayPort")
        return port
    }
    if let envStr = ProcessInfo.processInfo.environment["CODEY_GATEWAY_PORT"], let port = Int(envStr) {
        UserDefaults.standard.set(port, forKey: "gatewayPort")
        return port
    }
    let saved = UserDefaults.standard.integer(forKey: "gatewayPort")
    return saved > 0 ? saved : 3001
}

// Helper runs as a headless child of Codey.app — no dock icon, no menu bar,
// no app bundle. NSApp is still initialized because the CGEvent + NSEvent
// APIs we use for hotkey monitoring need an active run loop on the main
// thread, but we never present any UI here.
let app = NSApplication.shared
// Accessory policy = no Dock icon, but still allowed to display windows
// (NSPanel for the HUD overlay). Default policy for a bundle-less binary
// won't render any windows.
app.setActivationPolicy(.accessory)

let port = resolveGatewayPort()
let coordinator = VoiceCoordinator(gatewayPort: port)
coordinator.start()

NotificationCenter.default.addObserver(
    forName: NSApplication.willTerminateNotification,
    object: nil,
    queue: .main
) { _ in
    coordinator.applicationWillTerminate()
}

app.run()
