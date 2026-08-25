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

    /// Runs a raw transcript through the gateway's cleanup pass and returns
    /// the text to use.
    ///
    /// Never fails: an unreachable gateway, a non-200, a malformed body and a
    /// timeout all return `text` unchanged, because that is the text the user
    /// would have got anyway. The endpoint answers the same way when cleanup
    /// is switched off, so there is exactly one path through here.
    ///
    /// Its own `URLSession` — the shared one caps requests at 3 seconds, which
    /// is shorter than the cleanup budget and would cancel a call that was
    /// about to succeed. Given a whole second of headroom over `timeoutMs` so
    /// the gateway's own fallback is what normally fires; this timeout only
    /// catches a gateway that stopped answering altogether.
    func polish(_ text: String, timeoutMs: Int) async -> String {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = Double(max(500, timeoutMs)) / 1000 + 1
        let polishSession = URLSession(configuration: config)

        var request = URLRequest(url: baseURL.appendingPathComponent("voice/polish"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])

        do {
            let (data, response) = try await polishSession.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cleaned = json["text"] as? String,
                  !cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return text }
            return cleaned
        } catch {
            print("polish: gateway call failed, keeping the raw transcript - \(error.localizedDescription)")
            return text
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
