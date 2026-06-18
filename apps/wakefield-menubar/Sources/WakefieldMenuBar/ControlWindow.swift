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
        case .setup:
            SetupPane(model: model)
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
    case setup
    case agent
    case connectors
    case wakeups
    case duties
    case chat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .setup: return "Setup"
        case .agent: return "Agent"
        case .connectors: return "Connectors"
        case .wakeups: return "Wakeups"
        case .duties: return "Duties"
        case .chat: return "Codex Chat"
        }
    }

    var symbol: String {
        switch self {
        case .setup: return "wand.and.stars"
        case .agent: return "sparkles"
        case .connectors: return "point.3.connected.trianglepath.dotted"
        case .wakeups: return "alarm"
        case .duties: return "checklist"
        case .chat: return "bubble.left.and.text.bubble.right"
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                SetupStepPill(index: 0, title: "Name", selected: step == 0, done: step > 0)
                SetupStepPill(index: 1, title: "Connect", selected: step == 1, done: step > 1)
                SetupStepPill(index: 2, title: "Wake", selected: step == 2, done: step > 2)
                SetupStepPill(index: 3, title: "Try", selected: step == 3, done: false)
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
                    launchStep
                default:
                    doneStep
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
                .onChange(of: selectedPreset) { _, value in
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
            Text("Wakefield can listen through iMessage, Discord, and email.")
                .foregroundStyle(.secondary)

            VStack(spacing: 10) {
                SetupConnectorRow(symbol: "message.fill", title: "iMessage", subtitle: "Photon/Spectrum for iMessage and SMS.")
                SetupConnectorRow(symbol: "bubble.left.and.bubble.right.fill", title: "Discord", subtitle: "A bot token and allowed channels or DMs.")
                SetupConnectorRow(symbol: "envelope.fill", title: "Email", subtitle: "IMAP settings for read-only intake.")
            }

            HStack {
                Button("Back") { step = 0 }
                Spacer()
                Button {
                    model.controlTab = .connectors
                } label: {
                    Label("Open Connector Setup", systemImage: "slider.horizontal.3")
                }
                Button {
                    step = 2
                } label: {
                    Label("Continue", systemImage: "arrow.right.circle")
                }
            }
        }
    }

    private var launchStep: some View {
        FormPane {
            Text("Wake \(name)")
                .font(.title2.weight(.semibold))
            Text("Wakefield will create the local agent folder, install the Codex hooks and skills, start the background service, then open Codex with the first prompt ready to send.")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Label("Agent folder under ~/Wakefield Agents", systemImage: "folder")
                Label("Private memory under .wakefield/memories", systemImage: "brain.head.profile")
                Label("Codex opens with the bootstrap prompt filled in", systemImage: "bubble.left.and.text.bubble.right")
            }
            .foregroundStyle(.secondary)

            HStack {
                Button("Back") { step = 1 }
                Spacer()
                Button {
                    model.finishOnboarding(name: name, ownerName: ownerName, soul: soul)
                    step = 3
                } label: {
                    Label("Finish Setup", systemImage: "checkmark.circle.fill")
                }
                .disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var doneStep: some View {
        FormPane {
            Text(model.onboardingOpenedCodex ? "Press Send In Codex" : "Finishing Setup")
                .font(.title2.weight(.semibold))
            if model.busy {
                ProgressView()
            }
            Text(doneCopy)
                .foregroundStyle(.secondary)
            HStack {
                Button {
                    model.continueOnboardingAfterBootstrap()
                } label: {
                    Label("I Sent It", systemImage: "arrow.triangle.2.circlepath.circle")
                }
                .disabled(model.busy || !model.onboardingOpenedCodex)
                Button {
                    model.controlTab = .connectors
                } label: {
                    Label("Set Up Connectors", systemImage: "point.3.connected.trianglepath.dotted")
                }
            }
            Divider()
            Text("First test")
                .font(.headline)
            Text("Text or DM \(name): \"Hey \(name), I'm \(ownerName.isEmpty ? "your name" : ownerName).\"")
                .font(.title3.weight(.medium))
        }
    }

    private var doneCopy: String {
        if model.onboardingOpenedCodex {
            return "Codex should be open with the first prompt filled in. Send that prompt, wait for the assistant to answer, then come back here."
        }
        if !model.lastError.isEmpty {
            return model.lastError
        }
        return "Wakefield is creating the assistant and opening Codex."
    }
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

private struct SetupConnectorRow: View {
    let symbol: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .frame(width: 24)
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

private struct AgentPane: View {
    @ObservedObject var model: WakefieldModel
    @State private var name = ""
    @State private var soul = ""
    @State private var selectedPreset = wakefieldSoulPresets[0].id

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
                    Label(model.agentDetails?.profile == nil ? "Create" : "Save", systemImage: "checkmark.circle")
                }
                .disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            LabeledControl("Soul Style") {
                Picker("", selection: $selectedPreset) {
                    ForEach(wakefieldSoulPresets) { preset in
                        Text(preset.label).tag(preset.id)
                    }
                    Text("Custom").tag("custom")
                }
                .pickerStyle(.menu)
                .onChange(of: selectedPreset) { _, value in
                    guard let preset = wakefieldSoulPresets.first(where: { $0.id == value }) else { return }
                    soul = preset.text
                }
            }
            .frame(maxWidth: 360)

            VStack(alignment: .leading, spacing: 6) {
                Text("Soul")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $soul)
                    .font(.body)
                    .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 190)
                    .padding(6)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

            Spacer(minLength: 0)
        }
        .padding(22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear(perform: load)
        .onChange(of: model.agentDetails?.profile?.name) { _, _ in load() }
        .onChange(of: model.agentDetails?.soul) { _, _ in load() }
    }

    private func load() {
        name = model.agentDetails?.profile?.name ?? model.snapshot?.agent?.name ?? ""
        let currentSoul = model.agentDetails?.soul ?? ""
        soul = currentSoul.isEmpty ? wakefieldSoulPresets[0].text : currentSoul
        selectedPreset = wakefieldPresetId(for: soul)
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
    wakefieldSoulPresets.first(where: { $0.text == soul })?.id ?? "custom"
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
            WakeupEditor(model: model, selectedWakeup: selectedWakeup, draft: $draft) {
                selectedWakeupId = nil
                draft = WakeupDraft(wakeup: nil, suggestedIndex: model.duties.wakeups.count + 1)
            }
        }
        .onAppear {
            let wakeup = selectedWakeup ?? model.duties.wakeups.first
            selectedWakeupId = wakeup?.id
            draft = WakeupDraft(wakeup: wakeup, suggestedIndex: model.duties.wakeups.count + 1)
        }
        .onChange(of: selectedWakeupId) { _, _ in
            draft = WakeupDraft(wakeup: selectedWakeup, suggestedIndex: model.duties.wakeups.count + 1)
        }
    }

    private var selectedWakeup: Wakeup? {
        model.duties.wakeups.first(where: { $0.id == selectedWakeupId })
    }
}

