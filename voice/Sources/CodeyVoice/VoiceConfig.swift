import Foundation

struct VoiceConfig: Codable {
    var enabled: Bool = false
    var dictationEnabled: Bool = false
    var conversationEnabled: Bool = false
    var hotkey: String = "Fn"
    var language: String = "auto"
    var injection: InjectionMode = .paste
    /// Legacy config value retained so older gateway.json files still decode.
    /// The primary hotkey now always dictates; converseHotkey always talks to
    /// the selected Chat, so this value no longer routes transcripts.
    var mode: Mode = .inject
    /// Second binding: start/stop a spoken conversation in the focused chat.
    /// Handled here rather than in Electron because only this helper can bind
    /// Fn-based combinations. Empty means unbound.
    var converseHotkey: String = "Shift+Fn"

    var provider: Provider = .api
    var apiUrl: String = "https://api.openai.com/v1"
    var apiKey: String = ""
    // gpt-4o-mini-transcribe is ~2–3× faster than whisper-1 on the same audio
    // and supports the same /audio/transcriptions endpoint, so existing
    // configs keep working. Users on self-hosted endpoints can override.
    var apiModel: String = "gpt-4o-mini-transcribe"
    /// WhisperKit model variant id (HuggingFace argmaxinc/whisperkit-coreml).
    var localModel: String = "openai_whisper-large-v3_turbo_954MB"
    /// OpenAI Realtime API WebSocket URL. Uses the same apiKey as the batch API.
    /// Requires `?intent=transcription` to open a transcription session.
    var realtimeUrl: String = "wss://api.openai.com/v1/realtime?intent=transcription"
    /// Realtime transcription model (e.g. "gpt-4o-mini-transcribe").
    var realtimeModel: String = "gpt-4o-mini-transcribe"

    enum Mode: String, Codable {
        case inject
        case converse
    }

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

    /// Decodes leniently: any key the gateway omits keeps its default above.
    ///
    /// Swift's synthesized `init(from:)` ignores property defaults and throws
    /// on a missing key, which would fail the *whole* config fetch — and the
    /// gateway passes `voice` through from gateway.json verbatim, so a config
    /// written before a field existed is normal, not exceptional. `mode` in
    /// particular is optional on the gateway side, so requiring it would stop
    /// config polling for every user who hasn't opted into converse yet.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = VoiceConfig()
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? d.enabled
        dictationEnabled = try c.decodeIfPresent(Bool.self, forKey: .dictationEnabled) ?? enabled
        conversationEnabled = try c.decodeIfPresent(Bool.self, forKey: .conversationEnabled) ?? enabled
        hotkey = try c.decodeIfPresent(String.self, forKey: .hotkey) ?? d.hotkey
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? d.language
        injection = try c.decodeIfPresent(InjectionMode.self, forKey: .injection) ?? d.injection
        mode = try c.decodeIfPresent(Mode.self, forKey: .mode) ?? d.mode
        converseHotkey = try c.decodeIfPresent(String.self, forKey: .converseHotkey) ?? d.converseHotkey
        provider = try c.decodeIfPresent(Provider.self, forKey: .provider) ?? d.provider
        apiUrl = try c.decodeIfPresent(String.self, forKey: .apiUrl) ?? d.apiUrl
        apiKey = try c.decodeIfPresent(String.self, forKey: .apiKey) ?? d.apiKey
        apiModel = try c.decodeIfPresent(String.self, forKey: .apiModel) ?? d.apiModel
        localModel = try c.decodeIfPresent(String.self, forKey: .localModel) ?? d.localModel
        realtimeUrl = try c.decodeIfPresent(String.self, forKey: .realtimeUrl) ?? d.realtimeUrl
        realtimeModel = try c.decodeIfPresent(String.self, forKey: .realtimeModel) ?? d.realtimeModel
    }

    init() {}
}
