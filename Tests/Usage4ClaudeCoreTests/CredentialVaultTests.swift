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

    func testCorruptFileIsTreatedAsEmpty() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: fileURL)
        let vault = try CredentialVault(fileURL: fileURL, key: CredentialVault.generateKey())
        XCTAssertNil(vault.load(key: "accounts"))
        XCTAssertTrue(vault.save(key: "accounts", value: "[]"))
        XCTAssertEqual(vault.load(key: "accounts"), "[]")
    }

    func testRejectsBadKeyLength() {
        XCTAssertThrowsError(try CredentialVault(fileURL: fileURL, key: Data([1, 2, 3])))
    }

    func testGeneratedKeyHasExpectedLength() {
        XCTAssertEqual(CredentialVault.generateKey().count, CredentialVault.keyLength)
        XCTAssertNotEqual(CredentialVault.generateKey(), CredentialVault.generateKey())
    }
}
