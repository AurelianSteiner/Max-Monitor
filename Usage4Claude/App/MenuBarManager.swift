//
//  MenuBarManager.swift
//  Usage4Claude
//
//  Created by f-is-h on 2025-10-15.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI
import AppKit
import Combine
import OSLog
import Sparkle

/// 菜单栏管理器
/// 负责协调 UI 和数据层，管理设置窗口
class MenuBarManager: ObservableObject {
    // MARK: - Properties

    /// UI 管理器
    private let ui = MenuBarUI()
    /// 数据刷新管理器
    private let dataManager = DataRefreshManager()
    /// 设置窗口
    private var settingsWindow: NSWindow?
    /// 用户设置实例
    @ObservedObject private var settings = UserSettings.shared
    /// Combine 订阅集合
    private var cancellables = Set<AnyCancellable>()
    /// 窗口关闭观察者
    private var windowCloseObserver: NSObjectProtocol?
    /// 语言变化观察者
    private var languageChangeObserver: NSObjectProtocol?

    /// 是否有可用更新（由 Sparkle 的 SPUUpdaterDelegate 回调驱动）
    @Published var hasAvailableUpdate = false
    /// 最新版本号（来自 Sparkle 发现的 appcast 条目）
    @Published var latestVersion: String?
    /// 用户已确认的版本号（点击检查更新后记录）
    private var acknowledgedVersion: String?

    /// 是否应该显示徽章和通知（用户未确认时才显示）
    var shouldShowUpdateBadge: Bool {
        guard hasAvailableUpdate, let latest = latestVersion else { return false }
        return acknowledgedVersion != latest
    }

    // MARK: - Initialization

