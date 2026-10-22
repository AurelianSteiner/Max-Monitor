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
/// Release 用本地加密存储。两种实现各自独立，`KeychainManager` 只在
/// 选择实现时区分 `#if DEBUG`，业务方法本身不再重复。
///
/// Release seit 2.8.1: `VaultCredentialStorage` — die Daten liegen verschlüsselt
/// in einer Datei. Auch der Schlüssel wird nach einmaliger Übernahme lokal
/// gespeichert; Neustarts und Updates benötigen keinen Schlüsselbundzugriff.
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

/// Read-only source for the one-time import from earlier releases.
private struct KeychainCredentialStorage {
    let service: String

    /// Only used during the initial import. Denial is an error, never "no key".
    func load(key: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        guard let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return value
    }
}

/// Release storage: encrypted vault and durable local key, private to this user.
/// Keychain is read only until the initial import completes; never as a fallback.
private final class VaultCredentialStorage: CredentialStorage {
    private let vault: PersistentCredentialVault?

    init(service: String) {
        do {
            let base = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            )
            let directory = base.appendingPathComponent(service, isDirectory: true)
            let legacy = KeychainCredentialStorage(service: service)
            vault = try PersistentCredentialVault(directory: directory, loadLegacy: legacy.load)
        } catch {
            // Fail closed: no repeated Keychain fallback and no replacement key.
            vault = nil
            Logger.keychain.error("Tresor nicht verfügbar; Altbestand bleibt erhalten: \(error.localizedDescription, privacy: .public)")
        }
    }

    func save(key: String, value: String) -> Bool {
        vault?.save(key: key, value: value) ?? false
    }

    func load(key: String) -> String? {
        vault?.load(key: key)
    }

    func delete(key: String) -> Bool {
        vault?.delete(key: key) ?? false
    }
}

/// 管理认证凭据存储的类
/// 用于安全存储敏感信息（如 Organization ID 和 Session Key）
/// Debug 模式：使用 UserDefaults（便于开发测试，不弹窗）
/// Release 模式：使用本地加密存储
class KeychainManager {
    static let shared = KeychainManager()

    private let storage: CredentialStorage

    private init() {
        #if DEBUG
        storage = UserDefaultsCredentialStorage()
        #else
        // 动态获取 Bundle ID，如果获取失败则使用默认值
        // Local vault + local key; Keychain is only an initial migration source.
        storage = VaultCredentialStorage(service: Bundle.main.bundleIdentifier ?? "xyz.fi5h.Usage4Claude")
        #endif
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
    /// Wie alle Zugangsdaten: Release im lokalen Tresor, DEBUG in UserDefaults
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
