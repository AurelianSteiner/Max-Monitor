//
//  LocalizationHelper.swift
//  Usage4Claude
//
//  Created by f-is-h on 2025-10-15.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation

/// 本地化字符串访问器
/// 提供类型安全的本地化字符串访问方式
/// 支持动态语言切换，根据用户设置返回对应语言的字符串
enum L {
    
    // MARK: - Menu Items
    enum Menu {
        static var generalSettings: String { localized("menu.general_settings") }
        static var checkUpdates: String { localized("menu.check_updates") }
        static var about: String { localized("menu.about") }
        static var quit: String { localized("menu.quit") }
        static var account: String { localized("menu.account") }
        static var accountPrefix: String { localized("menu.account_prefix") }
    }

    // MARK: - Account Management
    enum Account {
        static var listTitle: String { localized("account.list_title") }
        static var noAccounts: String { localized("account.no_accounts") }
        static var addAccount: String { localized("account.add_account") }
        static var addNewAccount: String { localized("account.add_new_account") }
        static var alias: String { localized("account.alias") }
        static var aliasOptional: String { localized("account.alias_optional") }
        static var aliasPlaceholder: String { localized("account.alias_placeholder") }
        /// Erklärt, wozu das Alias-Feld in der Kontoliste gut ist
        static var aliasHint: String { localized("account.alias_hint") }
        static var clearAlias: String { localized("account.clear_alias") }
        static var deleteAccount: String { localized("account.delete_account") }
        static var deleteConfirmTitle: String { localized("account.delete_confirm_title") }
        static var deleteConfirmMessage: String { localized("account.delete_confirm_message") }
        static var delete: String { localized("account.delete") }
        static var cancel: String { localized("account.cancel") }
        static var validateAndAdd: String { localized("account.validate_and_add") }
        static var multiOrgAdded: String { localized("account.multi_org_added") }
        static var claudeAccounts: String { localized("account.claude_accounts") }
        static var codexAccounts: String { localized("account.codex_accounts") }
        static var addCodexAccount: String { localized("account.add_codex_account") }

        // Firma oder privat? Steht als kleines Symbol neben dem Kontonamen und
        // trennt so das Team-Konto vom privaten Abo auf derselben Email.
        static var kindCompany: String { localized("account.kind.company") }
        static var kindPersonal: String { localized("account.kind.personal") }
        static var kindUnknown: String { localized("account.kind.unknown") }
        /// Beschriftung und Erklärung des Auswahlfelds in den Einstellungen
        static var kindLabel: String { localized("account.kind.label") }
        static var kindHint: String { localized("account.kind.hint") }

        // Gekündigtes Abo: Datum von Hand, Plakette auf der Karte
        static var cancellationLabel: String { localized("account.cancellation.label") }
        static var cancellationHint: String { localized("account.cancellation.hint") }
        static var cancellationClear: String { localized("account.cancellation.clear") }
        /// „endet 9. Okt." — Plakette auf der Karte
        static func cancellationEndsOn(_ date: String) -> String {
            String(format: localized("account.cancellation.ends_on"), date)
        }
        /// „beendet 9. Okt." — wenn der Tag schon vorbei ist
        static func cancellationEnded(_ date: String) -> String {
            String(format: localized("account.cancellation.ended"), date)
        }
        /// Tooltip der Plakette: volles Datum plus Restzeit
        static func cancellationHelp(_ date: String, _ remaining: String) -> String {
            String(format: localized("account.cancellation.help"), date, remaining)
        }
        /// Restzeit in Tagen: heute / 1 Tag / n Tage / vorbei
        static func cancellationDaysLeft(_ days: Int) -> String {
            switch days {
            case ..<0: return localized("account.cancellation.days_past")
            case 0:    return localized("account.cancellation.days_today")
            case 1:    return localized("account.cancellation.days_one")
            default:   return String(format: localized("account.cancellation.days_other"), days)
            }
        }
    }
    