private struct WakeupEditor: View {
    @ObservedObject var model: WakefieldModel
    let selectedWakeup: Wakeup?
    @Binding var draft: WakeupDraft
    let newAction: () -> Void

    var body: some View {
        FormPane {
            HStack {
                Text("Wakeup")
                    .font(.title3.weight(.semibold))
                Spacer()
                Button {
                    newAction()
                } label: {
                    Label("New", systemImage: "plus.circle")
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

            HStack {
                Button {
                    model.saveWakeup(draft)
                } label: {
                    Label("Save Wakeup", systemImage: "checkmark.circle")
                }
                .disabled(model.busy || draft.id.isEmpty || draft.label.isEmpty || draft.times.isEmpty || draft.dutyIds.isEmpty)

                if let selectedWakeup {
                    Button(role: .destructive) {
                        model.deleteWakeup(selectedWakeup)
                        newAction()
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(model.busy)
                }
            }
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
            DutyEditor(model: model, selectedDuty: selectedDuty, draft: $draft) {
                selectedDutyId = nil
                draft = DutyDraft(duty: nil, suggestedIndex: model.duties.duties.count + 1)
            }
        }
        .onAppear {
            let duty = selectedDuty ?? model.duties.duties.first
            selectedDutyId = duty?.id
            draft = DutyDraft(duty: duty, suggestedIndex: model.duties.duties.count + 1)
        }
        .onChange(of: selectedDutyId) { _, _ in
            draft = DutyDraft(duty: selectedDuty, suggestedIndex: model.duties.duties.count + 1)
        }
    }

    private var selectedDuty: DutyDefinition? {
        model.duties.duties.first(where: { $0.id == selectedDutyId })
    }
}

private struct DutyEditor: View {
    @ObservedObject var model: WakefieldModel
    let selectedDuty: DutyDefinition?
    @Binding var draft: DutyDraft
    let newAction: () -> Void

    var body: some View {
        FormPane {
            HStack {
                Text("Duty")
                    .font(.title3.weight(.semibold))
                Spacer()
                Button {
                    newAction()
                } label: {
                    Label("New", systemImage: "plus.circle")
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
            HStack {
                Button {
                    model.saveDuty(draft)
                } label: {
                    Label("Save Duty", systemImage: "checkmark.circle")
                }
                .disabled(model.busy || draft.id.isEmpty || draft.label.isEmpty)

                if let selectedDuty {
                    Button(role: .destructive) {
                        model.deleteDuty(selectedDuty)
                        newAction()
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(model.busy)
                }
            }
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
