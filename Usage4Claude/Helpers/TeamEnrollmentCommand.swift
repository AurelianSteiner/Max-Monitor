import Foundation
import ServiceManagement
import Darwin

/// Runs before the normal application bootstrap: no windows, reporters, or provider refreshes.
enum TeamEnrollmentCommand {
    static func runIfRequested(arguments: [String] = CommandLine.arguments) -> Int32? {
        let known = ["--device-id", "--enrollment-status", "--enroll"]
        guard arguments.dropFirst().contains(where: known.contains) else { return nil }
        if Array(arguments.dropFirst()) == ["--enrollment-status", "--verify"] { return verifyStoredConnection() }
        guard arguments.count == 2 else { return failure("Use exactly one enrollment command.", code: 64) }
        switch arguments[1] {
        case "--device-id":
            print(FleetSettings.deviceId())
            _ = UserDefaults.standard.synchronize()
            return 0
        case "--enrollment-status":
            emit(status())
            _ = UserDefaults.standard.synchronize()
            return 0
        case "--enroll":
            return enroll()
        default:
            return failure("Unknown enrollment command.", code: 64)
        }
    }

    private static func enroll() -> Int32 {
        guard isatty(STDIN_FILENO) == 0 else {
            return failure("Provide enrollment JSON through protected stdin.", code: 64)
        }
        let data = FileHandle.standardInput.readData(ofLength: 16_385)
        guard !data.isEmpty, data.count <= 16_384 else {
            return failure("Enrollment JSON must be between 1 and 16384 bytes.", code: 64)
        }
        let enrollment: ValidatedTeamEnrollment
        do {
            enrollment = try JSONDecoder().decode(TeamEnrollmentRequest.self, from: data).validated()
            let defaults = UserDefaults.standard
            try enrollment.validateExisting(deviceId: FleetSettings.deviceId(),
                serverURL: defaults.string(forKey: TeamServerDefaultsKeys.serverURL),
                teamId: defaults.string(forKey: TeamServerDefaultsKeys.teamId),
                memberId: defaults.string(forKey: TeamServerDefaultsKeys.memberId),
                workerId: FleetSettings.workerId,
                role: defaults.string(forKey: TeamServerDefaultsKeys.role))
        } catch let error as TeamEnrollmentValidationError {
            return failure(error.description, code: 64)
        } catch {
            return failure("Enrollment JSON has missing or invalid fields.", code: 64)
        }

        progress("relay")
        let identity: EnrollmentIdentity
        do {
            identity = try identify(enrollment)
        } catch {
            // Do not print upstream payloads, URLs, or errors which could echo credentials.
            return failure("Relay validation failed; no connection settings were changed.", code: 65)
        }
        guard identity.role == "member", identity.memberId == enrollment.memberId else {
            return failure("Enrollment requires the expected ordinary member identity.", code: 65)
        }

        progress("credentials")
        let keychain = KeychainManager.shared
        let previousToken = keychain.loadTeamServerToken()
        if previousToken != enrollment.token {
            guard keychain.saveTeamServerToken(enrollment.token),
                  keychain.loadTeamServerToken() == enrollment.token else {
                // A failed write must not discard an existing usable connection.
                if let previousToken { _ = keychain.saveTeamServerToken(previousToken) }
                return failure("Credential storage refused enrollment; settings were preserved.", code: 66)
            }
        }
        progress("settings")
        let defaults = UserDefaults.standard
        defaults.set(enrollment.serverURL.absoluteString, forKey: TeamServerDefaultsKeys.serverURL)
        defaults.set(enrollment.teamId, forKey: TeamServerDefaultsKeys.teamId)
        defaults.set(identity.role, forKey: TeamServerDefaultsKeys.role)
        defaults.set(identity.memberId, forKey: TeamServerDefaultsKeys.memberId)
        if let name = identity.name { defaults.set(name, forKey: TeamServerDefaultsKeys.memberName) }
        else { defaults.removeObject(forKey: TeamServerDefaultsKeys.memberName) }
        defaults.set(enrollment.workerId, forKey: FleetSettings.workerIdKey)
        TeamServerConnection.removeLegacyFolderConfiguration()
        _ = defaults.synchronize()

        progress("login")
        if enrollment.launchAtLogin && SMAppService.mainApp.status != .enabled {
            // macOS may require user approval. Persist the verified connection regardless,
            // and expose the actual registration state to the installer.
            try? SMAppService.mainApp.register()
        }
        progress("complete")
        emit(status())
        return 0
    }

    /// Fixed phase names only: never put enrollment data or upstream errors on stderr.
    private static func progress(_ stage: String) {
        FileHandle.standardError.write(Data("MAX_MONITOR_ENROLLMENT_STAGE:\(stage)\n".utf8))
    }

