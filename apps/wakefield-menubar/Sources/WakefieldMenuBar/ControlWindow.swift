import SwiftUI

struct ControlWindow: View {
    @ObservedObject var model: WakefieldModel

    var body: some View {
        VStack(spacing: 0) {
            ControlHeader(model: model)
            Divider()
            HStack(spacing: 0) {
                sidebar
                Divider()
                content
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
            Button(role: .destructive) {
                model.pauseAll()
            } label: {
                Label("Turn Everything Off", systemImage: "pause.circle")
            }
            .buttonStyle(.borderless)
            .disabled(model.busy)
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
        case .chat:
            ChatPane(model: model)
        }
    }
}

private struct ControlHeader: View {
    @ObservedObject var model: WakefieldModel

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: model.menuBarSymbol)
                .font(.title2)
                .foregroundStyle(model.snapshot?.service.scheduler.loaded == true ? .green : .secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.snapshot?.agentName ?? "Wakefield")
                    .font(.title3.weight(.semibold))
                Text(model.snapshot?.service.scheduler.loaded == true ? "Assistant is on" : "Assistant is off")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Button {
                model.setRuntimeEnabled(model.snapshot?.service.scheduler.loaded != true)
            } label: {
                Label(model.snapshot?.service.scheduler.loaded == true ? "Turn Off" : "Turn On",
                      systemImage: model.snapshot?.service.scheduler.loaded == true ? "power.circle.fill" : "power.circle")
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
    case chat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .agent: return "Agent"
        case .connectors: return "Connectors"
        case .wakeups: return "Wakeups"
        case .duties: return "Duties"
        case .chat: return "Codex Chat"
        }
    }

    var symbol: String {
        switch self {
        case .agent: return "sparkles"
        case .connectors: return "point.3.connected.trianglepath.dotted"
        case .wakeups: return "alarm"
        case .duties: return "checklist"
        case .chat: return "bubble.left.and.text.bubble.right"
        }
    }
}

private struct AgentPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var name = ""
    @State private var soul = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Agent")
                    .font(.title3.weight(.semibold))
                Spacer()
            }

            HStack(alignment: .bottom, spacing: 12) {
                LabeledControl("Name") {
                    TextField("Mira", text: $name)
                        .textFieldStyle(.roundedBorder)
                }
                .frame(maxWidth: 360)

                Spacer()

                Button("Choose Codex Chat") {
                    model.controlTab = .chat
                }
                Button {
                    model.saveAgent(name: name, soul: soul)
                } label: {
                    Label("Save", systemImage: "checkmark.circle")
                }
                .disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Soul")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $soul)
                    .font(.body)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(6)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .layoutPriority(1)
        }
        .padding(22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear(perform: load)
        .onChange(of: model.agentDetails?.profile?.name) { _, _ in load() }
        .onChange(of: model.agentDetails?.soul) { _, _ in load() }
    }

    private func load() {
        name = model.agentDetails?.profile?.name ?? model.snapshot?.agent?.name ?? ""
        soul = model.agentDetails?.soul ?? ""
    }
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
                .foregroundStyle(connector.running ? .green : connector.ready ? .blue : .orange)
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

    var body: some View {
        FormPane {
            HStack {
                Label(connector.displayName, systemImage: connector.symbolName)
                    .font(.title3.weight(.semibold))
                Spacer()
                StatusPill(text: connector.stateText, tint: connector.running ? .green : connector.ready ? .blue : .orange)
                Toggle("", isOn: Binding(
                    get: { connector.running },
                    set: { model.setConnector(connector, running: $0) }
                ))
                .toggleStyle(.switch)
                .disabled(model.busy)
            }

            if let wizard {
                ConnectorSetupFields(wizard: wizard, values: $values)

                HStack {
                    Button {
                        model.setupConnector(wizard, values: values)
                    } label: {
                        Label("Save & Start", systemImage: "checkmark.circle")
                    }
                    .disabled(model.busy)

                    Button("Run Check") {
                        model.runConnectorCheck(connector)
                    }
                    .disabled(model.busy)
                }
            } else {
                EmptyState(symbol: "wrench.and.screwdriver", title: "Setup unavailable")
            }
        }
        .onAppear {
            if let wizard { values = connectorValues(from: wizard) }
        }
        .onChange(of: wizard) { _, next in
            if let next { values = connectorValues(from: next) }
        }
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
                LabeledControl("Allowed people") {
                    TextField("+15551234567, person@example.com", text: binding("allowedAddresses"))
                        .textFieldStyle(.roundedBorder)
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

    var body: some View {
        HStack(spacing: 0) {
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
            }
            .frame(width: 270)
            Divider()
            WakeupEditor(model: model, draft: $draft)
        }
        .onAppear {
            let wakeup = selectedWakeup ?? model.duties.wakeups.first
            selectedWakeupId = wakeup?.id
            draft = WakeupDraft(wakeup: wakeup)
        }
        .onChange(of: selectedWakeupId) { _, _ in
            draft = WakeupDraft(wakeup: selectedWakeup)
        }
    }

    private var selectedWakeup: Wakeup? {
        model.duties.wakeups.first(where: { $0.id == selectedWakeupId })
    }
}

