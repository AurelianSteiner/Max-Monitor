//
//  CredentialVault.swift
//  Usage4Claude
//
//  Verschlüsselte Ablage für Zugangsdaten — die Antwort auf ein Schlüsselbund-
//  Problem, das jedes Update betraf.
//
//  Der macOS-Schlüsselbund versieht jeden Eintrag mit einer „partition ID":
//  bei Apps ohne Apple-Team-ID ist das der Code-Hash (cdhash) genau des
//  Builds, der den Eintrag angelegt hat. Ein neuer Build darf den Eintrag
//  nach der Einmal-Frage („Erlauben") zwar **lesen**, aber weder ändern noch
//  löschen — `SecItemDelete` scheitert still, `SecItemAdd` meldet dann
//  „Duplikat" (-25299). Folge: Nach jedem Update konnte die App nichts mehr
//  speichern. Rotierte Refresh-Tokens, neue Konten, Aliase, Kündigungsdaten —
//  alles lebte nur bis zum nächsten Start. Beobachtet mit 2.8 im
//  securityd-Log: „ACL partition mismatch: client cdhash:… ACL (cdhash:…)".
//
//  Die Daten liegen AES-GCM-verschlüsselt in Application Support/<bundle id>.
//  PersistentCredentialVault übernimmt den bisherigen Schlüssel und Altbestand
//  einmalig. Danach liegt auch der Schlüssel in einer lokalen Datei (0600 im
//  Verzeichnis 0700). Neustarts und neue Signaturen greifen nicht mehr auf den
//  Schlüsselbund zu. Die Zugriffsschranke ist das macOS-Benutzerkonto; Prozesse
//  desselben Benutzers können auch den lokalen Schlüssel lesen.
//
//  Format: JSON `{ "version": 1, "entries": { "<name>": "<base64>" } }`, jeder
//  Wert einzeln versiegelt (AES-GCM, zufällige Nonce je Schreibvorgang, der
//  Eintragsname als zusätzliche authentifizierte Daten — ein Chiffrat lässt
//  sich also nicht unter einen anderen Namen schieben). Datei mit Modus 0600,
//  atomar geschrieben, alle Zugriffe hinter einem Lock (die Konto-Speicherung
//  läuft auf einer nebenläufigen Queue).
//
//  Ohne Abhängigkeiten auf den Rest der App — wird per `swift test` geprüft.
//

import Foundation
import CryptoKit
import Darwin

