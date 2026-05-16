import Foundation

struct VoiceConfig: Codable {
    var enabled: Bool = false
    var hotkey: String = "F5"
    var modelPath: String
    var language: String = "auto"
    var injection: InjectionMode = .paste

    enum InjectionMode: String, Codable {
        case paste
        case ax
    }

    static var `default`: VoiceConfig {
        let modelsDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codey/models")
        return VoiceConfig(
            modelPath: modelsDir.appendingPathComponent("ggml-tiny.bin").path
        )
    }
}
