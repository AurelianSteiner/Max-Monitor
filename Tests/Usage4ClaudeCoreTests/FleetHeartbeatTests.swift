import XCTest
@testable import Usage4ClaudeCore

final class FleetHeartbeatTests: XCTestCase {
    func testHeartbeatPreservesAccountDataTimeWhenDeviceReportsAgain() throws {
        let usageAt = Date(timeIntervalSince1970: 1_700_000_000)
        let now = usageAt.addingTimeInterval(1800)
        let account = FleetUsageAccount(accountId: "account", name: "Worker account", provider: "claude",
                                       usageUpdatedAt: usageAt, usageError: "Sign in again")
        let limit = try XCTUnwrap(FleetUsageLimit(accountId: "account", accountName: account.name,
            label: "5h", kind: "session", percent: 72.5, resetsAt: nil,
            usageUpdatedAt: usageAt, usageError: account.usageError))
        let heartbeat = FleetHeartbeat(teamId: "TESTTEAM", deviceId: UUID().uuidString, name: "Mac worker",
            workerId: "worker-1", reportedAt: now, batteryPercent: nil, powerSource: "ac", isCharging: nil,
            isAwake: true, stayAwakeEnabled: false, appVersion: "1.0", limits: [limit], accounts: [account],
            usageUpdatedAt: usageAt, usageError: account.usageError)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: heartbeat.jsonData()) as? [String: Any])
        let accounts = try XCTUnwrap(json["accounts"] as? [[String: Any]])
        XCTAssertNotEqual(json["reportedAt"] as? String, accounts[0]["usageUpdatedAt"] as? String)
        XCTAssertEqual(accounts[0]["usageError"] as? String, "Sign in again")
        XCTAssertNil(json["token"])
        XCTAssertNil(json["batteryPercent"])
        XCTAssertTrue(account.isStale(now: now))
    }

    func testInvalidLimitIsDroppedAndFinitePercentagesAreClamped() {
        func limit(_ value: Double) -> FleetUsageLimit? {
            FleetUsageLimit(accountId: "account", accountName: "Account", label: "7d", kind: "weekly",
                            percent: value, resetsAt: nil, usageUpdatedAt: nil, usageError: nil)
        }
        XCTAssertNil(limit(.nan))
        XCTAssertNil(limit(.infinity))
        XCTAssertEqual(limit(45.6)?.percent, 46)
        XCTAssertEqual(limit(140)?.percent, 100)
        XCTAssertEqual(limit(-1)?.percent, 0)
    }

    func testBatteryPercentageRoundsToIntegerOrRemainsUnavailable() throws {
        XCTAssertEqual(FleetHeartbeat.normalizedBatteryPercent(62.8), 63)
        XCTAssertEqual(FleetHeartbeat.normalizedBatteryPercent(123.4), 100)
        XCTAssertEqual(FleetHeartbeat.normalizedBatteryPercent(-1), 0)
        XCTAssertNil(FleetHeartbeat.normalizedBatteryPercent(nil))
        XCTAssertNil(FleetHeartbeat.normalizedBatteryPercent(.nan))
        let heartbeat = FleetHeartbeat(teamId: "TESTTEAM", deviceId: UUID().uuidString, name: "Mac worker",
            workerId: nil, reportedAt: Date(), batteryPercent: FleetHeartbeat.normalizedBatteryPercent(62.8),
            powerSource: "battery", isCharging: false, isAwake: true, stayAwakeEnabled: false,
            appVersion: nil, limits: [], accounts: [], usageUpdatedAt: nil, usageError: nil)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: heartbeat.jsonData()) as? [String: Any])
        XCTAssertEqual((json["batteryPercent"] as? NSNumber)?.intValue, 63)
    }

    func testUnknownUsageIsStaleAndFreshnessBoundaryIsInclusive() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let missing = FleetUsageAccount(accountId: "a", name: "Account", provider: "claude", usageUpdatedAt: nil, usageError: nil)
        XCTAssertTrue(missing.isStale(now: now))
        let boundary = FleetUsageAccount(accountId: "a", name: "Account", provider: "claude",
                                        usageUpdatedAt: now.addingTimeInterval(-900), usageError: nil)
        XCTAssertFalse(boundary.isStale(now: now))
        XCTAssertTrue(boundary.isStale(now: now.addingTimeInterval(1)))
    }

    func testDeviceIdentityPersistsWithoutDependingOnHostname() {
        let suite = "FleetHeartbeatTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = FleetSettings.deviceId(in: defaults)
        XCTAssertNotNil(UUID(uuidString: first))
        XCTAssertEqual(first, FleetSettings.deviceId(in: defaults))
        defaults.set("invalid old value", forKey: FleetSettings.deviceIdKey)
        let repaired = FleetSettings.deviceId(in: defaults)
        XCTAssertNotEqual(first, repaired)
        XCTAssertNotNil(UUID(uuidString: repaired))
    }
}
