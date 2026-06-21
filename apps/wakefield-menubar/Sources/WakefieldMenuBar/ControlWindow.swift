import AppKit
import SwiftUI

struct ControlWindow: View {
    @ObservedObject var model: WakefieldModel

    var body: some View {
        Group {
            if model.showingOnboarding {
                SetupPane(model: model)
            } else {
                VStack(spacing: 0) {
                    ControlHeader(model: model)
                    Divider()
                    HStack(spacing: 0) {
                        sidebar
                        Divider()
                        content
                    }
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { Task { await model.refreshAll() } }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(ControlTab.allCases) { item in
                Button {
                    model.controlTab = item
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: item.symbol)
                            .frame(width: 18)
                        Text(item.title)
                        Spacer()
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(model.controlTab == item ? Color.accentColor.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(12)
        .frame(width: 168)
    }

    @ViewBuilder
    private var content: some View {
        switch model.controlTab {
        case .agent:
            AgentPane(model: model)
        case .connectors:
            ConnectorsPane(model: model)
        case .wakeups:
            WakeupsPane(model: model)
        case .duties:
            DutiesPane(model: model)
        }
    }
}

private struct ControlHeader: View {
    @ObservedObject var model: WakefieldModel

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: model.menuBarSymbol)
                .font(.title2)
                .foregroundStyle(model.assistantRunning ? .green : .secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.snapshot?.agentName ?? "Wakefield")
                    .font(.title3.weight(.semibold))
                Text(model.assistantRunning ? "Assistant is on" : "Assistant is off")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Button {
                model.setRuntimeEnabled(!model.assistantRunning)
            } label: {
                Label(model.assistantRunning ? "Turn Off" : "Turn On",
                      systemImage: model.assistantRunning ? "power.circle.fill" : "power.circle")
            }
            .disabled(model.busy)
        }
        .padding(16)
    }
}

enum ControlTab: String, CaseIterable, Identifiable {
    case agent
    case connectors
    case wakeups
    case duties

    var id: String { rawValue }

    var title: String {
        switch self {
        case .agent: return "Agent"
        case .connectors: return "Connectors"
        case .wakeups: return "Wakeups"
        case .duties: return "Duties"
        }
    }

    var symbol: String {
        switch self {
        case .agent: return "sparkles"
        case .connectors: return "point.3.connected.trianglepath.dotted"
        case .wakeups: return "alarm"
        case .duties: return "checklist"
        }
    }
}

private struct SetupPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var step = 0
    @State private var name = "Mira"
    @State private var ownerName = NSFullUserName()
    @State private var selectedPreset = wakefieldSoulPresets[0].id
    @State private var soul = wakefieldSoulPresets[0].text
    @State private var customSoul = wakefieldSoulPresets[0].text
    @State private var connectorDrafts = OnboardingConnectorDraft.defaults
    @State private var onboardingStarted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                SetupStepPill(index: 0, title: "Name", selected: step == 0, done: step > 0)
                SetupStepPill(index: 1, title: "Connect", selected: step == 1, done: step > 1)
                SetupStepPill(index: 2, title: "Codex", selected: step == 2, done: step > 2)
                SetupStepPill(index: 3, title: "Use", selected: step == 3, done: false)
            }
            .padding(.horizontal, 22)
            .padding(.top, 20)
            .padding(.bottom, 8)

            Divider()

