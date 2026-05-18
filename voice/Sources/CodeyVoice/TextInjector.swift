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
            injectViaPaste(text)
        case .ax:
            injectViaAX(text)
        }
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

        // Small delay to let the pasteboard settle (Electron apps need more)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            // Synthesize ⌘V as discrete Command + V key events so Electron apps
            // (Cursor, VS Code, etc.) recognize them as real user input.
            // Each event needs proper flags + a small gap for the target's event
            // queue to register the modifier state.
            let source = CGEventSource(stateID: .combinedSessionState)
            let cmdKey: CGKeyCode = 0x37
            let vKey: CGKeyCode = 0x09

            let cmdDown = CGEvent(keyboardEventSource: source, virtualKey: cmdKey, keyDown: true)
            cmdDown?.flags = .maskCommand
            cmdDown?.post(tap: .cghidEventTap)
            usleep(12_000)

            let vDown = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true)
            vDown?.flags = .maskCommand
            vDown?.post(tap: .cghidEventTap)
            usleep(12_000)

            let vUp = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
            vUp?.flags = .maskCommand
            vUp?.post(tap: .cghidEventTap)
            usleep(12_000)

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
