import Foundation

/// One preferred spelling the recognizer should be biased toward.
///
/// Authored in `gateway.json` under `voice.vocabulary`, normally as a bare
/// string:
/// ```json
/// "vocabulary": ["WhisperKit", "Codey"]
/// ```
struct VocabularyTerm: Codable, Equatable {
    var term: String

    init(term: String) {
        self.term = term
    }

    /// Accepts a bare string or an object with a `term` field. The object form
    /// is what older configs hold — together with an `aliases` array that this
    /// build no longer reads, since the recognizer is now given the word up
    /// front instead of having its output rewritten afterwards.
    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(),
           let text = try? single.decode(String.self) {
            self.term = text
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.term = try c.decodeIfPresent(String.self, forKey: .term) ?? ""
    }

    /// Written back as a bare string, which is also the shape the Mac app now
    /// saves.
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(term)
    }

    private enum CodingKeys: String, CodingKey { case term }
}

/// Custom-vocabulary support, shared by all three transcription engines.
///
/// One mechanism, applied *before* decoding: Whisper — local, API and realtime
/// all expose it — conditions the decoder on this text, so a name it has never
/// seen becomes reachable instead of being snapped to a common word. Bounded
/// to ~224 tokens by the models, so we cap it here rather than let the tail
/// get silently trimmed.
///
/// There used to be a second half that rewrote known mis-hearings after
/// decoding. It existed because WhisperKit 0.18 ignored the hint outright; 1.1
/// does not, and a blind find-and-replace over a transcript is worse than
/// letting the model spell the word itself.
enum Vocabulary {
    /// Rough cap on the hint string. Whisper's prompt window is ~224 tokens;
    /// CJK runs about one token per character, so 300 characters is a
    /// conservative ceiling that also keeps the hint from crowding out the
    /// audio's own context.
    private static let maxPromptCharacters = 300

    /// Comma-joined list of preferred spellings, or nil when there is nothing
    /// to hint. Terms are taken in author order and stop at the cap — earlier
    /// entries win, which makes ordering a usable priority knob.
    ///
    /// `repeats` emits the whole list more than once. A single mention of a
    /// name is a weak signal: measured on `large-v3-v20240930_turbo_632MB`,
    /// a bare "Codey" left the transcript as "Cody" on English audio and
    /// "Code" on Chinese, while the same list twice got both right. The cap
    /// covers the finished string, so more repeats means fewer terms fit.
    static func promptText(_ terms: [VocabularyTerm], repeats: Int = 1) -> String? {
        let copies = max(1, repeats)
        let budget = maxPromptCharacters / copies
        var picked: [String] = []
        var length = 0
        for term in terms {
            let word = term.term.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !word.isEmpty, !picked.contains(word) else { continue }
            let cost = word.count + (picked.isEmpty ? 0 : 2)
            if length + cost > budget { break }
            picked.append(word)
            length += cost
        }
        guard !picked.isEmpty else { return nil }
        let list = picked.joined(separator: ", ")
        return Array(repeating: list, count: copies).joined(separator: ", ")
    }
}
