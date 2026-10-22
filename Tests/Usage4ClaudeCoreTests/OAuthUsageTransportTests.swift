import Foundation
import XCTest
@testable import Usage4ClaudeCore

final class OAuthUsageTransportTests: XCTestCase {
    func testTLSAbortRecoversOnSecondRequest() async {
        await check([.failure(.secureConnectionFailed), .status(200)], expectedAttempts: 2, expectedStatus: 200)
    }

    func testConnectionLossRecoversOnSecondRequest() async {
        await check([.failure(.networkConnectionLost), .status(200)], expectedAttempts: 2, expectedStatus: 200)
    }

    func testTimeoutRecoversOnSecondRequest() async {
        await check([.failure(.timedOut), .status(200)], expectedAttempts: 2, expectedStatus: 200)
    }

    func testPersistentTLSFailureStopsAfterOneRetry() async {
        await check([.failure(.secureConnectionFailed), .failure(.secureConnectionFailed), .status(200)],
                    expectedAttempts: 2, expectedError: .secureConnectionFailed)
    }

    func testHTTPResponsesDoNotTriggerTransportRetries() async {
        for status in [200, 401, 403, 429, 503] {
            await check([.status(status), .status(200)], expectedAttempts: 1, expectedStatus: status)
        }
    }

    func testCertificateFailuresAreNotRetried() async {
        for code in [URLError.Code.serverCertificateUntrusted, .serverCertificateHasBadDate,
                     .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
                     .clientCertificateRejected, .clientCertificateRequired] {
            await check([.failure(code), .status(200)], expectedAttempts: 1, expectedError: code)
        }
    }

    func testCancellationIsNotRetried() async {
        await check([.failure(.cancelled), .status(200)], expectedAttempts: 1, expectedError: .cancelled)
    }

    func testRefreshTokenPOSTIsNeverRetried() async {
        await check([.failure(.secureConnectionFailed), .status(200)], method: "POST",
                    expectedAttempts: 1, expectedError: .secureConnectionFailed)
    }

    private func check(_ steps: [UsageTransportProtocol.Step], method: String = "GET",
                       expectedAttempts: Int, expectedStatus: Int? = nil,
                       expectedError: URLError.Code? = nil,
                       file: StaticString = #filePath, line: UInt = #line) async {
        let url = URL(string: "https://usage.invalid/\(UUID().uuidString)")!
        UsageTransportProtocol.register(steps, for: url)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UsageTransportProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate(); UsageTransportProtocol.remove(url) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer test-only", forHTTPHeaderField: "Authorization")
        let result: (URLResponse?, Error?) = await withCheckedContinuation { continuation in
            OAuthUsageTransport.data(for: request, using: session) { _, response, error in
                continuation.resume(returning: (response, error))
            }
        }
        XCTAssertEqual(UsageTransportProtocol.attempts(for: url), expectedAttempts, file: file, line: line)
        XCTAssertEqual((result.0 as? HTTPURLResponse)?.statusCode, expectedStatus, file: file, line: line)
        XCTAssertEqual((result.1 as? URLError)?.code, expectedError, file: file, line: line)
    }
}

private final class UsageTransportProtocol: URLProtocol {
    enum Step {
        case failure(URLError.Code)
        case status(Int)
    }
    private static let lock = NSLock()
    private static var scripts: [URL: (steps: [Step], attempts: Int)] = [:]

    static func register(_ steps: [Step], for url: URL) {
        lock.lock(); defer { lock.unlock() }
        scripts[url] = (steps, 0)
    }

    static func attempts(for url: URL) -> Int {
        lock.lock(); defer { lock.unlock() }
        return scripts[url]?.attempts ?? 0
    }

    static func remove(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        scripts.removeValue(forKey: url)
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "usage.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        Self.lock.lock()
        var script = Self.scripts[url]!
        let step = script.steps[min(script.attempts, script.steps.count - 1)]
        script.attempts += 1
        Self.scripts[url] = script
        Self.lock.unlock()
        switch step {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .status(let code):
            let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
