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

/// Release storage: one-time legacy import, then a private local key and encrypted vault.
/// Preserve startup gating and the actual saved-account decoders before any migration commit.
private final class VaultCredentialStorage: CredentialStorage {
    static let vaultKeyAccount = "vault-key"
    static let migratedKeys = PersistentCredentialVault.migratedKeys
    private var vault: PersistentCredentialVault?
    private var keyReadStatus = "unavailable"
    private var keyOSStatus: Int32?
    private var keyBytes: Int?
    private var legacyReadCount = 0
    private var failureMessage = "Gespeicherte Daten konnten nicht sicher übernommen werden. Der ursprüngliche Bestand bleibt erhalten."
    private var providerAccountCounts: [String: Int] = [:]
    private var invalidSavedRecords: [String] = []
    private var unavailableLegacyEntries: [String: Int32] = [:]
    private let allowInteraction: Bool
    var isReady: Bool { vault != nil }

    var startupDiagnostics: [String: Any] {
        let names = vault?.keys.sorted() ?? []
        return ["keyReadStatus": keyReadStatus, "keyOSStatus": keyOSStatus as Any? ?? NSNull(),
                "decodedKeyBytes": keyBytes as Any? ?? NSNull(), "vaultOpened": vault != nil,
                "savedEntryCount": names.count, "decryptableEntryCount": names.count,
                "entryReadiness": Dictionary(uniqueKeysWithValues: names.map { ($0, true) }),
                "allowsAuthenticationUI": allowInteraction, "legacyReadsReady": isReady,
                "legacyReadCount": legacyReadCount, "credentialStorage": "persistentLocalVault",
                "unavailableLegacyEntries": unavailableLegacyEntries,
                "invalidSavedRecords": invalidSavedRecords, "providerAccountCounts": providerAccountCounts,
                "ready": isReady]
    }
    var startupMessage: String { failureMessage }

    init(service: String, allowInteraction: Bool = true) {
        self.allowInteraction = allowInteraction
        guard let file = Self.vaultFileURL(service: service) else { return }
        let source = KeychainCredentialStorage(service: service)
        do {
            vault = try PersistentCredentialVault(directory: file.deletingLastPathComponent(),
                fileName: file.lastPathComponent, loadLegacy: { name in
                    self.legacyReadCount += 1
                    switch source.read(key: name, allowInteraction: allowInteraction) {
                    case .value(let value):
                        if name == Self.vaultKeyAccount {
                            self.keyReadStatus = "value"; self.keyOSStatus = 0
                            self.keyBytes = Data(base64Encoded: value)?.count
                        }
                        return value
                    case .notFound:
                        if name == Self.vaultKeyAccount { self.keyReadStatus = "notFound"; self.keyOSStatus = errSecItemNotFound }
                        return nil
                    case .unavailable(let status):
                        self.keyOSStatus = status
                        self.unavailableLegacyEntries[name] = status
                        self.failureMessage = "macOS hat den Zugriff auf einen gespeicherten Altbestand noch nicht freigegeben (Status \(status)). Gespeicherte Konten bleiben erhalten."
                        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
                    }
                }, validateEntries: { values in
                    for name in ["accounts", "accounts_codex", "fleetMonitoringAccount"] {
                        guard let value = values[name], let data = value.data(using: .utf8) else {
                            self.providerAccountCounts[name] = 0; continue
                        }
                        if name == "fleetMonitoringAccount" {
                            if let account = try? JSONDecoder().decode(FleetMonitoringAccount.self, from: data),
                               !account.refreshToken.isEmpty { self.providerAccountCounts[name] = 1 }
                            else { self.invalidSavedRecords.append(name) }
                        } else if let accounts = try? JSONDecoder().decode([Account].self, from: data) {
                            self.providerAccountCounts[name] = accounts.count
                        } else { self.invalidSavedRecords.append(name) }
                    }
                    guard self.invalidSavedRecords.isEmpty else {
                        self.failureMessage = "Gespeicherte Kontodaten haben ein ungültiges Format. Vorhandene Daten bleiben erhalten; es werden keine leeren Konten gespeichert."
                        throw CocoaError(.fileReadCorruptFile)
                    }
                })
            if legacyReadCount == 0 { keyReadStatus = "local"; keyOSStatus = nil; keyBytes = CredentialVault.keyLength }
        } catch {
            vault = nil
            Logger.keychain.error("Tresor nicht verfügbar; Altbestand bleibt erhalten: \(error.localizedDescription, privacy: .public)")
        }
    }

