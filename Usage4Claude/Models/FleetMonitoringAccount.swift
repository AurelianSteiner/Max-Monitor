import Foundation

/// A separate OAuth grant for this Mac, never an Account Limits selection.
struct FleetMonitoringAccount: Codable, Equatable {
    let id: UUID
    let name: String
    let email: String
    let organizationId: String
    var refreshToken: String

    init(id: UUID = UUID(), name: String, email: String, organizationId: String, refreshToken: String) {
        self.id = id
        self.name = name
        self.email = email
        self.organizationId = organizationId
        self.refreshToken = refreshToken
    }
}

/// Persistence is injected so failed writes and late token rotations are testable.
final class FleetMonitoringAccountStore {
    private(set) var account: FleetMonitoringAccount?
    private let save: (String) -> Bool
    private let delete: () -> Bool

    init(load: () -> String?, save: @escaping (String) -> Bool, delete: @escaping () -> Bool) {
        self.save = save
        self.delete = delete
        if let raw = load(), let data = raw.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(FleetMonitoringAccount.self, from: data),
           !decoded.refreshToken.isEmpty {
            account = decoded
        }
    }

    @discardableResult
    func bind(_ account: FleetMonitoringAccount) -> Bool {
        guard !account.refreshToken.isEmpty,
              let data = try? JSONEncoder().encode(account),
              let raw = String(data: data, encoding: .utf8), save(raw) else { return false }
        self.account = account
        return true
    }

    @discardableResult
    func rotateToken(accountId: UUID, previousToken: String, newToken: String) -> Bool {
        guard var current = account, current.id == accountId,
              current.refreshToken == previousToken, !newToken.isEmpty else { return false }
        current.refreshToken = newToken
        return bind(current)
    }

    @discardableResult
    func disconnect() -> Bool {
        guard delete() else { return false }
        account = nil
        return true
    }
}
