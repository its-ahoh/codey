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

    /// Report current status to gateway.
    func reportStatus(_ status: String) async {
        var request = URLRequest(url: baseURL.appendingPathComponent("voice/status"))
        request.httpMethod = "POST"
        request.httpBody = try? JSONEncoder().encode(["status": status])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try? await session.data(for: request)
    }
}
