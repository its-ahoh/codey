import Foundation

/// Transcribes audio via the OpenAI Realtime WebSocket API (transcription-session).
///
/// Owns its own `URLSessionWebSocketTask` per utterance. The streaming path
/// forwards audio chunks as they arrive (`beginStreaming` → N×`appendChunk` →
/// `finishStreaming`) and delivers the final transcript through `finishStreaming`.
/// The single-shot protocol method `transcribe(audio:language:)` opens a socket,
/// sends the entire buffer in one message, commits, and awaits the result —
/// used as fallback when the full buffer is already available.
///
/// Lifecycle: one socket per utterance. Closed on `cancelStreaming`, `finishStreaming`,
/// idle timeout (>30s), or app termination.
final class RealtimeTranscriptionEngine: TranscriptionEngineProtocol, @unchecked Sendable {
    private let session: URLSession
    private var config: VoiceConfig
    private var webSocket: URLSessionWebSocketTask?
    private var streamingContinuation: CheckedContinuation<String, Error>?
    private var receiveTask: Task<Void, Never>?
    private var lastUsed: Date = .distantPast
    private var hasActiveUtterance = false
    private let idleUnloadAfter: TimeInterval = 30

    var onPartial: ((String) -> Void)?

    init(config: VoiceConfig) {
        self.config = config
        self.session = URLSession(configuration: .ephemeral)
    }

    func updateConfig(_ config: VoiceConfig) {
        self.config = config
    }

    // MARK: - Streaming API (called by VoiceCoordinator)

