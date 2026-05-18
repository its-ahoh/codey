import Foundation

/// Headless replacement for the former NSStatusBar UI. The helper is now a
/// sibling binary inside Codey.app (no menu bar icon of its own); state is
/// reported to the parent process via stdout / the gateway HTTP endpoint
/// instead of an in-helper Cocoa UI. NSAlert / NSStatusItem need a real .app
/// bundle to work, and we deliberately ship without one so TCC attributes
/// microphone + Accessibility prompts to Codey.app.
final class StatusItem {
    enum State: Equatable {
        case idle
        case recording
        case transcribing
        case gatewayDown
        case error(String)
        case permissionsNeeded

        var label: String {
            switch self {
            case .idle: return "idle"
            case .recording: return "recording"
            case .transcribing: return "transcribing"
            case .gatewayDown: return "gateway-down"
            case .error(let msg): return "error: \(msg)"
            case .permissionsNeeded: return "permissions-needed"
            }
        }
    }

    var onToggle: (() -> Void)?
    var onSettings: (() -> Void)?
    var onQuit: (() -> Void)?

    init() {}

    func updateState(_ state: State) {
        print("state: \(state.label)")
    }

    /// Surface missing permissions through stdout so the Electron main process
    /// can render the prompt in its own UI. We do not call NSAlert here — it
    /// requires an .app bundle and crashes when invoked from a sibling binary.
    func showPermissionAlert(missing: [String]) {
        print("permissions-needed: \(missing.joined(separator: ","))")
    }
}
