//
//  DashboardRefreshManager.swift
//  Usage4Claude
//
//  Dashboard（多账户总览）的数据层。
//
//  与 `DataRefreshManager` 的分工：后者只服务菜单栏图标 + 经典详情窗口，永远只看
//  「当前账户」；本类为**每个**账户各建一个绑定的 API Service 实例并行拉取，结果
//  存成一组 `AccountUsageSnapshot` 供 Dashboard 卡片渲染。两者互不干扰——总览
//  不可见时本类完全不发请求。
//
//  生命周期：视图 onAppear 调 `activate()`、onDisappear 调 `deactivate()`，
//  引用计数归零时停掉定时器。
//
//  线程约定：与项目其它 manager 一致——所有公开方法都在主线程调用（SwiftUI 视图、
//  已 `receive(on: .main)` 的通知订阅、主 RunLoop 上的 Timer），异步拉取一律回到
//  `@MainActor` 后再写 `@Published`。
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import Combine
import OSLog

final class DashboardRefreshManager: ObservableObject {

    // MARK: - Singleton

    /// 菜单栏 popover 与独立窗口共享同一份数据，避免两处各拉一遍
    static let shared = DashboardRefreshManager()

    // MARK: - Published State

    /// 每个账户的用量快照，顺序为「Claude 在前、Codex 在后」的账户添加顺序，
    /// 展示排序在视图层按用户偏好再做一次
    @Published private(set) var snapshots: [AccountUsageSnapshot] = []
    /// 是否有任一账户正在拉取
    @Published private(set) var isRefreshing = false
    /// 最近一次刷新的发起时间
    @Published private(set) var lastRefreshAt: Date?

    // MARK: - Private State

    private let settings = UserSettings.shared
    /// 每个账户一个绑定的 Service 实例：凭据、进行中的任务、OAuth token 缓存全部隔离
    private var claudeServices: [UUID: ClaudeAPIService] = [:]
    private var codexServices: [UUID: CodexAPIService] = [:]
    private var timer: Timer?
    /// 本轮还未返回的账户数，归零时结束刷新动画
    private var pendingCount = 0
    /// 可见性引用计数（popover + 独立窗口可能同时打开）
    private var activationCount = 0
    private var cancellables = Set<AnyCancellable>()

    /// 自动刷新的最小间隔：Dashboard 一次刷新会给每个账户各发一轮请求，
    /// 比单账户路径重得多，因此不跟随「智能模式 1 分钟」以下的激进间隔。
    private static let minimumAutoInterval: TimeInterval = 60
    /// 打开界面时的「数据还新鲜就别再打一轮」阈值
    private static let freshnessWindow: TimeInterval = 30
    /// 手动刷新防抖，与详情窗口的刷新按钮保持一致
    private static let manualRefreshCooldown: TimeInterval = 10
    /// 账户之间的请求错峰间隔，避免同一时刻打出一串请求。
    /// Bewusst großzügig (0.7s): jeder Claude-Account löst zusätzlich einen
    /// OAuth-Token-Refresh aus — mehrere Konten gleichzeitig ergaben sonst 429.
    private static let requestStagger: TimeInterval = 0.7

    // MARK: - Initialization

    private init() {
        // 账户增删改后同步卡片列表（切换当前账户也会走这条通知）
        NotificationCenter.default.publisher(for: .accountChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.syncAccounts()
            }
            .store(in: &cancellables)

        // objectWillChange 在变更「之前」触发，receive(on:) 推到下一轮 RunLoop 才读，
        // 这样拿到的才是变更后的账户列表
        settings.accountStore.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.syncAccounts()
            }
            .store(in: &cancellables)

