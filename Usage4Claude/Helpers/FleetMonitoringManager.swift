import Foundation
import Combine

/// Owns exactly one Mac account and its requests; Account Limits has its own store.
final class FleetMonitoringManager: ObservableObject {
    static let shared = FleetMonitoringManager()
    @Published private(set) var account: FleetMonitoringAccount?
    @Published private(set) var usageData: UsageData?
    @Published private(set) var updatedAt: Date?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRefreshing = false
    private let store: FleetMonitoringAccountStore
    private var service: ClaudeAPIService?
    private var lastAttemptAt: Date?
    private var consecutiveFailures = 0
    private var refreshDelay: TimeInterval = 300

    private init() {
        let keychain = KeychainManager.shared
        store = FleetMonitoringAccountStore(load: keychain.loadFleetMonitoringAccount,
            save: keychain.saveFleetMonitoringAccount, delete: keychain.deleteFleetMonitoringAccount)
        account = store.account
    }

    func bind(_ created: Account) throws {
        guard created.provider == .claude else { throw BindingError.saveFailed }
        let account = FleetMonitoringAccount(name: created.displayName, email: created.email ?? "",
            organizationId: created.organizationId, refreshToken: created.sessionKey)
        guard store.bind(account) else { throw BindingError.saveFailed }
        resetRequests()
        self.account = account
        notify()
        refresh()
    }

    func disconnect() {
        guard store.disconnect() else { errorMessage = L.Fleet.monitoringSaveFailed; return }
        resetRequests()
        account = nil
        notify()
    }

    private func resetRequests() {
        service?.cancelAllRequests()
        service = nil
        usageData = nil
        updatedAt = nil
        errorMessage = nil
        isRefreshing = false
        lastAttemptAt = nil
        consecutiveFailures = 0
        refreshDelay = 300
    }

    func refresh(force: Bool = false) {
        guard let account = store.account, !isRefreshing else { return }
        // Device liveness stays every minute; provider usage has its own cadence.
        if let lastAttemptAt, Date().timeIntervalSince(lastAttemptAt) < refreshDelay,
           !force || consecutiveFailures > 0 { return }
        lastAttemptAt = Date()
        isRefreshing = true
        if service == nil {
            let id = account.id
            let bound = Account(id: id, sessionKey: account.refreshToken,
                organizationId: account.organizationId, organizationName: account.name,
                alias: nil, createdAt: Date(), email: account.email)
            service = ClaudeAPIService(account: bound,
                credentialReader: { [weak self] in
                    guard self?.store.account?.id == id else { return "" }
                    return self?.store.account?.refreshToken ?? ""
                }, credentialWriter: { [weak self] previous, next in
                    guard let self else { return false }
                    let saved = self.store.rotateToken(accountId: id, previousToken: previous, newToken: next)
                    if saved { self.account = self.store.account }
                    return saved
                })
        }
        guard let service else { isRefreshing = false; return }
        Task { @MainActor [weak self] in
            let result = await service.fetchUsageResult()
            guard let self, self.store.account?.id == account.id else { return }
            self.isRefreshing = false
            switch result {
            case .success(let data):
                self.usageData = data
                self.updatedAt = Date()
                self.errorMessage = nil
                self.consecutiveFailures = 0
                self.refreshDelay = 300
            case .failure(let error):
                self.errorMessage = error.localizedDescription
                self.consecutiveFailures += 1
                self.refreshDelay = min(1800, 300 * pow(2, Double(min(self.consecutiveFailures, 3))))
            }
            self.notify()
        }
    }

    private func notify() {
        NotificationCenter.default.post(name: .fleetMonitoringChanged, object: nil)
    }

    enum BindingError: LocalizedError {
        case saveFailed
        var errorDescription: String? { L.Fleet.monitoringSaveFailed }
    }
}
