import Cocoa

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

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no dock icon

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
