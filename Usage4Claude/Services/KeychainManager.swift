//
//  KeychainManager.swift
//  Usage4Claude
//
//  Created by f-is-h on 2025-10-19.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import Security
import OSLog

/// 凭据存储后端协议：Debug 用 UserDefaults（便于开发测试、不触发系统弹窗），
/// Release 用 Keychain（安全存储）。两种实现各自独立，`KeychainManager` 只在
/// 选择实现时区分 `#if DEBUG`，业务方法本身不再重复。
///
/// Release seit 2.8.1: `VaultCredentialStorage` — die Daten liegen verschlüsselt
/// in einer Datei, im Schlüsselbund steht nur noch der Schlüssel dazu. Warum,
/// steht im Dateikopf von `CredentialVault.swift`.
protocol CredentialStorage {
    func save(key: String, value: String) -> Bool
    func load(key: String) -> String?
    func delete(key: String) -> Bool
}

/// Debug 模式存储：明文写入 UserDefaults
/// - Warning: 未加密，勿在共享机器上用真实账号跑 Debug 构建
private struct UserDefaultsCredentialStorage: CredentialStorage {
    private let keyPrefix = "DEBUG_"
    private let defaults = UserDefaults.standard

    func save(key: String, value: String) -> Bool {
        defaults.set(value, forKey: keyPrefix + key)
        return true
    }

    func load(key: String) -> String? {
        defaults.string(forKey: keyPrefix + key)
    }

    func delete(key: String) -> Bool {
        defaults.removeObject(forKey: keyPrefix + key)
        return true
    }
}

/// Release 模式存储：写入系统 Keychain
private struct KeychainCredentialStorage: CredentialStorage {
    let service: String

    func save(key: String, value: String) -> Bool {
        // Der Tresorschlüssel wird nie ersetzt, auch nicht nach einem
        // verweigerten oder ungültigen Leseergebnis.
        if key == VaultCredentialStorage.vaultKeyAccount {
            return addIfAbsent(key: key, value: value)
        }
        guard let data = value.data(using: .utf8) else { return false }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data
        ]

        // 先尝试删除已存在的项，再添加新项
        let deleteStatus = SecItemDelete(query as CFDictionary)
        if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
            // Typisch nach einem Update: Der Eintrag gehört der partition ID eines
            // anderen Builds, Löschen wird still verweigert — das Add darunter
            // meldet dann „Duplikat". Genau deshalb speichert Release seit 2.8.1
            // nicht mehr hier (VaultCredentialStorage).
            Logger.keychain.error("Keychain 删除失败: \(key), 状态码: \(deleteStatus)")
        }
        let status = SecItemAdd(query as CFDictionary, nil)

        if status == errSecSuccess {
            return true
        } else {
            Logger.keychain.error("Keychain 保存失败: \(key), 状态码: \(status)")
            return false
        }
    }

    func addIfAbsent(key: String, value: String, allowInteraction: Bool = true) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data
        ]
        if !allowInteraction { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            Logger.keychain.error("Keychain Erstanlage fehlgeschlagen: \(key), Status: \(status)")
            return false
        }
        return true
    }

    func load(key: String) -> String? {
        if case .value(let value) = read(key: key) { return value }
        return nil
    }

    func read(key: String, allowInteraction: Bool = true) -> VaultKeyReadResult {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        if !allowInteraction { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .notFound }
        guard status == errSecSuccess else {
            Logger.keychain.error("Keychain 读取失败: \(key), 状态码: \(status)")
            return .unavailable(status)
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            Logger.keychain.error("Keychain Datenformat ungültig: \(key)")
            return .unavailable(errSecDecode)
        }
        return .value(value)
    }

    func delete(key: String) -> Bool { delete(key: key, allowInteraction: true) }

    func delete(key: String, allowInteraction: Bool) -> Bool {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]

        if !allowInteraction { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
        let status = SecItemDelete(query as CFDictionary)

        if status == errSecSuccess || status == errSecItemNotFound {
            return true
        } else {
            Logger.keychain.error("Keychain 删除失败: \(key), 状态码: \(status)")
            return false
        }
    }
}