private struct WakeupEditor: View {
    @ObservedObject var model: WakefieldModel
    @Binding var draft: WakeupDraft

    var body: some View {
        FormPane {
            Text("Wakeup")
                .font(.title3.weight(.semibold))

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

            Button {
                model.saveWakeup(draft)
            } label: {
                Label("Save Wakeup", systemImage: "checkmark.circle")
            }
            .disabled(model.busy || draft.id.isEmpty || draft.label.isEmpty || draft.times.isEmpty || draft.dutyIds.isEmpty)
        }
    }
}

private struct DutiesPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var selectedDutyId: String?
    @State private var draft = DutyDraft(duty: nil)

    var body: some View {
        HStack(spacing: 0) {
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
            }
            .frame(width: 270)
            Divider()
            DutyEditor(model: model, draft: $draft)
        }
        .onAppear {
            let duty = selectedDuty ?? model.duties.duties.first
            selectedDutyId = duty?.id
            draft = DutyDraft(duty: duty)
        }
        .onChange(of: selectedDutyId) { _, _ in
            draft = DutyDraft(duty: selectedDuty)
        }
    }

    private var selectedDuty: DutyDefinition? {
        model.duties.duties.first(where: { $0.id == selectedDutyId })
    }
}

private struct DutyEditor: View {
    @ObservedObject var model: WakefieldModel
    @Binding var draft: DutyDraft

    var body: some View {
        FormPane {
            Text("Duty")
                .font(.title3.weight(.semibold))
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
            Button {
                model.saveDuty(draft)
            } label: {
                Label("Save Duty", systemImage: "checkmark.circle")
            }
            .disabled(model.busy || draft.id.isEmpty || draft.label.isEmpty)
        }
    }
}

private struct ChatPane: View {
    @ObservedObject var model: WakefieldModel

    var body: some View {
        List {
            Section("Selected") {
                HStack {
                    Image(systemName: "bubble.left.and.text.bubble.right.fill")
                        .foregroundStyle(.blue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.snapshot?.agent?.name ?? "Wakefield")
                            .font(.headline)
                        Text(selectedThreadName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Recent Codex Chats") {
                ForEach(model.threads) { thread in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(thread.displayName)
                                .font(.headline)
                            Text(thread.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if thread.threadId == model.snapshot?.agent?.threadId {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Button("Select") {
                                model.selectThread(thread)
                            }
                            .disabled(model.busy)
                        }
                    }
                    .padding(.vertical, 4)
                    .help(thread.threadId)
                }
            }
        }
    }

    private var selectedThreadName: String {
        guard let threadId = model.snapshot?.agent?.threadId else { return "No chat selected" }
        if let thread = model.threads.first(where: { $0.threadId == threadId }) {
            return thread.displayName
        }
        return "Selected Codex chat"
    }
}

private struct FormPane<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                content
            }
            .padding(22)
            .frame(maxWidth: 560, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