    init() {
        ui.configureClickHandler(target: self, action: #selector(handleClick))
        setupSettingsObservers()

        // Erstes Bild sofort zeichnen (graue Platzhalter-Gefäße, bis die
        // Kontodaten eintreffen) — danach hält das Punktreihen-Abo in
        // `MenuBarUI` das Symbol von selbst aktuell.
        updateMenuBarIcon()

        // Team-Server: gespeicherte Verbindung laden, Rolle prüfen und die
        // automatische Eigenmeldung starten — läuft auch ohne offenes
        // Team-Fenster (siehe TeamServerConnection / TeamAutoReporter).
        TeamServerConnection.bootstrap()
    }


    /// 处理菜单栏图标点击事件
    /// 左键切换弹出窗口，右键显示菜单
    @objc private func handleClick(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else {
            // 如果无法获取当前事件，默认作为左键点击处理
            togglePopover()
            return
        }

        if event.type == .rightMouseUp {
            showMenu()
        } else {
            togglePopover()
        }
    }

    /// 显示右键菜单
    private func showMenu() {
        let menu = ui.createStandardMenu(hasUpdate: hasAvailableUpdate, shouldShowBadge: shouldShowUpdateBadge, target: self)
        ui.statusItem.menu = menu
        ui.statusItem.button?.performClick(nil)
        ui.statusItem.menu = nil
    }
    
    
    // MARK: - Menu Actions

    @objc func quitApp() {
        NSApplication.shared.terminate(nil)
    }

    // Für „Bleib wach" gibt es hier bewusst keine Weiterleitung: Der Schalter
    // sitzt im Kopf der Übersicht und ruft `SleepGuard` direkt auf — ein
    // Menüeintrag wäre ein zweiter Weg zur selben Sache.

    /// 处理菜单操作
    /// 关闭弹出窗口并执行相应的操作
    private func handleMenuAction(_ action: MenuAction) {
        switch action {
        case .generalSettings:
            closePopover()
            openSettingsWindow(tab: 0)
        case .authSettings:
            closePopover()
            openSettingsWindow(tab: 1)
        case .checkForUpdates:
            closePopover()
            checkForUpdates()
        case .about:
            closePopover()
            openSettingsWindow(tab: 2)
        case .openDashboardWindow:
            closePopover()
            openDashboardWindow()
        case .quit:
            quitApp()
        }
    }

    // MARK: - Dashboard

    /// Übersicht in einem eigenständigen Fenster öffnen
    @objc func openDashboardWindow() {
        closePopover()
        FleetWindowManager.shared.show { [weak self] action in
            self?.handleMenuAction(action)
        }
    }

    /// Team-Ansicht öffnen: die Übersicht (Fenster, sonst Popover) im
    /// Team-Modus. Ein eigenes Team-Fenster gibt es seit 2.7 nicht mehr.
    @objc func openTeamOverview() {
        openDashboardWindow()
    }

    /// 设置设置变更观察者
    /// 监听设置变更、刷新频率变更等通知
    private func setupSettingsObservers() {
        // NotificationCenter 的 post 发生在哪个线程，publisher 就在哪个线程收，不能假定是主线程
        // （TimerManager 等下游依赖主 RunLoop），统一 receive(on:) 到主线程再处理。
        let settingsChanged = NotificationCenter.default.publisher(for: .settingsChanged)
            .receive(on: DispatchQueue.main)

        // 图标缓存清理 + 重绘需要即时反馈，不做防抖
        settingsChanged
            .sink { [weak self] _ in
                guard let self = self else { return }
                // 设置改变时清除图标缓存（显示模式可能改变）
                self.ui.clearIconCache()

                // 立即更新图标，无需等待
                self.updateMenuBarIcon()
            }
            .store(in: &cancellables)

        #if DEBUG
        // iconStyleMode 等几乎所有设置项改动都会 post settingsChanged，
        // 但只有"调试模拟模式"（debugModeEnabled）下改动才需要立即刷新——那条路径读的是本地
        // mock 数据（ClaudeAPIService.createMockData），不产生真实网络请求。
        // 若开发者正用真实账号联调 UI（debugModeEnabled 为 false），这类与用量数据
        // 无关的设置不该触发真实 API 请求；此前无条件 fetchUsage() 会导致连续改动
        // 设置时打出一串真实请求，被 API 判定请求过于频繁（429）。
        // 防抖仅作为同一批 mock 场景改动（如拖动滑块）的兜底合并，不是本次修复的关键。
        settingsChanged
            .debounce(for: .milliseconds(500), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self = self else { return }
                if self.settings.debugModeEnabled {
                    self.dataManager.fetchUsage()
                }

                // 模拟更新开关变化时，直接驱动 Sparkle 徽章状态机（无需真实 appcast）
                if self.settings.simulateUpdateAvailable {
                    self.hasAvailableUpdate = true
                    self.latestVersion = "2.0.0"
                    self.updateMenuBarIcon()
                    Logger.menuBar.debug("模拟更新已启用")
                } else {
                    self.hasAvailableUpdate = false
                    self.latestVersion = nil
                    self.updateMenuBarIcon()
                    Logger.menuBar.debug("模拟更新已禁用")
                }
            }
            .store(in: &cancellables)
        #endif

        NotificationCenter.default.publisher(for: .refreshIntervalChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                // 重启数据刷新定时器
                self?.dataManager.stopRefreshing()
                self?.dataManager.startRefreshing()
            }
            .store(in: &cancellables)
        
        // Popover schließen, sobald irgendein Fenster der App den Fokus
        // bekommt — Übersichts-, Team- oder Einstellungsfenster ersetzen die
        // Schnellansicht. Ohne das bliebe das Popover oben rechts unter dem
        // Menüleisten-Symbol stehen, wenn man in ein Fenster wechselt: Seine
        // Auto-Schließ-Mechanismen (globaler Klick-Monitor, didResignActive,
        // .semitransient) greifen alle nur bei Klicks in *andere* Apps.
        NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                guard let self, self.ui.popover.isShown else { return }
                guard let window = notification.object as? NSWindow else { return }
                // Klicks ins Popover machen dessen eigenes Fenster key —
                // das darf es natürlich nicht selbst schließen.
                if window === self.ui.popover.contentViewController?.view.window { return }
                #if DEBUG
                if UserSettings.shared.debugKeepDetailWindowOpen { return }
                #endif
                self.closePopover()
            }
            .store(in: &cancellables)

        // 监听账户变更通知
        NotificationCenter.default.publisher(for: .accountChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                guard let self = self else { return }
                Logger.menuBar.notice("账户已切换，刷新数据")
                let providerRaw = notification.userInfo?[Notification.UserInfoKey.provider] as? String
                let provider = providerRaw.flatMap { ProviderType(rawValue: $0) }
                // 清除图标缓存，确保新数据到达时重新渲染
                self.ui.clearIconCache()
                // 只刷新切换的 Provider，避免另一家的数据和通知状态被误清理
                self.dataManager.handleAccountChanged(provider: provider)
                // 更新菜单栏图标
                self.updateMenuBarIcon()
            }
            .store(in: &cancellables)
    }