/// Release-Speicher seit 2.8.1: Zugangsdaten in `CredentialVault` (verschlüsselte
/// Datei im App-Container), im Schlüsselbund nur der Schlüssel dazu.
///
/// Der Schlüsselbund-Eintrag `vault-key` wird genau einmal angelegt und danach
/// nur noch gelesen — Lesen erlaubt der Schlüsselbund jedem Build derselben
/// Signatur (nach der Einmal-Frage), Schreiben nur dem Build, der den Eintrag
/// angelegt hat (partition ID). Deshalb landet alles, was sich ändert, in der
/// Datei, die die App selbst schreibt.
///
/// Altbestand: Was noch als eigener Schlüsselbund-Eintrag liegt (`accounts`,
/// `accounts_codex`, …), wird beim Start in den Tresor übernommen und im
/// Schlüsselbund gelöscht, sofern der Schlüsselbund das zulässt. Lässt er es
/// nicht zu (Eintrag eines anderen Builds), bleibt der alte Eintrag stehen,
/// wird aber nicht mehr gelesen, sobald der Tresor ihn hat.
///
/// Die GUI wartet bei nicht lesbarem Bestand vor der Konteninitialisierung.
/// Der CLI-Zugriff behält seinen bisherigen Schlüsselbund-Fallback.
private final class VaultCredentialStorage: CredentialStorage {

    /// Name des Schlüssel-Eintrags im Schlüsselbund
    static let vaultKeyAccount = "vault-key"
    /// Einträge, die aus dem Schlüsselbund in den Tresor wandern
    static let migratedKeys = ["accounts", "accounts_codex", "teamServerToken", "sessionKey", "organizationId", "fleetMonitoringAccount"]

    private let keychain: KeychainCredentialStorage
    private let vault: CredentialVault?
    private let keyReadStatus: String
    private let keyOSStatus: Int32?
    private let keyBytes: Int?
    private let vaultFileWasPresent: Bool?
    private let allowInteraction: Bool
    private var legacyReadsReady = false
    private var unavailableLegacyEntries: [String: Int32] = [:]
    private var migrationSaveFailed = false
    private var invalidSavedRecords: [String] = []
    private var providerAccountCounts: [String: Int] = [:]

    private var vaultIsReadable: Bool {
        guard let vault else { return false }
        return vault.keys.allSatisfy { vault.load(key: $0) != nil }
    }

    /// A denied vault-key read must not initialize consumers with empty legacy
    /// fallbacks. A valid key must also decrypt every retained encrypted entry.
    var isReady: Bool {
        vaultIsReadable && legacyReadsReady && !migrationSaveFailed && invalidSavedRecords.isEmpty
    }

    /// Metadata only. Never includes a key, ciphertext or credential value.
    var startupDiagnostics: [String: Any] {
        let names = vault?.keys.sorted() ?? []
        let readable = names.filter { vault?.load(key: $0) != nil }
        return ["keyReadStatus": keyReadStatus,
                "keyOSStatus": keyOSStatus as Any? ?? NSNull(),
                "decodedKeyBytes": keyBytes as Any? ?? NSNull(),
                "vaultFileWasPresent": vaultFileWasPresent as Any? ?? NSNull(),
                "vaultOpened": vault != nil,
                "savedEntryCount": names.count,
                "decryptableEntryCount": readable.count,
                "entryReadiness": Dictionary(uniqueKeysWithValues: names.map { ($0, readable.contains($0)) }),
                "allowsAuthenticationUI": allowInteraction,
                "legacyReadsReady": legacyReadsReady,
                "unavailableLegacyEntries": unavailableLegacyEntries,
                "migrationSaveFailed": migrationSaveFailed,
                "invalidSavedRecords": invalidSavedRecords,
                "providerAccountCounts": providerAccountCounts,
                "ready": isReady]
    }

    var startupMessage: String {
        if !invalidSavedRecords.isEmpty {
            return "Gespeicherte Kontodaten haben ein ungültiges Format. Vorhandene Daten bleiben erhalten; es werden keine leeren Konten gespeichert."
        }
        if let first = unavailableLegacyEntries.sorted(by: { $0.key < $1.key }).first {
            return "macOS hat den Zugriff auf einen gespeicherten Altbestand noch nicht freigegeben (Status \(first.value)). Gespeicherte Konten bleiben erhalten."
        }
        if migrationSaveFailed {
            return "Gespeicherte Daten konnten nicht sicher übernommen werden. Der ursprüngliche Bestand bleibt erhalten."
        }
        if let vault {
            let total = vault.keys.count
            let readable = vault.keys.filter { vault.load(key: $0) != nil }.count
            return "Der gespeicherte Tresor lässt sich nicht vollständig öffnen (\(readable) von \(total) Einträgen lesbar). Vorhandene Daten bleiben erhalten."
        }
        if keyReadStatus == "value" && keyBytes == CredentialVault.keyLength {
            return "Der vorhandene Schlüssel wurde gelesen, der gespeicherte Tresor lässt sich jedoch nicht öffnen. Vorhandene Daten bleiben erhalten."
        }
        if keyReadStatus == "value" {
            return "Der vorhandene Tresorschlüssel hat ein ungültiges Format. Schlüssel und gespeicherte Daten bleiben erhalten."
        }
        if keyReadStatus == "notFound" && vaultFileWasPresent == true {
            return "Der gespeicherte Tresor ist vorhanden, sein Schlüssel wurde jedoch nicht gefunden. Es wird kein Ersatzschlüssel angelegt."
        }
        return "macOS hat den Zugriff noch nicht freigegeben (Status \(keyOSStatus.map(String.init) ?? "unbekannt")). Gespeicherte Konten bleiben erhalten."
    }