    // MARK: - Usage Detail View
    enum Usage {
        static var title: String { localized("usage.title") }
        static var notStarted: String { localized("usage.not_started") }
        static var resetIn: String { localized("usage.reset_in") }
        static var remaining: String { localized("usage.remaining") }
        static var loading: String { localized("usage.loading") }
        static var notConfigured: String { localized("usage.not_configured") }
        static var goToSettings: String { localized("usage.go_to_settings") }
        static var resetTime: String { localized("usage.reset_time") }
        static var fiveHourLimit: String { localized("usage.five_hour_limit") }
        static var sevenDayLimit: String { localized("usage.seven_day_limit") }
        static var fiveHourLimitShort: String { localized("usage.five_hour_limit_short") }
        static var sevenDayLimitShort: String { localized("usage.seven_day_limit_short") }
        static var resetDate: String { localized("usage.reset_date") }
        static var refresh: String { localized("usage.refresh") }
        static var refreshCooldown: String { localized("usage.refresh_cooldown") }
        static var codexTitle: String { localized("usage.codex_title") }
        static var codexRelogin: String { localized("usage.codex_relogin") }
    }
    
    // MARK: - Dashboard（多账户总览）
    enum Dashboard {
        static var title: String { localized("dashboard.title") }
        static var windowTitle: String { localized("dashboard.window_title") }
        static var showDashboard: String { localized("dashboard.show_dashboard") }
        static var showClassicDetail: String { localized("dashboard.show_classic_detail") }
        static var openWindow: String { localized("dashboard.open_window") }
        static var sortByOrder: String { localized("dashboard.sort_by_order") }
        static var sortByAvailability: String { localized("dashboard.sort_by_availability") }
        static var sortHelp: String { localized("dashboard.sort_help") }
        static var refreshAccount: String { localized("dashboard.refresh_account") }
        static var makeActive: String { localized("dashboard.make_active") }
        static var retry: String { localized("dashboard.retry") }
        /// Knopf auf einer Karte, deren Anmeldung abgelaufen ist — öffnet den Login
        static var reauth: String { localized("dashboard.reauth") }
        static var tapHint: String { localized("dashboard.tap_hint") }
        /// Eintrag im „…"-Menü, der das Team-Fenster öffnet
        static var openTeamWindow: String { localized("dashboard.open_team_window") }
        // Kurzlabels im Ringzentrum
        static var ringExtra: String { localized("dashboard.ring_extra") }
        static var ringOpus: String { localized("dashboard.ring_opus") }
        static var ringSonnet: String { localized("dashboard.ring_sonnet") }
        static var ringFable: String { localized("dashboard.ring_fable") }
        static var weeklyLimit: String { localized("dashboard.weekly_limit") }
        static var sessionLimit: String { localized("dashboard.session_limit") }
        /// Überschrift des Countdowns auf praktisch aufgebrauchten Karten
        static var freeAgain: String { localized("dashboard.free_again") }

        // Sperr-Plakette: benennt, *welches* Fenster zu ist. „Sitzung" kommt in
        // Stunden zurück, „Woche" kann Tage blockieren — der Unterschied muss
        // auf der Karte stehen, nicht nur im Countdown.
        static var lockSession: String { localized("dashboard.lock.session") }
        static var lockWeekly: String { localized("dashboard.lock.weekly") }
        static var lockSessionHelp: String { localized("dashboard.lock.session_help") }
        static var lockWeeklyHelp: String { localized("dashboard.lock.weekly_help") }

