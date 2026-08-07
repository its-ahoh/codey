import Foundation

/// One event from the gateway's `POST /voice/converse` NDJSON stream.
/// Mirrors `VoiceConverseEvent` in packages/core/src/voice-converse.ts; see
/// docs/superpowers/specs/voice-converse-spec.md for the ordering contract.
enum ConverseEvent {
    /// Declares up front who synthesizes audio for this response. `server`
    /// means audio events will follow; `client` means we speak the text
    /// ourselves. Declared once rather than inferred per segment.
    case start(serverTTS: Bool)
    /// Short acknowledgment played before the agent starts, so a 30s+ run
    /// doesn't read as a dead system.
    case ack(String)
    /// A recognized command was executed; this is the spoken result.
    case command(action: String, result: String)
    case text(seq: Int, text: String)
    case audio(seq: Int, data: Data)
    /// `degraded` means synthesis failed partway: some `text` seqs never got
    /// audio and the client should speak them itself.
    case done(degraded: Bool)
    case error(String)
}

/// Streams a voice transcript to the gateway and yields events as they
/// arrive. Line-delimited JSON rather than SSE or a binary framing: the
/// byte-stream `.lines` sequence below is the entire parser, and base64's
/// size overhead is irrelevant over loopback.
final class ConverseClient {
    private let baseURL: URL
    private let session: URLSession
    private var task: Task<Void, Never>?

    init(port: Int) {
        self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
        let config = URLSessionConfiguration.ephemeral
        // No overall timeout: an agent run legitimately takes minutes. The
        // resource timeout is what would otherwise kill a long turn.
        config.timeoutIntervalForRequest = 600
        config.timeoutIntervalForResource = 3600
        self.session = URLSession(configuration: config)
    }

    /// Sends `transcript` and invokes `onEvent` for each event, on the main
    /// queue. `onFinish` runs exactly once, whether the stream ended, failed
    /// or was cancelled.
    func converse(
        transcript: String,
        conversationId: String?,
        onEvent: @escaping (ConverseEvent) -> Void,
        onFinish: @escaping () -> Void
    ) {
        cancel()

        var request = URLRequest(url: baseURL.appendingPathComponent("voice/converse"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: String] = ["transcript": transcript]
        if let conversationId { payload["conversationId"] = conversationId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        task = Task { [weak self] in
            guard let self else { return }
            defer { DispatchQueue.main.async { onFinish() } }
            do {
                let (bytes, response) = try await self.session.bytes(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(status) else {
                    self.deliver(.error("Gateway returned \(status)"), to: onEvent)
                    return
                }
                for try await line in bytes.lines {
                    if Task.isCancelled { return }
                    guard let event = Self.parse(line) else { continue }
                    self.deliver(event, to: onEvent)
                }
            } catch {
                // A cancelled task surfaces here too; the coordinator has
                // already moved on, so don't report it as a failure.
                if !Task.isCancelled {
                    self.deliver(.error(error.localizedDescription), to: onEvent)
                }
            }
        }
    }

    /// Aborts an in-flight turn. Used for barge-in — the user pressing the
    /// hotkey mid-reply means they want to talk now, not after this finishes.
    func cancel() {
        task?.cancel()
        task = nil
    }

    private func deliver(_ event: ConverseEvent, to onEvent: @escaping (ConverseEvent) -> Void) {
        DispatchQueue.main.async { onEvent(event) }
    }

    /// Parses one NDJSON line. Unknown or malformed events are dropped rather
    /// than failing the stream, so a newer gateway can add event types
    /// without breaking an older helper.
    static func parse(_ line: String) -> ConverseEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return nil }

        switch type {
        case "start":
            return .start(serverTTS: (json["tts"] as? String) == "server")
        case "ack":
            guard let text = json["text"] as? String else { return nil }
            return .ack(text)
        case "command":
            guard let result = json["result"] as? String else { return nil }
            return .command(action: json["action"] as? String ?? "", result: result)
        case "text":
            guard let seq = json["seq"] as? Int, let text = json["text"] as? String else { return nil }
            return .text(seq: seq, text: text)
        case "audio":
            guard let seq = json["seq"] as? Int,
                  let b64 = json["dataBase64"] as? String,
                  let data = Data(base64Encoded: b64) else { return nil }
            return .audio(seq: seq, data: data)
        case "done":
            return .done(degraded: (json["ttsDegraded"] as? Bool) ?? false)
        case "error":
            return .error(json["message"] as? String ?? "Unknown error")
        default:
            return nil
        }
    }
}
