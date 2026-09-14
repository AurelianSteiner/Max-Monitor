//
//  ClaudeAPIService.swift
//  Usage4Claude
//
//  Created by f-is-h on 2025-10-15.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import OSLog

/// Claude API 服务类
/// 负责与 Claude.ai API 通信，获取用户的使用情况数据
/// 包含请求构建、认证处理、Cloudflare 绕过和数据解析功能
class ClaudeAPIService {
    // MARK: - Properties

    /// 一次性校验场景（登录页/设置页验证 sessionKey）复用的共享实例。
    /// 这类调用点过去各自 `ClaudeAPIService()` 创建局部实例，其 URLSession 从不
    /// `finishTasksAndInvalidate()`；若实例在请求进行中被释放，`[weak self]` 闭包
    /// 里挂起的单飞等待者也会随之丢失。复用同一长生命周期实例可一并避免这两个问题。
    static let shared = ClaudeAPIService()

    /// API 基础 URL
    private let baseURL = "https://claude.ai/api/organizations"

    /// 用户设置实例，用于获取认证信息
    private let settings = UserSettings.shared

    /// 共享的 URLSession 实例
    private let session: URLSession

    /// 当前正在执行的网络请求任务
    private var currentTask: URLSessionDataTask?

    // MARK: - Claude OAuth 单飞 & 缓存
    //
    // Claude OAuth refresh_token 每次续期后都会轮换（旧值立即失效）。
    // 多个并发刷新调用可能用同一个 refresh_token，导致后到者触发 401。
    // 单飞合并 + 缓存都委托给 OAuthTokenCache（actor，见 Services/OAuthTokenCache.swift），
    // 用 actor 的串行化天然替代手写 NSLock + 等待者数组。
    //
    // 缓存实例按**账户**共享，不是按 Service 实例：当前账户会同时被菜单栏的实例和
    // Dashboard 的绑定实例拉取，各自持缓存会让两次续期拿着同一枚 refresh_token 并发
    // 请求，后到者必然收到 HTTP 400（invalid_grant）。见 OAuthTokenCacheRegistry。
    private var oauthTokenCache: OAuthTokenCache {
        OAuthTokenCacheRegistry.claude.cache(for: tokenCacheKey)
    }

    /// token 缓存的账户键：绑定实例用自己的账户，未绑定实例用当前账户，
    /// 这样同一个账户的两条路径解析到同一个缓存。
    private var tokenCacheKey: String {
        (boundAccountId ?? settings.currentAccountId)?.uuidString ?? "claude.unknown"
    }

    // MARK: - 账户绑定（Dashboard 多账户并行拉取）

    // 默认实例跟随 `settings` 的当前账户（菜单栏路径，行为与以前完全一致）。
    // Dashboard 需要同时拉取全部账户，为每个账户单独建一个绑定实例：凭据来自
    // 构造时传入的 Account 而非当前账户，实例之间的 currentTask / OAuth 缓存
    // 天然隔离，互不取消也不串号。
    private let boundAccountId: UUID?
    private let boundOrganizationId: String?
    /// 构造时的凭据快照，仅作为账户已从存储中消失时的兜底。
    private let boundSessionKeyFallback: String?

    /// 本实例实际使用的 Session Key（绑定账户优先，否则取当前账户）。
    ///
    /// 绑定账户的凭据**每次都从账户存储里现读**，绝不缓存在实例里：OAuth refresh_token
    /// 会在任意一条路径续期时轮换（也可能是菜单栏那条路径写回的），实例内缓存一份就会
    /// 变陈旧，下一轮拿着失效的 token 去刷新 → HTTP 400。
    private var activeSessionKey: String {
        guard let id = boundAccountId else { return settings.sessionKey }
        return settings.accounts.first { $0.id == id }?.sessionKey
            ?? boundSessionKeyFallback
            ?? ""
    }

    /// 本实例实际使用的 Organization ID
    private var activeOrganizationId: String { boundOrganizationId ?? settings.organizationId }