    init(service: String, allowInteraction: Bool = true) {
        self.allowInteraction = allowInteraction
        keychain = KeychainCredentialStorage(service: service)
        let read = keychain.read(key: Self.vaultKeyAccount, allowInteraction: allowInteraction)
        switch read {
        case .value(let value):
            keyReadStatus = "value"; keyOSStatus = 0
            keyBytes = Data(base64Encoded: value)?.count
        case .notFound:
            keyReadStatus = "notFound"; keyOSStatus = errSecItemNotFound; keyBytes = nil
        case .unavailable(let status):
            keyReadStatus = "unavailable"; keyOSStatus = status; keyBytes = nil
        }
        if let file = Self.vaultFileURL(service: service) {
            do {
                _ = try FileManager.default.attributesOfItem(atPath: file.path)
                vaultFileWasPresent = true
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                vaultFileWasPresent = false
            } catch { vaultFileWasPresent = nil }
        } else { vaultFileWasPresent = nil }
        vault = Self.openVault(service: service, keychain: keychain, read: read, allowInteraction: allowInteraction)
        if vaultIsReadable { migrateLegacyEntries() }
    }

    // MARK: - CredentialStorage

    func save(key: String, value: String) -> Bool {
        guard let vault else { return keychain.save(key: key, value: value) }
        let saved = vault.save(key: key, value: value)
        if !saved {
            Logger.keychain.error("Tresor: Speichern fehlgeschlagen (\(key))")
        }
        return saved
    }

    func load(key: String) -> String? {
        if let vault, let value = vault.load(key: key) {
            return value
        }
        // Readiness already proved each missing startup entry is notFound.
        // Never prompt again or resurrect an older copy on the UI thread.
        if legacyReadsReady && Self.migratedKeys.contains(key) { return nil }
        // Noch nicht übernommener Altbestand — oder gar kein Tresor
        return keychain.load(key: key)
    }

    func delete(key: String) -> Bool {
        let vaultDone = vault?.delete(key: key) ?? true
        let keychainDone = keychain.delete(key: key)
        return vaultDone && keychainDone
    }

    // MARK: - Tresor öffnen

    private static func openVault(service: String, keychain: KeychainCredentialStorage, read: VaultKeyReadResult, allowInteraction: Bool) -> CredentialVault? {
        guard let fileURL = vaultFileURL(service: service) else {
            Logger.keychain.error("Tresor: Application-Support-Ordner nicht erreichbar")
            return nil
        }

        guard let keyData = VaultKeyAccess.resolve(read, existingVault: {
            do {
                _ = try FileManager.default.attributesOfItem(atPath: fileURL.path)
                return true
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                return false
            }
        }, createKey: { keychain.addIfAbsent(key: vaultKeyAccount, value: $0, allowInteraction: allowInteraction) }) else {
            Logger.keychain.error("Tresor-Schlüssel nicht sicher verfügbar – bestehender Schlüssel und Tresor bleiben erhalten")
            return nil
        }

        do {
            return try CredentialVault(fileURL: fileURL, key: keyData)
        } catch {
            Logger.keychain.error("Tresor konnte nicht geöffnet werden: \(error.localizedDescription)")
            return nil
        }
    }