    private static func status() -> [String: Any] {
        let defaults = UserDefaults.standard
        let teamId = defaults.string(forKey: TeamServerDefaultsKeys.teamId)
        return [
            "schema": 1,
            "deviceId": FleetSettings.deviceId(),
            "bundleId": Bundle.main.bundleIdentifier ?? "xyz.fi5h.Usage4Claude",
            "configured": teamId != nil && KeychainManager.shared.loadTeamServerToken() != nil,
            "serverURL": defaults.string(forKey: TeamServerDefaultsKeys.serverURL) as Any? ?? NSNull(),
            "teamId": teamId as Any? ?? NSNull(),
            "workerId": FleetSettings.workerId as Any? ?? NSNull(),
            "memberId": defaults.string(forKey: TeamServerDefaultsKeys.memberId) as Any? ?? NSNull(),
            "role": defaults.string(forKey: TeamServerDefaultsKeys.role) as Any? ?? NSNull(),
            "launchAtLoginStatus": loginStatus()
        ]
    }

private static func verifyStoredConnection() -> Int32 {
        var result = status()
        result["verified"] = false
        result["fleetAvailable"] = false
        let defaults = UserDefaults.standard
        guard let serverURL = defaults.string(forKey: TeamServerDefaultsKeys.serverURL),
              let teamId = defaults.string(forKey: TeamServerDefaultsKeys.teamId),
              let memberId = defaults.string(forKey: TeamServerDefaultsKeys.memberId),
              let workerId = FleetSettings.workerId,
              let token = KeychainManager.shared.loadTeamServerToken() else {
            result["health"] = "notConfigured"
            emit(result)
            return 65
        }
        do {
            let enrollment = try TeamEnrollmentRequest(serverURL: serverURL, teamId: teamId, token: token,
                memberId: memberId, workerId: workerId, deviceId: FleetSettings.deviceId(),
                launchAtLogin: false).validated()
            let identity = try identify(enrollment)
            guard identity.role == "member", identity.memberId == memberId else {
                throw EnrollmentCommandError.validationFailed
            }
            let fleet = try relayData(enrollment, path: "fleet", maximumBytes: 16 * 1024 * 1024)
            guard let object = try JSONSerialization.jsonObject(with: fleet) as? [String: Any],
                  object["schema"] as? Int == 1, object["machines"] is [Any],
                  object["queue"] is [String: Any] else { throw EnrollmentCommandError.validationFailed }
            result["verified"] = true
            result["fleetAvailable"] = true
            result["health"] = "verified"
            emit(result)
            return 0
        } catch {
            result["health"] = "unavailable"
            emit(result)
            return 65
        }
    }

    private static func loginStatus() -> String {
        switch SMAppService.mainApp.status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered: return "notRegistered"
        case .notFound: return "notFound"
        @unknown default: return "unknown"
        }
    }

    private struct EnrollmentIdentity: Decodable {
        let role: String
        let memberId: String
        let name: String?
    }

    private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private final class ResponseBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: (Data?, URLResponse?, Error?)?
        func store(_ data: Data?, _ response: URLResponse?, _ error: Error?) {
            lock.lock(); defer { lock.unlock() }
            value = (data, response, error)
        }
        func load() -> (Data?, URLResponse?, Error?)? {
            lock.lock(); defer { lock.unlock() }
            return value
        }
    }

    private static func identify(_ enrollment: ValidatedTeamEnrollment) throws -> EnrollmentIdentity {
        let data = try relayData(enrollment, path: "me", maximumBytes: 65_536)
        return try JSONDecoder().decode(EnrollmentIdentity.self, from: data)
    }

private static func relayData(_ enrollment: ValidatedTeamEnrollment, path: String,
                                  maximumBytes: Int) throws -> Data {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 25
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: RedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let url = enrollment.serverURL.appendingPathComponent("v1/teams/\(enrollment.teamId)/\(path)")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(enrollment.token)", forHTTPHeaderField: "Authorization")
        let completed = DispatchSemaphore(value: 0)
        let box = ResponseBox()
        session.dataTask(with: request) { data, response, error in
            box.store(data, response, error)
            completed.signal()
        }.resume()
        guard completed.wait(timeout: .now() + 30) == .success,
              let (data, response, error) = box.load(), error == nil,
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let data, data.count <= maximumBytes else { throw EnrollmentCommandError.validationFailed }
        return data
    }

    private enum EnrollmentCommandError: Error { case validationFailed }

    private static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        print(json)
    }

    private static func failure(_ message: String, code: Int32) -> Int32 {
        emit(["ok": false, "error": message])
        return code
    }
}