    /// Open a WebSocket to the Realtime API and send `transcription_session.update`
    /// to configure the session. Throws if connection fails or config is invalid.
    func beginStreaming(language: String) throws {
        guard !config.apiKey.isEmpty else { throw TranscriptionError.noAPIKey }
        guard let url = URL(string: config.realtimeUrl) else {
            throw TranscriptionError.invalidURL(config.realtimeUrl)
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")

        let ws = session.webSocketTask(with: request)
        self.webSocket = ws
        ws.resume()
        lastUsed = Date()
        hasActiveUtterance = true

        // Start the receive loop in background
        receiveTask = Task { [weak self] in await self?.receiveLoop() }

        // Send session configuration
        let model = config.realtimeModel
        let lang = language.isEmpty || language == "auto" ? "" : language
        let sessionUpdate: [String: Any] = [
            "type": "transcription_session.update",
            "input_audio_format": "pcm16",
            "input_audio_transcription": [
                "model": model,
                "language": lang,
            ] as [String: Any],
        ]
        let msg = try JSONSerialization.data(withJSONObject: sessionUpdate)
        ws.send(.data(msg)) { [weak self] error in
            if let error = error {
                print("realtime: session.update send error — \(error.localizedDescription)")
                self?.failContinuation(TranscriptionError.apiError(0, "session.update: \(error.localizedDescription)"))
            }
        }
    }

    /// Encode `samples` as PCM16 base64 and send as `input_audio_buffer.append`.
    /// Safe to call from any thread; the send is dispatched to the WebSocket's
    /// delegate queue internally.
    func appendChunk(_ samples: [Float]) {
        guard let ws = webSocket, hasActiveUtterance else { return }
        lastUsed = Date()
        let pcmData = pcm16Data(from: samples)
        let base64 = pcmData.base64EncodedString()
        let event: [String: Any] = [
            "type": "input_audio_buffer.append",
            "audio": base64,
        ]
        guard let msgData = try? JSONSerialization.data(withJSONObject: event) else { return }
        ws.send(.data(msgData)) { error in
            if let error = error {
                print("realtime: append error — \(error.localizedDescription)")
            }
        }
    }

    /// Signal end of audio by sending `input_audio_buffer.commit`, then await
    /// the final transcript from the WebSocket event stream. Returns the
    /// recognized text.
    func finishStreaming() async throws -> String {
        guard let ws = webSocket, hasActiveUtterance else {
            throw TranscriptionError.badResponse
        }
        hasActiveUtterance = false
        lastUsed = Date()

        return try await withCheckedThrowingContinuation { continuation in
            streamingContinuation = continuation
            let commit: [String: Any] = ["type": "input_audio_buffer.commit"]
            guard let data = try? JSONSerialization.data(withJSONObject: commit) else {
                continuation.resume(throwing: TranscriptionError.badResponse)
                return
            }
            ws.send(.data(data)) { error in
                if let error = error {
                    print("realtime: commit send error — \(error.localizedDescription)")
                    // Don't fail the continuation here — the response event
                    // will carry the error if the commit was malformed.
                }
            }
        }
    }

    /// Cancel the current utterance without consuming the result. Closes the
    /// WebSocket immediately.
    func cancelStreaming() {
        hasActiveUtterance = false
        streamingContinuation?.resume(throwing: TranscriptionError.badResponse)
        streamingContinuation = nil
        closeSocket()
    }

    // MARK: - TranscriptionEngineProtocol conformance

    /// Single-shot fallback path: open a WebSocket, send the full audio buffer
    /// in one `input_audio_buffer.append`, commit, and await the final transcript.
    /// This lets the coordinator call `activeEngine.transcribe(audio:language:)`
    /// uniformly when realtime streaming was not used (e.g. fallback after
    /// connection failure).
    func transcribe(audio: [Float], language: String) async throws -> String {
        guard !config.apiKey.isEmpty else { throw TranscriptionError.noAPIKey }
        guard let url = URL(string: config.realtimeUrl) else {
            throw TranscriptionError.invalidURL(config.realtimeUrl)
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")

        let ws = session.webSocketTask(with: request)
        self.webSocket = ws
        ws.resume()
        lastUsed = Date()
        hasActiveUtterance = true

        // Start receive loop
        receiveTask = Task { [weak self] in await self?.receiveLoop() }

        // Session update
        let model = config.realtimeModel
        let lang = language.isEmpty || language == "auto" ? "" : language
        let sessionUpdate: [String: Any] = [
            "type": "transcription_session.update",
            "input_audio_format": "pcm16",
            "input_audio_transcription": [
                "model": model,
                "language": lang,
            ] as [String: Any],
        ]
        let updateData = try JSONSerialization.data(withJSONObject: sessionUpdate)

        return try await withCheckedThrowingContinuation { continuation in
            streamingContinuation = continuation
            ws.send(.data(updateData)) { error in
                if let error = error {
                    continuation.resume(throwing: TranscriptionError.apiError(0, "session.update: \(error.localizedDescription)"))
                    return
                }
                // Send the full audio in one append
                let pcmData = pcm16Data(from: audio)
                let base64 = pcmData.base64EncodedString()
                let appendEvent: [String: Any] = [
                    "type": "input_audio_buffer.append",
                    "audio": base64,
                ]
                guard let appendData = try? JSONSerialization.data(withJSONObject: appendEvent) else {
                    continuation.resume(throwing: TranscriptionError.badResponse)
                    return
                }
                ws.send(.data(appendData)) { error in
                    if let error = error {
                        continuation.resume(throwing: TranscriptionError.apiError(0, "append: \(error.localizedDescription)"))
                        return
                    }
                    // Commit to finalize
                    let commit: [String: Any] = ["type": "input_audio_buffer.commit"]
                    guard let commitData = try? JSONSerialization.data(withJSONObject: commit) else {
                        continuation.resume(throwing: TranscriptionError.badResponse)
                        return
                    }
                    ws.send(.data(commitData)) { error in
                        if let error = error {
                            continuation.resume(throwing: TranscriptionError.apiError(0, "commit: \(error.localizedDescription)"))
                        }
                        // Success — continue waiting in receiveLoop for the result
                    }
                }
            }
        }
    }

    func unloadIfIdle() {
        guard webSocket != nil, !hasActiveUtterance else { return }
        if Date().timeIntervalSince(lastUsed) >= idleUnloadAfter {
            print("realtime: closing idle socket (>\(Int(idleUnloadAfter))s)")
            closeSocket()
        }
    }

    // MARK: - Internals

    /// Background loop reading WebSocket messages. Dispatches by event `type`.
    private func receiveLoop() async {
        guard let ws = webSocket else { return }

        while !Task.isCancelled {
            do {
                let message = try await ws.receive()
                lastUsed = Date()
                switch message {
                case .data(let data):
                    handleEvent(data: data)
                case .string(let string):
                    if let data = string.data(using: .utf8) {
                        handleEvent(data: data)
                    }
                @unknown default:
                    break
                }
            } catch {
                // Socket closed or connection error
                print("realtime: receive error — \(error.localizedDescription)")
                failContinuation(TranscriptionError.apiError(0, "connection: \(error.localizedDescription)"))
                break
            }
        }
    }

    private func handleEvent(data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else {
            return
        }

        switch type {
        case "conversation.item.input_audio_transcription.delta":
            if let delta = obj["delta"] as? String, !delta.isEmpty {
                let snapshot = delta
                if let cb = onPartial {
                    DispatchQueue.main.async { cb(snapshot) }
                }
            }

        case "conversation.item.input_audio_transcription.completed":
            let transcript = (obj["transcript"] as? String) ?? ""
            hasActiveUtterance = false
            if let continuation = streamingContinuation {
                streamingContinuation = nil
                continuation.resume(returning: transcript.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            // Don't close the socket here — let the coordinator call
            // finishStreaming or unloadIfIdle manage the lifecycle.

        case "error":
            let message = (obj["error"] as? [String: Any])?["message"] as? String
                ?? (obj["error"] as? String)
                ?? "unknown error"
            print("realtime: server error — \(message)")
            failContinuation(TranscriptionError.apiError(0, message))

        case "transcription_session.created", "transcription_session.updated":
            // Lifecycle acknowledgment — no action needed.
            break

        default:
            print("realtime: unhandled event type=\(type)")
        }
    }

    private func failContinuation(_ error: TranscriptionError) {
        hasActiveUtterance = false
        if let continuation = streamingContinuation {
            streamingContinuation = nil
            continuation.resume(throwing: error)
        }
    }

    private func closeSocket() {
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        receiveTask?.cancel()
        receiveTask = nil
        streamingContinuation = nil
        hasActiveUtterance = false
    }
}
