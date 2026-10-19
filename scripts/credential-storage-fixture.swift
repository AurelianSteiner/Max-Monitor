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
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vault-safe-fixture-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("credentials.vault")
        let original = CredentialVault.generateKey()
        let encrypted = try CredentialVault(fileURL: file, key: original)
        check(encrypted.save(key: "accounts", value: "fixture-only"), "fixture encryption")
        let bytes = try Data(contentsOf: file)
        fixtureKey = original.base64EncodedString()
        let keychain = KeychainCredentialStorage(service: "fixture-only-never-real")
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled, errSecNotAvailable, errSecDecode] {
            readStatus = status
            let read = keychain.read(key: "vault-key")
            if case .unavailable(let actual) = read { check(actual == status, "typed status") }
            else { preconditionFailure("status collapsed into missing") }
            let resolved = VaultKeyAccess.resolve(read, existingVault: { true }, createKey: {
                keychain.addIfAbsent(key: "vault-key", value: $0)
            })
            check(resolved == nil, "unavailable must not resolve")
            check(addCalls == 0 && deleteCalls == 0, "unavailable must not mutate keychain")
            check(fixtureKey == original.base64EncodedString(), "existing key preserved")
            let current = try Data(contentsOf: file)
            check(current == bytes, "existing ciphertext preserved")
        }
        readStatus = errSecSuccess
        for invalid in ["invalid-base64!", Data([1,2,3]).base64EncodedString()] {
            returnedData = Data(invalid.utf8)
            check(VaultKeyAccess.resolve(keychain.read(key: "vault-key"), existingVault: { true }, createKey: {
                keychain.addIfAbsent(key: "vault-key", value: $0)
            }) == nil, "invalid key rejected")
            check(addCalls == 0 && deleteCalls == 0, "invalid key must not mutate keychain")
        }
        returnedData = Data([0xff, 0xff])
        if case .unavailable(let actual) = keychain.read(key: "vault-key") { check(actual == errSecDecode, "invalid UTF8") }
        else { preconditionFailure("invalid data collapsed into missing") }
        returnedData = Data(original.base64EncodedString().utf8)
        let resolved = VaultKeyAccess.resolve(keychain.read(key: "vault-key"), existingVault: { true }, createKey: {
            keychain.addIfAbsent(key: "vault-key", value: $0)
        })
        check(resolved == original, "valid key stays readable")
        readStatus = errSecItemNotFound
        let missing = keychain.read(key: "vault-key")
        if case .notFound = missing { checks += 1 } else { preconditionFailure("notFound must be explicit") }
        check(VaultKeyAccess.resolve(missing, existingVault: { true }, createKey: {
            keychain.addIfAbsent(key: "vault-key", value: $0)
        }) == nil, "existing file prevents lost-key replacement")
        check(VaultKeyAccess.resolve(missing, existingVault: { throw CocoaError(.fileReadNoPermission) }, createKey: {
            keychain.addIfAbsent(key: "vault-key", value: $0)
        }) == nil, "unknown file status prevents creation")
        check(addCalls == 0 && deleteCalls == 0, "file guards must not mutate keychain")
        check(VaultKeyAccess.resolve(missing, existingVault: { false }, createKey: {
            keychain.addIfAbsent(key: "vault-key", value: $0)
        }) == nil, "duplicate race rejected")
        check(addCalls == 1 && deleteCalls == 0, "duplicate race is add-only")
        check(fixtureKey == original.base64EncodedString(), "race preserves existing key")
        check(!keychain.save(key: "vault-key", value: CredentialVault.generateKey().base64EncodedString()), "generic save cannot replace vault-key")
        check(deleteCalls == 0 && fixtureKey == original.base64EncodedString(), "save guard is add-only")
        let preserved = try Data(contentsOf: file)
        check(preserved == bytes, "every failure preserved encrypted file")
        let reopened = try CredentialVault(fileURL: file, key: original)
        check(reopened.load(key: "accounts") == "fixture-only", "original key still decrypts fixture")
        fixtureKey = nil
        let fresh = VaultKeyAccess.resolve(missing, existingVault: { false }, createKey: {
            keychain.addIfAbsent(key: "vault-key", value: $0)
        })
        check(fresh?.count == 32 && fresh?.base64EncodedString() == fixtureKey, "first creation succeeds")
        check(deleteCalls == 0, "no key deletion anywhere in vault-key fixture")
        let startupFile = directory.appendingPathComponent("startup.vault")
        let startupVault = try CredentialVault(fileURL: startupFile, key: original)
        let accountRaw = String(data: try JSONEncoder().encode([Account(sessionKey: "fixture-only", organizationId: "fixture-only", organizationName: "fixture")]), encoding: .utf8)!
        let monitoringRaw = String(data: try JSONEncoder().encode(FleetMonitoringAccount(name: "fixture", email: "", organizationId: "fixture", refreshToken: "fixture-only")), encoding: .utf8)!
        for name in VaultCredentialStorage.migratedKeys {
            let raw = name == "accounts" || name == "accounts_codex" ? accountRaw : (name == "fleetMonitoringAccount" ? monitoringRaw : "fixture-only")
            check(startupVault.save(key: name, value: raw), "seed isolated startup entry")
        }
        let startupBytes = try Data(contentsOf: startupFile)
        isolatedFixtureVaultURL = startupFile
        fixtureKey = original.base64EncodedString()
        addCalls = 0; deleteCalls = 0
        readStatus = errSecUserCanceled
        let deniedStore = VaultCredentialStorage(service: "isolated-fixture-never-real")
        check(!deniedStore.isReady, "denied existing vault must keep GUI consumers gated")
        check(addCalls == 0 && deleteCalls == 0, "denied startup cannot migrate or mutate keychain")
        check((try? Data(contentsOf: startupFile)) == startupBytes, "denied startup keeps ciphertext")
        readStatus = errSecSuccess
        returnedData = Data(CredentialVault.generateKey().base64EncodedString().utf8)
        let wrongKeyStore = VaultCredentialStorage(service: "isolated-fixture-never-real")
        check(!wrongKeyStore.isReady, "valid but wrong key cannot mark encrypted accounts ready")
        check(addCalls == 0 && deleteCalls == 0, "wrong-key startup cannot migrate or mutate keychain")
        check((try? Data(contentsOf: startupFile)) == startupBytes, "wrong-key startup keeps ciphertext")
        returnedData = Data(original.base64EncodedString().utf8)
        let retriedStore = VaultCredentialStorage(service: "isolated-fixture-never-real")
        check(retriedStore.isReady, "fresh backend after successful retry is ready")
        check(retriedStore.load(key: "accounts") == accountRaw, "successful retry retains actual account contents")
        check(addCalls == 0 && deleteCalls == 0, "successful existing-vault startup needs no keychain mutation")
        check((try? Data(contentsOf: startupFile)) == startupBytes, "successful retry keeps ciphertext")
        check(deniedStore.startupDiagnostics["keyReadStatus"] as? String == "unavailable", "diagnostic distinguishes unavailable key")
        check(deniedStore.startupDiagnostics["keyOSStatus"] as? Int32 == errSecUserCanceled, "diagnostic retains OS status only")
        check(wrongKeyStore.startupDiagnostics["decodedKeyBytes"] as? Int == 32, "diagnostic reports format length, not key")
        check(wrongKeyStore.startupDiagnostics["decryptableEntryCount"] as? Int == 0, "diagnostic identifies ciphertext mismatch")
        check(retriedStore.startupDiagnostics["decryptableEntryCount"] as? Int == 6, "diagnostic verifies every saved fixture entry")
        for malformed in ["not json", "{\"version\":2,\"entries\":{}}", "{\"version\":1,\"entries\":[]}", "{\"version\":1,\"entries\":{\"accounts\":123}}", "{\"entries\":{}}", "{\"version\":true,\"entries\":{}}"] {
            let originalMalformed = Data(malformed.utf8)
            try originalMalformed.write(to: startupFile)
            let failedStore = VaultCredentialStorage(service: "isolated-fixture-never-real")
            check(!failedStore.isReady, "malformed existing file cannot pass readiness vacuously")
            check(addCalls == 0 && deleteCalls == 0, "malformed file cannot migrate or change keychain")
            check((try? Data(contentsOf: startupFile)) == originalMalformed, "malformed bytes preserved")
        }
        try startupBytes.write(to: startupFile)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: startupFile.path)
        let unreadableStore = VaultCredentialStorage(service: "isolated-fixture-never-real")
        check(!unreadableStore.isReady, "unreadable existing file cannot pass readiness")
        check(addCalls == 0 && deleteCalls == 0, "unreadable file cannot migrate or change keychain")
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: startupFile.path)
        check((try? Data(contentsOf: startupFile)) == startupBytes, "unreadable original bytes preserved")
        try FileManager.default.removeItem(at: startupFile)
        let newStore = VaultCredentialStorage(service: "isolated-fixture-never-real")
        check(newStore.isReady, "genuinely missing file with existing valid key can start empty")
        check(newStore.startupDiagnostics["savedEntryCount"] as? Int == 0, "legitimate first empty store distinguished")
        // Every denied/malformed legacy read must freeze ALL migration writes/deletes.
        for denied in ["accounts", "accounts_codex", "fleetMonitoringAccount"] {
            legacyStatuses = ["accounts": errSecSuccess]; legacyStatuses[denied] = errSecUserCanceled
            legacyValues = ["accounts": Data(accountRaw.utf8)]
            addCalls = 0; deleteCalls = 0
            let blocked = VaultCredentialStorage(service: "isolated-fixture-never-real", allowInteraction: false)
            check(!blocked.isReady, "denied legacy entry blocks startup")
            check(!FileManager.default.fileExists(atPath: startupFile.path), "staged legacy values not persisted on denied later read")
            check(addCalls == 0 && deleteCalls == 0, "denied legacy startup has no mutations")
        }
        legacyStatuses = ["accounts": errSecSuccess]
        legacyValues = ["accounts": Data([0xff, 0xff])]
        let invalidUTF8 = VaultCredentialStorage(service: "isolated-fixture-never-real", allowInteraction: false)
        check(!invalidUTF8.isReady, "invalid legacy UTF8 blocks readiness")
        check(!FileManager.default.fileExists(atPath: startupFile.path) && deleteCalls == 0, "invalid legacy UTF8 preserves original")
        // Existing decryptable but schema-invalid values cannot become empty consumers.
        for key in ["accounts", "accounts_codex", "fleetMonitoringAccount"] {
            for invalid in ["fixture-only", "{}", "123"] {
                legacyStatuses = [:]; legacyValues = [:]
                let invalidVault = try CredentialVault(fileURL: startupFile, key: original)
                check(invalidVault.save(key: key, value: invalid), "seed invalid encrypted model")
                let badBytes = try Data(contentsOf: startupFile)
                let badStore = VaultCredentialStorage(service: "isolated-fixture-never-real", allowInteraction: false)
                check(!badStore.isReady, "present invalid saved model blocks readiness")
                check((try? Data(contentsOf: startupFile)) == badBytes && deleteCalls == 0, "invalid saved model preserves exact original bytes")
                try FileManager.default.removeItem(at: startupFile)
            }
        }
        // Legacy malformed payload validation also precedes first migration write/delete.
        legacyStatuses = ["accounts": errSecSuccess, "teamServerToken": errSecSuccess]
        legacyValues = ["accounts": Data("{}".utf8), "teamServerToken": Data("fixture-only".utf8)]
        let badLegacy = VaultCredentialStorage(service: "isolated-fixture-never-real", allowInteraction: false)
        check(!badLegacy.isReady, "invalid legacy model blocks readiness")
        check(!FileManager.default.fileExists(atPath: startupFile.path) && deleteCalls == 0, "invalid legacy model prevents migration")
        // A fresh retry really re-reads, then migrates only proven valid payloads.
        legacyStatuses = ["accounts": errSecSuccess, "fleetMonitoringAccount": errSecSuccess]
        legacyValues = ["accounts": Data(accountRaw.utf8), "fleetMonitoringAccount": Data(monitoringRaw.utf8)]
        authenticationModes = []
        let goodLegacy = VaultCredentialStorage(service: "isolated-fixture-never-real", allowInteraction: false)
        check(goodLegacy.isReady && goodLegacy.load(key: "accounts") == accountRaw, "fresh successful legacy retry retains models")
        check(deleteCalls == 2, "legacy originals removed only after all migrated payloads save")
        check(authenticationModes.allSatisfy { !$0 }, "noninteractive first probe denies auth UI for every read")
        check((goodLegacy.startupDiagnostics["providerAccountCounts"] as? [String: Int])?["accounts"] == 1, "real model count diagnostic")
        // Force a safe fixture persistence failure, never delete the original legacy entry.
        try FileManager.default.removeItem(at: startupFile)
        deleteCalls = 0
        afterRead = { key in
            if key == "fleetMonitoringAccount" { try? FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path) }
        }
        let saveFailed = VaultCredentialStorage(service: "isolated-fixture-never-real", allowInteraction: false)
        afterRead = nil
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        check(!saveFailed.isReady && deleteCalls == 0, "failed migration save keeps legacy original and gate closed")
        check(!FileManager.default.fileExists(atPath: startupFile.path), "failed migration creates no replacement store")
        // Actual singleton construction is lazy; GUI first probe must not do an earlier normal auth read.
        legacyStatuses = [:]; legacyValues = [:]
        readStatus = errSecInteractionNotAllowed
        let readsBefore = readCalls
        let manager = KeychainManager.shared
        check(readCalls == readsBefore, "singleton construction performs zero protected reads")
        authenticationModes = []
        check(!manager.prepareForApplicationStartup(retry: false), "first GUI probe remains gated on OS denial")
        check(authenticationModes == [false], "first GUI probe requests no auth UI")
        readStatus = errSecSuccess; returnedData = Data(original.base64EncodedString().utf8)
        authenticationModes = []
        check(manager.prepareForApplicationStartup(retry: true), "explicit retry opens a fresh ready backend")
        check(!authenticationModes.isEmpty && authenticationModes.allSatisfy { $0 }, "explicit retry preserves regular OS authentication")
        let afterReadyReads = readCalls
        check(manager.loadAccounts() == nil && readCalls == afterReadyReads, "ready missing accounts return legitimate empty without UI thread re-read")
        // File-based legacy Keychain UI state is process-local and serialized.
        for prior in [false, true] {
            interactionAllowed = prior; setInteractionValues = []
            var calls = 0
            let probe = LegacyKeychainStartupProbe.perform(allowInteraction: false) {
                calls += 1
                check(!interactionAllowed, "legacy optional UI disabled during first probe")
                return 42
            }
            if case .success(let value) = probe { check(value == 42 && calls == 1, "probe executes exactly once") }
            else { preconditionFailure("valid legacy state probe failed") }
            check(interactionAllowed == prior, "legacy UI state restored exactly")
            check(setInteractionValues == [false, prior], "never force enabled when prior state disabled")
        }
        getInteractionStatus = errSecNotAvailable; setInteractionValues = []
        var calls = 0
        let getFailed = LegacyKeychainStartupProbe.perform(allowInteraction: false) { calls += 1 }
        if case .failure(let failure) = getFailed { check(failure.stage == "readInteractionState", "state read failure identified") }
        else { preconditionFailure("failed state read was accepted") }
        check(calls == 0 && setInteractionValues.isEmpty, "failed state read performs no protected load or switch")
        getInteractionStatus = errSecSuccess; interactionAllowed = true; setInteractionValues = []
        setInteractionStatuses = [errSecNotAvailable, errSecSuccess]
        let disableFailed = LegacyKeychainStartupProbe.perform(allowInteraction: false) { calls += 1 }
        if case .failure(let failure) = disableFailed { check(failure.stage == "disableInteraction", "disable failure identified") }
        else { preconditionFailure("failed UI disable was accepted") }
        check(calls == 0 && interactionAllowed && setInteractionValues == [false, true], "disable failure skips protected load and restores exact prior state")
        setInteractionValues = []; setInteractionStatuses = [errSecSuccess, errSecNotAvailable]
        let restoreFailed = LegacyKeychainStartupProbe.perform(allowInteraction: false) { calls += 1; return 42 }
        if case .failure(let failure) = restoreFailed { check(failure.stage == "restoreInteractionState", "restore failure gates even completed load") }
        else { preconditionFailure("failed UI restore was accepted") }
        check(calls == 1 && !interactionAllowed, "failed restoration never force-enables UI")
        // Normal explicit Retry never toggles the legacy interaction policy.
        setInteractionValues = []; interactionAllowed = true
        let normal = LegacyKeychainStartupProbe.perform(allowInteraction: true) { interactionAllowed }
        if case .success(let allowed) = normal { check(allowed && setInteractionValues.isEmpty, "normal retry keeps existing OS auth semantics") }
        else { preconditionFailure("normal retry unexpectedly failed") }
        print("Vault key safety: \(checks) checks passed; real Keychain calls: 0; encrypted fixture preserved")
    }
}