nonisolated final class CredentialVault {

    /// Länge des Schlüssels in Bytes (AES-256)
    static let keyLength = 32

    enum VaultError: Error, Equatable {
        /// Der Schlüssel hat nicht die erwartete Länge
        case badKey
    }

    private let fileURL: URL
    private let key: SymmetricKey
    private let lock = NSLock()
    /// Eintragsname → Base64 des versiegelten Werts (`AES.GCM.SealedBox.combined`)
    private var entries: [String: String]

    /// Öffnet (oder beginnt) den Tresor in `fileURL` mit dem 32-Byte-Schlüssel.
    /// Eine fehlende Datei ist ein leerer Tresor. Unlesbare oder beschädigte
    /// Dateien sind Fehler und dürfen nicht durch einen leeren Tresor ersetzt werden.
    init(fileURL: URL, key: Data) throws {
        guard key.count == Self.keyLength else { throw VaultError.badKey }
        self.fileURL = fileURL
        self.key = SymmetricKey(data: key)
        self.entries = try Self.readEntries(at: fileURL)
    }

    /// Zufälliger Schlüssel für einen neuen Tresor
    static func generateKey() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    // MARK: - Zugriff

    /// Namen aller Einträge (für Migration und Diagnose)
    var keys: [String] {
        lock.lock(); defer { lock.unlock() }
        return Array(entries.keys)
    }

    func contains(key name: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return entries[name] != nil
    }

    /// Entschlüsselt einen Eintrag. nil, wenn er fehlt oder nicht zu diesem
    /// Schlüssel passt (anderer Schlüssel, manipulierte Datei).
    func load(key name: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let encoded = entries[name],
              let combined = Data(base64Encoded: encoded),
              let box = try? AES.GCM.SealedBox(combined: combined),
              let plain = try? AES.GCM.open(box, using: key, authenticating: Data(name.utf8)) else {
            return nil
        }
        return String(data: plain, encoding: .utf8)
    }

    /// Versiegelt und schreibt einen Eintrag. false, wenn die Datei nicht
    /// geschrieben werden konnte — dann bleibt der alte Stand auf der Platte.
    @discardableResult
    func save(key name: String, value: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let box = try? AES.GCM.seal(Data(value.utf8), using: key, authenticating: Data(name.utf8)),
              let combined = box.combined else {
            return false
        }
        let previous = entries[name]
        entries[name] = combined.base64EncodedString()
        do {
            try persist()
            return true
        } catch {
            entries[name] = previous
            return false
        }
    }

    /// Entfernt einen Eintrag. Ein fehlender Eintrag gilt als erledigt.
    @discardableResult
    func delete(key name: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard entries[name] != nil else { return true }
        let previous = entries[name]
        entries[name] = nil
        do {
            try persist()
            return true
        } catch {
            entries[name] = previous
            return false
        }
    }

    // MARK: - Datei

    private static func readEntries(at url: URL) throws -> [String: String] {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return [:]
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["version"] as? Int == 1,
              let entries = json["entries"] as? [String: String] else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return entries
    }

    /// Schreibt die Datei atomar und nur für den Benutzer lesbar. Der Ordner
    /// wird bei Bedarf angelegt.
    private func persist() throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let payload: [String: Any] = ["version": 1, "entries": entries]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        try data.write(to: fileURL, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}


/// Production persistence, also exercised by SwiftPM with an injected legacy reader.
/// An unfinished initial import is the only path that can use Keychain. No fallback exists
/// for missing/deleted entries, failed writes, or a damaged local key.
nonisolated final class PersistentCredentialVault {
    static let migratedKeys = [
        "accounts", "accounts_codex", "teamServerToken", "sessionKey", "organizationId",
        "fleetMonitoringAccount"
    ]
    enum StorageError: Error {
        case missingKey, invalidKey, unreadableEntry, persistenceFailed
    }

    private let vault: CredentialVault

    init(directory: URL, loadLegacy: (String) throws -> String?) throws {
        let files = FileManager.default
        try files.createDirectory(at: directory, withIntermediateDirectories: true,
                                  attributes: [.posixPermissions: 0o700])
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        // Enrollment commands and the GUI may start together. Only one process
        // may import credentials or create the durable key at a time.
        let descriptor = open(directory.appendingPathComponent(".credentials.lock").path,
                              O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteNoPermission) }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw CocoaError(.fileLocking) }
        defer { flock(descriptor, LOCK_UN) }

        let fileURL = directory.appendingPathComponent("credentials.vault")
        let keyURL = directory.appendingPathComponent("credentials.key")
        let readyURL = directory.appendingPathComponent("credentials.ready")
        let ready = files.fileExists(atPath: readyURL.path)
        let localKey = files.fileExists(atPath: keyURL.path)
        let key: Data
        if localKey {
            key = try Data(contentsOf: keyURL)
        } else {
            // A completed setup losing its key must never generate a replacement
            // or silently revert to old Keychain credentials.
            guard !ready else { throw StorageError.missingKey }
            if let stored = try loadLegacy("vault-key") {
                guard let decoded = Data(base64Encoded: stored) else { throw StorageError.invalidKey }
                key = decoded
            } else {
                guard !files.fileExists(atPath: fileURL.path) else { throw StorageError.missingKey }
                key = CredentialVault.generateKey()
            }
        }
        guard key.count == CredentialVault.keyLength else { throw StorageError.invalidKey }
        let opened = try CredentialVault(fileURL: fileURL, key: key)
        // Validate before publishing a local key or changing any existing data.
        for name in opened.keys {
            guard opened.load(key: name) != nil else { throw StorageError.unreadableEntry }
        }
        var legacyEntries: [String: String] = [:]
        if !ready {
            for name in Self.migratedKeys where !opened.contains(key: name) {
                legacyEntries[name] = try loadLegacy(name)
            }
        }

        if !localKey {
            // The directory is private before the key is created. Never replace
            // a key, including during an interrupted first import.
            try key.write(to: keyURL, options: [.withoutOverwriting])
        }
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyURL.path)
        if files.fileExists(atPath: fileURL.path) {
            try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        }
        for (name, value) in legacyEntries {
            guard opened.save(key: name, value: value) else { throw StorageError.persistenceFailed }
        }
        if !ready {
            // Commit last. An interrupted import keeps its key and retries only
            // unfinished entries; existing vault and Keychain sources survive.
            try Data("1\n".utf8).write(to: readyURL, options: [.atomic])
            try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: readyURL.path)
        }
        vault = opened
    }

    func load(key: String) -> String? { vault.load(key: key) }

    @discardableResult
    func save(key: String, value: String) -> Bool { vault.save(key: key, value: value) }

    @discardableResult
    func delete(key: String) -> Bool { vault.delete(key: key) }
}
