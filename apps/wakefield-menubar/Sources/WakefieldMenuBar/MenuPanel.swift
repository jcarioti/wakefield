import SwiftUI

struct MenuPanel: View {
    @ObservedObject var model: WakefieldModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()
            connectorSection
            wakeupsSection
            footer
        }
        .padding(16)
        .frame(width: 390)
        .onAppear { Task { await model.refreshAll() } }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: model.menuBarSymbol)
                .font(.title3)
                .foregroundStyle(accentColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(model.snapshot?.agentName ?? "Wakefield")
                    .font(.headline)
                Text(threadLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if model.busy {
                ProgressView().controlSize(.small)
            }
            StatusPill(
                text: assistantStatus,
                tint: model.snapshot?.service.scheduler.loaded == true ? .green : .secondary
            )
            Toggle("", isOn: Binding(
                get: { model.snapshot?.service.scheduler.loaded == true },
                set: { model.setRuntimeEnabled($0) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.mini)
            .disabled(model.busy)
        }
    }

    private var connectorSection: some View {
        SectionBlock(title: "Connectors", symbol: "point.3.connected.trianglepath.dotted") {
            let connectors = model.snapshot?.managedConnectors ?? []
            if connectors.isEmpty {
                Text("No connectors configured")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(connectors) { connector in
                    ToggleRow(
                        symbol: connector.symbolName,
                        title: connector.displayName,
                        detail: connector.stateText,
                        isOn: Binding(
                            get: { connector.running },
                            set: { model.setConnector(connector, running: $0) }
                        ),
                        tint: connector.running ? .green : connector.ready ? .blue : .orange
                    )
                    .disabled(model.busy)
                }
            }
        }
    }

    private var wakeupsSection: some View {
        SectionBlock(title: "Wakeups", symbol: "alarm") {
            let wakeups = model.duties.wakeups
            if wakeups.isEmpty {
                Text("No wakeups configured")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(wakeups) { wakeup in
                    ToggleRow(
                        symbol: wakeup.due == true ? "alarm.waves.left.and.right.fill" : "clock",
                        title: wakeup.label,
                        detail: wakeup.wakeTimes.joined(separator: ", "),
                        isOn: Binding(
                            get: { wakeup.enabled },
                            set: { model.setWakeup(wakeup, enabled: $0) }
                        ),
                        tint: wakeup.due == true ? .orange : wakeup.enabled ? .blue : .secondary
                    )
                    .disabled(model.busy)
                }
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.lastError.isEmpty {
                Text(model.lastError)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            } else if !model.lastMessage.isEmpty {
                Text(model.lastMessage)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack {
                Button("Open Wakefield") { model.openControlWindow(tab: .agent) }
                    .keyboardShortcut(",", modifiers: .command)
                Button("Run Once") { model.runServiceOnce() }
                    .disabled(model.busy)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
            .controlSize(.small)
        }
    }

    private var assistantStatus: String {
        model.snapshot?.service.scheduler.loaded == true ? "On" : "Off"
    }

    private var threadLine: String {
        if let thread = model.threads.first(where: { $0.threadId == model.snapshot?.agent?.threadId }) {
            return thread.displayName
        }
        if model.snapshot?.agent?.threadId != nil {
            return "Selected Codex chat"
        }
        return "No Codex chat selected"
    }

    private var accentColor: Color {
        guard let snapshot = model.snapshot else { return .secondary }
        if !snapshot.ready { return .orange }
        if snapshot.service.scheduler.loaded == true { return .green }
        return .secondary
    }
}

private struct ToggleRow: View {
    let symbol: String
    let title: String
    let detail: String
    @Binding var isOn: Bool
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption.weight(.semibold))
                Text(detail.isEmpty ? "Configured" : detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Toggle("", isOn: $isOn)
                .toggleStyle(.switch)
                .controlSize(.mini)
        }
    }
}

struct SectionBlock<Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            content
        }
    }
}

struct StatusPill: View {
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(tint)
                .frame(width: 7, height: 7)
            Text(text)
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary, in: Capsule())
    }
}
