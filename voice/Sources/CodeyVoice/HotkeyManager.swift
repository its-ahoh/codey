import Carbon.HIToolbox
import Cocoa
import Foundation

/// Registers a global hotkey via either Carbon (for normal keys/combos) or an
/// NSEvent monitor (for the Fn modifier, which Carbon's RegisterEventHotKey
/// cannot bind). Calls `onToggle` on each tap.
///
/// Hotkey string format mirrors WhisperTab:
///   "Fn"                          — Fn key alone (NSEvent path)
///   "F5", "F1"..."F19"            — function keys (Carbon path)
///   "Meta+Shift+V"                — modifier combo + key (Carbon path)
///   "Control+Alt+Space"
final class HotkeyManager {
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var fnMonitorGlobal: Any?
    private var fnMonitorLocal: Any?
    private var fnPreviouslyDown = false
    let onToggle: () -> Void

    init(onToggle: @escaping () -> Void) {
        self.onToggle = onToggle
    }

    /// Register the configured hotkey. Returns true if the registration was
    /// accepted by the OS; false if the combo couldn't be parsed or bound.
    @discardableResult
    func register(hotkey: String) -> Bool {
        unregister()
        let trimmed = hotkey.trimmingCharacters(in: .whitespaces)
        print("HotkeyManager.register(\"\(trimmed)\")")
        if trimmed.caseInsensitiveCompare("Fn") == .orderedSame
            || trimmed.caseInsensitiveCompare("Function") == .orderedSame {
            let ok = registerFnMonitor()
            print("Fn monitor registered: \(ok)")
            return ok
        }
        let ok = registerCarbonHotKey(spec: trimmed)
        print("Carbon hotkey '\(trimmed)' registered: \(ok)")
        return ok
    }

    // MARK: - Fn key path (NSEvent flagsChanged)

    private func registerFnMonitor() -> Bool {
        // Toggle on Fn-down edges. NSEvent.modifierFlags includes .function
        // when fn is held; we trigger when it transitions 0 → 1.
        //
        // NSEvent.addGlobalMonitorForEvents requires Accessibility permission
        // for THIS binary (CodeyVoice). Granting it to the parent Electron app
        // is not enough — macOS tracks Accessibility per-binary by code signature.
        let optionKey = "AXTrustedCheckOptionPrompt" as CFString
        let opts: CFDictionary = [optionKey: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(opts)
        if !trusted {
            FileHandle.standardError.write(Data(
                "Fn hotkey: Accessibility permission NOT granted to CodeyVoice helper. Open System Settings → Privacy & Security → Accessibility and enable CodeyVoice, then quit & relaunch Codey.\n".utf8
            ))
        } else {
            print("Fn hotkey: Accessibility OK, installing flagsChanged monitor")
        }

        let handler: (NSEvent) -> Void = { [weak self] event in
            guard let self = self else { return }
            let isDown = event.modifierFlags.contains(.function)
            if isDown && !self.fnPreviouslyDown {
                print("Fn pressed → toggling recording")
                DispatchQueue.main.async { self.onToggle() }
            }
            self.fnPreviouslyDown = isDown
        }
        fnMonitorGlobal = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: handler)
        fnMonitorLocal = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { event in
            handler(event)
            return event
        }
        if fnMonitorGlobal == nil {
            FileHandle.standardError.write(Data("Fn hotkey: addGlobalMonitorForEvents returned nil\n".utf8))
        }
        return fnMonitorGlobal != nil
    }

    // MARK: - Carbon path (function keys + modifier combos)

    private func registerCarbonHotKey(spec: String) -> Bool {
        let parts = spec.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
        guard !parts.isEmpty else { return false }

        var modifiers: UInt32 = 0
        var keyName: String?
        for p in parts {
            switch p.lowercased() {
            case "meta", "cmd", "command": modifiers |= UInt32(cmdKey)
            case "control", "ctrl":        modifiers |= UInt32(controlKey)
            case "alt", "option":          modifiers |= UInt32(optionKey)
            case "shift":                  modifiers |= UInt32(shiftKey)
            default:                       keyName = p
            }
        }
        guard let key = keyName, let keyCode = Self.virtualKeyCode(for: key) else { return false }

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let handler: EventHandlerUPP = { _, event, _ -> OSStatus in
            var hotKeyID = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hotKeyID
            )
            guard status == noErr, hotKeyID.id == 1 else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { HotkeyManager._shared?.onToggle() }
            return noErr
        }

        HotkeyManager._shared = self
        InstallEventHandler(GetApplicationEventTarget(), handler, 1, &eventType, nil, &eventHandler)

        let hotKeyID = EventHotKeyID(signature: OSType(0x4356_4F58), id: 1) // "CVOX"
        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        return status == noErr
    }

    func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if let ref = eventHandler {
            RemoveEventHandler(ref)
            eventHandler = nil
        }
        if let m = fnMonitorGlobal {
            NSEvent.removeMonitor(m)
            fnMonitorGlobal = nil
        }
        if let m = fnMonitorLocal {
            NSEvent.removeMonitor(m)
            fnMonitorLocal = nil
        }
        fnPreviouslyDown = false
        HotkeyManager._shared = nil
    }

    deinit { unregister() }

    private static var _shared: HotkeyManager?

    /// Map a human key name (e.g. "F5", "V", "Space") to a macOS virtual key code.
    private static func virtualKeyCode(for name: String) -> UInt32? {
        let upper = name.uppercased()
        // Function keys
        let fnKeys: [String: Int] = [
            "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4,
            "F5": kVK_F5, "F6": kVK_F6, "F7": kVK_F7, "F8": kVK_F8,
            "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
            "F13": kVK_F13, "F14": kVK_F14, "F15": kVK_F15, "F16": kVK_F16,
            "F17": kVK_F17, "F18": kVK_F18, "F19": kVK_F19,
        ]
        if let code = fnKeys[upper] { return UInt32(code) }

        // Named keys
        let named: [String: Int] = [
            "SPACE": kVK_Space, " ": kVK_Space,
            "RETURN": kVK_Return, "ENTER": kVK_Return,
            "TAB": kVK_Tab, "ESCAPE": kVK_Escape, "ESC": kVK_Escape,
            "DELETE": kVK_Delete, "BACKSPACE": kVK_Delete,
            "LEFT": kVK_LeftArrow, "RIGHT": kVK_RightArrow,
            "UP": kVK_UpArrow, "DOWN": kVK_DownArrow,
        ]
        if let code = named[upper] { return UInt32(code) }

        // Single letters/digits
        if upper.count == 1, let ch = upper.first {
            let letters: [Character: Int] = [
                "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D,
                "E": kVK_ANSI_E, "F": kVK_ANSI_F, "G": kVK_ANSI_G, "H": kVK_ANSI_H,
                "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L,
                "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O, "P": kVK_ANSI_P,
                "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T,
                "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X,
                "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z,
                "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
                "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7,
                "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            ]
            if let code = letters[ch] { return UInt32(code) }
        }
        return nil
    }
}
