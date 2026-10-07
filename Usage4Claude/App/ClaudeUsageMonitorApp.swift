//
//  ClaudeUsageMonitorApp.swift
//  Usage4Claude
//
//  Created by f-is-h on 2025-10-15.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI
import Combine
import Sparkle

/// Echter Prozess-Einstieg.
///
/// Warum nicht einfach `@main` auf dem App-Struct: Beim Wegfall der App
/// Sandbox (2.0) müssen die alten Container-UserDefaults einmalig importiert
/// werden, BEVOR irgendein Code UserDefaults anfasst. Schon das Erzeugen des
/// SwiftUI-App-Structs zieht aber den `@NSApplicationDelegateAdaptor` hoch —
/// und damit Sparkle (SULastCheckTime …) und `UserSettings.shared`. Ein
/// eigener Einstieg garantiert: Migration zuerst, dann erst SwiftUI.
@main
enum AppMain {
    static func main() {
        if let exitCode = TeamEnrollmentCommand.runIfRequested() {
            exit(exitCode)
        }
        // ALLERERSTE reguläre App-Anweisung — vor Sparkle, UserSettings & Co.
        SandboxedPreferencesMigrator.run()
        ClaudeUsageMonitorApp.main()
    }
}

/// Usage4Claude 应用主入口
struct ClaudeUsageMonitorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

/// 应用代理类
/// 负责应用生命周期管理、资源初始化和清理
class AppDelegate: NSObject, NSApplicationDelegate {
    // MARK: - Properties

    /// 应用代理共享实例
    /// SwiftUI 的 NSApplicationDelegateAdaptor 包装了 delegate，导致
    /// `NSApp.delegate as? AppDelegate` 不能可靠地拿到本类型；MenuBarManager
    /// 需要通过这个静态引用调用 `updaterController.checkForUpdates(_:)`。
    static weak var shared: AppDelegate?

    private var statusItem: NSStatusItem!
    private var popover: NSPopover!

    /// 菜单栏管理器，负责所有菜单栏相关功能
    private var menuBarManager: MenuBarManager!

    /// 用户设置实例
    private let settings = UserSettings.shared

    /// Sparkle 更新控制器
    /// - `startingUpdater: true` 让 Sparkle 按 Info.plist 中的
    ///   SUEnableAutomaticChecks / SUScheduledCheckInterval 自动后台检查（默认24小时）
    /// - `updaterDelegate: self` 让 AppDelegate 作为 SPUUpdaterDelegate，把
    ///   `didFindValidUpdate` / `updaterDidNotFindUpdate` 转给菜单栏徽章状态机，
    ///   使彩虹文字 / 红点徽章与 Sparkle 自己的模态对话框并存；EdDSA 签名校验
    ///   仍通过 Info.plist 的 SUPublicEDKey 完成
    /// - 暴露为 internal，让 MenuBarManager 通过 `AppDelegate.shared` 调用
    ///
    /// 在 init() 的 super.init() 之后构造：updaterDelegate 需要 self，而 Swift
    /// 不允许在存储属性初始化器里引用 self（此时仍早于任何后台检查）。
    private(set) var updaterController: SPUStandardUpdaterController!

    override init() {
        super.init()
        AppDelegate.shared = self
        updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
    }

    /// Combine 订阅集合，用于自动管理观察者生命周期
    private var cancellables = Set<AnyCancellable>()
    
    // MARK: - Application Lifecycle
    
    /// 应用启动完成时调用
    /// 初始化菜单栏管理器，根据是否首次启动显示欢迎窗口或开始刷新数据
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        menuBarManager = MenuBarManager()

        // Gemerkte „wach halten“-Schalter erneut anfordern (Power-Assertions
        // überleben den Prozess nicht)
        SleepGuard.shared.restoreFromDefaults()

        if settings.hasAnyValidCredentials {
            menuBarManager.startRefreshing()
        } else {
            // Kein Willkommensfenster mehr: Ohne Konto öffnet die Übersicht
            // mit ihrem Leerzustand — der Knopf dort führt direkt in die
            // Konten-Einstellungen, wo alle Anmeldewege beieinander liegen.
            // Das frühere Fenster war derselbe Inhalt ein zweites Mal.
            menuBarManager.openDashboardWindow()
        }
        if settings.isFirstLaunch {
            settings.isFirstLaunch = false
        }

        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in
                self?.settings.syncLaunchAtLoginStatus()
            }
            .store(in: &cancellables)
    }
    
    /// Klick auf das App-Symbol (Dock / Finder / Spotlight) bei bereits
    /// laufender App.
    /// Wegen LSUIElement=true gibt es kein dauerhaftes Dock-Icon, ein erneutes
    /// Starten würde sonst scheinbar nichts tun. Stattdessen die Übersicht
    /// öffnen.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NSApp.activate(ignoringOtherApps: true)

        // menuBarManager ist erst nach applicationDidFinishLaunching gesetzt —
        // im Zweifel direkt über den Fenster-Manager öffnen, statt zu crashen.
        if let menuBarManager {
            menuBarManager.openDashboardWindow()
        } else {
            FleetWindowManager.shared.show()
        }

        return true
    }

    /// 应用即将退出时调用
    /// 清理定时器和窗口资源
    /// 注意：Combine 订阅会在 cancellables 被释放时自动清理
    func applicationWillTerminate(_ notification: Notification) {
        // Power-Assertions freigeben (die gemerkten Schalter bleiben erhalten)
        SleepGuard.shared.releaseAll()
        menuBarManager?.cleanup()
        cancellables.removeAll()
    }
}

// MARK: - SPUUpdaterDelegate

extension AppDelegate: SPUUpdaterDelegate {
    /// Sparkle 在后台或手动检查中发现可用更新时回调：点亮菜单栏徽章 /
    /// 彩虹文字状态机，与 Sparkle 自己的“有可用更新”模态对话框并存。
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        menuBarManager?.applyUpdateAvailable(version: item.displayVersionString)
    }

    /// Sparkle 检查后未发现更新时回调：清除可能残留的徽章状态。
    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        menuBarManager?.applyUpdateNotFound()
    }
}
