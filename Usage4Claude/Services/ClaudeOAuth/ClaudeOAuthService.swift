//
//  ClaudeOAuthService.swift
//  Usage4Claude
//
//  Created by f-is-h on 2026-06-19.
//  Copyright © 2026 f-is-h. All rights reserved.
//

import Foundation
import OSLog

/// Claude OAuth token 端点返回的凭据
struct ClaudeOAuthTokens {
    let accessToken: String
    /// refresh 端点未轮换时可能为空字符串，调用方应保留旧值
    let refreshToken: String
    let expiresAt: Date?
}

/// Claude OAuth token 端点交互
///
/// 授权码交换与 refresh 均向 `console.anthropic.com/v1/oauth/token` POST **JSON** body
/// （与官方 Claude Code 一致）。
enum ClaudeOAuthService {

    // MARK: - 授权码换 token

    static func exchangeCode(
        code: String,
        state: String,
        codeVerifier: String,
        redirectURI: String,
        completion: @escaping (Result<ClaudeOAuthTokens, Error>) -> Void
    ) {
        post(payload: [
            "grant_type": "authorization_code",
            "code": code,
            "state": state,
            "redirect_uri": redirectURI,
            "client_id": ClaudeOAuthConfig.clientID,
            "code_verifier": codeVerifier
        ], completion: completion)
    }

    // MARK: - refresh_token 续期

    static func refresh(
        refreshToken: String,
        completion: @escaping (Result<ClaudeOAuthTokens, Error>) -> Void
    ) {
        post(payload: [
            "grant_type": "refresh_token",
            "refresh_token": refreshToken,
            "client_id": ClaudeOAuthConfig.clientID
        ], completion: completion)
    }

    // MARK: - 账户信息（用于账户显示名）

    /// 拉取 profile，返回 (email, 组织 uuid, 组织名, 账户类型)
    /// 组织 uuid 用作账户的 organizationId（与旧 cookie 账户的去重标识一致，便于迁移）
    static func fetchProfile(
        accessToken: String,
        completion: @escaping (Result<(email: String, orgId: String, orgName: String, kind: AccountKind), Error>) -> Void
    ) {
        guard let url = URL(string: ClaudeOAuthConfig.profileURL) else {
            completion(.failure(UsageError.invalidURL))
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(ClaudeOAuthConfig.betaHeader, forHTTPHeaderField: "anthropic-beta")
        session.dataTask(with: request) { data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let account = json["account"] as? [String: Any] else {
                completion(.failure(UsageError.decodingError))
                return
            }
            let email = account["email"] as? String ?? ""
            let org = json["organization"] as? [String: Any]
            let orgId = org?["uuid"] as? String ?? ""
            let orgName = org?["name"] as? String ?? email
            logOrganizationKeysOnce(org)
            let kind = accountKind(fromOrganization: org)
            completion(.success((email: email, orgId: orgId, orgName: orgName, kind: kind)))
        }.resume()
    }

    // MARK: - Firma oder privat?

    /// Anthropic dokumentiert im Profil kein festes Feld für „Team vs. privates
    /// Abo". Deshalb werden mehrere plausible Schlüssel abgeklopft — alle
    /// optional gelesen, fehlende oder unerwartete Formen ergeben `.unknown`.
    /// Aus dem Organisationsnamen wird bewusst **nicht** geraten.
    static func accountKind(fromOrganization org: [String: Any]?) -> AccountKind {
        guard let org else { return .unknown }

        // 1) Direkte Typ-Felder
        for key in ["organization_type", "billing_type", "type"] {
            if let raw = org[key] as? String {
                let detected = kind(fromMarker: raw)
                if detected != .unknown { return detected }
            }
        }

        // 2) capabilities: Liste von Markern wie "claude_max" / "raven"
        if let markers = (org["capabilities"] as? [Any])?.compactMap({ $0 as? String }) {
            if markers.contains(where: { kind(fromMarker: $0) == .company }) { return .company }
            if markers.contains(where: { kind(fromMarker: $0) == .personal }) { return .personal }
        }

        return .unknown
    }

    /// Firmen-Marker gewinnen: „claude_team" ist ein Firmenkonto, auch wenn
    /// „claude" nach dem privaten Abo klingt.
    private static func kind(fromMarker raw: String) -> AccountKind {
        let value = raw.lowercased()
        let company = ["team", "enterprise", "business", "raven", "work"]
        let personal = ["max", "pro", "individual", "personal", "consumer", "free"]
        if company.contains(where: { value.contains($0) }) { return .company }
        if personal.contains(where: { value.contains($0) }) { return .personal }
        return .unknown
    }

    /// Einmal pro Programmlauf die **Schlüsselnamen** des organization-Objekts
    /// loggen (nie die Werte — dort stehen Firmenname und uuid). Damit lassen
    /// sich die echten Feldnamen aus einem realen Login ablesen und die Erkennung
    /// oben später schärfen.
    private static var didLogOrganizationKeys = false

    private static func logOrganizationKeysOnce(_ org: [String: Any]?) {
        guard !didLogOrganizationKeys, let org else { return }
        didLogOrganizationKeys = true
        let keys = org.keys.sorted().joined(separator: ", ")
        Logger.api.debug("Claude profile organization keys: \(keys, privacy: .public)")
    }

    // MARK: - Private

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private static func post(payload: [String: String], completion: @escaping (Result<ClaudeOAuthTokens, Error>) -> Void) {
        guard let url = URL(string: ClaudeOAuthConfig.tokenURL),
              let body = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(.failure(UsageError.invalidURL))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        session.dataTask(with: request) { data, response, error in
            if let error = error {
                Logger.api.error("Claude OAuth token 请求失败: \(error.localizedDescription)")
                completion(.failure(UsageError.networkError))
                return
            }
            guard let data = data else {
                completion(.failure(UsageError.noData))
                return
            }
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                let bodyText = String(data: data, encoding: .utf8) ?? ""
                // Der Fehlertext enthält keine Geheimnisse (nur error/error_description)
                // und ist die einzige Spur, warum eine Anmeldung scheitert — deshalb
                // ungeschwärzt ins Log.
                Logger.api.error("Claude OAuth token HTTP \(http.statusCode): \(bodyText.prefix(200), privacy: .public)")
                // Ein totes Refresh-Token (400 + invalid_grant, siehe OAuthGrantFailure)
                // ist kein HTTP-Fehler, sondern eine abgelaufene Anmeldung: Nur eine
                // Neuanmeldung hilft, und die Karte muss genau das sagen.
                let failure: UsageError
                if OAuthGrantFailure.isDeadGrant(statusCode: http.statusCode, body: bodyText) {
                    failure = .sessionExpired
                } else if http.statusCode == 429 {
                    failure = .rateLimited
                } else {
                    failure = .httpError(statusCode: http.statusCode)
                }
                completion(.failure(failure))
                return
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let accessToken = json["access_token"] as? String, !accessToken.isEmpty else {
                completion(.failure(UsageError.decodingError))
                return
            }
            let refreshToken = json["refresh_token"] as? String ?? ""
            var expiresAt: Date?
            if let expiresIn = json["expires_in"] as? TimeInterval {
                expiresAt = Date().addingTimeInterval(expiresIn)
            }
            completion(.success(ClaudeOAuthTokens(
                accessToken: accessToken,
                refreshToken: refreshToken,
                expiresAt: expiresAt
            )))
        }.resume()
    }
}
