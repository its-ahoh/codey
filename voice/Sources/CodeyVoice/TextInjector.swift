import Cocoa
import CoreGraphics

/// Injects text into the currently focused UI element.
final class TextInjector {
    private let mode: VoiceConfig.InjectionMode

    init(mode: VoiceConfig.InjectionMode = .paste) {
        self.mode = mode
    }

    /// Inject text at the current cursor position.
    func inject(_ text: String) {
        guard !isSecureFieldFocused() else { return }
        switch mode {
        case .paste:
            // Fast path: short text into a native macOS app → synthesize the
            // characters directly via `CGEvent.keyboardSetUnicodeString` and
            // skip the clipboard entirely. Saves ~50–100 ms of pasteboard
            // settle + ⌘V key dance. Falls back to paste when the text is too
            // long for reliable unicode-event delivery, or when the frontmost
            // app is known to mishandle unicode-injected key events
            // (Electron/Chromium-based apps, mostly).
            if Self.canUseUnicodeFastPath(text: text), injectViaUnicode(text) {
                return
            }
            injectViaPaste(text)
        case .ax:
            injectViaAX(text)
        }
    }

    /// `CGEvent.keyboardSetUnicodeString` reliably ships ~20 UTF-16 units per
    /// event before targets start dropping characters; chunking handles up to
    /// a few hundred. Above ~300 the clipboard route is more robust. Electron
    /// apps see the unicode events as something between a paste and a typed
    /// keystroke — most handle it OK, but a handful (Cursor in some modes,
    /// Notion's slash menu) eat characters. Use paste there.
    private static func canUseUnicodeFastPath(text: String) -> Bool {
        if text.utf16.count > 300 { return false }
        if frontmostNeedsLongPasteDelay() { return false }
        return true
    }

