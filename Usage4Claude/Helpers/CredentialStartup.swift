import Foundation

/// Protected storage can wait inside macOS. Finish it off the UI thread before
/// constructing account stores, so an unavailable read cannot look like empty
/// saved accounts or cause their migration/persistence paths to run early.
nonisolated enum CredentialStartup {
    static func prepare(load: @escaping () -> Bool, completion: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let ready = load()
            DispatchQueue.main.async { completion(ready) }
        }
    }
}