        syncAccounts()
    }

    // MARK: - Preview Hook

    #if DEBUG
    /// 预览 / 截图工具专用：注入假快照并停掉真实拉取，
    /// 这样 Dashboard 的布局可以离屏渲染，完全不碰网络和凭据。
    private var isPreviewMode = false

    func injectPreviewSnapshots(_ previewSnapshots: [AccountUsageSnapshot]) {
        isPreviewMode = true
        snapshots = previewSnapshots
    }
    #endif

    private var isPreviewing: Bool {
        #if DEBUG
        return isPreviewMode
        #else
        return false
        #endif
    }

    // MARK: - Visibility

    /// Dashboard 变为可见：同步账户、按需刷新、启动定时器
    func activate() {
        activationCount += 1
        syncAccounts()
        refresh(force: false)
        startTimer()
    }

    /// Dashboard 不再可见：引用计数归零时停掉定时器
    func deactivate() {
        activationCount = max(0, activationCount - 1)
        if activationCount == 0 {
            stopTimer()
        }
    }

    // MARK: - Account Syncing

    /// 把 `settings` 里的账户列表映射到快照数组：保留已有数据、丢弃已删除账户、
    /// 补上新账户的空快照，并同步清理对应的绑定 Service。
    func syncAccounts() {
        guard !isPreviewing else { return }
        let accounts = settings.dashboardAccounts
        let liveIds = Set(accounts.map(\.id))

        var rebuilt: [AccountUsageSnapshot] = []
        rebuilt.reserveCapacity(accounts.count)
        /// Konten, deren Zugangsdaten sich durch eine Neuanmeldung geändert haben —
        /// die holen gleich neu, statt bis zum nächsten Takt „Neu anmelden" zu zeigen.
        var reauthenticated: [UUID] = []

        for account in accounts {
            if let existing = snapshots.first(where: { $0.id == account.id }) {
                // Neuanmeldung: Der Fehler „Anmeldung abgelaufen" gehört zum alten
                // Token und darf mit dem neuen nicht stehen bleiben.
                let credentialsChanged = existing.account.sessionKey != account.sessionKey
                if credentialsChanged, existing.needsReauth { reauthenticated.append(account.id) }
                // 凭据可能被静默续期过，快照里始终保存最新的账户对象
                rebuilt.append(
                    AccountUsageSnapshot(
                        account: account,
                        usageData: existing.usageData,
                        codexUsageData: existing.codexUsageData,
                        errorMessage: credentialsChanged && existing.needsReauth ? nil : existing.errorMessage,
                        needsReauth: credentialsChanged ? false : existing.needsReauth,
                        isLoading: existing.isLoading,
                        updatedAt: existing.updatedAt
                    )
                )
            } else {
                rebuilt.append(AccountUsageSnapshot(account: account))
            }
        }

        // 账户列表没变化时不写 @Published，避免视图无谓重建。
        // Verglichen wird alles, was die Karte anzeigt: Ohne Alias und Art blieben
        // die Karten nach einer Umbenennung bzw. einem Wechsel Firma/Privat auf dem
        // alten Stand, weil die Snapshots ihre eigene Kopie des Kontos halten.
        // (`Account ==` vergleicht nur die id und taugt hier deshalb nicht.)
        let unchanged = rebuilt.count == snapshots.count
            && zip(rebuilt, snapshots).allSatisfy {
                $0.id == $1.id
                    && $0.account.sessionKey == $1.account.sessionKey
                    && $0.account.alias == $1.account.alias
                    && $0.account.kind == $1.account.kind
                    && $0.account.subscriptionEndsAt == $1.account.subscriptionEndsAt
            }
        if !unchanged {
            snapshots = rebuilt
        }
        for id in reauthenticated {
            refreshAccount(id: id)
        }

        // 清理已删除账户的 Service（连同它们缓存的 token）
        for (id, service) in claudeServices where !liveIds.contains(id) {
            service.cancelAllRequests()
            claudeServices.removeValue(forKey: id)
        }
        for (id, service) in codexServices where !liveIds.contains(id) {
            service.cancelAllRequests()
            codexServices.removeValue(forKey: id)
        }
    }

    // MARK: - Refresh

    /// 刷新全部账户
    /// - Parameter force: true 表示用户手动触发，跳过「数据还新鲜」检查（仍受 10 秒防抖约束）
    func refresh(force: Bool) {
        guard !isPreviewing else { return }
        guard !snapshots.isEmpty else { return }
        guard !isRefreshing else { return }

        if let last = lastRefreshAt {
            let elapsed = Date().timeIntervalSince(last)
            let threshold = force ? Self.manualRefreshCooldown : Self.freshnessWindow
            if elapsed < threshold { return }
        }

        let ids = snapshots.map(\.id)
        lastRefreshAt = Date()
        isRefreshing = true
        pendingCount = ids.count
        ids.forEach { setLoading(true, for: $0) }

        for (index, id) in ids.enumerated() {
            Task { @MainActor [weak self] in
                guard let self = self else { return }
                if index > 0 {
                    let delay = UInt64(Double(index) * Self.requestStagger * 1_000_000_000)
                    try? await Task.sleep(nanoseconds: delay)
                }
                await self.fetchAccount(id: id)
                self.pendingCount -= 1
                if self.pendingCount <= 0 {
                    self.pendingCount = 0
                    self.isRefreshing = false
                }
            }
        }
    }

    /// 只刷新单个账户（卡片上的刷新图标 / 右键菜单）
    func refreshAccount(id: UUID) {
        guard !isPreviewing else { return }
        guard snapshots.contains(where: { $0.id == id }) else { return }
        setLoading(true, for: id)
        Task { @MainActor [weak self] in
            await self?.fetchAccount(id: id)
        }
    }

    @MainActor
    private func fetchAccount(id: UUID) async {
        guard let snapshot = snapshots.first(where: { $0.id == id }) else { return }
        let account = snapshot.account

        switch account.provider {
        case .claude:
            let result = await claudeService(for: account).fetchUsageResult()
            applyClaude(result, for: id)
        case .codex:
            let result = await codexService(for: account).fetchUsageResult()
            applyCodex(result, for: id)
        }
    }

    // MARK: - Result Handling

    private func applyClaude(_ result: Result<UsageData, Error>, for id: UUID) {
        guard let index = snapshots.firstIndex(where: { $0.id == id }) else { return }
        snapshots[index].isLoading = false
        switch result {
        case .success(let data):
            snapshots[index].usageData = data
            snapshots[index].errorMessage = nil
            snapshots[index].needsReauth = false
            snapshots[index].updatedAt = Date()
        case .failure(let error):
            // 429 auf einem Konto, das schon Daten hat: letzte Daten stehen lassen
            // und die alarmierende "Zu viele Anfragen"-Meldung unterdrücken. Der
            // nächste (entzerrte) Refresh holt die Aktualisierung nach.
            if isRateLimit(error), snapshots[index].usageData != nil {
                snapshots[index].errorMessage = nil
            } else {
                snapshots[index].errorMessage = error.localizedDescription
            }
            snapshots[index].needsReauth = isAuthFailure(error)
            Logger.menuBar.info("Dashboard: Claude 账户拉取失败（\(error.localizedDescription)）")
        }
    }

    /// Abgelaufene oder widerrufene Anmeldung: Da hilft kein „Erneut versuchen",
    /// die Karte bietet stattdessen „Neu anmelden" an.
    private func isAuthFailure(_ error: Error) -> Bool {
        guard let usageError = error as? UsageError else { return false }
        switch usageError {
        case .sessionExpired, .unauthorized: return true
        default: return false
        }
    }

    /// 429（请求过于频繁）判定：用于在已有数据时静默处理限流，而不是弹出错误。
    private func isRateLimit(_ error: Error) -> Bool {
        if let usageError = error as? UsageError, case .rateLimited = usageError { return true }
        return false
    }

    private func applyCodex(_ result: Result<CodexUsageData, Error>, for id: UUID) {
        guard let index = snapshots.firstIndex(where: { $0.id == id }) else { return }
        snapshots[index].isLoading = false
        switch result {
        case .success(let data):
            snapshots[index].codexUsageData = data
            snapshots[index].errorMessage = nil
            snapshots[index].needsReauth = false
            snapshots[index].updatedAt = Date()
        case .failure(let error):
            if isRateLimit(error), snapshots[index].codexUsageData != nil {
                snapshots[index].errorMessage = nil
            } else {
                snapshots[index].errorMessage = error.localizedDescription
            }
            snapshots[index].needsReauth = isAuthFailure(error)
            Logger.menuBar.info("Dashboard: Codex 账户拉取失败（\(error.localizedDescription)）")
        }
    }

    private func setLoading(_ loading: Bool, for id: UUID) {
        guard let index = snapshots.firstIndex(where: { $0.id == id }) else { return }
        guard snapshots[index].isLoading != loading else { return }
        snapshots[index].isLoading = loading
    }

    // MARK: - Services

    private func claudeService(for account: Account) -> ClaudeAPIService {
        if let existing = claudeServices[account.id] { return existing }
        let service = ClaudeAPIService(account: account)
        claudeServices[account.id] = service
        return service
    }

    private func codexService(for account: Account) -> CodexAPIService {
        if let existing = codexServices[account.id] { return existing }
        let service = CodexAPIService(account: account)
        codexServices[account.id] = service
        return service
    }

    // MARK: - Timer

    private func startTimer() {
        stopTimer()
        let interval = max(Self.minimumAutoInterval, TimeInterval(settings.effectiveRefreshInterval))
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.refresh(force: false)
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: - Cleanup

    func cleanup() {
        stopTimer()
        claudeServices.values.forEach { $0.cancelAllRequests() }
        codexServices.values.forEach { $0.cancelAllRequests() }
        claudeServices.removeAll()
        codexServices.removeAll()
        activationCount = 0
    }
}