    /// Type `text` directly via CGEvent unicode payloads. Returns `false` if
    /// the underlying API call fails so the caller can fall back to paste.
    /// Splits into 20-UTF16 chunks because event tap drops chars past that
    /// limit. Inter-chunk gap is small (1 ms) — empirically enough for AppKit
    /// + Catalyst input handlers; tighter spacing risks merges into a single
    /// event in the target's run loop.
    private func injectViaUnicode(_ text: String) -> Bool {
        let source = CGEventSource(stateID: .combinedSessionState)
        let utf16 = Array(text.utf16)
        let chunkSize = 20
        var idx = 0
        while idx < utf16.count {
            let end = min(idx + chunkSize, utf16.count)
            let slice = Array(utf16[idx..<end])
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) else {
                return false
            }
            slice.withUnsafeBufferPointer { ptr in
                event.keyboardSetUnicodeString(stringLength: slice.count,
                                               unicodeString: ptr.baseAddress)
            }
            event.post(tap: .cghidEventTap)
            idx = end
            if idx < utf16.count { usleep(1_000) }
        }
        return true
    }

    /// Pre-flight check: is there a focused UI element that will actually
    /// accept text? Used to decide between auto-inject and "show in HUD"
    /// when the user fires the hotkey without first clicking into a field.
    /// Conservative: only roles we know take typed text are treated as
    /// injectable; anything else (Finder, a desktop click, a button focus,
    /// nothing focused at all) returns false.
    static func canInjectAtCurrentFocus() -> Bool {
        let systemWide = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focused = focusedRef else {
            return false
        }
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXRoleAttribute as CFString, &roleRef)
        guard let role = roleRef as? String else { return false }
        // AXSecureTextField excluded — we never inject into password fields.
        let textRoles: Set<String> = [
            "AXTextField",
            "AXTextArea",
            "AXSearchField",
            "AXComboBox",
        ]
        return textRoles.contains(role)
    }

    /// Returns true if the focused UI element is a secure text field (password input).
    private func isSecureFieldFocused() -> Bool {
        let systemWide = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focused = focusedRef else {
            return false
        }
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXRoleAttribute as CFString, &roleRef)
        return (roleRef as? String) == "AXSecureTextField"
    }

    // MARK: - Paste approach (primary)

    /// Copy text to pasteboard, synthesize ⌘V, restore old clipboard.
    ///
    /// Timing notes — previous version waited 120 ms before posting ⌘V and
    /// 12 ms between each key event. That 120 ms was the single largest
    /// chunk of "press release → text appears" latency. Modern macOS settles
    /// `setString` synchronously on the main thread, so the only thing that
    /// actually needs the delay is letting the frontmost app finish its
    /// current run-loop tick before we send keys. 40 ms is plenty for
    /// AppKit/Catalyst apps; Electron apps (Cursor, VS Code) sometimes need
    /// more, so we bump up to 80 ms when one is frontmost.
    private func injectViaPaste(_ text: String) {
        let pasteboard = NSPasteboard.general

        // Save existing content (string/RTF only to avoid large clipboard images)
        let safeTypes: Set<NSPasteboard.PasteboardType> = [.string, .init("public.rtf")]
        var savedItems: [[NSPasteboard.PasteboardType: Data]] = []
        for item in 0..<(pasteboard.pasteboardItems?.count ?? 0) {
            guard let item = pasteboard.pasteboardItems?[item] else { continue }
            var dict: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types where safeTypes.contains(type) {
                if let data = item.data(forType: type) {
                    dict[type] = data
                }
            }
            if !dict.isEmpty {
                savedItems.append(dict)
            }
        }

        // Write our text
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        let pasteDelay: TimeInterval = Self.frontmostNeedsLongPasteDelay() ? 0.08 : 0.04
        DispatchQueue.main.asyncAfter(deadline: .now() + pasteDelay) {
            // Synthesize ⌘V as discrete Command + V key events so Electron apps
            // (Cursor, VS Code, etc.) recognize them as real user input.
            // 4 µs gaps between events — modern macOS event tap pipeline
            // delivers within tens of µs, the longer 12 ms gap from before was
            // a cargo-culted "safe" value with no measurable benefit.
            let source = CGEventSource(stateID: .combinedSessionState)
            let cmdKey: CGKeyCode = 0x37
            let vKey: CGKeyCode = 0x09

            let cmdDown = CGEvent(keyboardEventSource: source, virtualKey: cmdKey, keyDown: true)
            cmdDown?.flags = .maskCommand
            cmdDown?.post(tap: .cghidEventTap)
            usleep(4_000)

            let vDown = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true)
            vDown?.flags = .maskCommand
            vDown?.post(tap: .cghidEventTap)
            usleep(4_000)

            let vUp = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
            vUp?.flags = .maskCommand
            vUp?.post(tap: .cghidEventTap)
            usleep(4_000)

            let cmdUp = CGEvent(keyboardEventSource: source, virtualKey: cmdKey, keyDown: false)
            cmdUp?.post(tap: .cghidEventTap)

            // Restore old clipboard after a brief delay
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                pasteboard.clearContents()
                let items: [NSPasteboardItem] = savedItems.map { dict in
                    let item = NSPasteboardItem()
                    for (type, data) in dict {
                        item.setData(data, forType: type)
                    }
                    return item
                }
                pasteboard.writeObjects(items)
            }
        }
    }

    /// Heuristic: bundle IDs of frontmost apps known to need a longer
    /// pasteboard-settle delay before ⌘V is reliably picked up. Electron's
    /// shared clipboard listener is async and occasionally misses fast
    /// `setString → key event` sequences if the chromium message loop is
    /// busy. Native AppKit doesn't have this issue. Extend the list as
    /// real-world misses get reported.
    private static func frontmostNeedsLongPasteDelay() -> Bool {
        guard let frontApp = NSWorkspace.shared.frontmostApplication,
              let bundleID = frontApp.bundleIdentifier?.lowercased() else { return false }
        let electronOrChromium: [String] = [
            "com.todesktop.230313mzl4w4u92",  // Cursor
            "com.microsoft.vscode",
            "com.microsoft.vscode.insiders",
            "com.github.atom",
            "com.tinyspeck.slackmacgap",       // Slack
            "com.hnc.discord",
            "com.electron.",                    // generic catch-all prefix
            "notion.id",
            "md.obsidian",
        ]
        return electronOrChromium.contains { bundleID.contains($0) }
    }

    // MARK: - AX API approach (fallback)

    /// Use Accessibility API to set the focused element's value directly.
    private func injectViaAX(_ text: String) {
        let systemWide = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(
            systemWide,
            kAXFocusedUIElementAttribute as CFString,
            &focusedRef
        )
        guard result == .success, let focused = focusedRef else {
            // Fallback to paste if AX fails
            injectViaPaste(text)
            return
        }

        let focusedElement = focused as! AXUIElement

        // Try setting selected text first (inserts at cursor)
        let setResult = AXUIElementSetAttributeValue(
            focusedElement,
            kAXSelectedTextAttribute as CFString,
            text as CFTypeRef
        )

        if setResult != .success {
            // Fallback: set the entire value
            let valueResult = AXUIElementSetAttributeValue(
                focusedElement,
                kAXValueAttribute as CFString,
                text as CFTypeRef
            )
            if valueResult != .success {
                // Last resort: paste
                injectViaPaste(text)
            }
        }
    }
}