        // Der EINE Wach-Schalter „Bleib wach": kurze Beschriftung neben dem
        // Symbol und der Erklärtext im Tooltip.
        static var sleepLabel: String { localized("dashboard.sleep.label") }
        static var sleepHelp: String { localized("dashboard.sleep.help") }
        /// Ehrliche Zeile im Tooltip: Zuklappen schläfert derzeit noch ein,
        /// das nächste Einschalten fragt einmal nach dem Passwort
        static var sleepLidNote: String { localized("dashboard.sleep.lid_note") }
        /// Text im ⓘ-Popover neben dem Schalter
        static var sleepInfo: String { localized("dashboard.sleep.info") }
        static var sleepStateOn: String { localized("dashboard.sleep.state_on") }
        static var sleepStateOff: String { localized("dashboard.sleep.state_off") }
        /// Zeile im Tooltip, wenn die Deckel-Stufe greift (Schalter an,
        /// `SleepDisabled 1`): läuft auch zugeklappt weiter
        static var sleepLidActive: String { localized("dashboard.sleep.lid_active") }
        /// Zusatz im Tooltip, wenn das System per `pmset disablesleep 1` nie
        /// schläft, der Schalter aber aus ist — dann ist das die Einstellung
        /// des Benutzers, nicht die der App
        static var sleepSystemOverride: String { localized("dashboard.sleep.system_override") }

        // Tooltip des Maskottchens im Kopf — je nach Wach-Zustand
        static var mascotAwakeHelp: String { localized("dashboard.mascot.awake_help") }
        static var mascotAsleepHelp: String { localized("dashboard.mascot.asleep_help") }
        /// Platzhalter im Ampel-Tooltip, solange für ein Fenster nichts vorliegt
        static var dotNoData: String { localized("dashboard.dot_no_data") }
        /// Zusatz im Ampel-Tooltip, wenn ein Fenster praktisch aufgebraucht ist
        static var dotUsedUp: String { localized("dashboard.dot_used_up") }
        static var dotAlmostUsedUp: String { localized("dashboard.dot_almost_used_up") }

        /// Tooltip eines Wasserstands: Kontoname, Wochen- und Sitzungswert
        static func dotHelp(_ name: String, _ weekly: String, _ session: String) -> String {
            String(format: localized("dashboard.dot_help"), name, weekly, session)
        }

        /// Zusatzzeile im Tooltip, wenn ein Modellkontingent (Fable/Opus/Sonnet)
        /// durch ist. Es sperrt das Konto nicht — genau das sagt der Satz.
        static func dotModelFull(_ model: String) -> String {
            String(format: localized("dashboard.dot_model_full"), model)
        }

        static func updatedAt(_ time: String) -> String {
            String(format: localized("dashboard.updated_at"), time)
        }

        /// 列数选项。单数形态在德/法/英等语言里与复数不同，因此单列走独立的键。
        static func columns(_ count: Int) -> String {
            count == 1
                ? localized("dashboard.columns_one")
                : String(format: localized("dashboard.columns_other"), count)
        }
    }

    // MARK: - Settings Tabs
    enum SettingsTab {
        static var general: String { localized("settings.tab.general") }
        static var auth: String { localized("settings.tab.auth") }
        static var about: String { localized("settings.tab.about") }
    }
    
    // MARK: - Settings General
    enum SettingsGeneral {
        static var launchSection: String { localized("settings.general.launch_section") }
        static var launchAtLogin: String { localized("settings.general.launch_at_login") }
        static var launchHint: String { localized("settings.general.launch_hint") }
        static var displaySection: String { localized("settings.general.display_section") }
        static var refreshSection: String { localized("settings.general.refresh_section") }
        static var refreshMode: String { localized("settings.general.refresh_mode") }
        static var refreshInterval: String { localized("settings.general.refresh_interval") }
        static var refreshHintSmart: String { localized("settings.general.refresh_hint_smart") }
        static var refreshHintFixed: String { localized("settings.general.refresh_hint_fixed") }
        static var interfaceLanguage: String { localized("settings.general.interface_language") }
        static var resetButton: String { localized("settings.general.reset_button") }
    }
    
