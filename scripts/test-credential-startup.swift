import Foundation

// swiftc Usage4Claude/Helpers/CredentialStartup.swift scripts/test-credential-startup.swift -o /tmp/credential-startup-test
@main
enum CredentialStartupTest {
    static func main() {
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        var completed = false
        var heartbeat = false
        var loadCount = 0
        let beginning = Date()
        CredentialStartup.prepare(load: {
            precondition(!Thread.isMainThread, "Protected reads must run off the main thread")
            loadCount += 1
            started.signal()
            release.wait()
        }, completion: {
            precondition(Thread.isMainThread, "Consumers must initialize on the main thread")
            completed = true
        })
        precondition(Date().timeIntervalSince(beginning) < 0.5, "Startup must return while storage is blocked")
        precondition(started.wait(timeout: .now() + 2) == .success)
        DispatchQueue.main.async { heartbeat = true }
        let blockedDeadline = Date().addingTimeInterval(2)
        while !heartbeat && Date() < blockedDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        precondition(heartbeat, "The UI queue must keep running while macOS waits")
        precondition(!completed, "Account consumers must not initialize before storage is ready")
        release.signal()
        let completeDeadline = Date().addingTimeInterval(2)
        while !completed && Date() < completeDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        precondition(completed && loadCount == 1, "Load once, then initialize consumers")
        print("Credential startup: 6 checks passed; blocked read never blocks the main queue")
    }
}