    /// `~/Library/Containers/<bundle id>/Data/Library/Application Support/<service>/credentials.vault`
    /// (die App ist sandboxed, FileManager liefert den Container-Pfad)
    private static func vaultFileURL(service: String) -> URL? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return base
            .appendingPathComponent(service, isDirectory: true)
            .appendingPathComponent("credentials.vault")
    }

    // MARK: - Altbestand übernehmen

    /// Einmal je Eintrag: Was noch im Schlüsselbund liegt und im Tresor fehlt,
    /// wird kopiert und — wenn der Schlüsselbund es zulässt — dort gelöscht.
    private func migrateLegacyEntries() {
        guard let vault else { return }
        var pending: [String: String] = [:]
        for key in Self.migratedKeys where !vault.contains(key: key) {
            switch keychain.read(key: key, allowInteraction: allowInteraction) {
            case .value(let value): pending[key] = value
            case .notFound: continue
            case .unavailable(let status):
                unavailableLegacyEntries[key] = status
                // No migration write/delete until every needed read is known.
                return
            }
        }
        // Match the real consumer decoders before migrating or initializing
        // accounts. Decryptable UTF-8 alone is not a valid saved account list.
        for key in ["accounts", "accounts_codex", "fleetMonitoringAccount"] {
            guard let value = vault.load(key: key) ?? pending[key] else {
                providerAccountCounts[key] = 0
                continue
            }
            guard let data = value.data(using: .utf8) else {
                invalidSavedRecords.append(key)
                continue
            }
            if key == "fleetMonitoringAccount" {
                if let account = try? JSONDecoder().decode(FleetMonitoringAccount.self, from: data),
                   !account.refreshToken.isEmpty {
                    providerAccountCounts[key] = 1
                } else { invalidSavedRecords.append(key) }
            } else if let accounts = try? JSONDecoder().decode([Account].self, from: data) {
                providerAccountCounts[key] = accounts.count
            } else { invalidSavedRecords.append(key) }
        }
        guard invalidSavedRecords.isEmpty else { return }
        for key in Self.migratedKeys {
            guard let value = pending[key] else { continue }
            guard vault.save(key: key, value: value) else {
                migrationSaveFailed = true
                Logger.keychain.error("Tresor: Übernahme fehlgeschlagen (\(key)) – bleibt im Schlüsselbund")
                return
            }
        }
        legacyReadsReady = true
        for key in Self.migratedKeys where pending[key] != nil {
            // Löschen gelingt nur dem Build, der den Eintrag angelegt hat. Sonst
            // bleibt eine (ab jetzt ungelesene) Kopie liegen — `delete` loggt das.
            _ = keychain.delete(key: key, allowInteraction: allowInteraction)
            Logger.keychain.notice("Tresor: \(key) übernommen")
        }
    }
}

/// 管理认证凭据存储的类
/// 用于安全存储敏感信息（如 Organization ID 和 Session Key）
/// Debug 模式：使用 UserDefaults（便于开发测试，不弹窗）
/// Release 模式：使用 Keychain（安全存储）
class KeychainManager {
    static let shared = KeychainManager()

    // Merely constructing the singleton must not make a protected read before
    // AppKit can show the startup window. CLI first use keeps normal OS auth.
    private var preparedStorage: CredentialStorage?
    private var storage: CredentialStorage {
        if let preparedStorage { return preparedStorage }
        #if DEBUG
        let created: CredentialStorage = UserDefaultsCredentialStorage()
        #else
        let created: CredentialStorage = VaultCredentialStorage(service: Bundle.main.bundleIdentifier ?? "xyz.fi5h.Usage4Claude")
        #endif
        preparedStorage = created
        return created
    }
    private(set) var startupReadinessMessage = "Gespeicherte Verbindung wird geladen …"

    private init() {}

    /// The first GUI probe cannot display OS auth UI: it returns a precise
    /// status while keeping AppKit responsive. Explicit Retry uses normal auth
    /// on this same binary and always constructs a fresh backend.
    func prepareForApplicationStartup(retry: Bool) -> Bool {
        #if DEBUG
        return true
        #else
        let candidate = VaultCredentialStorage(
            service: Bundle.main.bundleIdentifier ?? "xyz.fi5h.Usage4Claude",
            allowInteraction: retry)
        recordStartupDiagnostics(candidate)
        guard candidate.isReady else { return false }
        preparedStorage = candidate
        return true
        #endif
    }

