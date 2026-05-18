import Foundation

struct VoiceConfig: Codable {
    var enabled: Bool = false
    var hotkey: String = "Fn"
    var language: String = "auto"
    var injection: InjectionMode = .paste
    var provider: Provider = .api
    var apiUrl: String = "https://api.openai.com/v1"
    var apiKey: String = ""
    var apiModel: String = "whisper-1"
    /// WhisperKit model variant id (HuggingFace argmaxinc/whisperkit-coreml).
    var localModel: String = "openai_whisper-large-v3_turbo_954MB"

    enum InjectionMode: String, Codable {
        case paste
        case ax
    }

    enum Provider: String, Codable {
        case api
        case local
    }

    static var `default`: VoiceConfig {
        VoiceConfig()
    }
}
