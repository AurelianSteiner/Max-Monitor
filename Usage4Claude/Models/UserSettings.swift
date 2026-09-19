//
//  UserSettings.swift
//  Usage4Claude
//
//  Created by f-is-h on 2025-10-15.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import SwiftUI
import Combine
import ServiceManagement
import OSLog

// MARK: - Display Modes

/// 菜单栏图标样式模式
/// Die Menüleiste zeigt immer die Punktreihe (ein Wasserstand je Konto);
/// wählbar ist nur noch farbig vs. einfarbig. Der frühere Wert
/// `color_with_background` gehörte zur alten Ring-Darstellung — gespeicherte
/// Reste davon fallen beim Laden auf den Standard zurück (siehe init()).
enum IconStyleMode: String, CaseIterable, Codable {
    /// 彩色通透（默认，彩色无背景）
    case colorTranslucent = "color_translucent"
    /// 单色（Template模式，跟随系统主题）
    case monochrome = "monochrome"
}

// MARK: - Refresh Modes

/// 刷新模式
enum RefreshMode: String, CaseIterable, Codable {
    /// 智能频率（根据使用情况自动调整）
    case smart = "smart"
    /// 固定频率（用户手动设置）
    case fixed = "fixed"
    
    var localizedName: String {
        switch self {
        case .smart:
            return L.Refresh.smartMode
        case .fixed:
            return L.Refresh.fixedMode
        }
    }
}

/// 数据刷新频率
enum RefreshInterval: Int, CaseIterable, Codable {
    /// 1分钟刷新一次
    case oneMinute = 60
    /// 3分钟刷新一次
    case threeMinutes = 180
    /// 5分钟刷新一次
    case fiveMinutes = 300
    /// 10分钟刷新一次
    case tenMinutes = 600
    
    var localizedName: String {
        switch self {
        case .oneMinute:
            return L.Refresh.oneMinute
        case .threeMinutes:
            return L.Refresh.threeMinutes
        case .fiveMinutes:
            return L.Refresh.fiveMinutes
        case .tenMinutes:
            return L.Refresh.tenMinutes
        }
    }
}

// MARK: - Limit Types

/// 限制类型
enum LimitType: String, CaseIterable, Codable {
    /// 5小时限制
    case fiveHour = "five_hour"
    /// 7天限制
    case sevenDay = "seven_day"
    /// Extra Usage 额外付费额度
    case extraUsage = "extra_usage"
    /// Opus 每周限制
    case opusWeekly = "seven_day_opus"
    /// Sonnet 每周限制
    case sonnetWeekly = "seven_day_sonnet"
    /// Fable 每周限制（Claude 5 时代的 per-model weekly，按模型名解析出的独立限制）
    case fableWeekly = "seven_day_fable"
    /// Codex 5小时窗口（primary）
    case codexPrimary = "codex_primary"
    /// Codex 7天窗口（secondary）
    case codexSecondary = "codex_secondary"
    /// Codex Extra Usage / credits
    case codexExtraUsage = "codex_extra_usage"

    /// 所属 Provider
    var provider: ProviderType {
        switch self {
        case .fiveHour, .sevenDay, .extraUsage, .opusWeekly, .sonnetWeekly, .fableWeekly:
            return .claude
        case .codexPrimary, .codexSecondary, .codexExtraUsage:
            return .codex
        }
    }

    /// 把一个每周模型限制（来自 `UsageData.weeklyModels`）解析为对应的限制类型。
    /// 优先按 API 返回的模型显示名（大小写不敏感）匹配 Fable / Opus / Sonnet；
    /// 名称缺失或无法识别时，退回旧的按槽位奇偶判定（slot % 2 == 0 → Opus，否则 Sonnet），
    /// 以保持旧版 seven_day_opus / seven_day_sonnet 独立字段的历史行为不变。
    /// - Parameters:
    ///   - name: 模型显示名（如 "Fable"、"Claude Opus 4.6"），可为 nil
    ///   - slot: 该模型在 weeklyModels 中的索引，用于名称缺失时的回退
    /// - Returns: 解析出的每周限制类型（.fableWeekly / .opusWeekly / .sonnetWeekly）
    static func weeklyType(forModelName name: String?, slot: Int) -> LimitType {
        if let lowered = name?.lowercased() {
            if lowered.contains("fable") { return .fableWeekly }
            if lowered.contains("opus") { return .opusWeekly }
            if lowered.contains("sonnet") { return .sonnetWeekly }
        }
        return slot % 2 == 0 ? .opusWeekly : .sonnetWeekly
    }
}