    // MARK: - Settings: Schlaf-Einstellungen des Systems
    /// Der eingeklappte Abschnitt mit den drei `pmset`-Befehlen. Die Befehle
    /// selbst stehen im Code, nicht hier — übersetzt wird nur, was sie tun.
    enum SettingsSleep {
        static var section: String { localized("settings.sleep.section") }
        static var intro: String { localized("settings.sleep.intro") }
        static var captionStatus: String { localized("settings.sleep.caption_status") }
        static var captionOff: String { localized("settings.sleep.caption_off") }
        static var captionOn: String { localized("settings.sleep.caption_on") }
        static var copy: String { localized("settings.sleep.copy") }
        static var copied: String { localized("settings.sleep.copied") }
        static var note: String { localized("settings.sleep.note") }

        // Live-Werte aus `pmset -g` (SystemSleepInfo) über den Befehlen
        static var valueSleepOn: String { localized("settings.sleep.value_sleep_on") }
        static var valueSleepOff: String { localized("settings.sleep.value_sleep_off") }
        static var valueDisplayNever: String { localized("settings.sleep.value_display_never") }
        static func valueDisplayMinutes(_ minutes: Int) -> String {
            String(format: localized("settings.sleep.value_display_minutes"), minutes, minutes)
        }
        /// `pmset` ließ sich nicht ausführen oder die Ausgabe nicht lesen
        static var valueUnknown: String { localized("settings.sleep.value_unknown") }
    }

    // MARK: - Settings Authentication
    enum SettingsAuth {
        static var sessionKeyLabel: String { localized("settings.auth.session_key_label") }
        /// Eingeklappte Notnagel-Anmeldewege (Cookie, Handeingabe)
        static var moreLoginPaths: String { localized("settings.auth.more_login_paths") }
        static var sessionKeyPlaceholder: String { localized("settings.auth.session_key_placeholder") }
        static var sessionKeyHint: String { localized("settings.auth.session_key_hint") }
        static var configured: String { localized("settings.auth.configured") }
        static var notConfigured: String { localized("settings.auth.not_configured") }
        static var credentialsTitle: String { localized("settings.auth.credentials_title") }
        static var readyToUse: String { localized("settings.auth.ready_to_use") }
        static var needCredentials: String { localized("settings.auth.need_credentials") }
        static var manualInputClaudeOnlyHelp: String { localized("settings.auth.manual_input_claude_only_help") }
    }
    
    // MARK: - Settings About
    enum SettingsAbout {
        static func version(_ version: String) -> String {
            String(format: localized("settings.about.version"), version)
        }
        static var description: String { localized("settings.about.description") }
        static var developer: String { localized("settings.about.developer") }
        static var license: String { localized("settings.about.license") }
        static var licenseValue: String { localized("settings.about.license_value") }
        static var github: String { localized("settings.about.github") }
        static var copyright: String { localized("settings.about.copyright") }
    }
    
    // MARK: - Welcome View
    enum Welcome {
        /// Leerzustand der Übersicht (früher Untertitel des Willkommensfensters)
        static var subtitle: String { localized("welcome.subtitle") }
        /// Format-Prüfung des Session-Keys beim manuellen Hinzufügen
        static var validFormat: String { localized("welcome.valid_format") }
        static var invalidFormat: String { localized("welcome.invalid_format") }
    }
    
    // MARK: - Update
    enum Update {
        /// 通用“好”按钮，被诊断 / 设置等多处复用
        static var okButton: String { localized("update.ok_button") }
        // 更新提示：菜单栏徽章 / 彩虹文字 / 弹窗横幅
        enum Notification {
            static var available: String { localized("update.notification.available") }
            static var badgeMenu: String { localized("update.notification.badge_menu") }
            static var badgeShort: String { localized("update.notification.badge_short") }
        }
    }
    
    // MARK: - Icon Style Mode
    enum IconStyle {
        static var colorTranslucent: String { localized("icon_style.color_translucent") }
        static var monochrome: String { localized("icon_style.monochrome") }
    }
    