    private func recordStartupDiagnostics(_ backend: VaultCredentialStorage) {
        startupReadinessMessage = backend.startupMessage
        var metadata = backend.startupDiagnostics
        metadata["schema"] = 1
        metadata["processIdentifier"] = ProcessInfo.processInfo.processIdentifier
        metadata["recordedAt"] = ISO8601DateFormatter().string(from: Date())
        metadata["appVersion"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        // Existing Worker Setup directory; read-only diagnostics contain counts
        // and OS statuses only, never credentials or encrypted data.
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Max Monitor/Worker Setup", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let file = directory.appendingPathComponent("startup-diagnostics.json")
            let data = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { /* Diagnostic persistence cannot change credential readiness. */ }
    }

    // MARK: - Organization ID / Session Key

    @discardableResult
    func saveOrganizationId(_ value: String) -> Bool {
        storage.save(key: "organizationId", value: value)
    }

    func loadOrganizationId() -> String? {
        storage.load(key: "organizationId")
    }

    @discardableResult
    func deleteOrganizationId() -> Bool {
        storage.delete(key: "organizationId")
    }

    @discardableResult
    func saveSessionKey(_ value: String) -> Bool {
        storage.save(key: "sessionKey", value: value)
    }

    func loadSessionKey() -> String? {
        storage.load(key: "sessionKey")
    }

    @discardableResult
    func deleteSessionKey() -> Bool {
        storage.delete(key: "sessionKey")
    }

    /// 删除所有认证信息
    /// - Returns: 是否全部删除成功
    @discardableResult
    func deleteAll() -> Bool {
        let result1 = deleteOrganizationId()
        let result2 = deleteSessionKey()
        return result1 && result2
    }

    /// 删除所有凭证信息（deleteAll 的别名，更符合业务语义）
    /// - Returns: 是否全部删除成功
    @discardableResult
    func deleteCredentials() -> Bool {
        deleteAll()
    }

    // MARK: - Team-Server-Token

    /// Token der Team-Server-Verbindung (`TeamServerConnection`).
    /// Wie alle Zugangsdaten: Release im Schlüsselbund, DEBUG in UserDefaults
    /// (Schlüssel `DEBUG_teamServerToken`).

    @discardableResult
    func saveTeamServerToken(_ value: String) -> Bool {
        storage.save(key: "teamServerToken", value: value)
    }

    func loadTeamServerToken() -> String? {
        storage.load(key: "teamServerToken")
    }

    @discardableResult
    func deleteTeamServerToken() -> Bool {
        storage.delete(key: "teamServerToken")
    }

    // Separate from accounts/accounts_codex; never populated by Account Limits.
    @discardableResult
    func saveFleetMonitoringAccount(_ value: String) -> Bool {
        storage.save(key: "fleetMonitoringAccount", value: value)
    }

    func loadFleetMonitoringAccount() -> String? {
        storage.load(key: "fleetMonitoringAccount")
    }

    @discardableResult
    func deleteFleetMonitoringAccount() -> Bool {
        storage.delete(key: "fleetMonitoringAccount")
    }

    // MARK: - 账户列表存储（v2.1.0 多账户支持）

    @discardableResult
    func saveAccounts(_ accounts: [Account]) -> Bool {
        saveAccountsList(accounts, key: "accounts")
    }

    func loadAccounts() -> [Account]? {
        loadAccountsList(key: "accounts")
    }

    @discardableResult
    func deleteAccounts() -> Bool {
        storage.delete(key: "accounts")
    }

    // MARK: - Codex 账户列表存储

    @discardableResult
    func saveCodexAccounts(_ accounts: [Account]) -> Bool {
        saveAccountsList(accounts, key: "accounts_codex")
    }

    func loadCodexAccounts() -> [Account]? {
        loadAccountsList(key: "accounts_codex")
    }

    @discardableResult
    func deleteCodexAccounts() -> Bool {
        storage.delete(key: "accounts_codex")
    }

    // MARK: - 账户列表的 JSON 编解码封装

    @discardableResult
    private func saveAccountsList(_ accounts: [Account], key: String) -> Bool {
        guard let jsonData = try? JSONEncoder().encode(accounts),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            Logger.keychain.error("账户列表编码失败 (\(key))")
            return false
        }
        let result = storage.save(key: key, value: jsonString)
        if result {
            Logger.keychain.debug("保存 \(accounts.count) 个账户 (\(key))")
        }
        return result
    }

    private func loadAccountsList(key: String) -> [Account]? {
        guard let jsonString = storage.load(key: key),
              let jsonData = jsonString.data(using: .utf8) else {
            return nil
        }
        guard let accounts = try? JSONDecoder().decode([Account].self, from: jsonData) else {
            Logger.keychain.error("账户列表解码失败 (\(key))")
            return nil
        }
        Logger.keychain.debug("读取 \(accounts.count) 个账户 (\(key))")
        return accounts
    }
}
