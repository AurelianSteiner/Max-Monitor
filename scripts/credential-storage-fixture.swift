// Isolated test harness, compiled with actual production storage and models.
private var isolatedFixtureVaultURL: URL?
// Isolated fixture: all SecItem calls below shadow Security's imported calls.
// No real keychain, ACL, token, app container, or customer data is accessed.
private var readStatus: OSStatus = errSecSuccess
private var returnedData: Data?
private var fixtureKey: String?
private var addCalls = 0
private var deleteCalls = 0
private var checks = 0
private var readCalls = 0
private var legacyStatuses: [String: OSStatus] = [:]
private var legacyValues: [String: Data] = [:]
private var authenticationModes: [Bool] = []
private var afterRead: ((String) -> Void)?
// Only localized display strings are stubbed; actual saved-account model decoders are compiled.
enum L { enum Account { static let kindCompany = "company"; static let kindPersonal = "personal"; static let kindUnknown = "unknown" } }


private var interactionAllowed = true
private var getInteractionStatus: OSStatus = errSecSuccess
private var setInteractionStatuses: [OSStatus] = []
private var setInteractionValues: [Bool] = []
func SecKeychainGetUserInteractionAllowed(_ state: UnsafeMutablePointer<DarwinBoolean>) -> OSStatus {
    if getInteractionStatus == errSecSuccess { state.pointee = DarwinBoolean(interactionAllowed) }
    return getInteractionStatus
}
func SecKeychainSetUserInteractionAllowed(_ state: Bool) -> OSStatus {
    setInteractionValues.append(state)
    let status = setInteractionStatuses.isEmpty ? errSecSuccess : setInteractionStatuses.removeFirst()
    if status == errSecSuccess { interactionAllowed = state }
    return status
}

func SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    readCalls += 1
    let attributes = query as NSDictionary
    let account = attributes[kSecAttrAccount as String] as? String ?? ""
    authenticationModes.append((attributes[kSecUseAuthenticationUI as String] as? String) != (kSecUseAuthenticationUIFail as String))
    defer { afterRead?(account) }
    if account != "vault-key" {
        let status = legacyStatuses[account] ?? errSecItemNotFound
        if status == errSecSuccess { result?.pointee = legacyValues[account] as CFData? }
        return status
    }
    if readStatus == errSecSuccess { result?.pointee = returnedData as CFData? }
    return readStatus
}
func SecItemAdd(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    addCalls += 1
    guard fixtureKey == nil else { return errSecDuplicateItem }
    let attributes = query as NSDictionary
    fixtureKey = String(data: attributes[kSecValueData as String] as! Data, encoding: .utf8)
    return errSecSuccess
}
func SecItemDelete(_ query: CFDictionary) -> OSStatus {
    deleteCalls += 1
    fixtureKey = nil
    return errSecSuccess
}
private func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    precondition(condition(), name)
    checks += 1
}

@main struct VaultKeyFixture {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vault-local-fixture-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("credentials.vault")
        isolatedFixtureVaultURL = file
        let original = CredentialVault.generateKey()
        let accountRaw = String(data: try JSONEncoder().encode([Account(sessionKey: "fixture", organizationId: "fixture", organizationName: "fixture")]), encoding: .utf8)!
        let monitoringRaw = String(data: try JSONEncoder().encode(FleetMonitoringAccount(name: "fixture", email: "", organizationId: "fixture", refreshToken: "fixture")), encoding: .utf8)!
        func reset() throws {
            try? FileManager.default.removeItem(at: directory)
            readStatus = errSecSuccess; returnedData = Data(original.base64EncodedString().utf8)
            legacyStatuses = [:]; legacyValues = [:]; addCalls = 0; deleteCalls = 0; readCalls = 0
            authenticationModes = []; setInteractionValues = []
        }
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled, errSecNotAvailable, errSecDecode] {
            try reset(); readStatus = status
            let old = try CredentialVault(fileURL: file, key: original)
            check(old.save(key: "accounts", value: accountRaw), "seed encrypted accounts")
            let before = try Data(contentsOf: file)
            let blocked = VaultCredentialStorage(service: "fixture", allowInteraction: false)
            check(!blocked.isReady, "denial gates consumers")
            check((try? Data(contentsOf: file)) == before, "denial preserves bytes")
            check(addCalls == 0 && deleteCalls == 0, "denial never mutates Keychain")
            check(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("credentials.key").path), "denial never publishes a replacement key")
        }
        for name in ["accounts", "accounts_codex", "fleetMonitoringAccount"] {
            for invalid in ["fixture-only", "{}", "123"] {
                try reset()
                let old = try CredentialVault(fileURL: file, key: original)
                check(old.save(key: name, value: invalid), "seed malformed model")
                let before = try Data(contentsOf: file)
                let blocked = VaultCredentialStorage(service: "fixture", allowInteraction: false)
                check(!blocked.isReady, "actual model decoder gates invalid records")
                check((try? Data(contentsOf: file)) == before && deleteCalls == 0, "invalid model preserves bytes and source")
            }
        }
        try reset()
        legacyStatuses = ["accounts": errSecSuccess, "fleetMonitoringAccount": errSecUserCanceled]
        legacyValues = ["accounts": Data(accountRaw.utf8)]
        let deniedLegacy = VaultCredentialStorage(service: "fixture", allowInteraction: false)
        check(!deniedLegacy.isReady && !FileManager.default.fileExists(atPath: file.path), "partial legacy read never commits")
        legacyStatuses["fleetMonitoringAccount"] = errSecSuccess
        legacyValues["fleetMonitoringAccount"] = Data(monitoringRaw.utf8)
        let migrated = VaultCredentialStorage(service: "fixture", allowInteraction: false)
        check(migrated.isReady && migrated.load(key: "accounts") == accountRaw, "retry imports valid real models")
        check(deleteCalls == 0 && addCalls == 0, "local import keeps all old Keychain entries")
        check(authenticationModes.allSatisfy { !$0 }, "first probe never requests authentication UI")
        check((migrated.startupDiagnostics["providerAccountCounts"] as? [String: Int])?["accounts"] == 1, "actual provider count")
        let priorReads = readCalls
        readStatus = errSecInteractionNotAllowed
        let restarted = VaultCredentialStorage(service: "fixture", allowInteraction: false)
        check(restarted.isReady && readCalls == priorReads, "restart while Keychain is locked performs zero protected reads")
        check(restarted.delete(key: "accounts") && restarted.load(key: "accounts_codex") == nil, "delete and missing entry stay local")
        let updated = VaultCredentialStorage(service: "fixture")
        check(updated.isReady && updated.load(key: "accounts") == nil && readCalls == priorReads, "new backend never resurrects old Keychain account")
        check(updated.startupDiagnostics["keyReadStatus"] as? String == "local", "metadata proves durable local source")
        let manager = KeychainManager.shared
        check(manager.prepareForApplicationStartup(retry: false), "GUI starts with complete local storage")
        check(setInteractionValues.isEmpty, "completed setup never changes Keychain UI mode")
        check(readCalls == priorReads && manager.loadAccounts() == nil, "singleton remains local")
        print("\(checks) actual production-storage checks passed; zero real Keychain access.")
    }
}
