import Foundation

/// Device availability and provider data have separate clocks. A heartbeat never
/// makes an old account snapshot fresh, and no provider credentials leave the Mac.
struct FleetHeartbeat: Encodable, Sendable {
    let teamId: String
    let deviceId: String
    let name: String
    let workerId: String?
    let reportedAt: Date
    let batteryPercent: Int?
    let powerSource: String?
    let isCharging: Bool?
    let isAwake: Bool
    let stayAwakeEnabled: Bool
    let appVersion: String?
    let limits: [FleetUsageLimit]
    let accounts: [FleetUsageAccount]
    let usageUpdatedAt: Date?
    let usageError: String?

    func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(self)
    }

    static func normalizedBatteryPercent(_ value: Double?) -> Int? {
        guard let value, value.isFinite else { return nil }
        return Int(min(100, max(0, value)).rounded())
    }
}

struct FleetUsageAccount: Encodable, Sendable, Equatable {
    let accountId: String
    let name: String
    let provider: String
    let usageUpdatedAt: Date?
    let usageError: String?

    func isStale(now: Date = Date(), maximumAge: TimeInterval = 15 * 60) -> Bool {
        guard let usageUpdatedAt else { return true }
        return now.timeIntervalSince(usageUpdatedAt) > maximumAge
    }
}

struct FleetUsageLimit: Encodable, Sendable, Equatable {
    let accountId: String
    let accountName: String
    let label: String
    let kind: String
    let percent: Double
    let resetsAt: Date?
    let usageUpdatedAt: Date?
    let usageError: String?

    init?(accountId: String, accountName: String, label: String, kind: String,
          percent: Double, resetsAt: Date?, usageUpdatedAt: Date?, usageError: String?) {
        // Do not turn invalid provider values into a reassuring zero.
        guard percent.isFinite else { return nil }
        self.accountId = accountId
        self.accountName = String(accountName.prefix(120))
        self.label = String(label.prefix(160))
        self.kind = String(kind.prefix(80))
        self.percent = min(100, max(0, percent.rounded()))
        self.resetsAt = resetsAt
        self.usageUpdatedAt = usageUpdatedAt
        self.usageError = usageError.map { String($0.prefix(500)) }
    }
}

enum FleetSettings {
    #if DEBUG
    static let deviceIdKey = "DEBUG_fleetDeviceId"
    static let workerIdKey = "DEBUG_fleetWorkerId"
    #else
    static let deviceIdKey = "fleetDeviceId"
    static let workerIdKey = "fleetWorkerId"
    #endif

    static func deviceId(in defaults: UserDefaults = .standard) -> String {
        if let raw = defaults.string(forKey: deviceIdKey), let id = UUID(uuidString: raw) {
            return id.uuidString.lowercased()
        }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: deviceIdKey)
        return id
    }

    static var workerId: String? {
        let value = UserDefaults.standard.string(forKey: workerIdKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : String(value.prefix(120))
    }
}
