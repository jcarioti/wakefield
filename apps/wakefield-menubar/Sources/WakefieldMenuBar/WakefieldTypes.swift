import Foundation

let wakefieldConfiguredCredentialMask = "••••••••"

func isWakefieldConfiguredCredentialMask(_ value: String?) -> Bool {
    value == wakefieldConfiguredCredentialMask
}

struct MenuSnapshot: Decodable {
    var headline: String
    var ready: Bool
    var agent: AgentSummary?
    var service: ServiceSummary
    var duties: DutySummary
    var threads: ThreadSummary
    var managedConnectors: [ManagedConnector]
    var nextSteps: [String]

    var agentName: String { agent?.name ?? "Wakefield" }
}

struct AgentSummary: Decodable {
    var id: String
    var name: String
    var ownerName: String?
    var agentHome: String?
    var threadId: String?
    var cwd: String?
    var soulPath: String?
    var bootstrapPromptPath: String?
}

struct AgentConfigStatus: Decodable {
    var ok: Bool
    var profile: AgentSummary?
    var soul: String?
}

struct ServiceSummary: Decodable {
    var enabled: Bool
    var intervalMinutes: Int?
    var lastRunAt: String?
    var nextRunAt: String?
    var externalDispatch: ExternalDispatchSummary?
    var environment: ServiceEnvironment?
    var duties: DutySummary?
    var scheduler: SchedulerSummary
}

struct ExternalDispatchSummary: Decodable {
    var enabled: Bool?
    var mode: String?
    var limit: Int?
    var pending: Int?
}

struct ServiceEnvironment: Decodable {
    var configured: Bool?
    var path: String?
    var exists: Bool?
    var loaded: Bool?
}

struct SchedulerSummary: Decodable {
    var supported: Bool?
    var canLoad: Bool?
    var installed: Bool
    var loaded: Bool?
    var label: String?
    var plistPath: String?
}

struct DutySummary: Decodable {
    var total: Int
    var enabled: Int
    var due: Int
    var items: [Wakeup]
}

struct DutiesDocument: Decodable {
    var duties: [DutyDefinition]
    var wakeups: [Wakeup]
}

struct DutyDefinition: Decodable, Identifiable, Hashable {
    var id: String
    var label: String
    var enabled: Bool?
    var skills: [String]?
    var prompt: String?
}

struct Wakeup: Decodable, Identifiable, Hashable {
    var id: String
    var label: String
    var enabled: Bool
    var dispatchMode: String?
    var duties: [String]?
    var dutyIds: [String]?
    var dutyItems: [DutyDefinition]?
    var wakeTimes: [String]
    var nextRunAt: String?
    var due: Bool?
    var missingDuties: [String]?

    var selectedDutyIds: [String] {
        dutyIds ?? duties ?? []
    }
}

struct ThreadSummary: Decodable {
    var selectedThreadId: String?
    var recent: [CodexThread]
}

struct ThreadsResponse: Decodable {
    var threads: [CodexThread]
}

struct CodexThread: Decodable, Identifiable, Hashable {
    var threadId: String
    var title: String?
    var updatedAt: String?
    var cwd: String?

    var id: String { threadId }

    var displayName: String {
        if let title, !title.isEmpty { return title }
        guard let cwd, !cwd.isEmpty else { return "Codex thread" }
        let name = URL(fileURLWithPath: cwd).lastPathComponent
        return name.isEmpty ? "Codex thread" : name
    }

    var detail: String {
        let date = updatedAt.flatMap(parseWakefieldDate)
        let when = date.map(relativeTime) ?? "recent"
        if let cwd, !cwd.isEmpty {
            let name = URL(fileURLWithPath: cwd).lastPathComponent
            return title?.isEmpty == false ? "\(when), \(name)" : "\(when), \(URL(fileURLWithPath: cwd).deletingLastPathComponent().path)"
        }
        return when
    }

    var shortId: String {
        if threadId.count <= 8 { return threadId }
        return String(threadId.prefix(8))
    }
}

struct ManagedConnector: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var adapter: String
    var connectorId: String?
    var enabled: Bool
    var configured: Bool
    var ready: Bool
    var running: Bool
    var nextAction: NextAction?
    var package: PackageStatus?
    var connectorConfig: ConnectorConfigStatus?
    var mcp: MCPStatus?
    var launchAgent: LaunchAgentStatus?

    var displayName: String {
        if connectorId == "discord" { return "Discord" }
        if connectorId == "imessage" { return "iMessage" }
        if connectorId == "email" { return "Email" }
        return name.replacingOccurrences(of: " Codex Connector", with: "")
    }

    var stateText: String {
        if !enabled { return "Off" }
        if running && ready { return "Running" }
        if ready { return "Ready" }
        if configured { return "Needs tools" }
        return "Setup needed"
    }

    var symbolName: String {
        if connectorId == "discord" { return "bubble.left.and.bubble.right.fill" }
        if connectorId == "imessage" { return "message.fill" }
        if connectorId == "email" { return "envelope.fill" }
        return "point.3.connected.trianglepath.dotted"
    }
}

struct NextAction: Decodable, Hashable {
    var id: String?
    var label: String?
    var reason: String?
}

