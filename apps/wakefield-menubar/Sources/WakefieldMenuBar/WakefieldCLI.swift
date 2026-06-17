import Foundation

struct CommandResult: Sendable {
    let status: Int32
    let output: String

    var ok: Bool { status == 0 }
    var trimmedOutput: String { output.trimmingCharacters(in: .whitespacesAndNewlines) }
}

enum WakefieldCLI {
    static func json<T: Decodable>(_ args: [String], timeout: TimeInterval = 60) async throws -> T {
        let result = await run(args + ["--json"], timeout: timeout)
        guard result.ok else { throw WakefieldCLIError.command(result.trimmedOutput) }
        guard let data = result.output.data(using: .utf8) else {
            throw WakefieldCLIError.command("Wakefield returned non-UTF8 output.")
        }
        do {
            return try JSONDecoder.wakefield.decode(T.self, from: data)
        } catch {
            throw WakefieldCLIError.command("Could not read Wakefield JSON: \(error.localizedDescription)")
        }
    }

    static func run(_ args: [String], timeout: TimeInterval = 60) async -> CommandResult {
        await Task.detached(priority: .userInitiated) {
            runSync(args, timeout: timeout)
        }.value
    }

    private static func runSync(_ args: [String], timeout: TimeInterval) -> CommandResult {
        let invocation = resolveInvocation(args)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments
        process.environment = processEnvironment()

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        var collected = Data()

        do {
            try process.run()
        } catch {
            return CommandResult(status: -1, output: "Could not start Wakefield: \(error.localizedDescription)")
        }

        let reader = pipe.fileHandleForReading
        let deadline = Date().addingTimeInterval(timeout)
        let watchdog = DispatchWorkItem {
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)

        while process.isRunning, Date() < deadline {
            collected.append(reader.availableData)
        }
        process.waitUntilExit()
        watchdog.cancel()
        collected.append(reader.readDataToEndOfFile())

        let text = String(data: collected, encoding: .utf8) ?? ""
        return CommandResult(status: process.terminationStatus, output: text)
    }

    private static func resolveInvocation(_ args: [String]) -> (executable: String, arguments: [String]) {
        if let configured = configuredCLIPath(), FileManager.default.fileExists(atPath: configured) {
            if configured.hasSuffix(".mjs") {
                return nodeInvocation(script: configured, args: args)
            }
            return (configured, args)
        }
        if let dev = developmentCLIPath(), FileManager.default.fileExists(atPath: dev) {
            return nodeInvocation(script: dev, args: args)
        }
        return ("/usr/bin/env", ["wakefield"] + args)
    }

    private static func nodeInvocation(script: String, args: [String]) -> (executable: String, arguments: [String]) {
        if let node = configuredNodePath(), FileManager.default.fileExists(atPath: node) {
            return (node, [script] + args)
        }
        return ("/usr/bin/env", ["node", script] + args)
    }

    private static func configuredCLIPath() -> String? {
        let env = ProcessInfo.processInfo.environment
        if let value = env["WAKEFIELD_CLI"], !value.isEmpty { return expandHome(value) }
        if let value = Bundle.main.object(forInfoDictionaryKey: "WakefieldCLIPath") as? String, !value.isEmpty {
            return expandHome(value)
        }
        return nil
    }

    private static func developmentCLIPath() -> String? {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            url.deleteLastPathComponent()
        }
        let candidate = url.appendingPathComponent("src/cli.mjs").path
        return FileManager.default.fileExists(atPath: candidate) ? candidate : nil
    }

    private static func configuredNodePath() -> String? {
        let env = ProcessInfo.processInfo.environment
        if let value = env["WAKEFIELD_NODE"], !value.isEmpty { return expandHome(value) }
        if let value = env["WAKEFIELD_NODE_PATH"], !value.isEmpty { return expandHome(value) }
        if let value = Bundle.main.object(forInfoDictionaryKey: "WakefieldNodePath") as? String, !value.isEmpty {
            return expandHome(value)
        }
        for candidate in [
            "\(NSHomeDirectory())/.local/share/mise/shims/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ] where FileManager.default.fileExists(atPath: candidate) {
            return candidate
        }
        return nil
    }

    private static func processEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let currentPath = environment["PATH"] ?? ""
        environment["PATH"] = [
            "\(NSHomeDirectory())/.local/share/mise/shims",
            "\(NSHomeDirectory())/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            currentPath
        ].filter { !$0.isEmpty }.joined(separator: ":")
        if environment["WAKEFIELD_NODE"] == nil, let node = configuredNodePath() {
            environment["WAKEFIELD_NODE"] = node
        }
        return environment
    }
}

enum WakefieldCLIError: LocalizedError {
    case command(String)

    var errorDescription: String? {
        switch self {
        case .command(let message):
            return message.isEmpty ? "Wakefield command failed." : message
        }
    }
}

extension JSONDecoder {
    static var wakefield: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

func expandHome(_ value: String) -> String {
    NSString(string: value).expandingTildeInPath
}
