import XCTest
@testable import Usage4ClaudeCore

final class PersistentCredentialVaultTests: XCTestCase {
    private var directory: URL!
    private enum Denied: Error { case keychain }
    private var vaultURL: URL { directory.appendingPathComponent("credentials.vault") }
    private var keyURL: URL { directory.appendingPathComponent("credentials.key") }
    private var readyURL: URL { directory.appendingPathComponent("credentials.ready") }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("persistent-vault-\(UUID())")
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }

    private func reopenWithoutKeychain() throws -> PersistentCredentialVault {
        try PersistentCredentialVault(directory: directory) { _ in
            XCTFail("Completed setup must never access Keychain")
            throw Denied.keychain
        }
    }

    func testFreshSetupRestartTokenRotationAndMissingEntriesNeverReadKeychainAgain() throws {
        let first = try PersistentCredentialVault(directory: directory, loadLegacy: { _ in nil })
        XCTAssertTrue(first.save(key: "accounts", value: "refresh-token-1"))
        let key = try Data(contentsOf: keyURL)
        let restarted = try reopenWithoutKeychain()
        XCTAssertEqual(restarted.load(key: "accounts"), "refresh-token-1")
        XCTAssertNil(restarted.load(key: "accounts_codex"))
        XCTAssertTrue(restarted.delete(key: "never-existed"))
        XCTAssertTrue(restarted.save(key: "accounts", value: "refresh-token-2"))
        let updated = try reopenWithoutKeychain()
        XCTAssertEqual(updated.load(key: "accounts"), "refresh-token-2")
        XCTAssertEqual(try Data(contentsOf: keyURL), key)
    }

    func testExistingVaultKeepsKeyAndImportsAllCredentialTypesOnce() throws {
        let key = CredentialVault.generateKey()
        let old = try CredentialVault(fileURL: vaultURL, key: key)
        XCTAssertTrue(old.save(key: "accounts", value: "newer-vault-account"))
        let legacy = Dictionary(uniqueKeysWithValues: PersistentCredentialVault.migratedKeys.map { ($0, "legacy-\($0)") })
        var reads: [String] = []
        let migrated = try PersistentCredentialVault(directory: directory) { name in
            reads.append(name)
            return name == "vault-key" ? key.base64EncodedString() : legacy[name]
        }
        XCTAssertEqual(migrated.load(key: "accounts"), "newer-vault-account")
        XCTAssertFalse(reads.contains("accounts"))
        for name in PersistentCredentialVault.migratedKeys where name != "accounts" {
            XCTAssertEqual(migrated.load(key: name), legacy[name])
        }
        XCTAssertEqual(try Data(contentsOf: keyURL), key)
        XCTAssertEqual(try reopenWithoutKeychain().load(key: "fleetMonitoringAccount"), "legacy-fleetMonitoringAccount")
    }

    func testDeletedCredentialsStayDeletedAfterRestartDespiteLegacyCopies() throws {
        let first = try PersistentCredentialVault(directory: directory) { name in
            name == "teamServerToken" ? "old-team-token" : nil
        }
        XCTAssertTrue(first.delete(key: "teamServerToken"))
        XCTAssertNil(try reopenWithoutKeychain().load(key: "teamServerToken"))
    }

    func testDeniedImportDoesNotCreateKeyOrOverwriteExistingVault() throws {
        let key = CredentialVault.generateKey()
        let old = try CredentialVault(fileURL: vaultURL, key: key)
        XCTAssertTrue(old.save(key: "accounts", value: "preserve-me"))
        let before = try Data(contentsOf: vaultURL)
        XCTAssertThrowsError(try PersistentCredentialVault(directory: directory) { _ in throw Denied.keychain })
        XCTAssertFalse(FileManager.default.fileExists(atPath: keyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: readyURL.path))
        XCTAssertEqual(try Data(contentsOf: vaultURL), before)
    }

    func testDeniedLegacyEntryImportIsNotMarkedComplete() throws {
        XCTAssertThrowsError(try PersistentCredentialVault(directory: directory) { name in
            if name == "accounts" { throw Denied.keychain }
            return nil
        })
        XCTAssertFalse(FileManager.default.fileExists(atPath: keyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: readyURL.path))
        let retried = try PersistentCredentialVault(directory: directory) { name in
            name == "accounts" ? "recovered" : nil
        }
        XCTAssertEqual(retried.load(key: "accounts"), "recovered")
        XCTAssertEqual(try reopenWithoutKeychain().load(key: "accounts"), "recovered")
    }

    func testMissingLegacyVaultKeyDoesNotGenerateReplacement() throws {
        let old = try CredentialVault(fileURL: vaultURL, key: CredentialVault.generateKey())
        XCTAssertTrue(old.save(key: "accounts", value: "preserve-me"))
        let before = try Data(contentsOf: vaultURL)
        XCTAssertThrowsError(try PersistentCredentialVault(directory: directory, loadLegacy: { _ in nil }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: keyURL.path))
        XCTAssertEqual(try Data(contentsOf: vaultURL), before)
    }

    func testWrongLegacyKeyIsRejectedBeforePublishingLocalKey() throws {
        let old = try CredentialVault(fileURL: vaultURL, key: CredentialVault.generateKey())
        XCTAssertTrue(old.save(key: "accounts", value: "preserve-me"))
        let before = try Data(contentsOf: vaultURL)
        XCTAssertThrowsError(try PersistentCredentialVault(directory: directory) { name in
            name == "vault-key" ? CredentialVault.generateKey().base64EncodedString() : nil
        })
        XCTAssertFalse(FileManager.default.fileExists(atPath: keyURL.path))
        XCTAssertEqual(try Data(contentsOf: vaultURL), before)
    }

    func testMissingOrDamagedLocalKeyNeverFallsBackToKeychain() throws {
        let first = try PersistentCredentialVault(directory: directory, loadLegacy: { _ in nil })
        XCTAssertTrue(first.save(key: "accounts", value: "preserve-me"))
        let before = try Data(contentsOf: vaultURL)
        try Data([1, 2, 3]).write(to: keyURL)
        XCTAssertThrowsError(try reopenWithoutKeychain())
        try FileManager.default.removeItem(at: keyURL)
        XCTAssertThrowsError(try reopenWithoutKeychain())
        XCTAssertEqual(try Data(contentsOf: vaultURL), before)
    }

    func testUnreadableEntryNamesPreserveOriginalCiphertextAndBlockKeyPublication() throws {
        let key = CredentialVault.generateKey()
        let original = try CredentialVault(fileURL: vaultURL, key: key)
        XCTAssertTrue(original.save(key: "teamServerToken", value: "synthetic-team-token"))
        let otherKey = try CredentialVault(fileURL: vaultURL, key: CredentialVault.generateKey())
        XCTAssertTrue(otherKey.save(key: "accounts", value: "synthetic-account"))
        let before = try Data(contentsOf: vaultURL)
        XCTAssertThrowsError(try PersistentCredentialVault(directory: directory) { name in
            name == "vault-key" ? key.base64EncodedString() : nil
        }) { error in
            guard let storageError = error as? PersistentCredentialVault.StorageError,
                  case .unreadableEntry(let names) = storageError else {
                return XCTFail("Expected exact unreadable entry names")
            }
            XCTAssertEqual(names, ["accounts"])
        }
        XCTAssertEqual(try Data(contentsOf: vaultURL), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: keyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: readyURL.path))
    }

    func testCorruptVaultNeverFallsBackOrOverwrites() throws {
        _ = try PersistentCredentialVault(directory: directory, loadLegacy: { _ in nil })
        let corrupted = Data("not-json".utf8)
        try corrupted.write(to: vaultURL)
        XCTAssertThrowsError(try reopenWithoutKeychain())
        XCTAssertEqual(try Data(contentsOf: vaultURL), corrupted)
    }

    func testInterruptedImportKeepsItsKeyAndExistingEntries() throws {
        let key = CredentialVault.generateKey()
        let old = try CredentialVault(fileURL: vaultURL, key: key)
        XCTAssertTrue(old.save(key: "accounts", value: "already-imported"))
        try key.write(to: keyURL)
        let resumed = try PersistentCredentialVault(directory: directory) { name in
            XCTAssertNotEqual(name, "vault-key")
            XCTAssertNotEqual(name, "accounts")
            return name == "teamServerToken" ? "remaining-token" : nil
        }
        XCTAssertEqual(resumed.load(key: "accounts"), "already-imported")
        XCTAssertEqual(try Data(contentsOf: keyURL), key)
        XCTAssertEqual(try reopenWithoutKeychain().load(key: "teamServerToken"), "remaining-token")
    }

    func testLocalFilesArePrivateAndStoredTokensAreEncrypted() throws {
        let vault = try PersistentCredentialVault(directory: directory, loadLegacy: { _ in nil })
        XCTAssertTrue(vault.save(key: "teamServerToken", value: "secret-token-for-permission-test"))
        for (url, mode) in [(directory!, 0o700), (keyURL, 0o600), (vaultURL, 0o600), (readyURL, 0o600)] {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            XCTAssertEqual(attributes[.posixPermissions] as? Int, mode)
        }
        XCTAssertFalse(try String(contentsOf: vaultURL).contains("secret-token-for-permission-test"))
    }

    func testWriteAndDeleteFailuresKeepPreviousValuesWithoutKeychainFallback() throws {
        let vault = try PersistentCredentialVault(directory: directory, loadLegacy: { _ in nil })
        XCTAssertTrue(vault.save(key: "accounts", value: "previous-token"))
        let backup = directory.appendingPathComponent("preserved.vault")
        try FileManager.default.moveItem(at: vaultURL, to: backup)
        // A directory at the destination deterministically rejects atomic writes.
        try FileManager.default.createDirectory(at: vaultURL, withIntermediateDirectories: false)
        XCTAssertFalse(vault.save(key: "accounts", value: "unsaved-token"))
        XCTAssertFalse(vault.delete(key: "accounts"))
        XCTAssertEqual(vault.load(key: "accounts"), "previous-token")
        let original = try CredentialVault(fileURL: backup, key: Data(contentsOf: keyURL))
        XCTAssertEqual(original.load(key: "accounts"), "previous-token")
    }
}
