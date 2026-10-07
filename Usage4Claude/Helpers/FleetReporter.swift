import AppKit
import Combine
import IOKit.ps
import OSLog

/// A separate liveness loop: reports even without an account or after an API
/// failure. The older person-level TeamAutoReporter remains compatible.
final class FleetReporter {
    static let shared = FleetReporter()
    static let heartbeatInterval: TimeInterval = 10 * 60

    private var timer: Timer?
    private var cancellables = Set<AnyCancellable>()
    private var isPosting = false
    private var pendingReport = false
    private var lastAttemptAt: Date?

    private init() {
        NotificationCenter.default.publisher(for: .teamServerChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.connectionDidChange() }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .fleetMonitoringChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.report(force: true) }
            .store(in: &cancellables)

        NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.report() }
            .store(in: &cancellables)

        DispatchQueue.main.async { [weak self] in self?.connectionDidChange() }
    }

    func connectionDidChange() {
        dispatchPrecondition(condition: .onQueue(.main))
        let connection = TeamServerConnection.shared
        let connected = connection.client != nil && connection.role != nil

        timer?.invalidate()
        timer = nil
        if connected {
            let timer = Timer(timeInterval: Self.heartbeatInterval, repeats: true) { [weak self] _ in
                self?.report()
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            lastAttemptAt = nil
            report()
        }
    }

    /// Provider refresh is bounded: a stuck request must not hide a healthy Mac.
    func report(now: Date = Date(), force: Bool = false) {
        dispatchPrecondition(condition: .onQueue(.main))
        let connection = TeamServerConnection.shared
        guard let teamId = connection.teamId, let client = connection.client,
              connection.role != nil else { return }
        if isPosting {
            if force { pendingReport = true }
            return
        }
        if !force, let lastAttemptAt, now.timeIntervalSince(lastAttemptAt) < 60 { return }
        lastAttemptAt = now
        isPosting = true
        FleetMonitoringManager.shared.refresh()

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.isPosting = false
                if self.pendingReport {
                    self.pendingReport = false
                    self.report(force: true)
                }
            }
            // Give the separate monitoring request time to finish. Device liveness
            // still gets sent if Claude is unavailable; never refresh its data stamp.
            for _ in 0..<20 {
                guard FleetMonitoringManager.shared.isRefreshing else { break }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            let battery = await Task.detached(priority: .utility) { Self.readBattery() }.value
            guard TeamServerConnection.shared.teamId == teamId,
                  TeamServerConnection.shared.isConnected,
                  TeamServerConnection.shared.role != nil else { return }
            let heartbeat = Self.buildHeartbeat(teamId: teamId, monitoring: FleetMonitoringManager.shared,
                                                battery: battery, now: Date())
            do {
                try await client.postHeartbeat(heartbeat)
                Logger.team.debug("Mac-Heartbeat gemeldet")
            } catch {
                if let serverError = error as? TeamServerError, serverError == .invalidToken {
                    TeamServerConnection.shared.verifyIdentity()
                }
                Logger.team.info("Mac-Heartbeat fehlgeschlagen: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    static func buildHeartbeat(teamId: String, monitoring: FleetMonitoringManager,
                               battery: BatteryTelemetry, now: Date) -> FleetHeartbeat {
        let account = monitoring.account
        let accountId = account?.id.uuidString.lowercased()
        let accounts = account.map {
            [FleetUsageAccount(accountId: $0.id.uuidString.lowercased(), name: String($0.name.prefix(120)),
                provider: "claude", usageUpdatedAt: monitoring.updatedAt,
                usageError: monitoring.errorMessage.map { String($0.prefix(500)) })]
        } ?? []
        var limits: [FleetUsageLimit] = []
        if let account, let data = monitoring.usageData {
            func add(_ value: UsageData.LimitData?, kind: String, label: String) {
                guard let value, let limit = FleetUsageLimit(accountId: account.id.uuidString.lowercased(),
                    accountName: account.name, label: label, kind: kind,
                    percent: value.percentage, resetsAt: value.resetsAt,
                    usageUpdatedAt: monitoring.updatedAt, usageError: monitoring.errorMessage) else { return }
                limits.append(limit)
            }
            add(data.fiveHour, kind: "session", label: "5h")
            add(data.sevenDay, kind: "weekly", label: "7d")
            for (index, model) in data.weeklyModels.enumerated() {
                add(model.limit, kind: "model:\(index)", label: model.modelName ?? "Model \(index + 1)")
            }
        }
        var heartbeat = FleetHeartbeat(teamId: teamId, deviceId: FleetSettings.deviceId(),
            name: String((Host.current().localizedName ?? ProcessInfo.processInfo.hostName).prefix(120)),
            workerId: FleetSettings.workerId, reportedAt: now,
            batteryPercent: FleetHeartbeat.normalizedBatteryPercent(battery.percent), powerSource: battery.powerSource,
            isCharging: battery.isCharging, isAwake: true, stayAwakeEnabled: SleepGuard.shared.isAwake,
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            limits: Array(limits.prefix(50)), accounts: accounts, usageUpdatedAt: monitoring.updatedAt,
            usageError: monitoring.errorMessage.map { String($0.prefix(500)) })
        heartbeat.monitoringAccountId = accountId
        return heartbeat
    }

    struct BatteryTelemetry: Sendable {
        let percent: Double?
        let powerSource: String?
        let isCharging: Bool?
    }

    private static func readBattery() -> BatteryTelemetry {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else {
            return BatteryTelemetry(percent: nil, powerSource: nil, isCharging: nil)
        }
        for source in list {
            guard let description = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  let current = description[kIOPSCurrentCapacityKey] as? NSNumber,
                  let maximum = description[kIOPSMaxCapacityKey] as? NSNumber, maximum.doubleValue > 0 else { continue }
            let power = description[kIOPSPowerSourceStateKey] as? String
            return BatteryTelemetry(percent: min(100, max(0, current.doubleValue / maximum.doubleValue * 100)),
                                    powerSource: power == kIOPSACPowerValue ? "ac" : "battery",
                                    isCharging: description[kIOPSIsChargingKey] as? Bool)
        }
        // Desktop Macs have no battery. This is distinct from a zero-percent battery.
        return BatteryTelemetry(percent: nil, powerSource: "ac", isCharging: nil)
    }
}
