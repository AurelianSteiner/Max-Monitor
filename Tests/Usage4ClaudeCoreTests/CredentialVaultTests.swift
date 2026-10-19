import XCTest
@testable import Usage4ClaudeCore

/// Die verschlüsselte Ablage, die den Schlüsselbund als Datenspeicher ablöst
/// (Hintergrund im Dateikopf von CredentialVault.swift).
final class CredentialVaultTests: XCTestCase {

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("vault-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var fileURL: URL { directory.appendingPathComponent("credentials.vault") }

    func testRoundTripAndPersistenceAcrossInstances() throws {
        let key = CredentialVault.generateKey()
        let vault = try CredentialVault(fileURL: fileURL, key: key)
        XCTAssertNil(vault.load(key: "accounts"))
        XCTAssertTrue(vault.save(key: "accounts", value: "[{\"id\":\"1\"}]"))
        XCTAssertTrue(vault.save(key: "accounts_codex", value: "[]"))
        XCTAssertEqual(vault.load(key: "accounts"), "[{\"id\":\"1\"}]")

        // Neue Instanz mit demselben Schlüssel liest dieselben Werte
        let reopened = try CredentialVault(fileURL: fileURL, key: key)
        XCTAssertEqual(reopened.load(key: "accounts"), "[{\"id\":\"1\"}]")
        XCTAssertEqual(reopened.load(key: "accounts_codex"), "[]")
        XCTAssertEqual(Set(reopened.keys), ["accounts", "accounts_codex"])
    }

    func testOverwriteReplacesValue() throws {
        let vault = try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey())
        vault.save(key: "token", value: "old")
        vault.save(key: "token", value: "new")
        XCTAssertEqual(vault.load(key: "token"), "new")
    }