    /// 本实例的凭据是否可用。判定规则与 `UserSettings.hasValidCredentials` 一致：
    /// OAuth 账户仅凭 refresh_token 即可，cookie 账户还需要 organizationId。
    private var hasActiveCredentials: Bool {
        guard boundAccountId != nil else { return settings.hasValidCredentials }
        let key = activeSessionKey
        guard !key.isEmpty else { return false }
        if Self.isOAuthRefreshToken(key) { return true }
        return !activeOrganizationId.isEmpty
    }

    // MARK: - Initialization

    /// - Parameter account: 绑定的账户。传 nil（默认）时跟随 `UserSettings` 的当前账户。
    init(account: Account? = nil) {
        self.boundAccountId = account?.id
        self.boundOrganizationId = account?.organizationId
        self.boundSessionKeyFallback = account?.sessionKey

        // 配置 URLSession
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30  // 请求超时：30秒
        configuration.timeoutIntervalForResource = 60 // 资源超时：60秒
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData  // 不使用缓存

        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true

        if account != nil {
            // Gebundene Instanzen bekommen einen **eigenen** Cookie-Topf statt des
            // globalen: dort ist `sessionKey` für alle Konten derselbe Cookie-Name,
            // parallele Anfragen würden sich gegenseitig überschreiben (Konto A
            // sendet Bs Cookie). Gar keinen Speicher zu nehmen wäre aber auch falsch —
            // Cloudflare setzt cf_clearance/__cf_bm per Set-Cookie, und ohne Ablage
            // scheitern Cookie-Session-Konten an der Bot-Erkennung.
            configuration.httpCookieStorage = HTTPCookieStorage()
        }

        self.session = URLSession(configuration: configuration)
    }

    // MARK: - Claude OAuth Support

    /// 判断凭据是否为 Claude OAuth refresh_token（以 "sk-ant-ort01-" 开头）
    static func isOAuthRefreshToken(_ credential: String) -> Bool {
        credential.hasPrefix("sk-ant-ort01-")
    }

    /// 清除 OAuth access_token 缓存（账户切换时调用；401 重试路径见 fetchClaudeOAuthUsageData，
    /// 那里需要等 clear 完成后再重试，走的是 oauthTokenCache.clear() 的 await 版本）
    func clearOAuthTokenCache() {
        Task { await oauthTokenCache.clear() }
    }
    
    // MARK: - Public Methods
    
    /// 获取用户的 Claude 使用情况（并行获取主用量和 Extra Usage）
    /// - Parameter completion: 完成回调，包含成功的 UsageData 或失败的 Error
    /// - Note: 请求会自动添加必要的 Headers 以绕过 Cloudflare 防护
    /// - Important: 调用前确保用户已配置有效的认证信息
    /// - Note: 同时并行调用主 usage API 和 Extra Usage API，Extra Usage 失败不影响主功能
    func fetchUsage(completion: @escaping (Result<UsageData, Error>) -> Void) {
        #if DEBUG
        // 调试模式：返回模拟数据（立即返回，无延迟）
        if settings.debugModeEnabled {
            let mockData = createMockData()
            DispatchQueue.main.async {
                completion(.success(mockData))
            }
            return
        }
        #endif

        // 取消之前的请求（如果存在）
        currentTask?.cancel()

        // 检查认证信息
        guard hasActiveCredentials else {
            DispatchQueue.main.async { completion(.failure(UsageError.noCredentials)) }
            return
        }

        // OAuth 账户：凭据是 refresh_token，走 /api/oauth/usage 路径，跳过 Cloudflare cookie 流程
        if Self.isOAuthRefreshToken(activeSessionKey) {
            fetchOAuthUsage(completion: completion)
            return
        }

        // 使用 DispatchGroup 并行请求两个 API
        let dispatchGroup = DispatchGroup()
        var mainUsageData: UsageData?
        var extraUsageData: ExtraUsageData?
        var mainError: Error?

        // ========== 请求1: 主 Usage API ==========
        dispatchGroup.enter()
        fetchMainUsage { result in
            switch result {
            case .success(let data):
                mainUsageData = data
            case .failure(let error):
                mainError = error
            }
            dispatchGroup.leave()
        }

        // ========== 请求2: Extra Usage API（可选） ==========
        dispatchGroup.enter()
        fetchExtraUsage { result in
            switch result {
            case .success(let data):
                extraUsageData = data  // 可能为 nil（功能未启用或失败）
            case .failure:
                // Extra Usage 失败不影响主功能，保持 extraUsageData 为 nil
                Logger.api.info("Extra Usage API failed, continuing with main usage data only")
            }
            dispatchGroup.leave()
        }

        // ========== 等待两个请求完成后合并结果 ==========
        dispatchGroup.notify(queue: .main) {
            // 如果主 API 失败，则整体失败
            if let error = mainError {
                completion(.failure(error))
                return
            }

            // 主 API 成功，合并 Extra Usage 数据
            guard var finalData = mainUsageData else {
                completion(.failure(UsageError.decodingError))
                return
            }

            // 创建包含 Extra Usage 的完整数据（整体保留所有模型槽，如 Fable / Opus / Sonnet）
            finalData = UsageData(
                fiveHour: finalData.fiveHour,
                sevenDay: finalData.sevenDay,
                weeklyModels: finalData.weeklyModels,
                extraUsage: extraUsageData  // 可能为 nil
            )

            completion(.success(finalData))
        }
    }