    // MARK: - Refresh Interval
    enum Refresh {
        static var smartMode: String { localized("refresh.smart_mode") }
        static var fixedMode: String { localized("refresh.fixed_mode") }
        static var oneMinute: String { localized("refresh.1_minute") }
        static var threeMinutes: String { localized("refresh.3_minutes") }
        static var fiveMinutes: String { localized("refresh.5_minutes") }
        static var tenMinutes: String { localized("refresh.10_minutes") }
    }
    
    // MARK: - Language Names
    enum Language {
        static var english: String { localized("language.english") }
        static var german: String { localized("language.german") }
    }
    
    // MARK: - Window Titles
    enum Window {
        static var settingsTitle: String { localized("window.settings_title") }
    }

    // MARK: - Detail Rows
    enum DetailRow {
        static var fiveHour: String { localized("detail_row.five_hour_limit") }
        static var sevenDay: String { localized("detail_row.seven_day_limit") }
        static var opusWeekly: String { localized("detail_row.opus_weekly_limit") }
        static var sonnetWeekly: String { localized("detail_row.sonnet_weekly_limit") }
        static var fableWeekly: String { localized("detail_row.fable_weekly_limit") }
        static var extraUsage: String { localized("detail_row.extra_usage") }
        static var today: String { localized("usage_data.detail_today") }

        static func creditsBalance(_ balance: Double) -> String {
            return String(format: localized("extra_usage.detail_credits_balance"), displayCredits(balance))
        }

        static func creditsRemaining(_ balance: Double) -> String {
            return String(format: localized("extra_usage.detail_credits_remaining"), displayCredits(balance))
        }

        private static func displayCredits(_ balance: Double) -> Int {
            max(0, Int(balance.rounded(.down)))
        }
    }

    // MARK: - Usage Data Formatting
    enum UsageData {
        static var notStartedReset: String { localized("usage_data.not_started_reset") }
        static var resettingSoon: String { localized("usage_data.resetting_soon") }
        static func resetsInHours(_ hours: Int, _ minutes: Int) -> String {
            String(format: localized("usage_data.resets_in_hours"), hours, minutes)
        }
        static func resetsInMinutes(_ minutes: Int) -> String {
            String(format: localized("usage_data.resets_in_minutes"), minutes)
        }
        static func resetsInDays(_ days: Int, _ hours: Int) -> String {
            String(format: localized("usage_data.resets_in_days"), days, hours)
        }
        static var unknown: String { localized("usage_data.unknown") }
        static var today: String { localized("usage_data.today") }
        static var tomorrow: String { localized("usage_data.tomorrow") }

        // Compact remaining formats
        static var compactResettingSoon: String { localized("usage_data.compact_resetting_soon") }
        static func compactRemainingMinutes(_ minutes: Int) -> String {
            String(format: localized("usage_data.compact_remaining_minutes"), minutes)
        }
        static func compactRemainingHours(_ hours: Int, _ minutes: Int) -> String {
            String(format: localized("usage_data.compact_remaining_hours"), hours, minutes)
        }
        static func compactRemainingDays(_ days: Int, _ hours: Int) -> String {
            String(format: localized("usage_data.compact_remaining_days"), days, hours)
        }
        static func compactRemainingDaysWithMinutes(_ days: Int, _ hours: Int, _ minutes: Int) -> String {
            String(format: localized("usage_data.compact_remaining_days_with_minutes"), days, hours, minutes)
        }
    }
    
    // MARK: - Error Messages
    enum Error {
        static var invalidUrl: String { localized("error.invalid_url") }
        static var noData: String { localized("error.no_data") }
        static var sessionExpired: String { localized("error.session_expired") }
        static var cloudflareBlocked: String { localized("error.cloudflare_blocked") }
        static var noCredentials: String { localized("error.no_credentials") }
        static var networkFailed: String { localized("error.network_failed") }
        static var decodingFailed: String { localized("error.decoding_failed") }
        static var noOrganizationsFound: String { localized("error.no_organizations_found") }
        static var unauthorized: String { localized("error.unauthorized") }
        static var rateLimited: String { localized("error.rate_limited") }
        static func httpStatus(_ code: Int) -> String {
            String(format: localized("error.http_status"), code)
        }
    }

