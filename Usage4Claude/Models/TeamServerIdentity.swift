import Foundation

/// Reporting purpose is independent of the member's access role.
enum FleetWorkerKind: String, Codable, Equatable {
    case newsletter
    case codexRepair = "codex-repair"

    static func usesClaudeMonitoring(_ raw: String) -> Bool {
        Self(rawValue: raw) == .newsletter
    }
}

/// What a token is allowed to do on the team relay.
enum TeamServerRole: String, Codable, Equatable, CaseIterable {
    case superAdmin = "super"
    case admin
    case member
    case guest

    init(lenient raw: String?) {
        switch raw?.lowercased() {
        case "super": self = .superAdmin
        case "admin": self = .admin
        case "guest": self = .guest
        default: self = .member
        }
    }

    var seesAllReports: Bool { true }
    var canManageMembers: Bool { self == .superAdmin }
    var canViewMembers: Bool { self != .member }
    var canDeleteMacs: Bool { self == .superAdmin || self == .admin }
}

/// GET /me response. No local account selection can change its worker purpose.
struct TeamServerIdentity: Equatable {
    let role: TeamServerRole
    let name: String?
    let memberId: String?
    let macWorker: Bool
    var workerKind: String = "newsletter"
}

extension TeamServerIdentity: Decodable {
    private enum CodingKeys: String, CodingKey { case role, name, memberId, macWorker, workerKind }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = TeamServerRole(lenient: try? container.decodeIfPresent(String.self, forKey: .role))
        macWorker = try container.decodeIfPresent(Bool.self, forKey: .macWorker) ?? (role == .member)
        workerKind = container.contains(.workerKind)
            ? try container.decode(String.self, forKey: .workerKind) : "newsletter"
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? nil
        memberId = (try? container.decodeIfPresent(String.self, forKey: .memberId)) ?? nil
    }
}
