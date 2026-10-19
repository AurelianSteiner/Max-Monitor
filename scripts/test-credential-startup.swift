import Foundation

// swiftc Usage4Claude/Helpers/CredentialStartup.swift scripts/test-credential-startup.swift -o /tmp/credential-startup-test
@main
enum CredentialStartupTest {
    static func main() {
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        var completed = false
        var storageReady = true
        var consumersStarted = false
        var heartbeat = false
        var loadCount = 0
        let beginning = Date()
        CredentialStartup.prepare(load: {
            precondition(!Thread.isMainThread, "Protected reads must run off the main thread")
            loadCount += 1
            started.signal()
            release.wait()
            return false // macOS canceled/denied this first protected read.
        }, completion: { ready in
            precondition(Thread.isMainThread, "Consumers must initialize on the main thread")
            storageReady = ready
            if ready { consumersStarted = true }
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
        precondition(!storageReady && !consumersStarted, "Denied storage must never initialize empty account consumers")
        completed = false
        CredentialStartup.prepare(load: {
            precondition(!Thread.isMainThread)
            loadCount += 1
            return true // A real retry reopens storage; no cached failed result.
        }, completion: { ready in
            storageReady = ready
            if ready { consumersStarted = true }
            completed = true
        })
        let retryDeadline = Date().addingTimeInterval(2)
        while !completed && Date() < retryDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        precondition(completed && storageReady && consumersStarted && loadCount == 2,
                     "A successful fresh retry initializes consumers exactly after readiness")
        print("Credential startup: 8 checks passed; blocked/denied storage never initializes empty consumers; fresh retry works")
    }
}
