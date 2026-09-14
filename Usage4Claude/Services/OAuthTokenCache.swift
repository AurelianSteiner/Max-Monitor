//
//  OAuthTokenCache.swift
//  Usage4Claude
//
//  审计报告 4.2：OAuth access_token 的缓存 + 单飞合并，用 actor 替代手写
//  NSLock + 等待者数组。actor 方法天然串行化：并发调用者在 await 挂起点让出
//  执行权，后到者发现 refreshTask 已存在就直接复用同一个 Task，无需手动维护
//  等待者列表或操心「忘记唤醒某个等待者」这类问题。
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation

/// Fehler des Caches selbst — unabhängig vom Anbieter, damit die Datei ohne
/// `UsageError` auskommt (SwiftPM-Testziel).
nonisolated enum OAuthTokenCacheError: Error, Equatable {
    /// Das Refresh-Token ist tot (verbraucht oder widerrufen). Der Cache merkt
    /// sich das und lehnt weitere Erneuerungen mit **demselben** Token sofort
    /// ab, ohne das Netz zu belasten — bis eine Neuanmeldung ein anderes Token
    /// bringt. Die Erneuerungs-Closure wirft diesen Fehler, wenn der Server das
    /// Token abgelehnt hat (siehe `OAuthGrantFailure`).
    case revokedGrant
}

/// 单个 Provider 的 OAuth access_token 缓存 + 单飞刷新
actor OAuthTokenCache {
    /// 一次刷新换到的结果（不同 Provider 的响应结构不同，调用方在 refresh 闭包里统一成这个形状）
    struct Tokens {
        let accessToken: String
        /// 刷新端点可能不轮换 refresh_token（返回空字符串时应视为沿用旧值，由调用方在闭包里处理好）
        let refreshToken: String
        let expiresAt: Date
    }

    private var cachedAccessToken: String?
    private var cachedExpiry: Date?
    private var cachedForRefreshToken: String?

    private var refreshTask: Task<Tokens, Error>?
    private var refreshTaskToken: String?

    /// Refresh-Token, das der Server als tot gemeldet hat. Solange das Konto
    /// genau dieses Token trägt, geht keine weitere Erneuerung mehr raus:
    /// Vorher schlug jeder Abruf jede Minute je Konto am Token-Endpunkt auf
    /// (HTTP 400, invalid_grant) — Tausende Fehlversuche am Tag, bis der
    /// Endpunkt das ganze Netz drosselte und auch Neuanmeldungen scheiterten.
    private var deadRefreshToken: String?

    /// 获取有效的 access_token：命中缓存直接返回；否则发起刷新，
    /// 同一 refresh_token 的并发调用自动复用同一次网络请求的结果。
    /// - Parameters:
    ///   - refreshToken: 当前 refresh_token
    ///   - margin: 提前刷新余量，避免用到临期 token（默认 5 分钟）
    ///   - refresh: 实际发起网络刷新的闭包，返回新的 token 三元组
    func accessToken(
        refreshToken: String,
        margin: TimeInterval = 5 * 60,
        refresh: @escaping (String) async throws -> Tokens
    ) async throws -> String {
        // Totes Token: sofort ablehnen, kein Netz. Ein anderes Token (nach
        // Neuanmeldung) läuft normal durch.
        if let dead = deadRefreshToken, dead == refreshToken {
            throw OAuthTokenCacheError.revokedGrant
        }

        if let cached = cachedAccessToken, !cached.isEmpty,
           let expiry = cachedExpiry,
           cachedForRefreshToken == refreshToken,
           expiry > Date().addingTimeInterval(margin) {
            return cached
        }

        // 同一 refresh_token 已有刷新在进行中：直接复用同一个 Task 的结果
        if let task = refreshTask, refreshTaskToken == refreshToken {
            return try await task.value.accessToken
        }

        let task = Task<Tokens, Error> {
            try await refresh(refreshToken)
        }
        refreshTask = task
        refreshTaskToken = refreshToken

        defer {
            // 避免把已完成（成功或失败）的旧 Task 留在原地，导致下次误判为"仍在进行中"
            if refreshTaskToken == refreshToken {
                refreshTask = nil
                refreshTaskToken = nil
            }
        }

        let tokens: Tokens
        do {
            tokens = try await task.value
        } catch OAuthTokenCacheError.revokedGrant {
            // Der Server hat genau dieses Token abgelehnt — merken, damit die
            // nächsten Abrufe nicht wieder anklopfen.
            deadRefreshToken = refreshToken
            cachedAccessToken = nil
            cachedExpiry = nil
            cachedForRefreshToken = nil
            throw OAuthTokenCacheError.revokedGrant
        }
        cachedAccessToken = tokens.accessToken
        cachedExpiry = tokens.expiresAt
        cachedForRefreshToken = tokens.refreshToken
        return tokens.accessToken
    }

    /// Ist dieses Refresh-Token als tot bekannt? (Nur für Tests und Diagnose.)
    func isKnownDead(refreshToken: String) -> Bool {
        deadRefreshToken == refreshToken
    }

    /// 返回尚未过期的缓存 token（不触发刷新）
    /// 供刷新失败（网络瞬断/服务端抖动）时回退使用：默认 margin 0——
    /// 哪怕 token 已进入提前刷新窗口，只要还没真正过期就可以顶用一轮。
    func validCachedToken(refreshToken: String, margin: TimeInterval = 0) -> String? {
        guard let cached = cachedAccessToken, !cached.isEmpty,
              let expiry = cachedExpiry,
              cachedForRefreshToken == refreshToken,
              expiry > Date().addingTimeInterval(margin) else { return nil }
        return cached
    }

    /// 清除缓存（账户切换或收到 401 时调用，强制下次重新走网络刷新）
    ///
    /// Das Wissen um ein totes Refresh-Token bleibt dabei erhalten: Ein 401 der
    /// Usage-Schnittstelle sagt nichts über das Refresh-Token — die Sperre
    /// löst sich nur durch ein anderes Token (Neuanmeldung).
    func clear() {
        cachedAccessToken = nil
        cachedExpiry = nil
        cachedForRefreshToken = nil
    }
}

