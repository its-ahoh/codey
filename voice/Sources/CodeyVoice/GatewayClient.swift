import Foundation

/// Communicates with the Codey Node gateway over HTTP localhost.
final class GatewayClient {
    private let baseURL: URL
    private let session: URLSession
    private(set) var isReachable = false

    init(port: Int = 3001) {
        self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        self.session = URLSession(configuration: config)
    }

    /// Poll gateway health. Returns true if reachable.
    func checkHealth() async -> Bool {
        let url = baseURL.appendingPathComponent("voice/status")
        do {
            let (_, response) = try await session.data(from: url)
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            isReachable = ok
            return ok
        } catch {
            isReachable = false
            return false
        }
    }

    /// Fetch voice config from gateway.
    func fetchConfig() async -> VoiceConfig? {
        let url = baseURL.appendingPathComponent("voice/config")
        do {
            let (data, response) = try await session.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(VoiceConfig.self, from: data)
        } catch {
            return nil
        }
    }

    /// Tell the gateway the converse hotkey was pressed. The gateway forwards
    /// it to the Mac app, which owns the in-chat voice turn.
    func triggerConverseHotkey() async {
        var request = URLRequest(url: baseURL.appendingPathComponent("voice/converse-hotkey"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        _ = try? await session.data(for: request)
    }

    /// Ask the Mac app to open its settings window. Replaces opening
    /// `/config` in a browser: that endpoint now requires a bearer token, and
    /// it always dumped every stored credential into the browser.
    func openSettings() async {
        var request = URLRequest(url: baseURL.appendingPathComponent("voice/open-settings"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        _ = try? await session.data(for: request)
    }

    /// Report current status to gateway.
    func reportStatus(_ status: String) async {
        var request = URLRequest(url: baseURL.appendingPathComponent("voice/status"))
        request.httpMethod = "POST"
        request.httpBody = try? JSONEncoder().encode(["status": status])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try? await session.data(for: request)
    }
}