    // MARK: - Display Options (v2.0.0)
    enum DisplayOptions {
        /// Überschrift der Auswahl „farbig oder einfarbig in der Menüleiste"
        static var menuBarLayout: String { localized("display_options.menu_bar_layout") }
        /// Erklärung zur Punktreihe unter der Auswahl
        static var accountDotsDescription: String { localized("display_options.account_dots_description") }
    }

    // MARK: - Launch at Login
    enum LaunchAtLogin {
        static var statusEnabled: String { localized("launch.status.enabled") }
        static var statusDisabled: String { localized("launch.status.disabled") }
        static var statusRequiresApproval: String { localized("launch.status.requires_approval") }
        static var statusNotFound: String { localized("launch.status.not_found") }
        static var errorTitle: String { localized("launch.error.title") }
        static var errorEnable: String { localized("launch.error.enable") }
        static var errorDisable: String { localized("launch.error.disable") }
    }

    // MARK: - Extra Usage
    enum ExtraUsage {
        static var notEnabled: String { localized("extra_usage.not_enabled") }
        static var unlimited: String { localized("extra_usage.unlimited") }
        static var limitReached: String { localized("extra_usage.limit_reached") }
        static func usageAmount(_ used: Double, _ limit: Double, symbol: String = "$") -> String {
            String(format: localized("extra_usage.usage_amount"), symbol, used, symbol, limit)
        }
        static func remainingAmount(_ remaining: Double, symbol: String = "$") -> String {
            String(format: localized("extra_usage.remaining_amount"), symbol, remaining)
        }
        static func creditsBalance(_ balance: Double) -> String {
            return String(format: localized("extra_usage.credits_balance"), displayCredits(balance))
        }
        static func creditsRemaining(_ balance: Double) -> String {
            return String(format: localized("extra_usage.credits_remaining"), displayCredits(balance))
        }

        private static func displayCredits(_ balance: Double) -> Int {
            max(0, Int(balance.rounded(.down)))
        }
    }

    // MARK: - Appearance
    enum Appearance {
        static var system: String { localized("appearance.system") }
        static var light: String { localized("appearance.light") }
        static var dark: String { localized("appearance.dark") }
    }

    // MARK: - Settings General (Appearance)
    enum SettingsGeneralAppearance {
        static var section: String { localized("settings.general.appearance_section") }
    }

    // MARK: - Web Login
    enum WebLogin {
        static var windowTitle: String { localized("weblogin.window_title") }
        static var codexWindowTitle: String { localized("weblogin.codex_window_title") }
        static var browserLogin: String { localized("weblogin.browser_login") }
        static var browserLoginRecommended: String { localized("weblogin.browser_login_recommended") }
        static var manualInput: String { localized("weblogin.manual_input") }
        static var cookieLogin: String { localized("weblogin.cookie_login") }
        static var cookieLoginHelp: String { localized("weblogin.cookie_login_help") }
        static var orManualInput: String { localized("weblogin.or_manual_input") }
        static var loading: String { localized("weblogin.loading") }
        static var waitingForLogin: String { localized("weblogin.waiting_for_login") }
        static var codexWaitingForLogin: String { localized("weblogin.codex_waiting_for_login") }
        static var validating: String { localized("weblogin.validating") }
        static func success(_ name: String) -> String {
            String(format: localized("weblogin.success"), name)
        }
        static var cloudflareBlocked: String { localized("weblogin.cloudflare_blocked") }
        static var privacyNotice: String { localized("weblogin.privacy_notice") }

