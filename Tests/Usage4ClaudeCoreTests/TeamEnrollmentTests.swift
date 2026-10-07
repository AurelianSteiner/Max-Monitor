import XCTest
@testable import Usage4ClaudeCore

final class TeamEnrollmentTests: XCTestCase {
    private let deviceId = "67e3fd35-331a-4c8c-a2b1-1d0617f24913"

    private func request(serverURL: String = "https://relay.example/", teamId: String = "TEAM1234",
                         token: String = "opaque-member-token", workerId: String = "macbook-5",
                         memberId: String = "member-5", deviceId: String? = nil) -> TeamEnrollmentRequest {
        TeamEnrollmentRequest(serverURL: serverURL, teamId: teamId, token: token, memberId: memberId,
                              workerId: workerId, deviceId: deviceId ?? self.deviceId, launchAtLogin: true)
    }

    func testAcceptsCanonicalSecureRelayAndNormalizesIdentity() throws {
        let enrollment = try request(serverURL: "HTTPS://Relay.Example/", teamId: "team1234",
                                     deviceId: deviceId.uppercased()).validated()
        XCTAssertEqual(enrollment.serverURL.absoluteString, "https://relay.example")
        XCTAssertEqual(enrollment.teamId, "TEAM1234")
        XCTAssertEqual(enrollment.deviceId, deviceId)
        XCTAssertTrue(enrollment.launchAtLogin)
    }

    func testRejectsCredentialLeaksAndUnsafeRelayPaths() {
        for server in ["http://relay.example", "ftp://relay.example", "https://user:password@relay.example",
                       "https://relay.example/../fleet", "https://relay.example/%2fsecrets", "https://relay.example?token=secret", "https://relay.example#fragment"] {
            XCTAssertThrowsError(try request(serverURL: server).validated(), server)
        }
        for server in ["http://localhost:8940", "http://127.0.0.1:8940/", "http://[::1]:8940"] {
            XCTAssertNoThrow(try request(serverURL: server).validated(), server)
        }
    }

    func testAllowsRelayMountedUnderAnHTTPSPathPrefix() throws {
        let enrollment = try request(serverURL: "https://api.ruegamer-steiner.de/max-monitor/").validated()
        XCTAssertEqual(enrollment.serverURL.absoluteString, "https://api.ruegamer-steiner.de/max-monitor")
        XCTAssertEqual(enrollment.serverURL.appendingPathComponent("v1/teams/TEAM1234/me").absoluteString,
                       "https://api.ruegamer-steiner.de/max-monitor/v1/teams/TEAM1234/me")
        XCTAssertNoThrow(try enrollment.validateExisting(deviceId: deviceId,
            serverURL: "https://api.ruegamer-steiner.de/max-monitor/", teamId: "TEAM1234",
            memberId: "member-5", workerId: "macbook-5"))
    }

    func testRejectsHeaderInjectionAndMalformedIdentifiers() {
        for token in ["", "token\r\nAuthorization: malicious", "has a space", String(repeating: "a", count: 4097)] {
            XCTAssertThrowsError(try request(token: token).validated())
        }
        for team in ["abc", "TEAM/1234", "TEAM 1234", String(repeating: "A", count: 17)] {
            XCTAssertThrowsError(try request(teamId: team).validated())
        }
        XCTAssertThrowsError(try request(workerId: "mac\n5").validated())
        XCTAssertThrowsError(try request(memberId: "").validated())
        XCTAssertThrowsError(try request(deviceId: "not-a-device-uuid").validated())
    }

    func testIdempotentEnrollmentAndPreexistingWorkerAreAllowed() throws {
        let enrollment = try request().validated()
        XCTAssertNoThrow(try enrollment.validateExisting(deviceId: deviceId, serverURL: "https://relay.example/",
            teamId: "TEAM1234", memberId: "member-5", workerId: "macbook-5"))
        XCTAssertNoThrow(try enrollment.validateExisting(deviceId: deviceId, serverURL: nil,
            teamId: nil, memberId: nil, workerId: "macbook-5"))
    }

    func testNeverRepurposesAnotherMacOrItsConfiguredConnection() throws {
        let enrollment = try request().validated()
        XCTAssertThrowsError(try enrollment.validateExisting(deviceId: UUID().uuidString, serverURL: nil,
            teamId: nil, memberId: nil, workerId: nil))
        XCTAssertThrowsError(try enrollment.validateExisting(deviceId: deviceId, serverURL: "https://other.example",
            teamId: "TEAM1234", memberId: "member-5", workerId: "macbook-5"))
        XCTAssertThrowsError(try enrollment.validateExisting(deviceId: deviceId, serverURL: "https://relay.example",
            teamId: "OTHER123", memberId: "member-5", workerId: "macbook-5"))
        XCTAssertThrowsError(try enrollment.validateExisting(deviceId: deviceId, serverURL: "https://relay.example",
            teamId: "TEAM1234", memberId: "other-member", workerId: "macbook-5"))
        XCTAssertThrowsError(try enrollment.validateExisting(deviceId: deviceId, serverURL: nil,
            teamId: nil, memberId: nil, workerId: "another-worker"))
    }

    func testOwnerAndAdminConnectionsCannotBecomeWorkerMembers() throws {
        let enrollment = try request().validated()
        for role in ["super", "admin"] {
            XCTAssertThrowsError(try enrollment.validateExisting(deviceId: deviceId,
                serverURL: "https://relay.example", teamId: "TEAM1234", memberId: nil,
                workerId: "macbook-5", role: role))
        }
        XCTAssertNoThrow(try enrollment.validateExisting(deviceId: deviceId,
            serverURL: "https://relay.example", teamId: "TEAM1234", memberId: "member-5",
            workerId: "macbook-5", role: "member"))
    }

    func testValidationErrorsDoNotEchoTheInputCredential() {
        let secret = "a-sensitive-secret\n"
        do {
            _ = try request(token: secret).validated()
            XCTFail("Invalid token should be rejected")
        } catch {
            XCTAssertFalse(String(describing: error).contains(secret))
        }
    }
}
