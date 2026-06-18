import AppKit
import Foundation
import SwiftUI

enum OnboardingPhase {
    case idle
    case creatingAgent
    case openingCodex
    case waitingForPrompt
    case foundChat
    case configuringConnectors
    case refreshingCodexTools
    case ready
    case refreshFailed
    case failed
}

@MainActor
final class WakefieldModel: ObservableObject {
    @Published var snapshot: MenuSnapshot?
    @Published var duties = DutiesDocument(duties: [], wakeups: [])
    @Published var threads: [CodexThread] = []
    @Published var wizards: [ConnectorWizard] = []
    @Published var agentDetails: AgentConfigStatus?
    @Published var controlTab: ControlTab = .agent
    @Published var busy = false
    @Published var lastMessage = ""
    @Published var lastError = ""
    @Published var onboardingPhase: OnboardingPhase = .idle
    @Published var onboardingOpenedCodex = false
    @Published var onboardingMcpRefreshFailed = false
    @Published var onboardingWatchingBootstrap = false
    @Published var onboardingReadyToUse = false
    @Published var onboardingPendingConnectorCount = 0
    @Published var showingOnboarding = false

    private var timer: Timer?
    private var controlWindow: NSWindow?
    private var controlWindowDelegate: WindowDelegate?
    private var openedFirstRun = false
    private var pendingOnboardingConnectors: [OnboardingConnectorDraft] = []
    private var onboardingShouldOpenConnectors = false

