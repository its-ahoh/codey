import Foundation

/// Transcribes audio via an OpenAI-compatible /audio/transcriptions API.
final class TranscriptionEngine: TranscriptionEngineProtocol, @unchecked Sendable {
    private let session: URLSession
    private var config: VoiceConfig

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

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")

        let boundary = "----CodeyVoice\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        // file field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wavData)
        body.append("\r\n".data(using: .utf8)!)

        // model field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"model\"\r\n\r\n".data(using: .utf8)!)
        body.append(config.apiModel.data(using: .utf8)!)
        body.append("\r\n".data(using: .utf8)!)

        // language field (if not auto)
        if !language.isEmpty && language != "auto" {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"language\"\r\n\r\n".data(using: .utf8)!)
            body.append(language.data(using: .utf8)!)
            body.append("\r\n".data(using: .utf8)!)
        }

        // response_format field — request plain text
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"response_format\"\r\n\r\n".data(using: .utf8)!)
        body.append("text".data(using: .utf8)!)
        body.append("\r\n".data(using: .utf8)!)

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw TranscriptionError.badResponse
        }
        guard (200...299).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw TranscriptionError.apiError(http.statusCode, msg)
        }

        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text
    }

    // MARK: - WAV encoding

    private func encodeWAV(samples: [Float], sampleRate: Int) -> Data {
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = UInt32(sampleRate) * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(samples.count * 2)
        let fileSize = 36 + dataSize

        var data = Data()

        // RIFF header
        data.append(contentsOf: "RIFF".utf8)
        data.append(littleEndian: fileSize)
        data.append(contentsOf: "WAVE".utf8)

        // fmt chunk
        data.append(contentsOf: "fmt ".utf8)
        data.append(littleEndian: UInt32(16))        // chunk size
        data.append(littleEndian: UInt16(1))          // PCM format
        data.append(littleEndian: numChannels)
        data.append(littleEndian: UInt32(sampleRate))
        data.append(littleEndian: byteRate)
        data.append(littleEndian: blockAlign)
        data.append(littleEndian: bitsPerSample)

        // data chunk
        data.append(contentsOf: "data".utf8)
        data.append(littleEndian: dataSize)

        // Convert float [-1,1] to Int16
        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let int16 = Int16(clamped * 32767.0)
            data.append(littleEndian: uint16FromInt16(int16))
        }

        return data
    }

    private func uint16FromInt16(_ v: Int16) -> UInt16 {
        UInt16(bitPattern: v)
    }
}

private extension Data {
    mutating func append<T: FixedWidthInteger>(littleEndian value: T) {
        var le = value.littleEndian
        Swift.withUnsafeBytes(of: &le) { append(contentsOf: $0) }
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
