import Cocoa

/// Menu bar status item with state indicator and settings.
final class StatusItem {
    private let item: NSStatusItem
    private var stateMenuItem: NSMenuItem!
    private var toggleMenuItem: NSMenuItem!

    enum State: Equatable {
        case idle
        case recording
        case transcribing
        case gatewayDown
        case error(String)
        case permissionsNeeded

        var icon: String {
            switch self {
            case .idle: return "mic"
            case .recording: return "mic.fill"
            case .transcribing: return "waveform"
            case .gatewayDown: return "mic.slash"
            case .error: return "exclamationmark.triangle"
            case .permissionsNeeded: return "lock.shield"
            }
        }

        var label: String {
            switch self {
            case .idle: return "Ready"
            case .recording: return "Recording…"
            case .transcribing: return "Transcribing…"
            case .gatewayDown: return "Gateway offline"
            case .error(let msg): return "Error: \(msg)"
            case .permissionsNeeded: return "Permissions needed"
            }
        }
    }

    var onToggle: (() -> Void)?
    var onSettings: (() -> Void)?
    var onQuit: (() -> Void)?

    init() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setupMenu()
        updateState(.idle)
    }

    func updateState(_ state: State) {
        if let button = item.button {
            let config = NSImage.SymbolConfiguration(pointSize: 16, weight: .medium)
            button.image = NSImage(systemSymbolName: state.icon, accessibilityDescription: "Codey Voice")?
                .withSymbolConfiguration(config)
            if case .recording = state {
                button.appearsDisabled = false
            }
        }
        stateMenuItem.title = state.label
        toggleMenuItem.title = (state == .recording) ? "Stop Recording (F5)" : "Start Recording (F5)"
    }

    private func setupMenu() {
        let menu = NSMenu()

        stateMenuItem = NSMenuItem(title: "Ready", action: nil, keyEquivalent: "")
        stateMenuItem.isEnabled = false
        menu.addItem(stateMenuItem)

        menu.addItem(.separator())

        toggleMenuItem = NSMenuItem(title: "Start Recording (F5)", action: #selector(toggleAction), keyEquivalent: "")
        toggleMenuItem.target = self
        menu.addItem(toggleMenuItem)

        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(settingsAction), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit Codey Voice", action: #selector(quitAction), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
    }

    @objc private func toggleAction() { onToggle?() }
    @objc private func settingsAction() { onSettings?() }
    @objc private func quitAction() { onQuit?() }

    // MARK: - Permission prompt

    func showPermissionAlert(missing: [String]) {
        let alert = NSAlert()
        alert.messageText = "Permissions Required"
        alert.informativeText = "Codey Voice needs the following permissions:\n\n" +
            missing.map { "• \($0)" }.joined(separator: "\n") +
            "\n\nGrant these in System Settings → Privacy & Security."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Later")

        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!)
        }
    }
}
