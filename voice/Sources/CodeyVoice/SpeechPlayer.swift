import AVFoundation
import Foundation

/// Plays a spoken reply: a queue of synthesized audio segments from the
/// gateway, with the system voice as the fallback when the gateway can't
/// synthesize (no API key, or synthesis failed partway).
///
/// Each `audio` event carries a complete MP3 for one sentence, so segments
/// play back to back through AVAudioPlayer rather than being fed into an
/// AVAudioEngine — there is no partial-frame stream to assemble. Enqueueing
/// preserves arrival order, which the gateway guarantees is `seq` order.
final class SpeechPlayer: NSObject {
    private enum Item {
        case audio(Data)
        case speech(String)
    }

    private var queue: [Item] = []
    private var player: AVAudioPlayer?
    private let synthesizer = AVSpeechSynthesizer()
    private var isPlaying = false
    /// Language hint for the system voice, e.g. "zh-CN". Empty means let
    /// AVSpeechSynthesizer infer it from the text.
    var languageHint: String = ""
    /// Called when the queue drains. Used to return the coordinator to idle.
    var onFinished: (() -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    var isActive: Bool { isPlaying || !queue.isEmpty }

    /// Enqueue one gateway-synthesized segment.
    func enqueueAudio(_ data: Data) {
        queue.append(.audio(data))
        playNextIfIdle()
    }

    /// Enqueue text for the system voice — client TTS mode, or the tail of a
    /// reply whose server-side synthesis failed.
    func enqueueSpeech(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        queue.append(.speech(trimmed))
        playNextIfIdle()
    }

    /// Stop immediately and drop anything pending. Barge-in depends on this
    /// being instant — the user pressed the hotkey because they want to talk
    /// now, not once the current sentence finishes.
    func stop() {
        queue.removeAll()
        player?.stop()
        player = nil
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isPlaying = false
    }

    private func playNextIfIdle() {
        guard !isPlaying else { return }
        guard !queue.isEmpty else {
            onFinished?()
            return
        }
        let item = queue.removeFirst()
        isPlaying = true

        switch item {
        case .audio(let data):
            do {
                let p = try AVAudioPlayer(data: data)
                p.delegate = self
                player = p
                p.play()
            } catch {
                // A segment that won't decode shouldn't strand the queue.
                print("SpeechPlayer: could not play audio segment — \(error.localizedDescription)")
                isPlaying = false
                playNextIfIdle()
            }
        case .speech(let text):
            let utterance = AVSpeechUtterance(string: text)
            if !languageHint.isEmpty, languageHint != "auto" {
                utterance.voice = AVSpeechSynthesisVoice(language: languageHint)
            }
            synthesizer.speak(utterance)
        }
    }

    private func advance() {
        isPlaying = false
        playNextIfIdle()
    }
}

extension SpeechPlayer: AVAudioPlayerDelegate {
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { [weak self] in self?.advance() }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        DispatchQueue.main.async { [weak self] in self?.advance() }
    }
}

extension SpeechPlayer: AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in self?.advance() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // stop() already cleared the queue; don't advance into it.
    }
}