        // MARK: Claude OAuth 登录（系统浏览器）
        static var claudeOAuthPortBusy: String { localized("weblogin.claude_oauth_port_busy") }
        static var claudeOAuthManualHint: String { localized("weblogin.claude_oauth_manual_hint") }
        static var claudeOAuthManualPrompt: String { localized("weblogin.claude_oauth_manual_prompt") }
        static var claudeOAuthManualSubmit: String { localized("weblogin.claude_oauth_manual_submit") }
        static var claudeOAuthManualInvalid: String { localized("weblogin.claude_oauth_manual_invalid") }
        /// 429 am Token-Endpunkt: Drosselung, kein Fehler der Anmeldung
        static var claudeOAuthRateLimited: String { localized("weblogin.claude_oauth_rate_limited") }

        // MARK: Codex OAuth 登录（系统浏览器）
        static var codexOAuthPreparing: String { localized("weblogin.codex_oauth_preparing") }
        static var codexOAuthWaitingBrowser: String { localized("weblogin.codex_oauth_waiting_browser") }
        static var codexOAuthWaitingHint: String { localized("weblogin.codex_oauth_waiting_hint") }
        static var codexOAuthExchanging: String { localized("weblogin.codex_oauth_exchanging") }
        static var codexOAuthFailed: String { localized("weblogin.codex_oauth_failed") }
        static var codexOAuthTimeout: String { localized("weblogin.codex_oauth_timeout") }
        static var codexOAuthPortBusy: String { localized("weblogin.codex_oauth_port_busy") }
        static var codexOAuthReopenBrowser: String { localized("weblogin.codex_oauth_reopen_browser") }
        static var codexOAuthRetry: String { localized("weblogin.codex_oauth_retry") }
    }

    // MARK: - Team-Übersicht
    enum Team {
        /// Alter einer Meldung
        static var justNow: String { localized("team.report.just_now") }
        static var stale: String { localized("team.report.stale") }

        // MARK: Einrichtung (Karte im Reiter „Konten")

        static var settingsTitle: String { localized("team.settings.title") }
        static var settingsIntro: String { localized("team.settings.intro") }
        static var idLabel: String { localized("team.settings.id_label") }
        static var copied: String { localized("team.settings.copied") }

        // MARK: Übersicht (eigenes Fenster)

        static var windowTitle: String { localized("team.window.title") }
        static var atLimitHelp: String { localized("team.view.at_limit_help") }

        /// „Personen: 4"
        static func peopleCount(_ count: Int) -> String {
            String(format: localized("team.view.people"), count)
        }

        /// „Fast am Limit: 2"
        static func atLimitCount(_ count: Int) -> String {
            String(format: localized("team.view.at_limit"), count)
        }

        /// „vor 3 Tagen gemeldet"
        static func reportedAgo(_ ago: String) -> String {
            String(format: localized("team.view.reported"), ago)
        }

        // MARK: Leere Zustände — jeder nennt den nächsten Schritt

        static var emptyNoTeam: String { localized("team.empty.no_team") }
        static var emptyNoTeamStep: String { localized("team.empty.no_team_step") }
        static var emptyOpenSettings: String { localized("team.empty.open_settings") }
        static var emptyNoReports: String { localized("team.empty.no_reports") }

        // MARK: Server-Verbindung

        /// Fehlertexte des Team-Servers (`TeamServerError`)
        static var serverNotConnected: String { localized("team.server.not_connected") }
        static var serverInvalidTeamId: String { localized("team.server.invalid_team_id") }
        static var serverInvalidToken: String { localized("team.server.invalid_token") }
        static var serverUnreachable: String { localized("team.server.unreachable") }
        static var serverBadResponse: String { localized("team.server.bad_response") }

        /// Eingetippte Adresse abgelehnt: https nötig (http nur lokal)
        static var serverInsecureURL: String { localized("team.server.insecure_url") }
        /// Gespeicherte http-Adresse aus einer älteren Version: bleibt stehen,
        /// wird aber nicht mehr benutzt
        static var serverInsecureSavedURL: String { localized("team.server.insecure_saved_url") }