extension UsageData {
    /// 槽位无关的按类型查找：返回名称解析后与 `type` 匹配的第一条每周模型限制。
    /// 让 Fable / Opus / Sonnet 各自读到正确的模型数据，而不再依赖固定槽位（opus=0, sonnet=1）。
    /// 对旧版无名称的数据，解析退回按槽位奇偶，行为与之前一致。
    func weeklyModel(matching type: LimitType) -> WeeklyModelLimit? {
        for (index, model) in weeklyModels.enumerated() {
            if LimitType.weeklyType(forModelName: model.modelName, slot: index) == type {
                return model
            }
        }
        return nil
    }
}

// MARK: - Dashboard

/// Dashboard（多账户总览）卡片的排序方式
enum DashboardSortMode: String, CaseIterable, Codable {
    /// 按账户添加顺序（Claude 在前、Codex 在后）——布局稳定，卡片不会来回跳
    case accountOrder = "account_order"
    /// 按最紧张的一项限制的使用率升序——"还最空的账户"排在最前
    case availability = "availability"

    var localizedName: String {
        switch self {
        case .accountOrder:
            return L.Dashboard.sortByOrder
        case .availability:
            return L.Dashboard.sortByAvailability
        }
    }
}

/// 应用外观模式
enum AppAppearance: String, CaseIterable, Codable {
    /// 跟随系统
    case system = "system"
    /// 浅色
    case light = "light"
    /// 深色
    case dark = "dark"

    var localizedName: String {
        switch self {
        case .system:
            return L.Appearance.system
        case .light:
            return L.Appearance.light
        case .dark:
            return L.Appearance.dark
        }
    }

    /// 对应的 SwiftUI ColorScheme（system 返回 nil，表示跟随系统）
    var colorScheme: ColorScheme? {
        switch self {
        case .system:
            return nil
        case .light:
            return .light
        case .dark:
            return .dark
        }
    }
}

/// 应用语言选项
enum AppLanguage: String, CaseIterable, Codable {
    /// Englisch
    case english = "en"
    /// Deutsch
    case german = "de"

    var localizedName: String {
        switch self {
        case .english:
            return L.Language.english
        case .german:
            return L.Language.german
        }
    }
}

extension AppLanguage {
    /// 将应用语言转换为对应的 Locale
    var locale: Locale {
        switch self {
        case .english:
            return Locale(identifier: "en_US")
        case .german:
            return Locale(identifier: "de_DE")
        }
    }
}

// MARK: - User Settings

/// 用户设置管理类
/// 负责管理应用的所有用户配置，包括认证信息、显示设置、语言等
/// 敏感信息（Organization ID 和 Session Key）存储在 Keychain 中
/// 非敏感设置存储在 UserDefaults 中
class UserSettings: ObservableObject {
    // MARK: - Singleton

    /// 单例实例
    static let shared = UserSettings()

    // MARK: - Properties

    private let defaults = UserDefaults.standard
    private let keychain = KeychainManager.shared

    /// Combine 订阅集合：转发 accountStore 的 objectWillChange，让绑定 UserSettings 的 SwiftUI 视图
    /// 在账户数据变化时也能收到更新（见 init() 中的订阅）
    private var cancellables = Set<AnyCancellable>()

    // MARK: - 多账户支持（v2.1.0，拆分到 AccountStore，见审计报告 4.1）

    /// 账户 CRUD、持久化、当前账户 ID 均已迁移到 AccountStore，这里只做门面转发，
    /// 保持外部调用点（settings.accounts、settings.addAccount(...) 等）零改动。
    let accountStore = AccountStore()

    var accounts: [Account] { accountStore.accounts }
    var currentAccountId: UUID? { accountStore.currentAccountId }
    var currentAccount: Account? { accountStore.currentAccount }

    var sessionKey: String {
        get { accountStore.sessionKey }
        set { accountStore.sessionKey = newValue }
    }

    var organizationId: String {
        get { accountStore.organizationId }
        set { accountStore.organizationId = newValue }
    }

    /// Claude 账户列表的语义别名（等同于 accounts，用于 provider-aware 代码中保持对称）
    var claudeAccounts: [Account] { accountStore.claudeAccounts }

    // MARK: - Codex 账户支持

    var codexAccounts: [Account] { accountStore.codexAccounts }
    var currentCodexAccountId: UUID? { accountStore.currentCodexAccountId }
    var currentCodexAccount: Account? { accountStore.currentCodexAccount }
    var codexSessionToken: String { accountStore.codexSessionToken }
    var hasValidCodexCredentials: Bool { accountStore.hasValidCodexCredentials }

    // MARK: - 非敏感设置（存储在UserDefaults中）