    // MARK: - Popover Management

    /// 切换弹出窗口显示状态
    @objc func togglePopover() {
        openDashboardWindow()
    }

    /// 打开弹出窗口
    private func openPopover(relativeTo button: NSStatusBarButton) {
        // 智能刷新数据
        dataManager.refreshOnPopoverOpen()

        // Immer die Mehrkonten-Übersicht: Es gibt keine Einzelkonto-Detailansicht mehr.
        // Ohne Konten zeigt die Übersicht selbst einen freundlichen Leerzustand.
        // Der Inhalt wird vom DashboardRefreshManager eigenständig versorgt (er lädt
        // erst beim onAppear der View, deaktiviert also keine Requests). Kein
        // Sekundentakt-Timer: die Restzeit-Zellen aktualisieren sich über TimelineView.
        ui.setPopoverContent(
            DashboardView(
                manager: DashboardRefreshManager.shared,
                onMenuAction: { [weak self] action in
                    self?.handleMenuAction(action)
                }
            )
        )

        // 打开 popover
        ui.openPopover(relativeTo: button)
    }

    /// 关闭弹出窗口
    private func closePopover() {
        ui.closePopover()
    }

    // MARK: - Data Fetching

    /// 开始数据刷新
    func startRefreshing() {
        dataManager.startRefreshing()
    }
    
    // MARK: - Settings Window
    
    @objc func openGeneralSettings() {
        openSettingsWindow(tab: 0)
    }

    @objc func openAbout() {
        openSettingsWindow(tab: 2)
    }

    /// 切换账户
    /// - Parameter sender: 发送菜单项，representedObject 包含 Account 对象
    @objc func switchAccount(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? Account else {
            Logger.menuBar.error("切换账户失败：无法获取账户信息")
            return
        }

        settings.switchToAccount(account)
    }

    /// 切换 Codex 账户
    @objc func switchCodexAccount(_ sender: NSMenuItem) {
        guard let account = sender.representedObject as? Account else { return }
        settings.switchToCodexAccount(account)
    }

    @objc func checkForUpdates() {
        // 记录用户已确认当前版本，隐藏徽章与彩虹文字
        if let version = latestVersion {
            acknowledgedVersion = version
            objectWillChange.send()
            updateMenuBarIcon()
        }

        // 交给 Sparkle：模态对话框、下载进度、EdDSA 签名校验和重启都由它处理。
        // 通过 AppDelegate.shared 访问控制器是因为 `NSApp.delegate as? AppDelegate`
        // 在 NSApplicationDelegateAdaptor 包装下不能可靠转换。
        guard let appDelegate = AppDelegate.shared else {
            Logger.menuBar.error("checkForUpdates: AppDelegate.shared not set")
            return
        }
        appDelegate.updaterController.checkForUpdates(self)
    }
    
    // MARK: - Update Status（由 Sparkle 驱动）

    /// Sparkle 发现可用更新时调用：点亮徽章 / 彩虹文字状态机。
    func applyUpdateAvailable(version: String?) {
        hasAvailableUpdate = true
        latestVersion = version
        updateMenuBarIcon()
    }

    /// Sparkle 未发现更新时调用：清除徽章状态。
    func applyUpdateNotFound() {
        hasAvailableUpdate = false
        latestVersion = nil
        updateMenuBarIcon()
    }

