import XCTest
@testable import Usage4ClaudeCore

final class FleetMonitoringAccountTests: XCTestCase {
    private final class Storage {
        var raw: String?
        var allowsWrite = true
        var allowsDelete = true
        var writes = 0
        func makeStore() -> FleetMonitoringAccountStore {
            FleetMonitoringAccountStore(load: { self.raw }, save: { value in
                guard self.allowsWrite else { return false }
                self.raw = value
                self.writes += 1
                return true
            }, delete: {
                guard self.allowsDelete else { return false }
                self.raw = nil
                return true
            })
        }
    }

    private func account(_ name: String = "Worker", token: String = "test-refresh-a") -> FleetMonitoringAccount {
        FleetMonitoringAccount(name: name, email: "worker@example.test", organizationId: "org-a", refreshToken: token)
    }

    func testMonitoringGrantReloadsFromItsOwnStorage() {
        let storage = Storage()
        let store = storage.makeStore()
        XCTAssertNil(store.account)
        let connected = account()
        XCTAssertTrue(store.bind(connected))
        XCTAssertEqual(storage.makeStore().account, connected)
    }

    func testLegacyAccountListIsNotImportedOrSelected() throws {
        let storage = Storage()
        storage.raw = String(data: try JSONEncoder().encode([account("Account A"), account("Account B")]), encoding: .utf8)
        XCTAssertNil(storage.makeStore().account)
    }

    func testDeniedSavePreservesExistingGrant() {
        let storage = Storage()
        let store = storage.makeStore()
        let existing = account()
        XCTAssertTrue(store.bind(existing))
        storage.allowsWrite = false
        XCTAssertFalse(store.bind(account("Other", token: "test-refresh-b")))
        XCTAssertEqual(store.account, existing)
        XCTAssertEqual(storage.makeStore().account, existing)
    }

    func testRotationPersistsOnlyForMatchingGrantAndToken() {
        let storage = Storage()
        let store = storage.makeStore()
        let existing = account()
        XCTAssertTrue(store.bind(existing))
        XCTAssertTrue(store.rotateToken(accountId: existing.id, previousToken: existing.refreshToken, newToken: "test-rotated"))
        XCTAssertEqual(storage.makeStore().account?.refreshToken, "test-rotated")
        XCTAssertEqual(store.account?.id, existing.id)
        XCTAssertFalse(store.rotateToken(accountId: existing.id, previousToken: existing.refreshToken, newToken: "test-stale"))
        XCTAssertEqual(storage.makeStore().account?.refreshToken, "test-rotated")
    }

    func testLateRotationCannotRestoreReplacedOrDisconnectedAccount() {
        let storage = Storage()
        let store = storage.makeStore()
        let previous = account()
        let next = account("Other", token: "test-refresh-b")
        XCTAssertTrue(store.bind(previous))
        XCTAssertTrue(store.bind(next))
        XCTAssertFalse(store.rotateToken(accountId: previous.id, previousToken: previous.refreshToken, newToken: "test-stale"))
        XCTAssertEqual(store.account, next)
        XCTAssertTrue(store.disconnect())
        XCTAssertFalse(store.rotateToken(accountId: next.id, previousToken: next.refreshToken, newToken: "test-stale"))
        XCTAssertNil(storage.makeStore().account)
    }

    func testFailedDisconnectAndFailedRotationRetainCurrentGrant() {
        let storage = Storage()
        let store = storage.makeStore()
        let existing = account()
        XCTAssertTrue(store.bind(existing))
        storage.allowsDelete = false
        storage.allowsWrite = false
        XCTAssertFalse(store.disconnect())
        XCTAssertFalse(store.rotateToken(accountId: existing.id, previousToken: existing.refreshToken, newToken: "test-rotated"))
        XCTAssertEqual(store.account, existing)
        XCTAssertEqual(storage.makeStore().account, existing)
    }
}