    /// 菜单栏图标样式模式
    @Published var iconStyleMode: IconStyleMode {
        didSet {
            defaults.set(iconStyleMode.rawValue, forKey: "iconStyleMode")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }
    
    /// 刷新模式（智能/固定）
    @Published var refreshMode: RefreshMode {
        didSet {
            defaults.set(refreshMode.rawValue, forKey: "refreshMode")
            NotificationCenter.default.post(name: .refreshIntervalChanged, object: nil)
        }
    }
    
    /// 数据刷新间隔（秒）- 仅在固定模式下使用
    @Published var refreshInterval: Int {
        didSet {
            defaults.set(refreshInterval, forKey: "refreshInterval")
            NotificationCenter.default.post(name: .refreshIntervalChanged, object: nil)
        }
    }
    
    /// 应用界面语言
    @Published var language: AppLanguage {
        didSet {
            defaults.set(language.rawValue, forKey: "language")
            NotificationCenter.default.post(name: .languageChanged, object: nil)
        }
    }

    /// 外观模式的持久化、应用到 NSApp、系统主题监听都在 AppearanceManager 里，这里只做门面转发。
    /// 计算属性也能形成 ReferenceWritableKeyPath，$settings.appearance 双向绑定不受影响。
    let appearanceManager = AppearanceManager()

    var appearance: AppAppearance {
        get { appearanceManager.appearance }
        set { appearanceManager.appearance = newValue }
    }

    // MARK: - Dashboard（多账户总览）

    /// Dashboard 卡片的排序方式
    @Published var dashboardSortMode: DashboardSortMode {
        didSet {
            defaults.set(dashboardSortMode.rawValue, forKey: "dashboardSortMode")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// Dashboard 每行的卡片列数（1-3）
    @Published var dashboardColumns: Int {
        didSet {
            defaults.set(dashboardColumns, forKey: "dashboardColumns")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// Konten nach Anbieter in zwei Bahnen trennen: Claude links, Codex rechts.
    /// Gemischt nebeneinander war auf einen Blick nicht zu sehen, welche Karte
    /// zu welchem Dienst gehört — die Sortierung nach Verfügbarkeit mischt die
    /// beiden Reihen ja gerade absichtlich durcheinander. Die gewählte
    /// Sortierung gilt weiterhin, nur eben innerhalb jeder Bahn.
    @Published var dashboardGroupByProvider: Bool {
        didSet {
            defaults.set(dashboardGroupByProvider, forKey: "dashboardGroupByProvider")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 参与 Dashboard 展示的全部账户（Claude 在前、Codex 在后）
    var dashboardAccounts: [Account] {
        accounts + codexAccounts
    }

    /// 是否具备展示 Dashboard 的条件（至少两个账户），决定菜单里是否出现总览入口
    var canShowDashboard: Bool {
        dashboardAccounts.count > 1
    }

    /// Ab dem ersten Konto wird immer die Gesamtübersicht gezeigt (die frühere
    /// Einzelansicht entfällt). Ohne Konten bleibt der Willkommens-/Einrichtungs-Screen.
    var hasAnyDashboardAccount: Bool { !dashboardAccounts.isEmpty }

    /// 同一个 Provider 下是否存在多个账户。
    /// 只有这种情况下「点菜单栏图标默认进总览」才有意义——Claude 一个 + Codex 一个时，
    /// 经典详情窗口本来就是双列并排，信息比卡片更丰富，不该被总览顶掉。
    var hasMultipleAccountsPerProvider: Bool {
        accounts.count > 1 || codexAccounts.count > 1
    }

    /// 是否为首次启动标记
    @Published var isFirstLaunch: Bool {
        didSet {
            defaults.set(isFirstLaunch, forKey: "isFirstLaunch")
        }
    }
    
    /// 开机启动的注册/注销/状态同步都在 LaunchAtLoginManager 里，这里只做门面转发。
    /// isEnabled 直接派生自 SMAppService.mainApp.status（唯一事实来源），
    /// 不再需要存储 Bool + 标志位防递归，失败时 Toggle 会随 status 不变而自动弹回。
    let launchAtLoginManager = LaunchAtLoginManager()

    var launchAtLogin: Bool {
        get { launchAtLoginManager.isEnabled }
        set { launchAtLoginManager.isEnabled = newValue }
    }

    /// 开机启动状态（用于UI显示）
    var launchAtLoginStatus: SMAppService.Status { launchAtLoginManager.status }

    // MARK: - Debug Mode (仅Debug编译时可用)

    #if DEBUG
    /// 是否启用调试模式（模拟不同数据场景）
    @Published var debugModeEnabled: Bool {
        didSet {
            defaults.set(debugModeEnabled, forKey: "debugModeEnabled")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试场景类型
    @Published var debugScenario: DebugScenario {
        didSet {
            defaults.set(debugScenario.rawValue, forKey: "debugScenario")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的5小时限制百分比（0-100）
    @Published var debugFiveHourPercentage: Double {
        didSet {
            defaults.set(debugFiveHourPercentage, forKey: "debugFiveHourPercentage")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的7天限制百分比（0-100）
    @Published var debugSevenDayPercentage: Double {
        didSet {
            defaults.set(debugSevenDayPercentage, forKey: "debugSevenDayPercentage")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的 Opus 限制百分比（0-100）
    @Published var debugOpusPercentage: Double {
        didSet {
            defaults.set(debugOpusPercentage, forKey: "debugOpusPercentage")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的 Sonnet 限制百分比（0-100）
    @Published var debugSonnetPercentage: Double {
        didSet {
            defaults.set(debugSonnetPercentage, forKey: "debugSonnetPercentage")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的 Codex 5小时窗口百分比（0-100）
    @Published var debugCodexPrimaryPercentage: Double {
        didSet {
            defaults.set(debugCodexPrimaryPercentage, forKey: "debugCodexPrimaryPercentage")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的 Codex 7天窗口百分比（0-100）
    @Published var debugCodexSecondaryPercentage: Double {
        didSet {
            defaults.set(debugCodexSecondaryPercentage, forKey: "debugCodexSecondaryPercentage")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的 Codex Extra Usage 百分比（0-100）
    @Published var debugCodexExtraUsagePercentage: Double {
        didSet {
            defaults.set(debugCodexExtraUsagePercentage, forKey: "debugCodexExtraUsagePercentage")
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 调试用的 Extra Usage 是否启用
    @Published var debugExtraUsageEnabled: Bool {
        didSet {
            defaults.set(debugExtraUsageEnabled, forKey: "debugExtraUsageEnabled")
        }
    }

    /// 调试用的 Extra Usage 已使用金额（美分），与真实 API used_credits 单位一致
    @Published var debugExtraUsageUsed: Double {
        didSet {
            defaults.set(debugExtraUsageUsed, forKey: "debugExtraUsageUsed")
        }
    }

    /// 调试用的 Extra Usage 总限额（美分），与真实 API monthly_limit 单位一致，只能为整数
    @Published var debugExtraUsageLimit: Int {
        didSet {
            defaults.set(debugExtraUsageLimit, forKey: "debugExtraUsageLimit")
        }
    }

    /// 调试用的 Extra Usage 百分比（0-100），会同步更新 used 值
    @Published var debugExtraUsagePercentage: Double {
        didSet {
            defaults.set(debugExtraUsagePercentage, forKey: "debugExtraUsagePercentage")
            // 同步更新 used 值（美分）
            debugExtraUsageUsed = Double(debugExtraUsageLimit) * (debugExtraUsagePercentage / 100.0)
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 是否模拟有可用更新（调试用）
    @Published var simulateUpdateAvailable: Bool {
        didSet {
            defaults.set(simulateUpdateAvailable, forKey: "simulateUpdateAvailable")
            // 发送通知让 MenuBarManager 重新检查更新状态
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// 是否保持详情窗口始终打开（调试用，方便录制动画）
    @Published var debugKeepDetailWindowOpen: Bool {
        didSet {
            defaults.set(debugKeepDetailWindowOpen, forKey: "debugKeepDetailWindowOpen")
        }
    }

    /// 调试场景枚举
    enum DebugScenario: String, CaseIterable {
        case realData = "real"              // 真实API数据
        case fiveHourOnly = "five_hour"     // 仅5小时限制
        case sevenDayOnly = "seven_day"     // 仅7天限制
        case both = "both"                  // 同时有两种限制
        case allFive = "all_five"           // 全部5种限制（v2.0测试）

        var displayName: String {
            switch self {
            case .realData:
                return "真实数据"
            case .fiveHourOnly:
                return "仅5小时限制"
            case .sevenDayOnly:
                return "仅7天限制"
            case .both:
                return "双限制"
            case .allFive:
                return "全部5种限制"
            }
        }
    }
    #endif

    // MARK: - 智能模式内部状态（不持久化，委托给 SmartRefreshPolicy 纯逻辑状态机）

    /// 智能刷新的 4 级监控模式状态机（纯逻辑，可独立单测，见 Helpers/SmartRefreshPolicy.swift）
    private let smartRefreshPolicy = SmartRefreshPolicy()

    /// 上次检测的百分比（用于检测变化）
    var lastUtilization: Double? {
        get { smartRefreshPolicy.lastUtilization }
        set { smartRefreshPolicy.lastUtilization = newValue }
    }

    /// 连续无变化次数
    var unchangedCount: Int {
        get { smartRefreshPolicy.unchangedCount }
        set { smartRefreshPolicy.unchangedCount = newValue }
    }

    /// 当前监控模式（智能模式下使用）
    var currentMonitoringMode: MonitoringMode {
        get { smartRefreshPolicy.currentMode }
        set { smartRefreshPolicy.currentMode = newValue }
    }

    // MARK: - Initialization
    
    /// 检测系统语言并映射到应用支持的语言
    /// - Returns: 与系统语言最匹配的 AppLanguage
    private static func detectSystemLanguage() -> AppLanguage {
        let systemLanguage = Locale.preferredLanguages.first ?? "en"
        return systemLanguage.hasPrefix("de") ? .german : .english
    }
    
    /// 私有初始化方法（单例模式）
    /// 从 Keychain 加载敏感信息，从 UserDefaults 加载其他设置
    private init() {
        // MARK: - 从UserDefaults加载非敏感设置

        // Für die Punktreihe zählt nur noch farbig vs. einfarbig; das frühere
        // „farbig mit Hintergrund" der Ring-Darstellung parst nicht mehr und
        // fällt damit automatisch auf den Standard (farbig) zurück.
        if let styleString = defaults.string(forKey: "iconStyleMode"),
           let style = IconStyleMode(rawValue: styleString) {
            self.iconStyleMode = style
        } else {
            self.iconStyleMode = .colorTranslucent  // 默认彩色通透
        }

        // 加载刷新模式，默认为智能模式
        if let modeString = defaults.string(forKey: "refreshMode"),
           let mode = RefreshMode(rawValue: modeString) {
            self.refreshMode = mode
        } else {
            self.refreshMode = .smart
        }
        
        let savedRefreshInterval = defaults.integer(forKey: "refreshInterval")
        self.refreshInterval = savedRefreshInterval > 0 ? savedRefreshInterval : 180 // 默认3分钟
        
        if let langString = defaults.string(forKey: "language"),
           let lang = AppLanguage(rawValue: langString) {
            self.language = lang
        } else {
            // 首次启动时使用系统语言
            self.language = Self.detectSystemLanguage()
        }

        // 外观模式的加载已搬进 AppearanceManager.init()

        // Dashboard 设置：默认开启（多账户时直接看总览，单账户时本设置不生效）
        if let sortRaw = defaults.string(forKey: "dashboardSortMode"),
           let sortMode = DashboardSortMode(rawValue: sortRaw) {
            self.dashboardSortMode = sortMode
        } else {
            // Standard: nach Verfügbarkeit — freie Konten oben, fast erschöpfte unten.
            self.dashboardSortMode = .availability
        }
        let savedColumns = defaults.integer(forKey: "dashboardColumns")
        self.dashboardColumns = (1...3).contains(savedColumns) ? savedColumns : 2
        // Standard: an. Wer nur einen Anbieter nutzt, merkt davon nichts —
        // dann gibt es genau eine Bahn und das Gitter bleibt wie bisher.
        self.dashboardGroupByProvider = defaults.object(forKey: "dashboardGroupByProvider") as? Bool ?? true

        // 检查是否首次启动（如果没有保存过认证信息，就是首次启动）
        if !defaults.bool(forKey: "hasLaunched") {
            self.isFirstLaunch = true
            defaults.set(true, forKey: "hasLaunched")
        } else {
            self.isFirstLaunch = false
        }
        
        // 加载通知设置，默认开启

        // 开机启动状态的加载已搬进 LaunchAtLoginManager.init()

        // MARK: - 初始化调试模式设置

        #if DEBUG
        self.debugModeEnabled = defaults.bool(forKey: "debugModeEnabled")
        self.debugScenario = DebugScenario(
            rawValue: defaults.string(forKey: "debugScenario") ?? "real"
        ) ?? .realData
        self.debugFiveHourPercentage = defaults.object(forKey: "debugFiveHourPercentage") as? Double ?? 55.0
        self.debugSevenDayPercentage = defaults.object(forKey: "debugSevenDayPercentage") as? Double ?? 66.0
        self.debugOpusPercentage = defaults.object(forKey: "debugOpusPercentage") as? Double ?? 77.0
        self.debugSonnetPercentage = defaults.object(forKey: "debugSonnetPercentage") as? Double ?? 88.0
        self.debugCodexPrimaryPercentage = defaults.object(forKey: "debugCodexPrimaryPercentage") as? Double ?? 42.0
        self.debugCodexSecondaryPercentage = defaults.object(forKey: "debugCodexSecondaryPercentage") as? Double ?? 58.0
        self.debugCodexExtraUsagePercentage = defaults.object(forKey: "debugCodexExtraUsagePercentage") as? Double ?? 35.0
        self.debugExtraUsageEnabled = defaults.object(forKey: "debugExtraUsageEnabled") as? Bool ?? true
        self.debugExtraUsageUsed = defaults.object(forKey: "debugExtraUsageUsed") as? Double ?? 3050.0
        self.debugExtraUsageLimit = defaults.object(forKey: "debugExtraUsageLimit") as? Int ?? 5000
        self.debugExtraUsagePercentage = defaults.object(forKey: "debugExtraUsagePercentage") as? Double ?? 61.0
        self.simulateUpdateAvailable = defaults.bool(forKey: "simulateUpdateAvailable")
        self.debugKeepDetailWindowOpen = defaults.bool(forKey: "debugKeepDetailWindowOpen")
        #endif

        // 账户加载/迁移、开机启动注册状态、外观应用与系统主题监听都已分别搬进
        // AccountStore / LaunchAtLoginManager / AppearanceManager 各自的 init()；
        // 这里只需转发它们的 objectWillChange，让 @ObservedObject var settings =
        // UserSettings.shared 的 SwiftUI 视图在这些子对象变化时也能收到刷新。
        for publisher in [accountStore.objectWillChange, launchAtLoginManager.objectWillChange, appearanceManager.objectWillChange] {
            publisher
                .sink { [weak self] _ in self?.objectWillChange.send() }
                .store(in: &cancellables)
        }

        // 同步系统实际的开机启动状态（LaunchAtLoginManager.init 只读了一次快照，
        // 这里主动刷新一次以防应用启动前用户在系统设置里手动改过）
        syncLaunchAtLoginStatus()
    }
    
    // MARK: - Computed Properties

    /// 当前应用使用的 Locale（基于用户选择的语言）
    var appLocale: Locale {
        return language.locale
    }

    /// 检查认证信息是否已配置
    /// OAuth 账户仅凭 refresh_token（sk-ant-ort01- 前缀）即可认为有效；
    /// session-cookie 账户仍需 organizationId + sessionKey 双非空。
    var hasValidCredentials: Bool {
        guard !sessionKey.isEmpty else { return false }
        if sessionKey.hasPrefix("sk-ant-ort01-") { return true }
        return !organizationId.isEmpty
    }

    /// 检查任一 Provider 的认证信息是否已配置
    var hasAnyValidCredentials: Bool {
        return hasValidCredentials || hasValidCodexCredentials
    }

    /// 验证 Organization ID 格式
    /// - Parameter id: 要验证的 Organization ID
    /// - Returns: 如果格式有效（UUID 格式）返回 true
    func isValidOrganizationId(_ id: String) -> Bool {
        // Organization ID 应该是 UUID 格式
        let uuidRegex = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        let predicate = NSPredicate(format: "SELF MATCHES %@", uuidRegex)
        return predicate.evaluate(with: id)
    }

    /// 验证 Session Key 格式
    /// - Parameter key: 要验证的 Session Key
    /// - Returns: 如果格式有效返回 true
    func isValidSessionKey(_ key: String) -> Bool {
        // Session Key 应该是非空的，并且有合理的长度
        // 典型的 session key 长度在 20-200 字符之间
        return !key.isEmpty && key.count >= 20 && key.count <= 500
    }
    
    /// 获取当前生效的刷新间隔（秒）
    /// - Returns: 智能模式返回当前监控模式的间隔，固定模式返回用户设置的间隔
    var effectiveRefreshInterval: Int {
        switch refreshMode {
        case .smart:
            return currentMonitoringMode.interval
        case .fixed:
            return refreshInterval
        }
    }
    
    // MARK: - Public Methods

    /// 重置为默认设置
    /// 只重置非敏感设置，不影响认证信息
    func resetToDefaults() {
        appearance = .system
        iconStyleMode = .colorTranslucent
        refreshMode = .smart
        refreshInterval = 180  // 固定模式默认3分钟
        language = Self.detectSystemLanguage()
        dashboardSortMode = .availability
        dashboardColumns = 2
        dashboardGroupByProvider = true

        // 重置智能模式状态
        lastUtilization = nil
        unchangedCount = 0
        currentMonitoringMode = .active
    }
    
    /// 清除所有认证信息
    /// 从 Keychain 中删除 Organization ID 和 Session Key
    func clearCredentials() {
        keychain.deleteCredentials()
        organizationId = ""
        sessionKey = ""
        Logger.settings.notice("已清除所有认证信息")
    }
    
    /// 更新智能监控模式
    /// 根据用量百分比变化智能调整刷新频率
    /// - Parameter currentUtilization: 当前用量百分比
    func updateSmartMonitoringMode(currentUtilization: Double) {
        updateSmartMonitoringMode(providerUtilizations: [.claude: currentUtilization])
    }

    /// 更新智能监控模式
    /// 任一 Provider 用量变化会切回活跃模式；全部无变化才累计静默次数。
    /// 状态机本身在 SmartRefreshPolicy 中（纯逻辑、可单测），这里只处理日志和通知这两个副作用。
    /// - Parameter providerUtilizations: 本轮成功获取的 Provider 用量百分比
    func updateSmartMonitoringMode(providerUtilizations: [ProviderType: Double]) {
        // 只在智能模式下工作
        guard refreshMode == .smart else { return }

        let previousMode = smartRefreshPolicy.currentMode
        let modeChanged = smartRefreshPolicy.update(providerUtilizations: providerUtilizations)

        if modeChanged {
            logModeTransition(from: previousMode, to: smartRefreshPolicy.currentMode)
            NotificationCenter.default.post(name: .refreshIntervalChanged, object: nil)
        }
    }

    /// 记录模式切换日志
    /// - Parameters:
    ///   - from: 原模式
    ///   - to: 新模式
    private func logModeTransition(from: MonitoringMode, to: MonitoringMode) {
        let modeNames: [MonitoringMode: String] = [
            .active: "活跃 (1分钟)",
            .idleShort: "短期静默 (3分钟)",
            .idleMedium: "中期静默 (5分钟)",
            .idleLong: "长期静默 (10分钟)"
        ]
        Logger.settings.debug("监控模式切换: \(modeNames[from] ?? "") -> \(modeNames[to] ?? "")")
    }

    /// 重置智能监控模式状态
    /// 在切换到固定模式或用户手动刷新时调用
    func resetSmartMonitoringState() {
        smartRefreshPolicy.reset()
    }

    // MARK: - Account Management (v2.1.0)
    // 实际存取/持久化都在 AccountStore（Models/AccountStore.swift），这里只是门面转发，
    // 保持外部调用点不变。

    /// 添加新账户
    /// - Parameter account: 要添加的账户
    func addAccount(_ account: Account) {
        accountStore.addAccount(account)
    }

    /// 删除账户
    /// - Parameter account: 要删除的账户
    func removeAccount(_ account: Account) {
        accountStore.removeAccount(account)
    }

    /// 切换到指定账户
    /// - Parameter account: 要切换到的账户
    func switchToAccount(_ account: Account) {
        accountStore.switchToAccount(account)
    }

    /// 更新账户信息
    /// - Parameters:
    ///   - account: 要更新的账户
    ///   - alias: 新的别名（可选）
    func updateAccount(_ account: Account, alias: String?) {
        accountStore.updateAccount(account, alias: alias)
    }

    /// 更新账户类型（公司 / 私人）
    /// - Parameters:
    ///   - account: 要更新的账户
    ///   - kind: 手动选择的类型，覆盖登录时的自动识别
    func updateAccount(_ account: Account, kind: AccountKind) {
        accountStore.updateAccount(account, kind: kind)
    }

    /// Kündigungsdatum eines Claude-Kontos setzen oder löschen
    func updateAccount(_ account: Account, subscriptionEndsAt date: Date?) {
        accountStore.updateAccount(account, subscriptionEndsAt: date)
    }

    /// Neuanmeldung eines bekannten Kontos: Zugangsdaten an Ort und Stelle ersetzen
    /// (ID, Alias, Art und Kündigungsdatum bleiben). nil, wenn die Organisation unbekannt ist.
    @discardableResult
    func replaceClaudeCredentials(organizationId: String, sessionKey: String, email: String?, kind: AccountKind) -> Account? {
        accountStore.replaceClaudeCredentials(organizationId: organizationId, sessionKey: sessionKey, email: email, kind: kind)
    }

    /// 用于显示的账户列表
    var displayAccounts: [Account] { accountStore.displayAccounts }

    /// 当前账户的显示名称
    var currentAccountName: String? { accountStore.currentAccountName }

    // MARK: - Codex Account Management

    @discardableResult
    func addCodexAccount(_ account: Account) -> Account {
        accountStore.addCodexAccount(account).account
    }

    func removeCodexAccount(_ account: Account) {
        accountStore.removeCodexAccount(account)
    }

    func switchToCodexAccount(_ account: Account) {
        accountStore.switchToCodexAccount(account)
    }

    func updateCodexAccount(_ account: Account, alias: String?) {
        accountStore.updateCodexAccount(account, alias: alias)
    }

    /// Art eines Codex-Kontos (Firma / privat) — reine Handeingabe
    func updateCodexAccount(_ account: Account, kind: AccountKind) {
        accountStore.updateCodexAccount(account, kind: kind)
    }

    /// Kündigungsdatum eines Codex-Kontos setzen oder löschen
    func updateCodexAccount(_ account: Account, subscriptionEndsAt date: Date?) {
        accountStore.updateCodexAccount(account, subscriptionEndsAt: date)
    }

    /// 静默更新当前 Codex 账户的 session-token（不触发 accountChanged 通知）
    /// 用于自动续期场景——只更新持久化数据，不触发重新拉取循环
    func silentlyUpdateCurrentCodexSessionToken(_ token: String) {
        accountStore.silentlyUpdateCurrentCodexSessionToken(token)
    }

    /// 静默更新当前 Claude 账户的 session-token（不触发 accountChanged 通知）
    /// 用于 OAuth refresh_token 轮换场景——只更新持久化数据，不触发重新拉取循环
    func silentlyUpdateCurrentClaudeSessionToken(_ token: String) {
        accountStore.silentlyUpdateCurrentClaudeSessionToken(token)
    }

    /// 静默更新指定 Claude 账户的 session-token（Dashboard 并行拉取时使用）
    func silentlyUpdateClaudeSessionToken(accountId: UUID, token: String) {
        accountStore.silentlyUpdateClaudeSessionToken(accountId: accountId, token: token)
    }

    /// 静默更新指定 Codex 账户的 session-token（Dashboard 并行拉取时使用）
    func silentlyUpdateCodexSessionToken(accountId: UUID, token: String) {
        accountStore.silentlyUpdateCodexSessionToken(accountId: accountId, token: token)
    }

    // MARK: - Launch at Login Management
    // 注册/注销/状态同步都在 LaunchAtLoginManager 里，这里只保留一个转发方法，
    // 供 ClaudeUsageMonitorApp（didBecomeActive）和设置页（onAppear）调用。

    /// 从系统读取实际的开机启动状态并更新UI
    func syncLaunchAtLoginStatus() {
        launchAtLoginManager.refreshStatus()
    }

    // MARK: - Display Logic Helper Methods (v2.0)

    /// 获取当前应该显示的限制类型列表（显示所有有数据的类型）。
    /// Die frühere „benutzerdefinierte" Auswahl ist entfallen — es gilt immer
    /// die intelligente Regel: zeigen, was Daten hat.
    /// - Parameters:
    ///   - usageData: Claude 用量数据
    ///   - codexUsageData: Codex 用量数据（可选，有 Codex 账号时传入）
    /// - Returns: 要显示的限制类型数组，按显示顺序排列
    func getActiveDisplayTypes(usageData: UsageData?, codexUsageData: CodexUsageData? = nil) -> [LimitType] {
        var types: [LimitType] = []

        // Claude 类型：按规范顺序 fiveHour → sevenDay → extraUsage → opus → sonnet
        if let data = usageData {
            // 5小时和7天限制始终显示，因为所有账号均受这两项限制约束
            types.append(.fiveHour)
            types.append(.sevenDay)
            if data.extraUsage?.enabled == true {
                types.append(.extraUsage)
            }
            // 每周模型限制的前两个槽位：按模型名解析类型（Fable/Opus/Sonnet），
            // 让 Fable 作为一等类型独立出现，而不再被槽位奇偶强行归为 Opus/Sonnet。
            // 名称缺失时 weeklyType 会退回旧的按槽位奇偶判定。
            if let first = data.weeklyModels.first {
                types.append(LimitType.weeklyType(forModelName: first.modelName, slot: 0))
            }
            if data.weeklyModels.count > 1 {
                types.append(LimitType.weeklyType(forModelName: data.weeklyModels[1].modelName, slot: 1))
            }
        }

        // Codex 类型：仅在对应窗口确有数据时追加
        // （Codex 曾临时取消5小时窗口，此时 API 只返回7天窗口，
        //  不能像 Claude 的 fiveHour/sevenDay 那样假定 primary 必然存在）
        if let codex = codexUsageData {
            if codex.primary != nil {
                types.append(.codexPrimary)
            }
            if codex.secondary != nil {
                types.append(.codexSecondary)
            }
            if codex.extraUsage?.enabled == true {
                types.append(.codexExtraUsage)
            }
        }

        return types
    }
}

// MARK: - Notification Names

/// 设置相关通知名称扩展
// 注意：通知名称现已迁移到 NotificationNames.swift
// 保持向后兼容性的导入