    /// 获取主 Usage API 数据（内部方法）
    /// - Parameter completion: 完成回调
    private func fetchMainUsage(completion: @escaping (Result<UsageData, Error>) -> Void) {
        // Service 层统一约定：所有 completion 一律在主线程回调，调用方无需再包一层 DispatchQueue.main.async
        let complete: (Result<UsageData, Error>) -> Void = { result in
            DispatchQueue.main.async { completion(result) }
        }

        let urlString = "\(baseURL)/\(activeOrganizationId)/usage"

        guard let url = URL(string: urlString) else {
            complete(.failure(UsageError.invalidURL))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.assumesHTTP3Capable = false

        // 使用统一的 Header 构建器添加完整的浏览器 Headers 以绕过 Cloudflare
        ClaudeAPIHeaderBuilder.applyHeaders(
            to: &request,
            organizationId: activeOrganizationId,
            sessionKey: activeSessionKey
        )

        // 创建并保存任务引用
        currentTask = session.dataTask(with: request) { data, response, error in
            if let error = error {
                Logger.api.debug("Network error: \(error.localizedDescription)")
                complete(.failure(UsageError.networkError))
                return
            }

            guard let data = data else {
                complete(.failure(UsageError.noData))
                return
            }

            // 打印原始响应用于调试
            if let jsonString = String(data: data, encoding: .utf8) {
                Logger.api.debug("Main Usage API Response: \(jsonString)")

                // 检查是否是HTML响应（Cloudflare拦截）
                if jsonString.contains("<!DOCTYPE html>") || jsonString.contains("<html") {
                    Logger.api.debug("⚠️ Received HTML response, possibly intercepted by Cloudflare.")
                    complete(.failure(UsageError.cloudflareBlocked))
                    return
                }
            }

            // 检查HTTP状态码
            if let httpResponse = response as? HTTPURLResponse {
                Logger.api.debug("Main Usage HTTP Status: \(httpResponse.statusCode)")

                // 处理各种 HTTP 错误状态码
                switch httpResponse.statusCode {
                case 200...299:
                    // 成功响应，继续处理
                    break
                case 401:
                    // 未授权，通常是认证信息无效
                    complete(.failure(UsageError.unauthorized))
                    return
                case 403:
                    // HTML 已在上方提前返回 cloudflareBlocked，此处 403 均为 JSON 鉴权失败
                    complete(.failure(UsageError.unauthorized))
                    return
                case 429:
                    // 请求频率过高
                    complete(.failure(UsageError.rateLimited))
                    return
                default:
                    // 其他 HTTP 错误
                    Logger.api.error("HTTP error: \(httpResponse.statusCode)")
                    complete(.failure(UsageError.httpError(statusCode: httpResponse.statusCode)))
                    return
                }
            }

            // 解码 JSON 响应
            let decoder = JSONDecoder()

            // 检查是否是错误响应
            if let errorResponse = try? decoder.decode(ErrorResponse.self, from: data),
               errorResponse.error.type == "permission_error" {
                complete(.failure(UsageError.sessionExpired))
                return
            }

            // 解析成功响应
            do {
                let response = try decoder.decode(UsageResponse.self, from: data)
                let usageData = response.toUsageData()
                complete(.success(usageData))
            } catch {
                Logger.api.debug("Decoding error: \(error.localizedDescription)")
                complete(.failure(UsageError.decodingError))
            }
        }

        // 启动任务
        currentTask?.resume()
    }

    /// 获取用户的组织列表
    /// - Parameters:
    ///   - sessionKey: 可选的 sessionKey，如果不提供则使用 settings.sessionKey
    ///   - cookieHeader: 可选的完整 Cookie header 字符串（由 WebView 登录流程提供，含 cf_clearance/__cf_bm）
    ///   - completion: 完成回调，包含成功的组织数组或失败的 Error
    /// - Note: 用于自动获取 Organization ID，简化用户配置流程
    func fetchOrganizations(sessionKey: String? = nil, cookieHeader: String? = nil, completion: @escaping (Result<[Organization], Error>) -> Void) {
        // Service 层统一约定：所有 completion 一律在主线程回调，调用方无需再包一层 DispatchQueue.main.async
        let complete: (Result<[Organization], Error>) -> Void = { result in
            DispatchQueue.main.async { completion(result) }
        }

        let urlString = "\(baseURL.replacingOccurrences(of: "/organizations", with: ""))/organizations"

        guard let url = URL(string: urlString) else {
            complete(.failure(UsageError.invalidURL))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.assumesHTTP3Capable = false

        // 使用统一的 Header 构建器，仅需要 sessionKey
        // 如果提供了 sessionKey 参数则使用它，否则使用 settings.sessionKey
        let actualSessionKey = sessionKey ?? settings.sessionKey
        ClaudeAPIHeaderBuilder.applyHeaders(
            to: &request,
            organizationId: nil,  // 获取组织列表不需要 organizationId
            sessionKey: actualSessionKey
        )
        // 若提供了来自 WebView 的完整 Cookie header（含 cf_clearance/__cf_bm），
        // 覆盖 applyHeaders 仅含 sessionKey 的 Cookie 字段，确保 Cloudflare 通行证一并携带
        if let cookieHeader = cookieHeader {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }

        let task = session.dataTask(with: request) { data, response, error in
            if let error = error {
                Logger.api.debug("Network error: \(error.localizedDescription)")
                complete(.failure(UsageError.networkError))
                return
            }

            guard let data = data else {
                complete(.failure(UsageError.noData))
                return
            }

            // 打印原始响应用于调试
            if let jsonString = String(data: data, encoding: .utf8) {
                Logger.api.debug("Organizations API Response: \(jsonString)")
            }

            // 检查HTTP状态码
            if let httpResponse = response as? HTTPURLResponse {
                Logger.api.debug("HTTP Status Code: \(httpResponse.statusCode)")

                switch httpResponse.statusCode {
                case 200...299:
                    // 成功响应，继续处理
                    break
                case 401:
                    complete(.failure(UsageError.unauthorized))
                    return
                case 403:
                    // Cloudflare 拦截返回 HTML；API 鉴权失败返回 JSON
                    let isHTML = String(data: data, encoding: .utf8).map {
                        $0.contains("<!DOCTYPE html>") || $0.contains("<html")
                    } ?? false
                    complete(.failure(isHTML ? UsageError.cloudflareBlocked : UsageError.unauthorized))
                    return
                default:
                    Logger.api.error("HTTP error: \(httpResponse.statusCode)")
                    complete(.failure(UsageError.httpError(statusCode: httpResponse.statusCode)))
                    return
                }
            }

            // 解码 JSON 响应
            let decoder = JSONDecoder()
            do {
                let organizations = try decoder.decode([Organization].self, from: data)
                complete(.success(organizations))
            } catch {
                Logger.api.debug("Decoding error: \(error.localizedDescription)")
                complete(.failure(UsageError.decodingError))
            }
        }

        task.resume()
    }

    /// 获取 Extra Usage 额外用量数据
    /// - Parameter completion: 完成回调，包含成功的 ExtraUsageData 或失败的 Error
    /// - Note: 此方法是可选的，即使失败也不应影响主要功能
    func fetchExtraUsage(completion: @escaping (Result<ExtraUsageData?, Error>) -> Void) {
        // Service 层统一约定：所有 completion 一律在主线程回调，调用方无需再包一层 DispatchQueue.main.async
        let complete: (Result<ExtraUsageData?, Error>) -> Void = { result in
            DispatchQueue.main.async { completion(result) }
        }

        // 检查认证信息
        guard hasActiveCredentials else {
            complete(.failure(UsageError.noCredentials))
            return
        }

        let urlString = "\(baseURL)/\(activeOrganizationId)/overage_spend_limit"

        guard let url = URL(string: urlString) else {
            complete(.failure(UsageError.invalidURL))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.assumesHTTP3Capable = false

        // 使用统一的 Header 构建器添加完整的浏览器 Headers
        ClaudeAPIHeaderBuilder.applyHeaders(
            to: &request,
            organizationId: activeOrganizationId,
            sessionKey: activeSessionKey
        )

        let task = session.dataTask(with: request) { data, response, error in
            if let error = error {
                Logger.api.debug("Extra Usage API network error: \(error.localizedDescription)")
                complete(.failure(UsageError.networkError))
                return
            }

            guard let data = data else {
                complete(.failure(UsageError.noData))
                return
            }

            // 打印原始响应用于调试
            if let jsonString = String(data: data, encoding: .utf8) {
                Logger.api.debug("Extra Usage API Response: \(jsonString)")
            }

            // 检查HTTP状态码
            if let httpResponse = response as? HTTPURLResponse {
                Logger.api.debug("Extra Usage HTTP Status: \(httpResponse.statusCode)")

                switch httpResponse.statusCode {
                case 200...299:
                    // 成功响应，继续处理
                    break
                case 403, 404:
                    // Extra Usage 未启用或无权限，返回 nil 表示功能不可用
                    Logger.api.info("Extra Usage not available (HTTP \(httpResponse.statusCode))")
                    complete(.success(nil))
                    return
                case 401:
                    complete(.failure(UsageError.unauthorized))
                    return
                default:
                    Logger.api.warning("Extra Usage HTTP error: \(httpResponse.statusCode)")
                    complete(.success(nil))  // 优雅降级
                    return
                }
            }

            // 解码 JSON 响应
            let decoder = JSONDecoder()
            do {
                let extraUsageResponse = try decoder.decode(ExtraUsageResponse.self, from: data)
                let extraUsageData = extraUsageResponse.toExtraUsageData()
                complete(.success(extraUsageData))
            } catch {
                Logger.api.debug("Extra Usage decoding error: \(error.localizedDescription)")
                complete(.success(nil))  // 优雅降级
            }
        }

        task.resume()
    }

    // MARK: - OAuth Usage Path

    /// OAuth 账户专用：用 refresh_token 换 access_token 后调用 /api/oauth/usage
    /// - Parameter retryOnUnauthorized: 收到 401 时是否清缓存后立即重试一次（强制换新 access_token）。
    ///   仿照 Codex 侧 `DataRefreshManager.fetchCodexOnly(retryOnUnauthorized:)` 的既有模式，
    ///   避免用户在下一个刷新周期到来前一直看到错误状态。
    private func fetchOAuthUsage(retryOnUnauthorized: Bool = true, completion: @escaping (Result<UsageData, Error>) -> Void) {
        let refreshToken = activeSessionKey
        fetchOAuthAccessToken(refreshToken: refreshToken) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                DispatchQueue.main.async { completion(.failure(error)) }
            case .success(let accessToken):
                self.fetchClaudeOAuthUsageData(accessToken: accessToken, retryOnUnauthorized: retryOnUnauthorized, completion: completion)
            }
        }
    }

    /// 用 refresh_token 获取 access_token，带缓存 + 单飞合并（委托给 OAuthTokenCache actor）
    private func fetchOAuthAccessToken(refreshToken: String, completion: @escaping (Result<String, Error>) -> Void) {
        Task {
            do {
                let accessToken = try await oauthTokenCache.accessToken(refreshToken: refreshToken) { [weak self] token in
                    guard let self else { throw UsageError.decodingError }
                    return try await self.refreshClaudeOAuthTokens(refreshToken: token)
                }
                await MainActor.run { completion(.success(accessToken)) }
            } catch OAuthTokenCacheError.revokedGrant {
                // Der Cache kennt das Token als tot und hat gar nicht erst angefragt.
                // Für die Karte ist das eine abgelaufene Anmeldung — „Neu anmelden".
                await MainActor.run { completion(.failure(UsageError.sessionExpired)) }
            } catch {
                await MainActor.run { completion(.failure(error)) }
            }
        }
    }

    /// 实际发起网络请求向 Claude OAuth 端点换取新 token；处理 refresh_token 轮换的静默写回。
    /// 只会在 OAuthTokenCache 判定"确实需要发起新刷新"时才被调用一次（并发调用者共享同一次结果）。
    private func refreshClaudeOAuthTokens(refreshToken: String) async throws -> OAuthTokenCache.Tokens {
        do {
            let tokens = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ClaudeOAuthTokens, Error>) in
                ClaudeOAuthService.refresh(refreshToken: refreshToken) { result in
                    continuation.resume(with: result)
                }
            }

            // refresh_token 轮换：若响应携带新值则静默写回账户
            let newRefresh = tokens.refreshToken.isEmpty ? refreshToken : tokens.refreshToken
            if newRefresh != refreshToken {
                Logger.api.notice("Claude OAuth: refresh_token 已轮换，静默写回")
                // 绑定实例必须写回它自己的账户（而非"当前账户"），否则 Dashboard
                // 并行拉取时会把 A 账户的新 token 覆盖到当前账户上。
                let boundId = boundAccountId
                await MainActor.run {
                    if let boundId = boundId {
                        UserSettings.shared.silentlyUpdateClaudeSessionToken(accountId: boundId, token: newRefresh)
                    } else {
                        UserSettings.shared.silentlyUpdateCurrentClaudeSessionToken(newRefresh)
                    }
                }
            }

            // expires_in 通常为 3600 秒；未给出时保守使用 30 分钟
            let expiry = tokens.expiresAt ?? Date().addingTimeInterval(30 * 60)
            return OAuthTokenCache.Tokens(accessToken: tokens.accessToken, refreshToken: newRefresh, expiresAt: expiry)
        } catch UsageError.sessionExpired {
            // Der Server hat das Refresh-Token endgültig abgelehnt. Als
            // `revokedGrant` an den Cache melden — der merkt sich das Token und
            // lässt keine weitere Erneuerung damit raus (siehe OAuthTokenCache).
            Logger.api.notice("Claude OAuth: Refresh-Token widerrufen oder verbraucht – Konto braucht eine Neuanmeldung")
            throw OAuthTokenCacheError.revokedGrant
        } catch {
            Logger.api.error("Claude OAuth refresh 失败: \(error.localizedDescription)")
            throw error
        }
    }

    /// 用 access_token 调用 /api/oauth/usage，解析为 UsageData
    private func fetchClaudeOAuthUsageData(accessToken: String, retryOnUnauthorized: Bool, completion: @escaping (Result<UsageData, Error>) -> Void) {
        // Service 层统一约定：所有 completion 一律在主线程回调，调用方无需再包一层 DispatchQueue.main.async
        let complete: (Result<UsageData, Error>) -> Void = { result in
            DispatchQueue.main.async { completion(result) }
        }

        guard let url = URL(string: ClaudeOAuthConfig.usageURL) else {
            complete(.failure(UsageError.invalidURL))
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(ClaudeOAuthConfig.betaHeader, forHTTPHeaderField: "anthropic-beta")
        request.cachePolicy = .reloadIgnoringLocalCacheData

        session.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                Logger.api.error("Claude OAuth usage 网络错误: \(error.localizedDescription)")
                complete(.failure(UsageError.networkError))
                return
            }
            guard let data = data else {
                complete(.failure(UsageError.noData))
                return
            }
            if let http = response as? HTTPURLResponse {
                Logger.api.debug("Claude OAuth usage HTTP \(http.statusCode)")
                switch http.statusCode {
                case 200...299: break
                case 401:
                    // access_token 已失效，清缓存以便下次用 refresh_token 重新换取，
                    // 避免在 5 分钟缓存窗口内反复用坏 token 触发 401。
                    // 用 Task 顺序 await 清缓存再重试，避免 clear 与重试的缓存读取产生竞态
                    // （二者都要进 actor，若各开一个 Task 无法保证 clear 先于重试执行）。
                    if retryOnUnauthorized {
                        Logger.api.info("Claude OAuth usage 401，清缓存后立即用 refresh_token 换新 access_token 重试一次")
                        Task {
                            await self?.oauthTokenCache.clear()
                            self?.fetchOAuthUsage(retryOnUnauthorized: false, completion: completion)
                        }
                    } else {
                        Task { await self?.oauthTokenCache.clear() }
                        complete(.failure(UsageError.unauthorized))
                    }
                    return
                case 429:
                    complete(.failure(UsageError.rateLimited))
                    return
                default:
                    complete(.failure(UsageError.httpError(statusCode: http.statusCode)))
                    return
                }
            }
            if let raw = String(data: data, encoding: .utf8) {
                Logger.api.debug("Claude OAuth usage response: \(raw.prefix(500))")
            }

            let decoder = JSONDecoder()
            do {
                // 复用现有 UsageResponse 解码器（five_hour/seven_day/opus/sonnet 字段名一致）
                let baseResponse = try decoder.decode(UsageResponse.self, from: data)
                var usageData = baseResponse.toUsageData()

                // 尝试额外解码 extra_usage 字段
                // Issue #64: 此前四层 try? 静默吞掉失败原因，导致无法判断是
                // 「字段不存在」「字段名不同」还是「结构不匹配」，这里改为显式分支打日志诊断。
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let extraJson = json["extra_usage"] as? [String: Any] {
                        // 诊断用：即使解码成功也打一行 keys，因为 ExtraUsageResponse 全字段可选，
                        // 字段名对不上时不会抛错，只会静默产出全 nil 的“已禁用”结果。
                        Logger.api.debug("Claude OAuth usage extra_usage keys=\(Array(extraJson.keys).sorted())")
                        if let extraData = try? JSONSerialization.data(withJSONObject: extraJson) {
                            do {
                                let extraResponse = try decoder.decode(ExtraUsageResponse.self, from: extraData)
                                let extraUsageData = extraResponse.toExtraUsageData()
                                Logger.api.debug("Claude OAuth usage extra_usage 解析结果: enabled=\(extraUsageData?.enabled ?? false)")
                                usageData = UsageData(
                                    fiveHour: usageData.fiveHour,
                                    sevenDay: usageData.sevenDay,
                                    weeklyModels: usageData.weeklyModels,
                                    extraUsage: extraUsageData
                                )
                            } catch {
                                Logger.api.error("Claude OAuth usage extra_usage 解码失败: \(error.localizedDescription)，keys=\(Array(extraJson.keys))")
                            }
                        } else {
                            Logger.api.error("Claude OAuth usage extra_usage 字段无法重新序列化为 JSON，keys=\(Array(extraJson.keys))")
                        }
                    } else {
                        Logger.api.info("Claude OAuth usage 无 extra_usage 字段，顶层 keys=\(Array(json.keys))")
                    }
                }

                complete(.success(usageData))
            } catch {
                Logger.api.error("Claude OAuth usage 解析失败: \(error.localizedDescription)")
                complete(.failure(UsageError.decodingError))
            }
        }.resume()
    }

    /// 取消所有正在进行的网络请求
    /// 在应用退出或需要中断请求时调用
    func cancelAllRequests() {
        currentTask?.cancel()
        currentTask = nil
        Logger.api.debug("已取消所有网络请求")
    }

    // MARK: - Async 包装

    /// `fetchUsage(completion:)` 的 async 包装，供结构化并发调用方使用。
    /// 结果用 Result 表达而非 throws，与 completion 版本的错误语义保持一致。
    func fetchUsageResult() async -> Result<UsageData, Error> {
        await withCheckedContinuation { continuation in
            fetchUsage { continuation.resume(returning: $0) }
        }
    }

    // MARK: - Debug Mock Data

    #if DEBUG
    /// 创建分钟为00的未来时间
    /// - Parameter hoursFromNow: 从现在开始的小时数
    /// - Returns: 分钟为00的未来日期
    private func createResetTime(hoursFromNow: Double) -> Date {
        let calendar = Calendar.current
        let now = Date()
        let targetDate = now.addingTimeInterval(3600 * hoursFromNow)
        
        // 获取目标日期的组件
        var components = calendar.dateComponents([.year, .month, .day, .hour], from: targetDate)
        components.minute = 0
        components.second = 0
        
        // 返回分钟为00的时间
        return calendar.date(from: components) ?? targetDate
    }
    
    /// 绑定账户在调试模拟数据上的百分比偏移，让 Dashboard 的多张卡片呈现不同数值，
    /// 便于在没有真实多账户时验证布局。默认实例（当前账户）偏移为 0。
    /// UUID 的 Swift `hashValue` 每次启动都会变，这里用固定字节推导以保证稳定。
    private var mockPercentageOffset: Double {
        guard let id = boundAccountId else { return 0 }
        return Double(Int(id.uuid.0) % 6) * 8.0
    }

    private func mockPercentage(_ base: Double) -> Double {
        let shifted = base + mockPercentageOffset
        return shifted > 100 ? shifted - 100 : shifted
    }

    /// 创建模拟数据用于调试
    /// - Returns: 模拟的 UsageData 实例，基于各个百分比滑块的值
    private func createMockData() -> UsageData {
        // 根据各个滑块值创建对应的限制数据
        let extraUsageData: ExtraUsageData? = {
            guard settings.debugExtraUsageEnabled else {
                return ExtraUsageData(enabled: false, used: nil, limit: nil, currency: "USD")
            }
            // 调试数据以美分为单位存储，与真实 API 格式一致，除以 100 转换为美元
            return ExtraUsageData(
                enabled: true,
                used: settings.debugExtraUsageUsed / 100.0,
                limit: Double(settings.debugExtraUsageLimit) / 100.0,
                currency: "USD"
            )
        }()

        return UsageData(
            fiveHour: UsageData.LimitData(
                percentage: mockPercentage(settings.debugFiveHourPercentage),
                resetsAt: createResetTime(hoursFromNow: 1.8)  // 1.8小时后重置
            ),
            sevenDay: UsageData.LimitData(
                percentage: mockPercentage(settings.debugSevenDayPercentage),
                resetsAt: createResetTime(hoursFromNow: 24 * 2.3)  // 2.3天后重置
            ),
            opus: UsageData.LimitData(
                percentage: mockPercentage(settings.debugOpusPercentage),
                resetsAt: createResetTime(hoursFromNow: 24 * 4.5)  // 4.5天后重置
            ),
            sonnet: UsageData.LimitData(
                percentage: mockPercentage(settings.debugSonnetPercentage),
                resetsAt: createResetTime(hoursFromNow: 24 * 5.2)  // 5.2天后重置
            ),
            extraUsage: extraUsageData
        )
    }
    #endif
}


/// 用量查询相关错误
enum UsageError: LocalizedError {
    case invalidURL
    case noData
    case sessionExpired
    case cloudflareBlocked
    case noCredentials
    case networkError
    case decodingError
    case unauthorized              // 401 未授权
    case rateLimited               // 429 请求频率过高
    case httpError(statusCode: Int)  // 其他 HTTP 错误

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return L.Error.invalidUrl
        case .noData:
            return L.Error.noData
        case .sessionExpired:
            return L.Error.sessionExpired
        case .cloudflareBlocked:
            return L.Error.cloudflareBlocked
        case .noCredentials:
            return L.Error.noCredentials
        case .networkError:
            return L.Error.networkFailed
        case .decodingError:
            return L.Error.decodingFailed
        case .unauthorized:
            return L.Error.unauthorized
        case .rateLimited:
            return L.Error.rateLimited
        case .httpError(let statusCode):
            return L.Error.httpStatus(statusCode)
        }
    }
}

// MARK: - UsageProvider

extension ClaudeAPIService: UsageProvider {
    var providerType: ProviderType { .claude }
}
