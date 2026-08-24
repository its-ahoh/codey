import Foundation

/// One preferred spelling plus the mis-hearings that should be rewritten to it.
///
/// Authored in `gateway.json` under `voice.vocabulary`, either as a bare string
/// (hint only) or as an object:
/// ```json
/// "vocabulary": [
///   "WhisperKit",
///   { "term": "Codey", "aliases": ["寇迪", "Coday", "code E"] }
/// ]
/// ```
struct VocabularyTerm: Codable, Equatable {
    /// The correct spelling. Fed to the recognizer as a prompt hint so it
    /// biases *toward* this word while decoding.
    var term: String
    /// Known mis-transcriptions, rewritten to `term` after decoding. Empty is
    /// fine — the term still works as a prompt hint.
    var aliases: [String] = []

    init(term: String, aliases: [String] = []) {
        self.term = term
        self.aliases = aliases
    }

    /// Accepts either a bare string or the full object form. Hand-edited
    /// config is the normal authoring path here, so the terse form matters.
    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(),
           let text = try? single.decode(String.self) {
            self.term = text
            self.aliases = []
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.term = try c.decodeIfPresent(String.self, forKey: .term) ?? ""
        self.aliases = try c.decodeIfPresent([String].self, forKey: .aliases) ?? []
    }
}

/// Custom-vocabulary support, shared by all three transcription engines.
///
/// Two independent halves, because neither alone is enough:
///
/// - `promptText` runs *before* decoding. Whisper (local, API and realtime all
///   expose it) conditions the decoder on this text, so a name it has never
///   seen becomes reachable instead of being snapped to a common word.
///   Bounded to ~224 tokens by the models, so we cap it here rather than let
///   the tail get silently trimmed.
/// - `apply` runs *after* decoding, in the coordinator, on whatever any engine
///   returned. It fixes the residue: mis-hearings that repeat verbatim every
///   time, which a prompt hint alone does not always shake loose.
enum Vocabulary {
    /// Rough cap on the hint string. Whisper's prompt window is ~224 tokens;
    /// CJK runs about one token per character, so 300 characters is a
    /// conservative ceiling that also keeps the hint from crowding out the
    /// audio's own context.
    private static let maxPromptCharacters = 300

    /// Comma-joined list of preferred spellings, or nil when there is nothing
    /// to hint. Terms are taken in author order and stop at the cap — earlier
    /// entries win, which makes ordering a usable priority knob.
    static func promptText(_ terms: [VocabularyTerm]) -> String? {
        var picked: [String] = []
        var length = 0
        for term in terms {
            let word = term.term.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !word.isEmpty, !picked.contains(word) else { continue }
            let cost = word.count + (picked.isEmpty ? 0 : 2)
            if length + cost > maxPromptCharacters { break }
            picked.append(word)
            length += cost
        }
        return picked.isEmpty ? nil : picked.joined(separator: ", ")
    }

    /// Rewrite every known alias in `text` to its preferred spelling.
    ///
    /// Longest alias first, so a term whose alias is a prefix of another's
    /// cannot shadow it. Matching is case-insensitive and guarded by ASCII
    /// alphanumeric lookarounds: "cody" will not fire inside "codybase", while
    /// CJK aliases — whose neighbours are never ASCII alphanumerics — always
    /// match as plain substrings, which is the behaviour those need.
    static func apply(_ text: String, terms: [VocabularyTerm]) -> String {
        guard !text.isEmpty, !terms.isEmpty else { return text }

        var pairs: [(alias: String, term: String)] = []
        for entry in terms {
            let word = entry.term.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !word.isEmpty else { continue }
            for rawAlias in entry.aliases {
                let alias = rawAlias.trimmingCharacters(in: .whitespacesAndNewlines)
                // Exact match only: an alias that differs from the term just
                // by case ("cody" -> "Cody") is a legitimate capitalization
                // fix, so it must not be treated as a redundant self-mapping.
                guard !alias.isEmpty, alias != word else { continue }
                pairs.append((alias, word))
            }
        }
        guard !pairs.isEmpty else { return text }
        pairs.sort { $0.alias.count > $1.alias.count }

        var result = text
        for pair in pairs {
            let pattern = "(?<![A-Za-z0-9])"
                + NSRegularExpression.escapedPattern(for: pair.alias)
                + "(?![A-Za-z0-9])"
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                continue
            }
            let range = NSRange(result.startIndex..<result.endIndex, in: result)
            result = regex.stringByReplacingMatches(
                in: result,
                options: [],
                range: range,
                withTemplate: NSRegularExpression.escapedTemplate(for: pair.term)
            )
        }
        return result
    }
}