struct PackageStatus: Decodable, Hashable {
    var path: String?
    var ok: Bool?
}

struct ConnectorConfigStatus: Decodable, Hashable {
    var path: String?
    var ok: Bool?
    var targetId: String?
    var provider: String?
    var spectrum: SpectrumConnectorStatus?
    var outbound: ConnectorOutboundStatus?
}

struct SpectrumConnectorStatus: Decodable, Hashable {
    var cloudUrl: String?
    var projectUsers: PhotonProjectUsersStatus?
    var status: SpectrumRuntimeStatus?
}

struct PhotonProjectUsersStatus: Decodable, Hashable {
    var updatedAt: String?
    var total: Int?
    var users: [PhotonProjectUser]
}

struct PhotonProjectUser: Decodable, Identifiable, Hashable {
    var id: String
    var type: String?
    var displayName: String?
    var firstName: String?
    var lastName: String?
    var email: String?
    var phoneNumber: String?
    var assignedPhoneNumber: String?
    var projectOwner: Bool?
    var createdAt: String?
    var redirectUrl: String?
}

struct SpectrumRuntimeStatus: Decodable, Hashable {
    var status: String?
    var updatedAt: String?
    var knownSpaceIds: [String]?
}

struct ConnectorOutboundStatus: Decodable, Hashable {
    var allowOutboundToKnownSpaces: Bool?
    var addresses: [String]?
    var spaceIds: [String]?
}

struct MCPStatus: Decodable, Hashable {
    var ok: Bool?
    var serverName: String?
    var tools: [String]?
}

struct LaunchAgentStatus: Decodable, Hashable {
    var label: String?
    var installed: Bool?
    var loaded: Bool?
    var plistPath: String?
}

struct WizardsResponse: Decodable {
    var wizards: [ConnectorWizard]
}

struct ConnectorWizard: Decodable, Identifiable, Hashable {
    var id: String
    var connectorId: String
    var adapter: String
    var name: String
    var title: String?
    var description: String?
    var enabled: Bool
    var configured: Bool
    var ready: Bool
    var running: Bool
    var fields: [WizardField]
    var setupFields: [WizardField]
    var steps: [WizardStep]
    var nextAction: NextAction?
}

struct WizardField: Decodable, Identifiable, Hashable {
    var id: String
    var label: String
    var required: Bool?
    var placeholder: String?
    var value: String?
    var pathMustExist: Bool?
    var secretEnv: Bool?
    var envSet: Bool?
}

struct WizardStep: Decodable, Identifiable, Hashable {
    var id: String
    var title: String
    var status: String
    var description: String?
    var checks: [WizardCheck]?
}

struct WizardCheck: Decodable, Identifiable, Hashable {
    var id: String
    var label: String?
    var ok: Bool?
    var detail: String?
    var optional: Bool?
}

struct OnboardingConnectorDraft: Identifiable, Hashable {
    var id: String
    var enabled: Bool
    var values: [String: String]

    var displayName: String {
        switch id {
        case "imessage": return "iMessage"
        case "discord": return "Discord"
        case "email": return "Email"
        default: return id
        }
    }

    var subtitle: String {
        switch id {
        case "imessage": return "Photon/Spectrum for iMessage and SMS."
        case "discord": return "A bot token and allowed channels or DMs."
        case "email": return "IMAP settings for read-only intake."
        default: return ""
        }
    }

    var symbolName: String {
        switch id {
        case "imessage": return "message.fill"
        case "discord": return "bubble.left.and.bubble.right.fill"
        case "email": return "envelope.fill"
        default: return "point.3.connected.trianglepath.dotted"
        }
    }

    var missingRequiredFields: [String] {
        requiredFieldIds.filter { trimmedNonEmpty(values[$0]) == nil }
    }

    var readyForOnboarding: Bool {
        !enabled || missingRequiredFields.isEmpty
    }

    private var requiredFieldIds: [String] {
        switch id {
        case "imessage": return ["projectIdValue", "projectSecretValue"]
        case "discord": return ["tokenValue"]
        case "email": return ["imapHost", "username", "passwordValue"]
        default: return []
        }
    }

    static let defaults = [
        OnboardingConnectorDraft(id: "imessage", enabled: false, values: [
            "projectIdEnv": "PHOTON_PROJECT_ID",
            "projectSecretEnv": "PHOTON_SECRET_KEY",
            "allowGroupChats": "false"
        ]),
        OnboardingConnectorDraft(id: "discord", enabled: false, values: [
            "tokenEnv": "DISCORD_BOT_TOKEN"
        ]),
        OnboardingConnectorDraft(id: "email", enabled: false, values: [
            "passwordEnv": "WAKEFIELD_EMAIL_PASSWORD",
            "mailbox": "INBOX",
            "maxMessagesPerPoll": "10"
        ])
    ]
}

func relativeTime(_ date: Date) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    if seconds < 90 { return "just now" }
    if seconds < 5400 { return "\(seconds / 60)m ago" }
    if seconds < 172_800 { return "\(seconds / 3600)h ago" }
    return "\(seconds / 86_400)d ago"
}

func parseWakefieldDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
}
