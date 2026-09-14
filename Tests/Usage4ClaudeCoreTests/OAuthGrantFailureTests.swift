import XCTest
@testable import Usage4ClaudeCore

/// Ein totes Refresh-Token von einem vorübergehenden Fehler unterscheiden.
///
/// Verhindert den Fehler aus 2.7: Anthropic meldet ein verbrauchtes Token als
/// HTTP 400 + `invalid_grant`, die App hielt das für einen allgemeinen
/// HTTP-Fehler und versuchte es jede Minute erneut — bei jedem Konto.
final class OAuthGrantFailureTests: XCTestCase {

    // MARK: - Tote Autorisierung

    func testAnthropic400InvalidGrantIsDead() {
        let body = #"{"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}"#
        XCTAssertTrue(OAuthGrantFailure.isDeadGrant(statusCode: 400, body: body))
    }

    func testOpenAI401AlreadyUsedIsDead() {
        let body = #"{"error":{"message":"Your refresh token has already been used to generate a new access token. Please try signing in again.","type":"invalid_request_error"}}"#
        XCTAssertTrue(OAuthGrantFailure.isDeadGrant(statusCode: 401, body: body))
    }

    func testAny401IsDead() {
        XCTAssertTrue(OAuthGrantFailure.isDeadGrant(statusCode: 401, body: ""))
    }

    func testAlreadyUsedWordingIsDeadOnAnyStatus() {
        let body = "Your refresh token has already been used to generate a new access token."
        XCTAssertTrue(OAuthGrantFailure.isDeadGrant(statusCode: 400, body: body))
    }

    // MARK: - Nicht tot

    func testServerErrorIsNotDead() {
        XCTAssertFalse(OAuthGrantFailure.isDeadGrant(statusCode: 500, body: "internal server error"))
    }

    func testRateLimitIsNotDead() {
        XCTAssertFalse(OAuthGrantFailure.isDeadGrant(statusCode: 429, body: #"{"error":{"type":"rate_limit_error"}}"#))
    }

    func testUnrelated400IsNotDead() {
        let body = #"{"error": "invalid_request", "error_description": "Missing client_id"}"#
        XCTAssertFalse(OAuthGrantFailure.isDeadGrant(statusCode: 400, body: body))
    }

    func testCloudflareHtmlIsNotDead() {
        XCTAssertFalse(OAuthGrantFailure.isDeadGrant(statusCode: 403, body: "<html>Just a moment...</html>"))
    }
}