        // MARK: Server-Verbindung — Karte in den Einstellungen

        static var serverSection: String { localized("team.server.section") }
        static var serverTokenLabel: String { localized("team.server.token_label") }
        static var serverConnect: String { localized("team.server.connect") }
        static var serverDisconnect: String { localized("team.server.disconnect") }
        static var serverChange: String { localized("team.server.change") }
        static var serverURLLabel: String { localized("team.server.url_label") }
        static var roleSuper: String { localized("team.server.role_super") }
        static var roleAdmin: String { localized("team.server.role_admin") }
        static var roleMember: String { localized("team.server.role_member") }

        // MARK: Mitgliederverwaltung (nur Inhaber)

        static var membersTitle: String { localized("team.members.title") }
        static var membersNamePlaceholder: String { localized("team.members.name_placeholder") }
        static var membersAdd: String { localized("team.members.add") }
        static var membersRemove: String { localized("team.members.remove") }
        static var membersCopyToken: String { localized("team.members.copy_token") }
        static var membersCopyInvite: String { localized("team.members.copy_invite") }
        static var membersDeleteConfirmTitle: String { localized("team.members.delete_confirm_title") }

        /// „Til kann danach nicht mehr melden; das Token wird ungültig."
        static func membersDeleteConfirmMessage(_ name: String) -> String {
            String(format: localized("team.members.delete_confirm_message"), name)
        }

        /// „Dieses Token bekommt Til — es wird nur einmal angezeigt."
        static func membersTokenHint(_ name: String) -> String {
            String(format: localized("team.members.token_hint"), name)
        }

        /// Fertige Einladung für ein Mitglied — Download-Link, Fundort des
        /// Feldes, Team-ID und das Token dieser Person
        static func invitation(teamId: String, token: String) -> String {
            String(format: localized("team.invite.template"), teamId, token)
        }

        // MARK: Übersicht — Verbindungszeile und Server-Zustände

        /// „Verbunden als Admin"
        static func connectedAs(_ role: String) -> String {
            String(format: localized("team.view.connected_as"), role)
        }

        /// „3 von 8 gemeldet" — frische Meldungen gegen die Mitgliederliste
        static func membersReported(_ fresh: Int, _ total: Int) -> String {
            String(format: localized("team.view.members_reported"), fresh, total)
        }
        /// Zeile eines Mitglieds ohne Meldung
        static var rowNoReport: String { localized("team.row.no_report") }
        /// Gruppenüberschriften der Detailansicht
        static var detailModels: String { localized("team.detail.models") }
        static var detailAccounts: String { localized("team.detail.accounts") }
        /// Fußnote und Tooltip der Verlaufslinien in der Detailansicht
        static var detailHistory: String { localized("team.detail.history") }

        /// „Wochenlimit: 62 % → 78 % in 24 h" — Tooltip des Trend-Pfeils
        static func trendHelp(_ previous: Int, _ current: Int) -> String {
            String(format: localized("team.view.trend"), previous, current)
        }
        static var emptyServerNoReportsStep: String { localized("team.empty.server_no_reports_step") }
        static var emptyServerUnreachableStep: String { localized("team.empty.server_unreachable_step") }
    }

    // MARK: - Helper Methods

    /// 本地化字符串辅助方法
    /// 根据用户设置的语言返回对应的本地化字符串
    /// - Parameter key: 本地化字符串的键名
    /// - Returns: 对应语言的本地化字符串
    private static func localized(_ key: String) -> String {
        // 从UserSettings获取用户选择的语言
        let language = UserSettings.shared.language.rawValue
        
        // 获取对应语言的bundle
        guard let path = Bundle.main.path(forResource: language, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            // 如果找不到对应语言，使用系统默认
            return NSLocalizedString(key, comment: "")
        }
        
        return NSLocalizedString(key, bundle: bundle, comment: "")
    }
}
