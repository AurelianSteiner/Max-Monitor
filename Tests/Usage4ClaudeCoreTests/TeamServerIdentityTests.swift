import Foundation
import XCTest
@testable import Usage4ClaudeCore

final class TeamServerIdentityTests: XCTestCase {
    private func decode(_ json: String) throws -> TeamServerIdentity {
        try JSONDecoder().decode(TeamServerIdentity.self, from: Data(json.utf8))
    }

    func testLegacyIdentityKeepsNewsletterMonitoringAndExistingRoleDefaults() throws {
        let identity = try decode(#"{"role":"member","name":"Rot","memberId":"rot"}"#)
        XCTAssertEqual(identity.workerKind, "newsletter")
        XCTAssertTrue(FleetWorkerKind.usesClaudeMonitoring(identity.workerKind))
        XCTAssertTrue(identity.macWorker)
        XCTAssertFalse(identity.role.canManageMembers)
        XCTAssertFalse(identity.role.canDeleteMacs)
        XCTAssertEqual(try decode(#"{"role":"guest"}"#).macWorker, false)
    }

    func testCodexPurposeDoesNotGrantAccessOrOverrideReportingOptOut() throws {
        for role in ["member", "guest", "admin", "super"] {
            let json = "{\"role\":\"\(role)\",\"macWorker\":false,\"workerKind\":\"codex-repair\"}"
            let identity = try decode(json)
            XCTAssertEqual(identity.workerKind, "codex-repair")
            XCTAssertFalse(FleetWorkerKind.usesClaudeMonitoring(identity.workerKind))
            XCTAssertFalse(identity.macWorker)
            XCTAssertEqual(identity.role.canManageMembers, role == "super")
            XCTAssertEqual(identity.role.canDeleteMacs, role == "super" || role == "admin")
        }
        let enabled = try decode(#"{"role":"member","macWorker":true,"workerKind":"codex-repair"}"#)
        XCTAssertTrue(enabled.macWorker)
        XCTAssertFalse(FleetWorkerKind.usesClaudeMonitoring(enabled.workerKind))
    }

    func testWorkerPurposeChangesIdentityAndUnknownPurposeNeverStartsClaudeMonitoring() throws {
        let newsletter = try decode(#"{"role":"member","workerKind":"newsletter"}"#)
        let repair = try decode(#"{"role":"member","workerKind":"codex-repair"}"#)
        XCTAssertNotEqual(newsletter, repair)
        for kind in ["future-worker", "", "Claude", "CODEX-REPAIR"] {
            let identity = try decode("{\"role\":\"member\",\"workerKind\":\"\(kind)\"}")
            XCTAssertEqual(identity.workerKind, kind)
            XCTAssertFalse(FleetWorkerKind.usesClaudeMonitoring(identity.workerKind))
        }
        XCTAssertThrowsError(try decode(#"{"role":"member","workerKind":42}"#))
        XCTAssertThrowsError(try decode(#"{"role":"member","workerKind":null}"#))
    }
}
