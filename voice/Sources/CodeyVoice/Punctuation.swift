import Foundation

/// Rewrites ASCII punctuation to its full-width form where it sits inside
/// Chinese text.
///
/// Whisper transcribes Chinese with the punctuation of its training text,
/// which for a mixed corpus means it will happily end a Chinese sentence with
/// `,` or `.`. Those are the wrong characters: Chinese uses `，` and `。`,
/// which are full-width and carry their own spacing. The result reads as
/// broken typography no matter how good the recognition was.
///
/// This runs on every transcript, whether or not the model cleanup is switched
/// on, because it is a fixed mapping rather than a judgement call — no model,
/// no round trip, no way for it to invent text.
enum Punctuation {
    /// ASCII marks and the full-width character each becomes.
    ///
    /// Brackets are deliberately absent. They come in pairs, and a transcript
    /// that mentions code will contain unpaired ones, so rewriting a single
    /// bracket on adjacency alone would produce a mismatched pair.
    private static let fullWidth: [Character: Character] = [
        ",": "，",
        ".": "。",
        "?": "？",
        "!": "！",
        ":": "：",
        ";": "；",
    ]

    /// Returns `text` with Chinese-context ASCII punctuation replaced.
    ///
    /// A mark is converted when the text touching it is Chinese — the nearest
    /// non-space character on either side is Han — and the character right
    /// after it is not an ASCII letter or digit. That last clause is what
    /// protects the things a full stop legitimately appears inside:
    /// `ChatTab.tsx`, `3.14`, `v1.5`, `gpt-4o-mini`.
    ///
    /// Looking at both sides rather than just the left is what catches the
    /// common mixed case, where the mark follows a Latin word inside an
    /// otherwise Chinese sentence: `我们用 GPT-4o,它很快`.
    static func normalizeChinese(_ text: String) -> String {
        guard text.contains(where: isHan) else { return text }

        let chars = Array(text)
        var out: [Character] = []
        out.reserveCapacity(chars.count)

        var index = 0
        while index < chars.count {
            let char = chars[index]
            guard let wide = fullWidth[char], inChineseContext(chars, at: index) else {
                out.append(char)
                index += 1
                continue
            }
            out.append(wide)
            index += 1
            // Full-width marks include their own trailing space, so the one
            // Whisper wrote after the ASCII mark would show up as a visible
            // gap. Only spaces are dropped — a newline is structure.
            while index < chars.count, chars[index] == " " || chars[index] == "\t" {
                index += 1
            }
        }
        return String(out)
    }

    private static func inChineseContext(_ chars: [Character], at index: Int) -> Bool {
        if let next = chars[safe: index + 1], next.isASCII, next.isLetter || next.isNumber {
            return false
        }
        return isHan(nearestNonSpace(chars, from: index - 1, step: -1))
            || isHan(nearestNonSpace(chars, from: index + 1, step: 1))
    }

    /// The first character either side of `from` that is not a space or tab.
    /// Stops at a newline: text on the other side of a line break is not the
    /// same sentence, so it says nothing about this mark's language.
    private static func nearestNonSpace(_ chars: [Character], from: Int, step: Int) -> Character? {
        var index = from
        while let char = chars[safe: index] {
            if char == "\n" || char == "\r" { return nil }
            if char != " " && char != "\t" { return char }
            index += step
        }
        return nil
    }

    private static func isHan(_ char: Character?) -> Bool {
        guard let char, let scalar = char.unicodeScalars.first else { return false }
        // CJK Unified Ideographs plus Extension A. Enough to tell Chinese
        // text from Latin, which is the only question being asked.
        return (0x4E00...0x9FFF).contains(scalar.value)
            || (0x3400...0x4DBF).contains(scalar.value)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