    var menuBarSymbol: String {
        guard let snapshot else { return "waveform.path.ecg" }
        if busy { return "hourglass" }
        if !snapshot.ready { return "exclamationmark.triangle" }
        if snapshot.service.externalDispatch?.pending ?? 0 > 0 { return "tray.full" }
        return snapshot.service.enabled ? "waveform.path.ecg.rectangle" : "pause.circle"
    }

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { await self?.refreshAll() }
        }
        Task { await refreshAll() }
        if ProcessInfo.processInfo.environment["WAKEFIELD_MENUBAR_OPEN_CONTROL"] == "1" {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 500_000_000)
                openControlWindow()
            }
        }
    }

    func refreshAll() async {
        do {
            async let snapshotResult: MenuSnapshot = WakefieldCLI.json(["menu", "snapshot"])
            async let dutiesResult: DutiesDocument = WakefieldCLI.json(["duties", "list"])
            async let threadsResult: ThreadsResponse = WakefieldCLI.json(["threads", "list", "--limit", "12"])
            async let wizardsResult: WizardsResponse = WakefieldCLI.json(["managed-connectors", "wizards"])

            snapshot = try await snapshotResult
            duties = try await dutiesResult
            threads = try await threadsResult.threads
            wizards = try await wizardsResult.wizards
            agentDetails = try? await WakefieldCLI.json(["agent", "status"])
            if !onboardingMcpRefreshFailed && onboardingPhase != .refreshFailed {
                lastError = ""
            }
            reconcileOnboardingWithSnapshot()
            if !openedFirstRun, snapshot?.agent == nil {
                openedFirstRun = true
                showingOnboarding = true
                openControlWindow()
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func openControlWindow(tab: ControlTab = .agent) {
        if let snapshot, snapshot.agent == nil {
            showingOnboarding = true
        }
        controlTab = tab
        if let controlWindow {
            NSApp.setActivationPolicy(.regular)
            controlWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        NSApp.setActivationPolicy(.regular)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 580),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Wakefield"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ControlWindow(model: self))
        let delegate = WindowDelegate { [weak self] in
            self?.controlWindow = nil
            self?.controlWindowDelegate = nil
            NSApp.setActivationPolicy(.accessory)
        }
        controlWindowDelegate = delegate
        window.delegate = delegate
        controlWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func openMainControl(tab: ControlTab = .agent) {
        showingOnboarding = false
        controlTab = tab
        openControlWindow(tab: tab)
    }

    func runServiceOnce() {
        perform("Running Wakefield once", args: ["service", "run-once"], timeout: 180)
    }

    func setRuntimeEnabled(_ enabled: Bool) {
        Task {
            await performSequence(
                enabled ? "Starting assistant" : "Stopping assistant",
                commands: enabled
                    ? [
                        ["service", "configure", "--enable"],
                        ["service", "launch-agent", "install", "--load"]
                    ]
                    : [
                        ["service", "launch-agent", "unload"],
                        ["service", "configure", "--disable"]
                    ],
                timeout: 90
            )
        }
    }

    func saveAgent(name: String, soul: String, ownerName: String? = nil) {
        let command = agentDetails?.profile == nil
            ? ["init", "--name", name, "--soul", soul]
            : ["agent", "configure", "--name", name, "--soul", soul]
        var args = command
        if let ownerName = trimmedNonEmpty(ownerName) {
            args += ["--owner-name", ownerName]
        }
        perform(
            agentDetails?.profile == nil ? "Creating agent" : "Saving agent",
            args: args,
            timeout: 90
        )
    }

    func finishOnboarding(name: String, ownerName: String, soul: String, connectors: [OnboardingConnectorDraft]) {
        Task {
            showingOnboarding = true
            onboardingOpenedCodex = false
            onboardingMcpRefreshFailed = false
            onboardingWatchingBootstrap = false
            onboardingReadyToUse = false
            onboardingPhase = .creatingAgent
            pendingOnboardingConnectors = connectors.filter { $0.enabled }
            onboardingPendingConnectorCount = pendingOnboardingConnectors.count
            onboardingShouldOpenConnectors = !pendingOnboardingConnectors.isEmpty
            var setup = [
                "setup", "run",
                "--new-agent",
                "--create-agent-home",
                "--name", name,
                "--soul", soul,
                "--enable-service",
                "--enable-dispatch",
                "--install-launch-agent",
                "--load-launch-agent",
                "--allow-needs-thread",
                "--yes"
            ]
            if let owner = trimmedNonEmpty(ownerName) {
                setup += ["--owner-name", owner]
            }
            await performSequence("Creating \(name)", commands: [setup], timeout: 180)
            guard lastError.isEmpty else {
                onboardingPhase = .failed
                return
            }
            onboardingPhase = .openingCodex
            lastMessage = "Opening Codex"
            let opened = await WakefieldCLI.run(["agent", "open-new-thread"], timeout: 60)
            if opened.ok {
                onboardingOpenedCodex = true
                onboardingPhase = .waitingForPrompt
                lastMessage = "Codex is open with \(name)'s first prompt"
                await refreshAll()
                await watchForBootstrapThread()
            } else {
                await refreshAll()
                onboardingPhase = .failed
                lastError = opened.trimmedOutput
                lastMessage = "Opening Codex failed"
            }
        }
    }

    func continueOnboardingAfterBootstrap() {
        Task {
            await watchForBootstrapThread()
        }
    }

    func retryOnboardingMcpRefresh() {
        Task {
            await refreshOnboardingMcp()
        }
    }

    func pauseAll() {
        Task {
            var commands = (snapshot?.managedConnectors ?? []).map {
                ["managed-connectors", "launch-agent", "unload", $0.id]
            }
            commands.append(["service", "launch-agent", "unload"])
            commands.append(["service", "configure", "--disable"])
            await performSequence("Pausing Wakefield", commands: commands, timeout: 90)
        }
    }

    func setConnector(_ connector: ManagedConnector, running: Bool) {
        Task {
            await performSequence(
                running ? "Starting \(connector.displayName)" : "Stopping \(connector.displayName)",
                commands: running
                    ? [
                        ["managed-connectors", "configure", connector.id, "--adapter", connector.adapter, "--enable"],
                        ["managed-connectors", "launch-agent", "install", connector.id, "--load"]
                    ]
                    : [
                        ["managed-connectors", "launch-agent", "unload", connector.id],
                        ["managed-connectors", "configure", connector.id, "--disable"]
                    ],
                timeout: 90
            )
        }
    }

    func setupConnector(_ wizard: ConnectorWizard, values: [String: String]) {
        let alias = wizard.adapter == "imessage-spectrum" ? "imessage" : "discord"
        let envFile = values["envFile"].flatMap(trimmedNonEmpty) ?? "~/.wakefield.env"
        var args = [
            "setup", "connector", alias,
            "--envFile", envFile,
            "--overwrite",
            "--yes"
        ]

        func addSet(_ key: String, _ value: String?) {
            guard let value = trimmedNonEmpty(value) else { return }
            args += ["--set", "\(key)=\(value)"]
        }

        func addSecret(_ key: String, _ value: String?) {
            guard let value = trimmedNonEmpty(value) else { return }
            guard !isWakefieldConfiguredCredentialMask(value) else { return }
            args += ["--secret", "\(key)=\(value)"]
        }

        if wizard.adapter == "imessage-spectrum" {
            let projectIdEnv = values["projectIdEnv"].flatMap(trimmedNonEmpty) ?? "PHOTON_PROJECT_ID"
            let projectSecretEnv = values["projectSecretEnv"].flatMap(trimmedNonEmpty) ?? "PHOTON_SECRET_KEY"
            addSet("projectIdEnv", projectIdEnv)
            addSet("projectSecretEnv", projectSecretEnv)
            addSecret(projectIdEnv, values["projectIdValue"])
            addSecret(projectSecretEnv, values["projectSecretValue"])
            addSet("allowedSpaceIds", values["allowedSpaceIds"])
            addSet("allowGroupChats", values["allowGroupChats"])
        } else {
            let tokenEnv = values["tokenEnv"].flatMap(trimmedNonEmpty) ?? "DISCORD_BOT_TOKEN"
            addSet("tokenEnv", tokenEnv)
            addSecret(tokenEnv, values["tokenValue"])
            addSet("allowedChannelIds", values["allowedChannelIds"])
            addSet("allowedDmUserIds", values["allowedDmUserIds"])
            addSet("allowedGuildIds", values["allowedGuildIds"])
            addSet("commandPrefix", values["commandPrefix"])
        }

        perform("Configuring \(friendlyConnectorName(wizard))", args: args, timeout: 120)
    }

    func selectThread(_ thread: CodexThread) {
        var args = ["select-thread", "--thread-id", thread.threadId]
        if let cwd = thread.cwd, !cwd.isEmpty {
            args += ["--cwd", cwd]
        }
        perform("Selecting \(thread.displayName)", args: args)
    }

    func saveWakeup(_ draft: WakeupDraft) {
        var args = [
            "wakeups", "configure", draft.id,
            "--label", draft.label,
            "--dispatch-mode", draft.dispatchMode
        ]
        args.append(draft.enabled ? "--enable" : "--disable")
        for time in draft.times {
            args += ["--time", time]
        }
        for duty in draft.dutyIds {
            args += ["--duty", duty]
        }
        perform("Saving \(draft.label)", args: args)
    }

    func deleteWakeup(_ wakeup: Wakeup) {
        perform("Deleting \(wakeup.label)", args: ["wakeups", "delete", wakeup.id])
    }

    func setWakeup(_ wakeup: Wakeup, enabled: Bool) {
        perform(
            enabled ? "Turning on \(wakeup.label)" : "Turning off \(wakeup.label)",
            args: ["wakeups", "configure", wakeup.id, enabled ? "--enable" : "--disable"]
        )
    }

    func saveDuty(_ draft: DutyDraft) {
        var args = [
            "duties", "configure", draft.id,
            "--label", draft.label
        ]
        args.append(draft.enabled ? "--enable" : "--disable")
        for skill in draft.skills {
            args += ["--skill", skill]
        }
        if let prompt = trimmedNonEmpty(draft.prompt) {
            args += ["--prompt", prompt]
        }
        perform("Saving \(draft.label)", args: args)
    }

    func deleteDuty(_ duty: DutyDefinition) {
        perform("Deleting \(duty.label)", args: ["duties", "delete", duty.id, "--remove-references"])
    }

    func saveConnectorPackage(_ wizard: ConnectorWizard, values: [String: String]) {
        var args = [
            "managed-connectors", "configure", wizard.connectorId,
            "--adapter", wizard.adapter,
            "--enable"
        ]
        for field in wizard.fields {
            if let value = values[field.id], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                args += ["--set", "\(field.id)=\(value)"]
            }
        }
        perform("Saving \(friendlyConnectorName(wizard))", args: args)
    }

    func writeConnectorConfig(_ wizard: ConnectorWizard, values: [String: String]) {
        var args = ["managed-connectors", "init-config", wizard.connectorId, "--overwrite"]
        for field in wizard.setupFields {
            if let value = values[field.id], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                args += ["--set", "\(field.id)=\(value)"]
            }
        }
        perform("Writing \(friendlyConnectorName(wizard)) config", args: args, timeout: 90)
    }

    func installConnectorTools(_ wizard: ConnectorWizard) {
        perform(
            "Installing \(friendlyConnectorName(wizard)) tools",
            args: ["managed-connectors", "mcp", "install", wizard.connectorId],
            timeout: 90
        )
    }

    func startConnector(_ wizard: ConnectorWizard) {
        perform(
            "Starting \(friendlyConnectorName(wizard))",
            args: ["managed-connectors", "launch-agent", "install", wizard.connectorId, "--load"],
            timeout: 90
        )
    }

    func runConnectorCheck(_ connector: ManagedConnector) {
        perform(
            "Checking \(connector.displayName)",
            args: ["managed-connectors", "test", connector.id, "--kind", "status"],
            timeout: 90
        )
    }

    private func completePendingOnboardingConnectors() async {
        let drafts = pendingOnboardingConnectors
        guard !drafts.isEmpty else { return }
        onboardingPhase = .configuringConnectors
        let commands = drafts.map { onboardingConnectorSetupCommand($0) }
        await performSequence("Configuring selected connectors", commands: commands, timeout: 180)
        if lastError.isEmpty {
            pendingOnboardingConnectors = []
            onboardingPendingConnectorCount = 0
        } else {
            onboardingPhase = .failed
        }
    }

    private func onboardingConnectorSetupCommand(_ draft: OnboardingConnectorDraft) -> [String] {
        var args = [
            "setup", "connector", draft.id,
            "--envFile", "~/.wakefield.env",
            "--overwrite",
            "--yes"
        ]

        func addSet(_ key: String, _ value: String?) {
            guard let value = trimmedNonEmpty(value) else { return }
            args += ["--set", "\(key)=\(value)"]
        }

        func addSecret(_ key: String, _ value: String?) {
            guard let value = trimmedNonEmpty(value) else { return }
            args += ["--secret", "\(key)=\(value)"]
        }

        switch draft.id {
        case "imessage":
            let projectIdEnv = trimmedNonEmpty(draft.values["projectIdEnv"]) ?? "PHOTON_PROJECT_ID"
            let projectSecretEnv = trimmedNonEmpty(draft.values["projectSecretEnv"]) ?? "PHOTON_SECRET_KEY"
            addSet("projectIdEnv", projectIdEnv)
            addSet("projectSecretEnv", projectSecretEnv)
            addSecret(projectIdEnv, draft.values["projectIdValue"])
            addSecret(projectSecretEnv, draft.values["projectSecretValue"])
            addSet("allowedSpaceIds", draft.values["allowedSpaceIds"])
            addSet("allowGroupChats", draft.values["allowGroupChats"])
        case "discord":
            let tokenEnv = trimmedNonEmpty(draft.values["tokenEnv"]) ?? "DISCORD_BOT_TOKEN"
            addSet("tokenEnv", tokenEnv)
            addSecret(tokenEnv, draft.values["tokenValue"])
            addSet("allowedChannelIds", draft.values["allowedChannelIds"])
            addSet("allowedDmUserIds", draft.values["allowedDmUserIds"])
            addSet("allowedGuildIds", draft.values["allowedGuildIds"])
        case "email":
            let passwordEnv = trimmedNonEmpty(draft.values["passwordEnv"]) ?? "WAKEFIELD_EMAIL_PASSWORD"
            addSet("imapHost", draft.values["imapHost"])
            addSet("username", draft.values["username"])
            addSet("passwordEnv", passwordEnv)
            addSecret(passwordEnv, draft.values["passwordValue"])
            addSet("allowedSenders", draft.values["allowedSenders"])
            addSet("mailbox", draft.values["mailbox"])
            addSet("processedMailbox", draft.values["processedMailbox"])
            addSet("maxMessagesPerPoll", draft.values["maxMessagesPerPoll"])
        default:
            break
        }

        return args
    }

    private func watchForBootstrapThread() async {
        onboardingPhase = .waitingForPrompt
        onboardingWatchingBootstrap = true
        busy = true
        lastMessage = "Waiting for the Codex prompt to be sent"
        lastError = ""
        let detected = await waitForBootstrapThreadInPollingWindows()
        onboardingWatchingBootstrap = false
        guard detected.ok else {
            await refreshAll()
            busy = false
            onboardingPhase = .failed
            lastError = detected.trimmedOutput
            lastMessage = "Could not find the new Codex chat"
            return
        }
        busy = false
        onboardingOpenedCodex = false
        onboardingPhase = .foundChat
        lastMessage = "Wakefield found the new Codex chat"
        await refreshAll()

        if !pendingOnboardingConnectors.isEmpty {
            await completePendingOnboardingConnectors()
        }
        if lastError.isEmpty {
            await refreshOnboardingMcp()
        }
    }

    private func refreshOnboardingMcp() async {
        onboardingPhase = .refreshingCodexTools
        busy = true
        onboardingMcpRefreshFailed = false
        onboardingOpenedCodex = false
        onboardingWatchingBootstrap = false
        lastError = ""
        lastMessage = "Refreshing Codex tools"
        let reload = await WakefieldCLI.run([
            "mcp", "reload",
            "--timeout-ms", "60000",
            "--poll-ms", "1000",
            "--json"
        ], timeout: 90)
        busy = false
        if reload.ok {
            await refreshAll()
            onboardingPhase = .ready
            onboardingReadyToUse = true
            onboardingOpenedCodex = false
            lastMessage = "Codex refreshed MCP tools"
        } else {
            onboardingPhase = .refreshFailed
            onboardingMcpRefreshFailed = true
            lastError = reload.trimmedOutput
            lastMessage = "Codex tool refresh failed"
        }
    }

    private func waitForBootstrapThreadInPollingWindows() async -> CommandResult {
        let deadline = Date().addingTimeInterval(600)
        var lastResult = CommandResult(status: 1, output: "No Codex thread with the bootstrap prompt was found yet.")

        while Date() < deadline {
            if snapshotHasSelectedThread {
                return CommandResult(status: 0, output: "Wakefield found the selected Codex chat.")
            }

            let result = await WakefieldCLI.run([
                "agent", "wait-bootstrap-thread",
                "--timeout-ms", "5000",
                "--poll-ms", "1000",
                "--json"
            ], timeout: 8)
            if result.ok { return result }
            lastResult = result

            await refreshAll()
            if snapshotHasSelectedThread {
                return CommandResult(status: 0, output: "Wakefield found the selected Codex chat.")
            }
            if !isBootstrapWaitTimeout(result) {
                return result
            }
            lastMessage = "Still waiting for the Codex prompt"
        }

        return lastResult
    }

    private var snapshotHasSelectedThread: Bool {
        trimmedNonEmpty(snapshot?.agent?.threadId) != nil
            || trimmedNonEmpty(snapshot?.threads.selectedThreadId) != nil
    }

    private func isBootstrapWaitTimeout(_ result: CommandResult) -> Bool {
        result.status != 0 && result.output.contains("No Codex thread with the bootstrap prompt was found yet.")
    }

    private func reconcileOnboardingWithSnapshot() {
        guard snapshotHasSelectedThread else { return }
        guard onboardingOpenedCodex
            || onboardingWatchingBootstrap
            || onboardingPhase == .openingCodex
            || onboardingPhase == .waitingForPrompt
        else { return }

        onboardingOpenedCodex = false
        onboardingWatchingBootstrap = false
        onboardingPhase = .foundChat
        if lastMessage.isEmpty
            || lastMessage.localizedCaseInsensitiveContains("waiting")
            || lastMessage.localizedCaseInsensitiveContains("Codex is open") {
            lastMessage = "Wakefield found the new Codex chat"
        }
    }

    private func perform(_ label: String, args: [String], timeout: TimeInterval = 60) {
        Task {
            await performSequence(label, commands: [args], timeout: timeout)
        }
    }

    private func performSequence(_ label: String, commands: [[String]], timeout: TimeInterval) async {
        busy = true
        lastMessage = "\(label)..."
        lastError = ""
        for args in commands {
            let result = await WakefieldCLI.run(args, timeout: timeout)
            guard result.ok else {
                busy = false
                lastError = result.trimmedOutput
                lastMessage = "\(label) failed"
                await refreshAll()
                return
            }
        }
        busy = false
        lastMessage = "\(label) done"
        await refreshAll()
    }
}

private final class WindowDelegate: NSObject, NSWindowDelegate {
    private let onClose: () -> Void

    init(onClose: @escaping () -> Void) {
        self.onClose = onClose
    }

    func windowWillClose(_ notification: Notification) {
        onClose()
    }
}

func friendlyConnectorName(_ wizard: ConnectorWizard) -> String {
    if wizard.adapter == "discord-codex" { return "Discord" }
    if wizard.adapter == "imessage-spectrum" { return "iMessage" }
    return wizard.name
}

struct WakeupDraft: Equatable {
    var id: String
    var label: String
    var timesText: String
    var dutyIds: Set<String>
    var enabled: Bool
    var dispatchMode: String

    var times: [String] {
        timesText
            .split { $0 == "," || $0 == " " || $0 == "\n" || $0 == "\t" }
            .map(String.init)
            .filter { !$0.isEmpty }
    }

    init(wakeup: Wakeup?, suggestedIndex: Int = 1) {
        id = wakeup?.id ?? "new-wakeup-\(suggestedIndex)"
        label = wakeup?.label ?? "New Wakeup \(suggestedIndex)"
        timesText = (wakeup?.wakeTimes ?? ["09:00"]).joined(separator: ", ")
        dutyIds = Set(wakeup?.selectedDutyIds ?? [])
        enabled = wakeup?.enabled ?? true
        dispatchMode = wakeup?.dispatchMode ?? "ipc"
    }
}

struct DutyDraft: Equatable {
    var id: String
    var label: String
    var skillsText: String
    var prompt: String
    var enabled: Bool

    var skills: [String] {
        skillsText
            .split { $0 == "," || $0 == "\n" || $0 == "\t" }
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    init(duty: DutyDefinition?, suggestedIndex: Int = 1) {
        id = duty?.id ?? "new-duty-\(suggestedIndex)"
        label = duty?.label ?? "New Duty \(suggestedIndex)"
        skillsText = (duty?.skills ?? []).joined(separator: ", ")
        prompt = duty?.prompt ?? ""
        enabled = duty?.enabled ?? true
    }
}

func trimmedNonEmpty(_ value: String?) -> String? {
    let text = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
}
