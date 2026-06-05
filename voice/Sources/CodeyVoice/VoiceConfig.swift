import Foundation

struct VoiceConfig: Codable {
    var enabled: Bool = false
    var hotkey: String = "Fn"
    var language: String = "auto"
    var injection: InjectionMode = .paste
    var provider: Provider = .api
    var apiUrl: String = "https://api.openai.com/v1"
    var apiKey: String = ""
    // gpt-4o-mini-transcribe is ~2–3× faster than whisper-1 on the same audio
    // and supports the same /audio/transcriptions endpoint, so existing
    // configs keep working. Users on self-hosted endpoints can override.
    var apiModel: String = "gpt-4o-mini-transcribe"
    /// WhisperKit model variant id (HuggingFace argmaxinc/whisperkit-coreml).
    var localModel: String = "openai_whisper-large-v3_turbo_954MB"
    /// WebSocket endpoint for the OpenAI Realtime transcription API.
    var realtimeUrl: String = "wss://api.openai.com/v1/realtime?intent=transcription"
    /// Model to use for Realtime transcription sessions.
    var realtimeModel: String = "gpt-4o-mini-transcribe"

    enum InjectionMode: String, Codable {
        case paste
        case ax
    }

    enum Provider: String, Codable {
        case api
        case local
        case realtime
    }

    static var `default`: VoiceConfig {
        VoiceConfig()
    }
}