            Group {
                switch step {
                case 0:
                    identityStep
                case 1:
                    connectorsStep
                case 2:
                    codexStep
                default:
                    useStep
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var identityStep: some View {
        FormPane {
            Text("Create Your Assistant")
                .font(.title2.weight(.semibold))
            HStack(spacing: 12) {
                LabeledControl("Assistant name") {
                    TextField("Mira", text: $name)
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Your name") {
                    TextField("Sam", text: $ownerName)
                        .textFieldStyle(.roundedBorder)
                }
            }
            LabeledControl("Soul style") {
                Picker("", selection: $selectedPreset) {
                    ForEach(wakefieldSoulPresets) { preset in
                        Text(preset.label).tag(preset.id)
                    }
                    Text("Custom").tag("custom")
                }
                .pickerStyle(.segmented)
                .onChange(of: selectedPreset) { oldValue, value in
                    if oldValue == "custom" { customSoul = soul }
                    if value == "custom" {
                        soul = customSoul
                        return
                    }
                    guard let preset = wakefieldSoulPresets.first(where: { $0.id == value }) else { return }
                    soul = preset.text
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Soul")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $soul)
                    .frame(minHeight: 110, maxHeight: 150)
                    .padding(6)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
                    .onChange(of: soul) { _, value in
                        let presetId = wakefieldPresetId(for: value)
                        if presetId == "custom" { customSoul = value }
                        if selectedPreset != presetId { selectedPreset = presetId }
                    }
            }
            HStack {
                Spacer()
                Button {
                    step = 1
                } label: {
                    Label("Continue", systemImage: "arrow.right.circle")
                }
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var connectorsStep: some View {
        FormPane {
            Text("Connect Channels")
                .font(.title2.weight(.semibold))
            Text("Pick the channels this agent should answer on now.")
                .foregroundStyle(.secondary)

            VStack(spacing: 10) {
                ForEach($connectorDrafts) { $draft in
                    OnboardingConnectorCard(draft: $draft)
                }
            }

            if let issue = connectorIssue {
                Label(issue, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }

            HStack {
                Button("Back") { step = 0 }
                Spacer()
                Button {
                    step = 2
                } label: {
                    Label("Continue", systemImage: "arrow.right.circle")
                }
                .disabled(!connectorsReady)
            }
        }
    }

    @ViewBuilder
    private var codexStep: some View {
        if onboardingStarted || model.onboardingPhase != .idle || model.onboardingOpenedCodex || model.onboardingWatchingBootstrap || model.onboardingMcpRefreshFailed || model.onboardingReadyToUse {
            codexProgressStep
        } else {
            launchStep
        }
    }

    private var launchStep: some View {
        FormPane {
            Text("Wake \(name)")
                .font(.title2.weight(.semibold))
            Text("Wakefield will create the local agent folder, install Codex hooks and skills, start the background service, then open Codex with the first prompt ready to send.")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Label("Agent folder under ~/Wakefield Agents", systemImage: "folder")
                Label("Private memory under .wakefield/memories", systemImage: "brain.head.profile")
                if selectedConnectorNames.isEmpty {
                    Label("No channels selected yet", systemImage: "point.3.connected.trianglepath.dotted")
                } else {
                    Label("\(selectedConnectorNames.joined(separator: ", ")) queued for setup", systemImage: "point.3.connected.trianglepath.dotted")
                }
                Label("Soul: \(selectedSoulLabel)", systemImage: "sparkles")
                Label("Codex opens with the bootstrap prompt filled in", systemImage: "bubble.left.and.text.bubble.right")
            }
            .foregroundStyle(.secondary)

            HStack {
                Button("Back") { step = 1 }
                Spacer()
                Button {
                    onboardingStarted = true
                    model.finishOnboarding(name: name, ownerName: ownerName, soul: soul, connectors: connectorDrafts)
                } label: {
                    Label("Finish Setup", systemImage: "checkmark.circle.fill")
                }
                .disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var codexProgressStep: some View {
        FormPane {
            Text(codexTitle)
                .font(.title2.weight(.semibold))
            if model.busy {
                ProgressView()
            }
            Text(codexCopy)
                .foregroundStyle(.secondary)
            if model.onboardingMcpRefreshFailed {
                HStack {
                    Button {
                        model.retryOnboardingMcpRefresh()
                    } label: {
                        Label("Try Again", systemImage: "arrow.triangle.2.circlepath.circle")
                    }
                    .disabled(model.busy)
                }
            } else if model.onboardingReadyToUse {
                HStack {
                    Button {
                        step = 3
                    } label: {
                        Label("Continue", systemImage: "arrow.right.circle")
                    }
                }
            } else if !model.lastError.isEmpty && model.onboardingOpenedCodex {
                HStack {
                    Button {
                        model.continueOnboardingAfterBootstrap()
                    } label: {
                        Label("Keep Watching", systemImage: "arrow.triangle.2.circlepath.circle")
                    }
                    .disabled(model.busy)
                }
            }
        }
    }

    private var useStep: some View {
        FormPane {
            Text("See \(name) In Action")
                .font(.title2.weight(.semibold))
            Text("Everything is set up. Try a first message from one of the channels Wakefield connected.")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 10) {
                if connectorDrafts.contains(where: { $0.id == "imessage" && $0.enabled }) {
                    imessageFirstUseCard
                }
                if connectorDrafts.contains(where: { $0.id == "discord" && $0.enabled }) {
                    discordFirstUseCard
                }
                if connectorDrafts.contains(where: { $0.id == "email" && $0.enabled }) {
                    FirstUseCard(
                        title: "Email",
                        symbolName: "envelope.fill",
                        text: "Send a short test email to the configured mailbox. Email is intake only unless your agent has another reply channel.",
                        actionTitle: nil,
                        actionURL: nil
                    )
                }
                if selectedConnectorNames.isEmpty {
                    FirstUseCard(
                        title: "Codex",
                        symbolName: "bubble.left.and.text.bubble.right",
                        text: "Continue the \(name) Codex chat directly whenever you want to shape the assistant.",
                        actionTitle: nil,
                        actionURL: nil
                    )
                }
            }

            HStack {
                Spacer()
                Button {
                    model.openMainControl(tab: selectedConnectorNames.isEmpty ? .agent : .connectors)
                } label: {
                    Label("Open Wakefield", systemImage: "slider.horizontal.3")
                }
            }
        }
    }

    private var imessageFirstUseCard: some View {
        let user = photonOwnerUser ?? photonFirstUser
        let message = "Hey \(name), I'm \(ownerDisplayName)."
        let url = photonRedirectURL(for: user, message: message)
        let detail = user?.assignedPhoneNumber.map { "Photon assigned \($0) for \(user?.phoneNumber ?? "this contact")." }
            ?? "Wakefield could not find a Photon shared-user mapping yet. Open the connector panel and run the iMessage check after Photon is reachable."
        return FirstUseCard(
            title: "iMessage",
            symbolName: "message.fill",
            text: "\(detail)\n\(message)",
            actionTitle: url == nil ? nil : "Message in iMessage",
            actionURL: url
        )
    }

    private var discordFirstUseCard: some View {
        let channelId = firstConfiguredDiscordChannelId
        let url = channelId.flatMap { URL(string: "discord://-/channels/@me/\($0)") }
            ?? channelId.flatMap { URL(string: "https://discord.com/channels/@me/\($0)") }
        let text = channelId == nil
            ? "Open Discord and message the bot or an allowed channel: \"Hey \(name), I'm \(ownerDisplayName).\""
            : "Open the configured Discord channel and send: \"Hey \(name), I'm \(ownerDisplayName).\""
        return FirstUseCard(
            title: "Discord",
            symbolName: "bubble.left.and.bubble.right.fill",
            text: text,
            actionTitle: url == nil ? nil : "Open Discord",
            actionURL: url
        )
    }

    private var codexTitle: String {
        if model.onboardingReadyToUse { return "Ready" }
        if model.onboardingMcpRefreshFailed { return "Refresh Needed" }
        if let message = trimmedNonEmpty(model.lastMessage) {
            return message.replacingOccurrences(of: "...", with: "")
        }
        switch model.onboardingPhase {
        case .creatingAgent:
            return "Creating Agent"
        case .openingCodex:
            return "Opening Codex"
        case .waitingForPrompt:
            return "Waiting For Prompt"
        case .foundChat:
            return "Found Chat"
        case .configuringConnectors:
            return "Configuring Connectors"
        case .refreshingCodexTools:
            return "Refreshing Codex Tools"
        case .ready:
            return "Ready"
        case .refreshFailed:
            return "Refresh Needed"
        case .failed:
            return "Needs Attention"
        case .idle:
            return "Finishing Setup"
        }
    }

    private var codexCopy: String {
        if model.onboardingMcpRefreshFailed {
            return "Wakefield found the Codex chat and finished setup, but Codex did not accept the tool refresh yet. Keep Codex open and try again."
        }
        if model.onboardingReadyToUse {
            if selectedConnectorNames.isEmpty {
                return "Wakefield found the new Codex chat and finished setup."
            }
            return "Wakefield found the new Codex chat and refreshed Codex's MCP tools. Continue to try the assistant in the channels you set up."
        }
        if !model.lastError.isEmpty {
            return model.lastError
        }
        switch model.onboardingPhase {
        case .creatingAgent:
            return "Wakefield is creating the local agent folder, installing skills and hooks, and starting the background service."
        case .openingCodex:
            return "Wakefield is opening Codex with the first prompt filled in."
        case .waitingForPrompt:
            return "Codex should be open with the first prompt filled in. Send that prompt in Codex. Wakefield is watching for it and will continue automatically."
        case .foundChat:
            if model.onboardingPendingConnectorCount == 0 {
                return "Wakefield found the Codex chat and is finishing the final checks."
            }
            return "Wakefield found the Codex chat and is about to configure the selected connectors."
        case .configuringConnectors:
            return "Wakefield is installing and starting the selected connectors for this agent."
        case .refreshingCodexTools:
            return "Wakefield is asking the live Codex app to reload its tools. This can take a minute while Codex reconnects; a first status check may time out and then recover."
        case .failed:
            return "Wakefield could not finish setup. Review the message here and try again."
        case .idle, .ready, .refreshFailed:
            return "Wakefield is creating the assistant and opening Codex."
        }
    }

    private var selectedConnectorNames: [String] {
        connectorDrafts.filter { $0.enabled }.map(\.displayName)
    }

    private var connectorsReady: Bool {
        connectorDrafts.allSatisfy(\.readyForOnboarding)
    }

    private var connectorIssue: String? {
        guard let draft = connectorDrafts.first(where: { !$0.readyForOnboarding }) else { return nil }
        return "\(draft.displayName) is missing required setup fields."
    }

    private var selectedSoulLabel: String {
        if let preset = wakefieldSoulPresets.first(where: { $0.id == wakefieldPresetId(for: soul) }) {
            return preset.label
        }
        return "Custom"
    }

    private var ownerDisplayName: String {
        trimmedNonEmpty(ownerName) ?? "your name"
    }

    private var imessageConnector: ManagedConnector? {
        model.snapshot?.managedConnectors.first(where: { $0.connectorId == "imessage" || $0.id == "imessage-spectrum" })
    }

    private var photonOwnerUser: PhotonProjectUser? {
        imessageConnector?.connectorConfig?.spectrum?.projectUsers?.users.first(where: { $0.projectOwner == true })
    }

    private var photonFirstUser: PhotonProjectUser? {
        imessageConnector?.connectorConfig?.spectrum?.projectUsers?.users.first
    }

    private var firstConfiguredDiscordChannelId: String? {
        let values = connectorDrafts.first(where: { $0.id == "discord" })?.values["allowedChannelIds"] ?? ""
        return values
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
    }

    private func photonRedirectURL(for user: PhotonProjectUser?, message: String) -> URL? {
        guard var components = URLComponents(string: user?.redirectUrl ?? "") else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "msg" }
        queryItems.append(URLQueryItem(name: "msg", value: message))
        components.percentEncodedQuery = wakefieldPercentEncodedQuery(queryItems)
        return components.url
    }
}

private let wakefieldQueryValueAllowed: CharacterSet = {
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: ":#[]@!$&'()*+,;=%")
    return allowed
}()

private func wakefieldPercentEncodedQuery(_ items: [URLQueryItem]) -> String {
    items.map { item in
        let name = wakefieldPercentEncodeQueryPart(item.name)
        guard let value = item.value else { return name }
        return "\(name)=\(wakefieldPercentEncodeQueryPart(value))"
    }
    .joined(separator: "&")
}

private func wakefieldPercentEncodeQueryPart(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: wakefieldQueryValueAllowed) ?? ""
}

private struct SetupStepPill: View {
    let index: Int
    let title: String
    let selected: Bool
    let done: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: done ? "checkmark.circle.fill" : "\(index + 1).circle")
            Text(title)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(selected ? .primary : .secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(selected ? Color.accentColor.opacity(0.14) : Color.clear, in: Capsule())
    }
}

private struct FirstUseCard: View {
    let title: String
    let symbolName: String
    let text: String
    let actionTitle: String?
    let actionURL: URL?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbolName)
                .frame(width: 24)
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(text)
                    .font(.title3.weight(.medium))
                    .textSelection(.enabled)
                if let actionTitle, let actionURL {
                    Button {
                        NSWorkspace.shared.open(actionURL)
                    } label: {
                        Label(actionTitle, systemImage: "arrow.up.forward.app")
                    }
                    .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct OnboardingConnectorCard: View {
    @Binding var draft: OnboardingConnectorDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: draft.symbolName)
                    .frame(width: 24)
                    .foregroundStyle(draft.enabled ? .blue : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(draft.displayName)
                        .font(.headline)
                    Text(draft.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Toggle("", isOn: $draft.enabled)
                    .toggleStyle(.switch)
            }

            if draft.enabled {
                OnboardingConnectorFields(draft: $draft)
                if !draft.missingRequiredFields.isEmpty {
                    Text("Missing required fields")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct OnboardingConnectorFields: View {
    @Binding var draft: OnboardingConnectorDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch draft.id {
            case "imessage":
                LabeledControl("Photon project ID") {
                    SecureField("project id", text: binding("projectIdValue"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Photon secret") {
                    SecureField("secret", text: binding("projectSecretValue"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Allowed spaces") {
                    TextField("space ids", text: binding("allowedSpaceIds"))
                        .textFieldStyle(.roundedBorder)
                }
                Toggle("Allow group chats", isOn: Binding(
                    get: { (draft.values["allowGroupChats"] ?? "false") == "true" },
                    set: { draft.values["allowGroupChats"] = $0 ? "true" : "false" }
                ))
            case "discord":
                LabeledControl("Discord bot token") {
                    SecureField("bot token", text: binding("tokenValue"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Allowed channels") {
                    TextField("channel ids", text: binding("allowedChannelIds"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Allowed DMs") {
                    TextField("user ids", text: binding("allowedDmUserIds"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Allowed servers") {
                    TextField("server ids", text: binding("allowedGuildIds"))
                        .textFieldStyle(.roundedBorder)
                }
            case "email":
                LabeledControl("IMAP host") {
                    TextField("imap.example.com", text: binding("imapHost"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Mailbox username") {
                    TextField("agent@example.com", text: binding("username"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Mailbox password") {
                    SecureField("password", text: binding("passwordValue"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Allowed senders") {
                    TextField("person@example.com, @example.com", text: binding("allowedSenders"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Mailbox") {
                    TextField("INBOX", text: binding("mailbox"))
                        .textFieldStyle(.roundedBorder)
                }
            default:
                EmptyView()
            }
        }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(
            get: { draft.values[key] ?? "" },
            set: { draft.values[key] = $0 }
        )
    }
}

private struct AgentPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var name = ""
    @State private var soul = ""
    @State private var customSoul = ""
    @State private var selectedPreset = wakefieldSoulPresets[0].id
    @State private var selectedThreadId = ""
    @State private var savedName = ""
    @State private var savedSoul = ""

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .center, spacing: 12) {
                    Text("Agent")
                        .font(.title3.weight(.semibold))
                    Spacer()
                }

                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .bottom, spacing: 14) {
                        LabeledControl("Name") {
                            TextField("Mira", text: $name)
                                .textFieldStyle(.roundedBorder)
                        }
                        .frame(maxWidth: 420)

                        LabeledControl("Codex chat") {
                            Picker("", selection: $selectedThreadId) {
                                if selectedThreadId.isEmpty {
                                    Text("No chat selected").tag("")
                                }
                                if !selectedThreadId.isEmpty && !recentThreads.contains(where: { $0.threadId == selectedThreadId }) {
                                    Text(selectedThreadName).tag(selectedThreadId)
                                }
                                ForEach(recentThreads) { thread in
                                    Text(threadMenuLabel(thread)).tag(thread.threadId)
                                }
                            }
                            .pickerStyle(.menu)
                            .onChange(of: selectedThreadId) { _, value in
                                selectThread(value)
                            }
                        }
                        .frame(maxWidth: 360)

                        Spacer(minLength: 0)
                    }

                    LabeledControl("Soul style") {
                        Picker("", selection: $selectedPreset) {
                            ForEach(wakefieldSoulPresets) { preset in
                                Text(preset.label).tag(preset.id)
                            }
                            Text("Custom").tag("custom")
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: selectedPreset) { oldValue, value in
                            if oldValue == "custom" { customSoul = soul }
                            if value == "custom" {
                                soul = customSoul
                                return
                            }
                            guard let preset = wakefieldSoulPresets.first(where: { $0.id == value }) else { return }
                            soul = preset.text
                        }
                    }
                    .frame(maxWidth: 620)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Soul")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextEditor(text: $soul)
                            .font(.body)
                            .frame(maxWidth: .infinity, minHeight: 260, maxHeight: .infinity)
                            .padding(6)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
                            .onChange(of: soul) { _, value in
                                let presetId = wakefieldPresetId(for: value)
                                if presetId == "custom" { customSoul = value }
                                if selectedPreset != presetId { selectedPreset = presetId }
                            }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(22)
            .padding(.bottom, agentDirty ? 54 : 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            BottomSaveAction(
                title: model.agentDetails?.profile == nil ? "Create Agent" : "Save Agent",
                systemImage: "checkmark.circle.fill",
                isVisible: agentDirty,
                isDisabled: model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ) {
                model.saveAgent(name: name, soul: soul)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear(perform: load)
        .onChange(of: model.agentDetails?.profile?.name) { _, _ in load() }
        .onChange(of: model.agentDetails?.soul) { _, _ in load() }
        .onChange(of: model.snapshot?.agent?.threadId) { _, _ in syncSelectedThread() }
        .onChange(of: model.threads) { _, _ in syncSelectedThread() }
    }

    private func load() {
        name = model.agentDetails?.profile?.name ?? model.snapshot?.agent?.name ?? ""
        let currentSoul = wakefieldEditableSoul(from: model.agentDetails?.soul ?? "")
        soul = currentSoul.isEmpty ? wakefieldSoulPresets[0].text : currentSoul
        customSoul = soul
        savedName = name
        savedSoul = soul
        selectedPreset = wakefieldPresetId(for: soul)
        syncSelectedThread()
    }

    private var agentDirty: Bool {
        name != savedName || soul != savedSoul
    }

    private func syncSelectedThread() {
        selectedThreadId = model.snapshot?.agent?.threadId ?? model.snapshot?.threads.selectedThreadId ?? ""
    }

    private var recentThreads: [CodexThread] {
        Array(model.threads.enumerated())
            .sorted { left, right in
                let leftDate = left.element.updatedAt.flatMap(parseWakefieldDate) ?? .distantPast
                let rightDate = right.element.updatedAt.flatMap(parseWakefieldDate) ?? .distantPast
                if leftDate != rightDate { return leftDate > rightDate }
                return left.offset < right.offset
            }
            .map(\.element)
    }

    private var selectedThreadName: String {
        guard !selectedThreadId.isEmpty else { return "No chat selected" }
        if let thread = recentThreads.first(where: { $0.threadId == selectedThreadId }) {
            return thread.displayName
        }
        return model.snapshot?.agent?.threadId == selectedThreadId ? "Selected Codex chat" : "Codex chat"
    }

    private func threadMenuLabel(_ thread: CodexThread) -> String {
        "\(thread.displayName) - \(thread.detail)"
    }

    private func selectThread(_ threadId: String) {
        guard !threadId.isEmpty else { return }
        let currentThreadId = model.snapshot?.agent?.threadId ?? model.snapshot?.threads.selectedThreadId
        guard threadId != currentThreadId else { return }
        guard let thread = recentThreads.first(where: { $0.threadId == threadId }) else { return }
        model.selectThread(thread)
    }
}

private struct SoulPreset: Identifiable {
    let id: String
    let label: String
    let text: String
}

private let wakefieldSoulPresets = [
    SoulPreset(
        id: "friendly",
        label: "Light Friendly",
        text: "Warm, lightly playful, practical, and easy to talk to. You make everyday help feel calm and human without becoming performative."
    ),
    SoulPreset(
        id: "gamer",
        label: "Nerdy Gamer",
        text: "Bright, game-literate, a little mischievous, and quest-minded. You can use playful adventure language when it fits, while still being useful and grounded."
    ),
    SoulPreset(
        id: "fantasy",
        label: "Quiet Fantasy",
        text: "Mysterious, gentle, and a little storybook. You speak with a soft sense of ritual and wonder while keeping actions clear and modern."
    ),
    SoulPreset(
        id: "operator",
        label: "Calm Operator",
        text: "Focused, reliable, concise, and quietly kind. You are excellent at reminders, scheduled checks, and practical follow-through."
    )
]

private func wakefieldPresetId(for soul: String) -> String {
    let editable = wakefieldEditableSoul(from: soul)
    return wakefieldSoulPresets.first(where: { $0.text == editable })?.id ?? "custom"
}

private func wakefieldEditableSoul(from text: String) -> String {
    let document = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let soulHeading = document.range(of: "## Soul") else { return document }
    let afterHeading = document[soulHeading.upperBound...]
    let sectionEnd = afterHeading.range(of: "\n## ")?.lowerBound ?? afterHeading.endIndex
    return afterHeading[..<sectionEnd].trimmingCharacters(in: .whitespacesAndNewlines)
}

private struct ConnectorsPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var selectedConnectorId: String?

    var body: some View {
        HStack(spacing: 0) {
            List(selection: $selectedConnectorId) {
                ForEach(model.snapshot?.managedConnectors ?? []) { connector in
                    ConnectorListRow(connector: connector)
                        .tag(connector.id)
                }
            }
            .frame(width: 245)
            Divider()
            connectorDetail
        }
        .onAppear {
            selectedConnectorId = selectedConnectorId ?? model.snapshot?.managedConnectors.first?.id
        }
    }

    @ViewBuilder
    private var connectorDetail: some View {
        if let connector = selectedConnector {
            ConnectorDetailPane(
                model: model,
                connector: connector,
                wizard: model.wizards.first(where: { $0.connectorId == connector.id })
            )
        } else {
            EmptyState(symbol: "point.3.connected.trianglepath.dotted", title: "No connectors")
        }
    }

    private var selectedConnector: ManagedConnector? {
        let connectors = model.snapshot?.managedConnectors ?? []
        return connectors.first(where: { $0.id == selectedConnectorId }) ?? connectors.first
    }
}

private struct ConnectorListRow: View {
    let connector: ManagedConnector

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: connector.symbolName)
                .foregroundStyle(connector.isDegraded ? .orange : connector.running && connector.ready ? .green : connector.ready ? .blue : .orange)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(connector.displayName)
                    .font(.headline)
                Text(connector.stateText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 5)
    }
}

private struct ConnectorDetailPane: View {
    @ObservedObject var model: WakefieldModel
    let connector: ManagedConnector
    let wizard: ConnectorWizard?
    @State private var values: [String: String] = [:]
    @State private var savedValues: [String: String] = [:]

    var body: some View {
        ActionFormPane(
            showsAction: connectorDirty,
            title: "Save & Start \(connector.displayName)",
            systemImage: "checkmark.circle.fill",
            disabled: model.busy
        ) {
            if let wizard {
                savedValues = values
                model.setupConnector(wizard, values: values)
            }
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label(connector.displayName, systemImage: connector.symbolName)
                        .font(.title3.weight(.semibold))
                        .lineLimit(1)
                        .layoutPriority(1)
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { connector.running },
                        set: { model.setConnector(connector, running: $0) }
                    ))
                    .toggleStyle(.switch)
                    .disabled(model.busy)
                }
                HStack(spacing: 10) {
                    StatusPill(text: connector.stateText, tint: connector.isDegraded ? .orange : connector.running && connector.ready ? .green : connector.ready ? .blue : .orange)
                    Button("Run Check") {
                        model.runConnectorCheck(connector)
                    }
                    .disabled(model.busy)
                    Spacer()
                }
            }

            if let wizard {
                ConnectorSetupFields(wizard: wizard, values: $values)
            } else {
                EmptyState(symbol: "wrench.and.screwdriver", title: "Setup unavailable")
            }
        }
        .onAppear {
            loadValues()
        }
        .onChange(of: wizard) { _, next in
            guard next != nil else { return }
            loadValues()
        }
        .onChange(of: connector.id) { _, _ in
            loadValues()
        }
    }

    private var connectorDirty: Bool {
        wizard != nil && values != savedValues
    }

    private func loadValues() {
        guard let wizard else {
            values = [:]
            savedValues = [:]
            return
        }
        let next = connectorValues(from: wizard)
        values = next
        savedValues = next
    }
}

private struct ConnectorSetupFields: View {
    let wizard: ConnectorWizard
    @Binding var values: [String: String]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if wizard.adapter == "imessage-spectrum" {
                LabeledControl("Photon project ID") {
                    MaskedCredentialField(
                        placeholder: "project id",
                        configured: isWakefieldConfiguredCredentialMask(values["projectIdValue"]),
                        text: binding("projectIdValue")
                    )
                }
                LabeledControl("Photon secret") {
                    MaskedCredentialField(
                        placeholder: "secret",
                        configured: isWakefieldConfiguredCredentialMask(values["projectSecretValue"]),
                        text: binding("projectSecretValue")
                    )
                }
                LabeledControl("Allowed spaces") {
                    TextField("space ids", text: binding("allowedSpaceIds"))
                        .textFieldStyle(.roundedBorder)
                }
                Toggle("Allow group chats", isOn: Binding(
                    get: { (values["allowGroupChats"] ?? "false") == "true" },
                    set: { values["allowGroupChats"] = $0 ? "true" : "false" }
                ))
            } else {
                LabeledControl("Discord bot token") {
                    MaskedCredentialField(
                        placeholder: "bot token",
                        configured: isWakefieldConfiguredCredentialMask(values["tokenValue"]),
                        text: binding("tokenValue")
                    )
                }
                LabeledControl("Allowed channels") {
                    TextField("channel ids", text: binding("allowedChannelIds"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Allowed DMs") {
                    TextField("user ids", text: binding("allowedDmUserIds"))
                        .textFieldStyle(.roundedBorder)
                }
                LabeledControl("Allowed servers") {
                    TextField("server ids", text: binding("allowedGuildIds"))
                        .textFieldStyle(.roundedBorder)
                }
            }
        }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(
            get: { values[key] ?? "" },
            set: { values[key] = $0 }
        )
    }
}

private struct MaskedCredentialField: View {
    let placeholder: String
    let configured: Bool
    @Binding var text: String
    @FocusState private var focused: Bool
    @State private var restoreMaskOnBlur = false

    var body: some View {
        SecureField(placeholder, text: $text)
            .textFieldStyle(.roundedBorder)
            .focused($focused)
            .onChange(of: focused) { _, isFocused in
                if isFocused, isWakefieldConfiguredCredentialMask(text) {
                    restoreMaskOnBlur = true
                    text = ""
                } else if !isFocused, (configured || restoreMaskOnBlur), text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    text = wakefieldConfiguredCredentialMask
                } else if !isFocused, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    restoreMaskOnBlur = false
                }
            }
    }
}

private struct WakeupsPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var selectedWakeupId: String?
    @State private var draft = WakeupDraft(wakeup: nil)
    @State private var savedDraft = WakeupDraft(wakeup: nil)
    @State private var isEditing = false

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                ZStack(alignment: .bottomLeading) {
                    List(selection: $selectedWakeupId) {
                        ForEach(model.duties.wakeups) { wakeup in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(wakeup.label)
                                        .font(.headline)
                                    Text(wakeup.wakeTimes.joined(separator: ", "))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Toggle("", isOn: Binding(
                                    get: { wakeup.enabled },
                                    set: { model.setWakeup(wakeup, enabled: $0) }
                                ))
                                .toggleStyle(.switch)
                            }
                            .padding(.vertical, 5)
                            .tag(wakeup.id)
                        }
                        ListPaneFooterSpacer()
                    }
                    ListPaneFooterAction(title: "New Wakeup", systemImage: "plus.circle", disabled: model.busy) {
                        newWakeup()
                    }
                }
            }
            .frame(width: 270)
            Divider()
            wakeupDetail
        }
        .onAppear {
            let wakeup = selectedWakeup ?? model.duties.wakeups.first
            selectedWakeupId = wakeup?.id
            resetDraft(wakeup: wakeup)
        }
        .onChange(of: selectedWakeupId) { _, _ in
            isEditing = false
            resetDraft(wakeup: selectedWakeup)
        }
        .onChange(of: model.duties.wakeups) { _, _ in
            if isEditing, selectedWakeupId == draft.id, selectedWakeup != nil {
                isEditing = false
                resetDraft(wakeup: selectedWakeup)
            } else if !isEditing, selectedWakeupId == nil {
                selectedWakeupId = model.duties.wakeups.first?.id
            }
        }
    }

    @ViewBuilder
    private var wakeupDetail: some View {
        if isEditing {
            WakeupEditor(
                model: model,
                selectedWakeup: selectedWakeup,
                draft: $draft,
                savedDraft: savedDraft,
                isNew: selectedWakeup == nil,
                saveAction: saveWakeup,
                cancelAction: cancelEdit,
                deleteAction: deleteWakeup
            )
        } else if let selectedWakeup {
            WakeupDetailPane(wakeup: selectedWakeup, duties: model.duties.duties) {
                resetDraft(wakeup: selectedWakeup)
                isEditing = true
            }
        } else {
            EmptyState(symbol: "alarm", title: "No wakeup selected")
        }
    }

    private var selectedWakeup: Wakeup? {
        model.duties.wakeups.first(where: { $0.id == selectedWakeupId })
    }

    private func newWakeup() {
        selectedWakeupId = nil
        draft = WakeupDraft(wakeup: nil, suggestedIndex: model.duties.wakeups.count + 1)
        savedDraft = draft
        isEditing = true
    }

    private func resetDraft(wakeup: Wakeup?) {
        draft = WakeupDraft(wakeup: wakeup, suggestedIndex: model.duties.wakeups.count + 1)
        savedDraft = draft
    }

    private func saveWakeup() {
        selectedWakeupId = draft.id
        savedDraft = draft
        model.saveWakeup(draft)
    }

    private func cancelEdit() {
        if let selectedWakeup {
            resetDraft(wakeup: selectedWakeup)
            isEditing = false
        } else {
            selectedWakeupId = model.duties.wakeups.first?.id
            resetDraft(wakeup: selectedWakeup)
            isEditing = false
        }
    }

    private func deleteWakeup() {
        guard let selectedWakeup else { return }
        model.deleteWakeup(selectedWakeup)
        selectedWakeupId = model.duties.wakeups.first(where: { $0.id != selectedWakeup.id })?.id
        isEditing = false
    }
}

private struct WakeupDetailPane: View {
    let wakeup: Wakeup
    let duties: [DutyDefinition]
    let editAction: () -> Void

    var body: some View {
        OverviewPane {
            OverviewHeader(
                kind: "Wakeup",
                title: wakeup.label,
                subtitle: wakeup.enabled ? "Scheduled dispatch into the selected Codex thread." : "Paused until this wakeup is turned back on.",
                symbolName: "alarm",
                editAction: editAction
            ) {
                OverviewBadge(
                    title: wakeup.enabled ? "On" : "Off",
                    systemImage: wakeup.enabled ? "checkmark.circle.fill" : "pause.circle",
                    tint: wakeup.enabled ? .green : .secondary
                )
                OverviewBadge(
                    title: dispatchLabel(wakeup.dispatchMode ?? "ipc"),
                    systemImage: "arrowshape.turn.up.right.circle.fill",
                    tint: .blue
                )
            }

            OverviewMetricGrid(metrics: [
                OverviewMetric(label: "Runs at", value: wakeup.wakeTimes.joined(separator: ", "), symbolName: "clock"),
                OverviewMetric(label: "Next run", value: nextRunText, symbolName: "calendar")
            ])

            OverviewSection(title: "Assigned Duties") {
                OverviewPillList(items: dutyLabels, emptyText: "No duties are attached to this wakeup yet.", symbolName: "checkmark.circle")
            }

            OverviewSection(title: "Identifier") {
                OverviewCodeLine(wakeup.id)
            }
        }
    }

    private var dutyLabels: [String] {
        let selected = wakeup.selectedDutyIds
        let labels = selected.map { id in
            duties.first(where: { $0.id == id })?.label ?? id
        }
        return labels
    }

    private var nextRunText: String {
        if !wakeup.enabled { return "Paused" }
        if wakeup.due == true { return "Due now" }
        return formattedWakefieldDate(wakeup.nextRunAt) ?? "Not scheduled"
    }
}

private struct WakeupEditor: View {
    @ObservedObject var model: WakefieldModel
    let selectedWakeup: Wakeup?
    @Binding var draft: WakeupDraft
    let savedDraft: WakeupDraft
    let isNew: Bool
    let saveAction: () -> Void
    let cancelAction: () -> Void
    let deleteAction: () -> Void

    var body: some View {
        ActionFormPane(
            showsAction: isNew || draft != savedDraft,
            title: isNew ? "Create Wakeup" : "Save Wakeup",
            systemImage: "checkmark.circle.fill",
            disabled: model.busy || draft.id.isEmpty || draft.label.isEmpty || draft.times.isEmpty || draft.dutyIds.isEmpty,
            action: saveAction
        ) {
            HStack {
                Text(isNew ? "New Wakeup" : "Edit Wakeup")
                    .font(.title3.weight(.semibold))
                Spacer()
                if selectedWakeup != nil {
                    Button(role: .destructive) {
                        deleteAction()
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(model.busy)
                }
                Button("Cancel") {
                    cancelAction()
                }
            }

            LabeledControl("Name") {
                TextField("Morning Ops", text: $draft.label)
                    .textFieldStyle(.roundedBorder)
            }
            LabeledControl("ID") {
                TextField("morning-ops", text: $draft.id)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
            }
            LabeledControl("Times") {
                TextField("08:00, 16:00", text: $draft.timesText)
                    .textFieldStyle(.roundedBorder)
            }
            LabeledControl("Dispatch") {
                Picker("", selection: $draft.dispatchMode) {
                    Text("Codex").tag("ipc")
                    Text("Dry run").tag("dry-run")
                    Text("Manual").tag("manual")
                }
                .pickerStyle(.segmented)
            }
            Toggle("Enabled", isOn: $draft.enabled)
                .toggleStyle(.switch)

            VStack(alignment: .leading, spacing: 8) {
                Text("Duties")
                    .font(.headline)
                ForEach(model.duties.duties) { duty in
                    Toggle(isOn: Binding(
                        get: { draft.dutyIds.contains(duty.id) },
                        set: { enabled in
                            if enabled { draft.dutyIds.insert(duty.id) }
                            else { draft.dutyIds.remove(duty.id) }
                        }
                    )) {
                        Text(duty.label)
                    }
                }
            }
        }
    }
}

private struct ListPaneFooterAction: View {
    let title: String
    let systemImage: String
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.callout.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(disabled ? .tertiary : .secondary)
        .disabled(disabled)
        .padding(.leading, 18)
        .padding(.bottom, 10)
    }
}

private struct ListPaneFooterSpacer: View {
    var body: some View {
        Color.clear
            .frame(height: 34)
            .disabled(true)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}

private struct DutiesPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var selectedDutyId: String?
    @State private var draft = DutyDraft(duty: nil)
    @State private var savedDraft = DutyDraft(duty: nil)
    @State private var isEditing = false

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                ZStack(alignment: .bottomLeading) {
                    List(selection: $selectedDutyId) {
                        ForEach(model.duties.duties) { duty in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(duty.label)
                                    .font(.headline)
                                Text((duty.skills ?? []).joined(separator: ", "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 5)
                            .tag(duty.id)
                        }
                        ListPaneFooterSpacer()
                    }
                    ListPaneFooterAction(title: "New Duty", systemImage: "plus.circle", disabled: model.busy) {
                        newDuty()
                    }
                }
            }
            .frame(width: 270)
            Divider()
            dutyDetail
        }
        .onAppear {
            let duty = selectedDuty ?? model.duties.duties.first
            selectedDutyId = duty?.id
            resetDraft(duty: duty)
        }
        .onChange(of: selectedDutyId) { _, _ in
            isEditing = false
            resetDraft(duty: selectedDuty)
        }
        .onChange(of: model.duties.duties) { _, _ in
            if isEditing, selectedDutyId == draft.id, selectedDuty != nil {
                isEditing = false
                resetDraft(duty: selectedDuty)
            } else if !isEditing, selectedDutyId == nil {
                selectedDutyId = model.duties.duties.first?.id
            }
        }
    }

    @ViewBuilder
    private var dutyDetail: some View {
        if isEditing {
            DutyEditor(
                model: model,
                selectedDuty: selectedDuty,
                draft: $draft,
                savedDraft: savedDraft,
                isNew: selectedDuty == nil,
                saveAction: saveDuty,
                cancelAction: cancelEdit,
                deleteAction: deleteDuty
            )
        } else if let selectedDuty {
            DutyDetailPane(duty: selectedDuty, wakeups: model.duties.wakeups) {
                resetDraft(duty: selectedDuty)
                isEditing = true
            }
        } else {
            EmptyState(symbol: "checklist", title: "No duty selected")
        }
    }

    private var selectedDuty: DutyDefinition? {
        model.duties.duties.first(where: { $0.id == selectedDutyId })
    }

    private func newDuty() {
        selectedDutyId = nil
        draft = DutyDraft(duty: nil, suggestedIndex: model.duties.duties.count + 1)
        savedDraft = draft
        isEditing = true
    }

    private func resetDraft(duty: DutyDefinition?) {
        draft = DutyDraft(duty: duty, suggestedIndex: model.duties.duties.count + 1)
        savedDraft = draft
    }

    private func saveDuty() {
        selectedDutyId = draft.id
        savedDraft = draft
        model.saveDuty(draft)
    }

    private func cancelEdit() {
        if let selectedDuty {
            resetDraft(duty: selectedDuty)
            isEditing = false
        } else {
            selectedDutyId = model.duties.duties.first?.id
            resetDraft(duty: selectedDuty)
            isEditing = false
        }
    }

    private func deleteDuty() {
        guard let selectedDuty else { return }
        model.deleteDuty(selectedDuty)
        selectedDutyId = model.duties.duties.first(where: { $0.id != selectedDuty.id })?.id
        isEditing = false
    }
}

private struct DutyDetailPane: View {
    let duty: DutyDefinition
    let wakeups: [Wakeup]
    let editAction: () -> Void

    var body: some View {
        OverviewPane {
            OverviewHeader(
                kind: "Duty",
                title: duty.label,
                subtitle: duty.enabled == false ? "Disabled duty. Wakeups can keep it attached, but it will not run." : "Reusable work block that wakeups can dispatch.",
                symbolName: "checklist",
                editAction: editAction
            ) {
                OverviewBadge(
                    title: duty.enabled == false ? "Off" : "On",
                    systemImage: duty.enabled == false ? "pause.circle" : "checkmark.circle.fill",
                    tint: duty.enabled == false ? .secondary : .green
                )
                OverviewBadge(
                    title: skillCountText,
                    systemImage: "sparkles",
                    tint: .blue
                )
            }

            OverviewMetricGrid(metrics: [
                OverviewMetric(label: "Status", value: duty.enabled == false ? "Off" : "On", symbolName: duty.enabled == false ? "pause.circle" : "checkmark.circle"),
                OverviewMetric(label: "Skills", value: skillCountText, symbolName: "sparkles"),
                OverviewMetric(label: "Wakeups", value: wakeupCountText, symbolName: "alarm")
            ])

            OverviewSection(title: "Skills") {
                OverviewPillList(items: duty.skills ?? [], emptyText: "No skills are attached to this duty yet.", symbolName: "bolt.circle")
            }

            OverviewSection(title: "Scheduled In") {
                OverviewPillList(items: wakeupLabels, emptyText: "No wakeups currently include this duty.", symbolName: "alarm")
            }

            OverviewSection(title: "Prompt") {
                OverviewTextBlock(
                    text: trimmedNonEmpty(duty.prompt) ?? "No additional prompt. The duty runs from its skills and the agent's general instructions.",
                    isEmpty: trimmedNonEmpty(duty.prompt) == nil
                )
            }

            OverviewSection(title: "Identifier") {
                OverviewCodeLine(duty.id)
            }
        }
    }

    private var skillCountText: String {
        let count = duty.skills?.count ?? 0
        if count == 1 { return "1 skill" }
        return "\(count) skills"
    }

    private var wakeupLabels: [String] {
        wakeups
            .filter { $0.selectedDutyIds.contains(duty.id) }
            .map(\.label)
    }

    private var wakeupCountText: String {
        let count = wakeupLabels.count
        if count == 1 { return "1 wakeup" }
        return "\(count) wakeups"
    }
}

private struct DutyEditor: View {
    @ObservedObject var model: WakefieldModel
    let selectedDuty: DutyDefinition?
    @Binding var draft: DutyDraft
    let savedDraft: DutyDraft
    let isNew: Bool
    let saveAction: () -> Void
    let cancelAction: () -> Void
    let deleteAction: () -> Void

    var body: some View {
        ActionFormPane(
            showsAction: isNew || draft != savedDraft,
            title: isNew ? "Create Duty" : "Save Duty",
            systemImage: "checkmark.circle.fill",
            disabled: model.busy || draft.id.isEmpty || draft.label.isEmpty,
            action: saveAction
        ) {
            HStack {
                Text(isNew ? "New Duty" : "Edit Duty")
                    .font(.title3.weight(.semibold))
                Spacer()
                if selectedDuty != nil {
                    Button(role: .destructive) {
                        deleteAction()
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(model.busy)
                }
                Button("Cancel") {
                    cancelAction()
                }
            }

            LabeledControl("Name") {
                TextField("Inventory Check", text: $draft.label)
                    .textFieldStyle(.roundedBorder)
            }
            LabeledControl("ID") {
                TextField("inventory-check", text: $draft.id)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
            }
            LabeledControl("Skills") {
                TextField("skill-one, skill-two", text: $draft.skillsText)
                    .textFieldStyle(.roundedBorder)
            }
            Toggle("Enabled", isOn: $draft.enabled)
                .toggleStyle(.switch)
            VStack(alignment: .leading, spacing: 6) {
                Text("Prompt")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $draft.prompt)
                    .frame(minHeight: 150)
                    .padding(6)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }
}

private struct ActionFormPane<Content: View>: View {
    let showsAction: Bool
    let title: String
    let systemImage: String
    let disabled: Bool
    let action: () -> Void
    let content: Content

    init(
        showsAction: Bool,
        title: String,
        systemImage: String,
        disabled: Bool,
        action: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.showsAction = showsAction
        self.title = title
        self.systemImage = systemImage
        self.disabled = disabled
        self.action = action
        self.content = content()
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            FormPane(bottomInset: showsAction ? 54 : 0) {
                content
            }
            BottomSaveAction(
                title: title,
                systemImage: systemImage,
                isVisible: showsAction,
                isDisabled: disabled,
                action: action
            )
        }
        .animation(.easeOut(duration: 0.16), value: showsAction)
    }
}

private struct BottomSaveAction: View {
    let title: String
    let systemImage: String
    let isVisible: Bool
    let isDisabled: Bool
    let action: () -> Void

    var body: some View {
        if isVisible {
            Button(action: action) {
                Label(title, systemImage: systemImage)
                    .font(.headline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .background(isDisabled ? Color.accentColor.opacity(0.45) : Color.accentColor)
            .disabled(isDisabled)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

private struct FormPane<Content: View>: View {
    let bottomInset: CGFloat
    let content: Content

    init(bottomInset: CGFloat = 0, @ViewBuilder content: () -> Content) {
        self.bottomInset = bottomInset
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                content
            }
            .padding(22)
            .padding(.bottom, bottomInset)
            .frame(maxWidth: 560, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct OverviewPane<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                content
            }
            .padding(22)
            .frame(maxWidth: 620, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct OverviewHeader<Badges: View>: View {
    let kind: String
    let title: String
    let subtitle: String
    let symbolName: String
    let editAction: () -> Void
    let badges: Badges

    init(
        kind: String,
        title: String,
        subtitle: String,
        symbolName: String,
        editAction: @escaping () -> Void,
        @ViewBuilder badges: () -> Badges
    ) {
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.symbolName = symbolName
        self.editAction = editAction
        self.badges = badges()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: symbolName)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 28, height: 28)
                        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                    Text(kind)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    editAction()
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.title2.weight(.semibold))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                badges
            }
        }
    }
}

private struct OverviewBadge: View {
    let title: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
            Text(title)
                .lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(tint.opacity(0.14), in: Capsule())
    }
}

private struct OverviewMetric: Identifiable {
    let id = UUID()
    let label: String
    let value: String
    let symbolName: String
}

private struct OverviewMetricGrid: View {
    let metrics: [OverviewMetric]

    private let columns = [
        GridItem(.adaptive(minimum: 136), spacing: 8)
    ]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(metrics) { metric in
                OverviewMetricTile(metric: metric)
            }
        }
    }
}

private struct OverviewMetricTile: View {
    let metric: OverviewMetric

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: metric.symbolName)
                    .frame(width: 16)
                Text(metric.label)
                    .lineLimit(1)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)

            Text(metric.value.isEmpty ? "None" : metric.value)
                .font(.title3.weight(.semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(minHeight: 68, alignment: .topLeading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct OverviewSection<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct OverviewPillList: View {
    let items: [String]
    let emptyText: String
    let symbolName: String

    private let columns = [
        GridItem(.adaptive(minimum: 150), spacing: 8)
    ]

    var body: some View {
        if items.isEmpty {
            OverviewTextBlock(text: emptyText, isEmpty: true)
        } else {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                ForEach(items, id: \.self) { item in
                    HStack(spacing: 7) {
                        Image(systemName: symbolName)
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 16)
                        Text(item)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }
}

private struct OverviewTextBlock: View {
    let text: String
    let isEmpty: Bool

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(isEmpty ? .secondary : .primary)
            .lineLimit(6)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct OverviewCodeLine: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "number")
                .foregroundStyle(.secondary)
            Text(text)
                .font(.system(.body, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct LabeledControl<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            content
        }
    }
}

private func dispatchLabel(_ value: String) -> String {
    switch value {
    case "ipc": return "Codex"
    case "dry-run": return "Dry run"
    case "manual": return "Manual"
    default: return value
    }
}

private let wakefieldOverviewDateFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter
}()

private func formattedWakefieldDate(_ value: String?) -> String? {
    guard let value, let date = parseWakefieldDate(value) else { return nil }
    return wakefieldOverviewDateFormatter.string(from: date)
}

private struct EmptyState: View {
    let symbol: String
    let title: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private func connectorValues(from wizard: ConnectorWizard) -> [String: String] {
    let defaults = Dictionary(uniqueKeysWithValues: wizard.setupFields.map { ($0.id, $0.value ?? "") })
    var values = defaults
    values["envFile"] = "~/.wakefield.env"
    if wizard.adapter == "imessage-spectrum" {
        values["projectIdEnv"] = defaults["projectIdEnv"]?.isEmpty == false ? defaults["projectIdEnv"] : "PHOTON_PROJECT_ID"
        values["projectSecretEnv"] = defaults["projectSecretEnv"]?.isEmpty == false ? defaults["projectSecretEnv"] : "PHOTON_SECRET_KEY"
        values["projectIdValue"] = configuredCredentialMask(
            wizard,
            fieldId: "projectIdEnv",
            checkIds: ["photon-project-id"]
        )
        values["projectSecretValue"] = configuredCredentialMask(
            wizard,
            fieldId: "projectSecretEnv",
            checkIds: ["photon-secret"]
        )
    } else {
        values["tokenEnv"] = defaults["tokenEnv"]?.isEmpty == false ? defaults["tokenEnv"] : "DISCORD_BOT_TOKEN"
        values["tokenValue"] = configuredCredentialMask(
            wizard,
            fieldId: "tokenEnv",
            checkIds: ["bot-token", "token-file"]
        )
    }
    return values
}

private func configuredCredentialMask(_ wizard: ConnectorWizard, fieldId: String, checkIds: Set<String>) -> String {
    let envIsSet = wizard.setupFields.first(where: { $0.id == fieldId })?.envSet == true
    let checkIsOk = wizard.steps
        .flatMap { $0.checks ?? [] }
        .contains { checkIds.contains($0.id) && $0.ok == true }
    return envIsSet || checkIsOk ? wakefieldConfiguredCredentialMask : ""
}
