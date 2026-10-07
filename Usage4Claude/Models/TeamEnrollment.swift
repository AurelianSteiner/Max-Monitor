import Foundation

/// Only the installer-to-app wire format. Credentials arrive through stdin, never arguments.
struct TeamEnrollmentRequest: Decodable {
    let serverURL: String
    let teamId: String
    let token: String
    let memberId: String
    let workerId: String
    let deviceId: String
    var launchAtLogin: Bool? = true

    func validated() throws -> ValidatedTeamEnrollment {
        guard let components = URLComponents(string: serverURL),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              !components.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              components.percentEncodedPath == components.path,
              components.port == nil || (1...65535).contains(components.port!) else {
            throw TeamEnrollmentValidationError.invalidServerURL
        }
        let loopback = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        guard scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(loopback)) else {
            throw TeamEnrollmentValidationError.invalidServerURL
        }
        var normalized = components
        normalized.scheme = scheme
        normalized.host = host.lowercased()
        let prefix = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        normalized.path = prefix.isEmpty ? "" : "/" + prefix
        guard let url = normalized.url else { throw TeamEnrollmentValidationError.invalidServerURL }

        let normalizedTeam = teamId.uppercased()
        guard (4...16).contains(normalizedTeam.count),
              normalizedTeam.allSatisfy({ "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".contains($0) }) else {
            throw TeamEnrollmentValidationError.invalidTeamId
        }
        guard (1...4096).contains(token.utf8.count),
              token.utf8.allSatisfy({ (33...126).contains($0) }) else {
            throw TeamEnrollmentValidationError.invalidToken
        }
        guard (1...120).contains(workerId.utf8.count),
              workerId.utf8.allSatisfy({ (33...126).contains($0) }) else {
            throw TeamEnrollmentValidationError.invalidWorkerId
        }
        guard (1...160).contains(memberId.utf8.count),
              memberId.utf8.allSatisfy({ (33...126).contains($0) }) else {
            throw TeamEnrollmentValidationError.invalidMemberId
        }
        guard let uuid = UUID(uuidString: deviceId) else {
            throw TeamEnrollmentValidationError.invalidDeviceId
        }
        return ValidatedTeamEnrollment(serverURL: url, teamId: normalizedTeam, token: token,
                                       memberId: memberId, workerId: workerId,
                                       deviceId: uuid.uuidString.lowercased(), launchAtLogin: launchAtLogin ?? true)
    }
}

struct ValidatedTeamEnrollment {
    let serverURL: URL
    let teamId: String
    let token: String
    let memberId: String
    let workerId: String
    let deviceId: String
    let launchAtLogin: Bool

    /// Provisioning never repurposes an already configured Mac silently.
    func validateExisting(deviceId ownDeviceId: String, serverURL savedURL: String?,
                          teamId savedTeamId: String?, memberId savedMemberId: String?,
                          workerId savedWorkerId: String?, role savedRole: String? = nil) throws {
        guard ownDeviceId.lowercased() == deviceId else { throw TeamEnrollmentValidationError.deviceMismatch }
        if let savedTeamId {
            guard savedRole == nil || savedRole == "member",
                  savedTeamId == teamId,
                  savedURL.flatMap(URL.init(string:))?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    == serverURL.absoluteString,
                  savedMemberId == nil || savedMemberId == memberId else {
                throw TeamEnrollmentValidationError.existingConnection
            }
        }
        if let savedWorkerId, !savedWorkerId.isEmpty, savedWorkerId != workerId {
            throw TeamEnrollmentValidationError.existingWorker
        }
    }
}

enum TeamEnrollmentValidationError: Error, CustomStringConvertible {
    case invalidServerURL, invalidTeamId, invalidToken, invalidWorkerId, invalidMemberId, invalidDeviceId
    case deviceMismatch, existingConnection, existingWorker

    var description: String {
        switch self {
        case .invalidServerURL: return "Use a clean HTTPS relay URL; loopback HTTP is allowed for local testing."
        case .invalidTeamId: return "Team ID must contain 4–16 letters or digits."
        case .invalidToken: return "Member token is missing or invalid."
        case .invalidWorkerId: return "Worker ID is missing or invalid."
        case .invalidMemberId: return "Expected member ID is missing or invalid."
        case .invalidDeviceId: return "Device ID must be a UUID."
        case .deviceMismatch: return "Enrollment belongs to another device."
        case .existingConnection: return "This Mac already has a different team or member connection."
        case .existingWorker: return "This Mac already has a different worker ID."
        }
    }
}
