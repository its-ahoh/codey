import Carbon.HIToolbox
import Foundation

/// Registers a global hotkey (F5 by default) via Carbon Event Manager.
/// Calls `onToggle` on each tap. Thread-safe via main queue dispatch.
final class HotkeyManager {
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    let onToggle: () -> Void

    init(onToggle: @escaping () -> Void) {
        self.onToggle = onToggle
    }

    func register() {
        // Install application event handler
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        let handler: EventHandlerUPP = { _, event, _ -> OSStatus in
            // Retrieve the hotkey ID from the event to verify it's ours
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

            DispatchQueue.main.async {
                HotkeyManager._shared?.onToggle()
            }
            return noErr
        }

        // Keep a static reference so the C callback can reach the instance
        HotkeyManager._shared = self

        InstallApplicationEventHandler(
            handler,
            1,
            &eventType,
            nil,
            &eventHandler
        )

        // Register F5 (key code 96)
        var hotKeyID = EventHotKeyID(signature: OSType(0x4356_4F58), id: 1) // "CVOX"
        RegisterEventHotKey(
            UInt32(kVK_F5),
            0, // no modifiers
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
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
        HotkeyManager._shared = nil
    }

    deinit {
        unregister()
    }

    /// Static reference for the C callback closure.
    private static var _shared: HotkeyManager?
}
