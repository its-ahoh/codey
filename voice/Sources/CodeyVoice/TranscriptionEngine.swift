import Foundation

/// Transcribes audio via an OpenAI-compatible /audio/transcriptions API.
///
/// Uses Server-Sent Events when the model name signals a streaming-capable
/// backend (the `gpt-4o*-transcribe` family). Streaming gives us partial
/// transcript deltas before the request finishes, which we surface via
/// `onPartial` for the HUD preview and shave a few hundred ms off perceived
/// latency on multi-second clips. `whisper-1` and unknown models stay on the
/// original non-streaming path since they don't honor `stream=true`.
final class TranscriptionEngine: TranscriptionEngineProtocol, @unchecked Sendable {
    private let session: URLSession
    private var config: VoiceConfig
    var onPartial: ((String) -> Void)?

    init(config: VoiceConfig) {
        self.config = config
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: cfg)
    }

    func updateConfig(_ config: VoiceConfig) {
        self.config = config
    }

    func unloadIfIdle() {
        // API engine holds no heavyweight state.
    }

    /// Transcribe 16 kHz mono Float32 audio via the configured API.
    func transcribe(audio: [Float], language: String) async throws -> String {
        let baseURL = config.apiUrl.hasSuffix("/")
            ? String(config.apiUrl.dropLast())
            : config.apiUrl
        guard let url = URL(string: "\(baseURL)/audio/transcriptions") else {
            throw TranscriptionError.invalidURL(baseURL)
        }
        guard !config.apiKey.isEmpty else {
            throw TranscriptionError.noAPIKey
        }

        let wavData = encodeWAV(samples: audio, sampleRate: 16000)
        let streaming = modelSupportsStreaming(config.apiModel)
        let request = buildRequest(url: url, wav: wavData, language: language, streaming: streaming)

        return streaming
            ? try await runStreaming(request: request)
            : try await runOneShot(request: request)
    }

    /// Models known to honor `stream=true` on /audio/transcriptions.
    /// OpenAI's docs explicitly list the gpt-4o transcribe family;
    /// `whisper-1` returns 400 if `stream` is sent, so we keep it on the
    /// legacy path. Self-hosted endpoints can opt in by naming the model
    /// with a `gpt-4o` prefix (or we add more aliases here later).
    private func modelSupportsStreaming(_ model: String) -> Bool {
        let m = model.lowercased()
        return m.contains("gpt-4o") && m.contains("transcribe")
    }

    private func buildRequest(url: URL, wav: Data, language: String, streaming: Bool) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
        if streaming {
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        }

        let boundary = "----CodeyVoice\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append(value.data(using: .utf8)!)
            body.append("\r\n".data(using: .utf8)!)
        }

        // file field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wav)
        body.append("\r\n".data(using: .utf8)!)

        field("model", config.apiModel)
        if !language.isEmpty && language != "auto" {
            field("language", language)
        }
        // Streaming endpoints require JSON; the one-shot path still asks for
        // `text` so the response body is the transcript verbatim.
        field("response_format", streaming ? "json" : "text")
        if streaming { field("stream", "true") }

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        return request
    }

    private func runOneShot(request: URLRequest) async throws -> String {
        let (data, response) = try await session.data(for: request)
        try Self.validateHTTP(response: response, body: data)
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Consume an SSE stream of `transcript.text.delta` / `transcript.text.done`
    /// events. We accumulate deltas (covers servers that send incremental
    /// chunks) and prefer the explicit `text` from the terminal `.done` event
    /// when present (covers servers that send a single final event).
    private func runStreaming(request: URLRequest) async throws -> String {
        let (bytes, response) = try await session.bytes(for: request)
        // For SSE we can only read the body as a stream; if the server errored,
        // bytes will still be readable but contain a JSON error payload.
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            var collected = Data()
            for try await b in bytes { collected.append(b); if collected.count > 64_000 { break } }
            let msg = String(data: collected, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw TranscriptionError.apiError(http.statusCode, msg)
        }

        var accumulated = ""
        var finalText: String?
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let json = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else {
                continue
            }
            let type = (obj["type"] as? String) ?? ""
            switch type {
            case "transcript.text.delta":
                if let delta = obj["delta"] as? String, !delta.isEmpty {
                    accumulated += delta
                    let snapshot = accumulated
                    if let cb = onPartial {
                        await MainActor.run { cb(snapshot) }
                    }
                }
            case "transcript.text.done":
                if let text = obj["text"] as? String { finalText = text }
            default:
                continue
            }
        }
        return (finalText ?? accumulated).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func validateHTTP(response: URLResponse, body: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw TranscriptionError.badResponse
        }
        guard (200...299).contains(http.statusCode) else {
            let msg = String(data: body, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw TranscriptionError.apiError(http.statusCode, msg)
        }
    }

    // MARK: - WAV encoding

    /// Encode 16-bit PCM WAV from Float32 samples in `[-1, 1]`. Pre-allocates
    /// the full buffer (44-byte header + `samples.count * 2`) and writes the
    /// Int16 payload in one pass via `pcm16Data(from:)` so the same clamp+scale
    /// logic is shared with the realtime WebSocket path.
    private func encodeWAV(samples: [Float], sampleRate: Int) -> Data {
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = UInt32(sampleRate) * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign: UInt16 = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(samples.count * 2)
        let fileSize = 36 + dataSize
        let totalBytes = 44 + Int(dataSize)

        let payload = pcm16Data(from: samples)
        var data = Data(count: totalBytes)
        data.withUnsafeMutableBytes { raw in
            let base = raw.baseAddress!
            // RIFF header
            memcpy(base, "RIFF", 4)
            writeLE(base, offset: 4, value: fileSize)
            memcpy(base.advanced(by: 8), "WAVE", 4)
            // fmt chunk
            memcpy(base.advanced(by: 12), "fmt ", 4)
            writeLE(base, offset: 16, value: UInt32(16))
            writeLE(base, offset: 20, value: UInt16(1))   // PCM
            writeLE(base, offset: 22, value: numChannels)
            writeLE(base, offset: 24, value: UInt32(sampleRate))
            writeLE(base, offset: 28, value: byteRate)
            writeLE(base, offset: 32, value: blockAlign)
            writeLE(base, offset: 34, value: bitsPerSample)
            // data chunk
            memcpy(base.advanced(by: 36), "data", 4)
            writeLE(base, offset: 40, value: dataSize)

            // PCM payload — use the shared helper's raw bytes
            let dest = base.advanced(by: 44)
            payload.withUnsafeBytes { src in
                memcpy(dest, src.baseAddress!, payload.count)
            }
        }
        return data
    }

    @inline(__always)
    private func writeLE<T: FixedWidthInteger>(_ base: UnsafeMutableRawPointer, offset: Int, value: T) {
        var le = value.littleEndian
        memcpy(base.advanced(by: offset), &le, MemoryLayout<T>.size)
    }
}

enum TranscriptionError: LocalizedError {
    case invalidURL(String)
    case noAPIKey
    case badResponse
    case apiError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url): return "Invalid API URL: \(url)"
        case .noAPIKey: return "No API key configured"
        case .badResponse: return "Bad response from transcription API"
        case .apiError(let code, let msg): return "API error \(code): \(msg)"
        }
    }
}