    /// 打开设置窗口
    /// - Parameter tab: 要显示的标签页索引 (0: 通用, 1: 认证, 2: 关于)
    private func openSettingsWindow(tab: Int) {
        if settingsWindow == nil {
            // 切换为 regular 模式，使应用显示在 Dock 中
            NSApp.setActivationPolicy(.regular)
            
            let settingsView = SettingsView(initialTab: tab)
            let hostingController = NSHostingController(rootView: settingsView)
            
            settingsWindow = NSWindow(
                contentViewController: hostingController
            )
            settingsWindow?.title = L.Window.settingsTitle
            settingsWindow?.styleMask = [.titled, .closable, .miniaturizable]
            settingsWindow?.setFrameAutosaveName("Usage4Claude.SettingsWindow")

            // 移除旧的观察者（如果存在）
            if let observer = windowCloseObserver {
                NotificationCenter.default.removeObserver(observer)
            }
            
            // 添加窗口关闭观察者
            windowCloseObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification,
                object: settingsWindow,
                queue: .main
            ) { [weak self] notification in
                // Zurück zu accessory (kein Dock-Symbol) — aber nur, wenn kein
                // anderes Fenster mehr offen ist. Vorher fiel die Policy hier
                // bedingungslos zurück und riss einem noch offenen
                // Übersichtsfenster Dock-Symbol und Menüleiste weg.
                let closing = notification.object as? NSWindow
                let hasOtherWindows = NSApp.windows.contains {
                    $0.isVisible && $0.canBecomeMain && $0 !== closing
                }
                if !hasOtherWindows {
                    NSApp.setActivationPolicy(.accessory)
                }

                self?.settingsWindow = nil
                if self?.settings.hasAnyValidCredentials == true
                    && self?.dataManager.usageData == nil
                    && self?.dataManager.codexUsageData == nil {
                    self?.startRefreshing()
                }
            }

            // Das Popover-Schließen beim Fokuswechsel übernimmt der globale
            // didBecomeKey-Beobachter in setupSettingsObservers — der frühere
            // Beobachter nur für dieses Fenster leckte bei jedem Neuaufbau.

            // 移除旧的语言变化观察者（如果存在）
            if let observer = languageChangeObserver {
                NotificationCenter.default.removeObserver(observer)
            }

            // 添加语言变化观察者 - 当语言切换时更新窗口标题
            languageChangeObserver = NotificationCenter.default.addObserver(
                forName: .languageChanged,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.settingsWindow?.title = L.Window.settingsTitle
            }
        }

        // 先激活应用，再居中和显示窗口
        NSApp.activate(ignoringOtherApps: true)

        // 延迟一小段时间确保应用激活完成后再居中窗口
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.settingsWindow?.center()
            self?.settingsWindow?.makeKeyAndOrderFront(nil)
        }

        if ui.popover.isShown {
            closePopover()
        }
    }
    
    // MARK: - Icon Management

    /// 更新菜单栏图标
    private func updateMenuBarIcon() {
        ui.updateMenuBarIcon(hasUpdate: hasAvailableUpdate, shouldShowBadge: shouldShowUpdateBadge)
    }
    
    // MARK: - Cleanup
    
    /// 清理所有资源
    /// 在应用退出时调用，停止所有定时器并移除所有观察者
    func cleanup() {
        // 清理窗口观察者
        if let observer = windowCloseObserver {
            NotificationCenter.default.removeObserver(observer)
            windowCloseObserver = nil
        }

        // 清理语言变化观察者
        if let observer = languageChangeObserver {
            NotificationCenter.default.removeObserver(observer)
            languageChangeObserver = nil
        }

        // 取消所有 Combine 订阅
        cancellables.removeAll()

        // 清理 UI
        ui.cleanup()

        // 清理数据管理器
        dataManager.cleanup()
        DashboardRefreshManager.shared.cleanup()

        // 关闭窗口
        DashboardWindowManager.shared.close()
        FleetWindowManager.shared.close()
        settingsWindow?.close()
        settingsWindow = nil
    }
    
    deinit {
        cleanup()
    }
}
