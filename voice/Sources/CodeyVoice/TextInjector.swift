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

        // Small delay to let the pasteboard settle
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            // Synthesize ⌘V
            let source = CGEventSource(stateID: .hidSystemState)

            let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: true)  // V
            keyDown?.flags = .maskCommand
            keyDown?.post(tap: .cghidEventTap)

            let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: false)
            keyUp?.flags = .maskCommand
            keyUp?.post(tap: .cghidEventTap)

            // Restore old clipboard after a brief delay
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
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