// MARK: - 按账户共享缓存实例

/// 同一个账户的所有 API Service 实例必须共用同一个 `OAuthTokenCache`。
///
/// 背景：Claude / Codex 的 OAuth `refresh_token` 每次续期都会轮换，旧值立即失效。
/// `OAuthTokenCache` 的单飞合并只在**同一个实例内**生效。自从 Dashboard 为每个账户
/// 建了自己的绑定 Service，当前账户就同时被两个 Service 拉取（菜单栏那个 + Dashboard
/// 那个）；如果它们各自持有一个缓存，就会拿着同一枚 refresh_token 并发续期，先到的
/// 那次让 token 轮换，后到的那次必然收到 HTTP 400（invalid_grant）。
///
/// 这个注册表按账户 ID 发放缓存实例，把单飞的作用域从「实例内」提升到「账户内」。
/// 新增任何会拉取用量的代码路径时，都必须通过这里取缓存，不要再 `OAuthTokenCache()`。
final class OAuthTokenCacheRegistry {
    /// Claude 侧的注册表
    static let claude = OAuthTokenCacheRegistry()
    /// Codex 侧的注册表（两家 token 体系无关，分开存放）
    static let codex = OAuthTokenCacheRegistry()

    private var caches: [String: OAuthTokenCache] = [:]
    private let lock = NSLock()

    private init() {}

    /// 取（或首次创建）指定账户的缓存实例
    /// - Parameter accountKey: 账户 UUID 字符串；账户未知时用一个稳定的占位键
    func cache(for accountKey: String) -> OAuthTokenCache {
        lock.lock()
        defer { lock.unlock() }
        if let existing = caches[accountKey] {
            return existing
        }
        let cache = OAuthTokenCache()
        caches[accountKey] = cache
        return cache
    }
}
