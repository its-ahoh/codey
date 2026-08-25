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
/// The hint carries a second job: Whisper imitates the *style* of whatever it
/// is conditioned on, punctuation included. A bare comma-joined term list —
/// which is what this emitted before — reads as unpunctuated running text and
/// pulled periods and question marks out of the transcript along with it. So
/// the terms now ride inside ordinary punctuated sentences, and those
/// sentences are emitted even when the user has no vocabulary at all.
///
/// There used to be a second half that rewrote known mis-hearings after
/// decoding. It existed because WhisperKit 0.18 ignored the hint outright; 1.1
/// does not, and a blind find-and-replace over a transcript is worse than
/// letting the model spell the word itself.
enum Vocabulary {
    /// Rough cap on the hint string. Whisper's prompt window is ~224 tokens;
    /// CJK runs about one token per character, so 300 characters is a
    /// conservative ceiling that also keeps the hint from crowding out the
    /// audio's own context. Covers the style sentence too, not just the terms.
    private static let maxPromptCharacters = 300

    /// Longest wrapper a term sentence can add around the list itself.
    /// Reserved up front so a long carrier can't starve the terms to zero.
    private static let termSentenceOverhead = 20

    /// Which carrier language to write the hint in.
    private enum Style {
        case english
        case chinese
        /// `language: "auto"` — the user may speak either, and a hint written
        /// wholly in one language nudges Whisper's language detection toward
        /// it. Emitting both keeps detection where it was.
        case bilingual
    }

    /// The prompt Whisper is conditioned on, or nil when there is nothing
    /// useful to say.
    ///
    /// Returns a punctuation-carrying sentence even with an empty vocabulary —
    /// that sentence is the whole point for users who never authored terms.
    ///
    /// Terms are taken in author order and stop at the cap — earlier entries
    /// win, which makes ordering a usable priority knob.
    ///
    /// `repeats` emits the term list in more than one sentence. A single
    /// mention of a name is a weak signal: measured on
    /// `large-v3-v20240930_turbo_632MB`, a bare "Codey" left the transcript as
    /// "Cody" on English audio and "Code" on Chinese, while the same list
    /// twice got both right. The cap covers the finished string, so more
    /// repeats means fewer terms fit.
    static func promptText(_ terms: [VocabularyTerm], repeats: Int = 1, language: String = "auto") -> String? {
        let style = resolveStyle(language)
        let opener = styleSentence(style)
        let copies = max(1, repeats)

        let budget = (maxPromptCharacters - opener.count) / copies - termSentenceOverhead
        let picked = pickTerms(terms, budget: budget)
        guard !picked.isEmpty else { return opener }

        var sentences = [opener]
        for index in 0..<copies {
            sentences.append(termSentence(style, index: index, terms: picked))
        }
        return sentences.joined(separator: " ")
    }

    /// Terms that fit, in author order, deduplicated.
    private static func pickTerms(_ terms: [VocabularyTerm], budget: Int) -> [String] {
        guard budget > 0 else { return [] }
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
        return picked
    }

    /// `language` arrives as the raw config value: a BCP-47-ish tag, "auto",
    /// or empty.
    private static func resolveStyle(_ language: String) -> Style {
        let tag = language
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(separator: "-").first.map(String.init) ?? ""
        switch tag {
        case "", "auto": return .bilingual
        case "zh", "yue": return .chinese
        default: return .english
        }
    }

    /// The sentence that exists purely to demonstrate punctuation.
    private static func styleSentence(_ style: Style) -> String {
        switch style {
        case .english: return englishOpener
        case .chinese: return chineseOpener
        case .bilingual: return englishOpener + " " + chineseOpener
        }
    }

    private static let englishOpener =
        "Transcribed with full punctuation: commas, periods, and question marks."
    private static let chineseOpener =
        "以下内容使用完整标点，包含逗号、句号和问号。"

    /// One sentence naming the vocabulary. For `.bilingual` the sentences
    /// alternate so repeated copies reinforce both languages rather than one.
    private static func termSentence(_ style: Style, index: Int, terms: [String]) -> String {
        let useChinese: Bool
        switch style {
        case .english: useChinese = false
        case .chinese: useChinese = true
        case .bilingual: useChinese = index % 2 == 1
        }
        return useChinese
            ? "其中可能提到：" + terms.joined(separator: "、") + "。"
            : "It may mention: " + terms.joined(separator: ", ") + "."
    }
}