    func testDeleteRemovesEntryAndMissingDeleteSucceeds() throws {
        let vault = try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey())
        vault.save(key: "token", value: "x")
        XCTAssertTrue(vault.delete(key: "token"))
        XCTAssertNil(vault.load(key: "token"))
        XCTAssertFalse(vault.contains(key: "token"))
        XCTAssertTrue(vault.delete(key: "token"))
    }

    /// Ein anderer Schlüssel liest nichts — kein Absturz, kein Klartext.
    func testWrongKeyYieldsNil() throws {
        let vault = try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey())
        vault.save(key: "accounts", value: "secret")
        let other = try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey())
        XCTAssertNil(other.load(key: "accounts"))
        XCTAssertTrue(other.contains(key: "accounts"))
    }

    /// Ein Chiffrat unter einem fremden Namen ist ungültig (AAD = Eintragsname).
    func testCiphertextIsBoundToItsName() throws {
        let key = CredentialVault.generateKey()
        let vault = try CredentialVault(fileURL: fileURL, key: key)
        vault.save(key: "accounts", value: "secret")

        let data = try Data(contentsOf: fileURL)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var entries = try XCTUnwrap(json["entries"] as? [String: String])
        entries["accounts_codex"] = entries["accounts"]
        json["entries"] = entries
        try JSONSerialization.data(withJSONObject: json).write(to: fileURL)

        let reopened = try CredentialVault(fileURL: fileURL, key: key)
        XCTAssertEqual(reopened.load(key: "accounts"), "secret")
        XCTAssertNil(reopened.load(key: "accounts_codex"))
    }

    func testFileIsPrivateAndContainsNoPlaintext() throws {
        let vault = try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey())
        vault.save(key: "accounts", value: "sk-ant-ort01-very-secret")
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? Int) ?? 0, 0o600)
        let text = try String(contentsOf: fileURL, encoding: .utf8)
        XCTAssertFalse(text.contains("sk-ant-ort01"))
    }

    func testMalformedExistingFileIsRejectedAndPreserved() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let original = Data("not json".utf8)
        try original.write(to: fileURL)
        XCTAssertThrowsError(try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey()))
        XCTAssertEqual(try Data(contentsOf: fileURL), original)
    }

    func testUnsupportedVersionAndInvalidEntryShapesAreRejectedWithoutChangingFile() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for text in ["{\"version\":2,\"entries\":{}}", "{\"version\":1,\"entries\":[]}",
                     "{\"version\":1,\"entries\":{\"accounts\":123}}", "{\"entries\":{}}"] {
            let original = Data(text.utf8)
            try original.write(to: fileURL)
            XCTAssertThrowsError(try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey()))
            XCTAssertEqual(try Data(contentsOf: fileURL), original)
        }
    }

    func testUnreadableExistingFileIsRejectedAndPreserved() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let original = Data("{\"version\":1,\"entries\":{}}".utf8)
        try original.write(to: fileURL)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: fileURL.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path) }
        XCTAssertThrowsError(try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey()))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        XCTAssertEqual(try Data(contentsOf: fileURL), original)
    }

    func testRejectsBadKeyLength() {
        XCTAssertThrowsError(try CredentialVault(fileURL: fileURL, key: Data([1, 2, 3])))
    }

    func testGeneratedKeyHasExpectedLength() {
        XCTAssertEqual(CredentialVault.generateKey().count, CredentialVault.keyLength)
        XCTAssertNotEqual(CredentialVault.generateKey(), CredentialVault.generateKey())
    }

    func testUnavailableAndInvalidKeysNeverReplaceExistingEncryptedVault() throws {
        let originalKey = CredentialVault.generateKey()
        let vault = try CredentialVault(fileURL: fileURL, key: originalKey)
        XCTAssertTrue(vault.save(key: "accounts", value: "fixture-only"))
        let originalFile = try Data(contentsOf: fileURL)
        let failures: [VaultKeyReadResult] = [
            .unavailable(-25308), .unavailable(-25293), .unavailable(-128),
            .unavailable(-25291), .unavailable(-26275), .value("invalid-base64!"),
            .value(Data([1, 2, 3]).base64EncodedString()), .notFound
        ]
        for failure in failures {
            var creations = 0
            let resolved = VaultKeyAccess.resolve(failure, existingVault: { true }, createKey: { _ in
                creations += 1
                return true
            })
            XCTAssertNil(resolved)
            XCTAssertEqual(creations, 0)
            XCTAssertEqual(try Data(contentsOf: fileURL), originalFile)
            let reopened = try CredentialVault(fileURL: fileURL, key: originalKey)
            XCTAssertEqual(reopened.load(key: "accounts"), "fixture-only")
        }
    }

    func testVaultKeyReadPreservesValidKeyWithoutCreatingOne() throws {
        let originalKey = CredentialVault.generateKey()
        let resolved = VaultKeyAccess.resolve(.value(originalKey.base64EncodedString()),
            existingVault: { XCTFail("Existing key requires no file probe"); return true },
            createKey: { _ in XCTFail("Existing key must not be created again"); return false })
        XCTAssertEqual(resolved, originalKey)
    }

    func testVaultKeyCreationRequiresConfirmedMissingKeyAndMissingFile() {
        var created: Data?
        let resolved = VaultKeyAccess.resolve(.notFound, existingVault: { false }, createKey: {
            created = Data(base64Encoded: $0)
            return true
        })
        XCTAssertEqual(resolved, created)
        XCTAssertEqual(resolved?.count, CredentialVault.keyLength)
    }

    func testVaultFileProbeFailureAndDuplicateKeyRaceDoNotResolveANewKey() {
        var creations = 0
        XCTAssertNil(VaultKeyAccess.resolve(.notFound, existingVault: {
            throw CocoaError(.fileReadNoPermission)
        }, createKey: { _ in creations += 1; return true }))
        XCTAssertEqual(creations, 0)
        XCTAssertNil(VaultKeyAccess.resolve(.notFound, existingVault: { false }, createKey: { _ in
            creations += 1
            // SecItemAdd reports duplicate; the already stored key is untouched.
            return false
        }))
        XCTAssertEqual(creations, 1)
    }
}