    func save(key: String, value: String) -> Bool { vault?.save(key: key, value: value) ?? false }
    func load(key: String) -> String? { vault?.load(key: key) }
    func delete(key: String) -> Bool { vault?.delete(key: key) ?? false }

    static func hasLocalStorage(service: String) -> Bool {
        guard let file = vaultFileURL(service: service) else { return false }
        // Even damaged local storage must fail locally rather than prompt again.
        return FileManager.default.fileExists(atPath: file.deletingLastPathComponent()
            .appendingPathComponent("credentials.ready").path)
    }

    private static func vaultFileURL(service: String) -> URL? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return base.appendingPathComponent(service, isDirectory: true).appendingPathComponent("credentials.vault")
    }

    // MARK: - Altbestand übernehmen
    // PersistentCredentialVault commits only after all reads and model decoders succeed.
}

/// The file-based macOS Keychain ignores the SecItem authentication-UI query
/// flag when it falls through to SecKeychainItemCopyContent. Its documented
/// process-wide UI switch is used only during the serialized pre-consumer probe.
private enum LegacyKeychainStartupProbe {
    struct Failure: Error {
        let stage: String
        let status: OSStatus
        let restoreStatus: OSStatus?
    }
    private static let lock = NSLock()

    static func perform<T>(allowInteraction: Bool, load: () -> T) -> Result<T, Failure> {
        lock.lock(); defer { lock.unlock() }
        guard !allowInteraction else { return .success(load()) }
        var previous: DarwinBoolean = false
        let readStatus = SecKeychainGetUserInteractionAllowed(&previous)
        guard readStatus == errSecSuccess else {
            return .failure(Failure(stage: "readInteractionState", status: readStatus, restoreStatus: nil))
        }
        let disableStatus = SecKeychainSetUserInteractionAllowed(false)
        guard disableStatus == errSecSuccess else {
            let restored = SecKeychainSetUserInteractionAllowed(previous.boolValue)
            return .failure(Failure(stage: "disableInteraction", status: disableStatus, restoreStatus: restored))
        }
        let candidate = load()
        let restored = SecKeychainSetUserInteractionAllowed(previous.boolValue)
        guard restored == errSecSuccess else {
            return .failure(Failure(stage: "restoreInteractionState", status: restored, restoreStatus: restored))
        }
        return .success(candidate)
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
        let service = Bundle.main.bundleIdentifier ?? "xyz.fi5h.Usage4Claude"
        let result: Result<VaultCredentialStorage, LegacyKeychainStartupProbe.Failure>
        if VaultCredentialStorage.hasLocalStorage(service: service) {
            result = .success(VaultCredentialStorage(service: service, allowInteraction: false))
        } else {
            result = LegacyKeychainStartupProbe.perform(allowInteraction: retry) {
                VaultCredentialStorage(service: service, allowInteraction: retry)
            }
        }
        guard case .success(let candidate) = result else {
            if case .failure(let failure) = result {
                startupReadinessMessage = "Die sichere Schlüsselbundprüfung konnte nicht abgeschlossen werden (Status \(failure.status)). Gespeicherte Daten bleiben erhalten."
                persistStartupDiagnostics(["ready": false, "startupProbeSafetyFailure": failure.stage,
                    "keyOSStatus": failure.status,
                    "interactionRestoreStatus": failure.restoreStatus as Any? ?? NSNull()])
            }
            return false
        }
        recordStartupDiagnostics(candidate)
        guard candidate.isReady else { return false }
        preparedStorage = candidate
        return true
        #endif
    }

    private func recordStartupDiagnostics(_ backend: VaultCredentialStorage) {
        startupReadinessMessage = backend.startupMessage
        persistStartupDiagnostics(backend.startupDiagnostics)
    }

    private func persistStartupDiagnostics(_ values: [String: Any]) {
        var metadata = values
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
