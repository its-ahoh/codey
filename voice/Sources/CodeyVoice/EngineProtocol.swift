import Foundation

/// Pluggable transcription backend. Both API (HTTP) and local (WhisperKit) engines conform.
protocol TranscriptionEngineProtocol: AnyObject {
    /// Transcribe 16 kHz mono Float32 audio. Returns the recognized text (may be empty).
    func transcribe(audio: [Float], language: String) async throws -> String

    /// Apply hot-reloaded config. Engines that need to switch model/provider use this.
    func updateConfig(_ config: VoiceConfig)

    /// Release any heavy resources (loaded model weights, GPU buffers).
    /// Called by the coordinator after an idle period so we don't keep the
    /// model resident when the user isn't dictating.
    func unloadIfIdle()
}
