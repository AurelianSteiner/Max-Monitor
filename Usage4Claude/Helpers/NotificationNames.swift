//
//  NotificationNames.swift
//  Usage4Claude
//
//  Created by Claude Code on 2025-12-01.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation

/// 通知名称扩展
/// 提供类型安全的通知名称常量，避免硬编码字符串导致的拼写错误
/// 所有应用内通知应使用这些常量而非直接使用字符串
extension Notification.Name {
    // MARK: - Settings Related

    /// 设置已更改通知
    /// 当用户修改任何设置项时发送
    static let settingsChanged = Notification.Name("settingsChanged")

    /// 刷新间隔已更改通知
    /// 当用户修改刷新间隔或刷新模式时发送
    static let refreshIntervalChanged = Notification.Name("refreshIntervalChanged")

    /// 语言已更改通知
    /// 当用户切换应用语言时发送，触发 UI 重新渲染
    static let languageChanged = Notification.Name("languageChanged")

    /// 账户已更改通知（v2.1.0）
    /// 当用户切换账户时发送，触发数据刷新
    static let accountChanged = Notification.Name("accountChanged")

    // MARK: - Team-Übersicht

    /// Server-Verbindung des Teams hergestellt, getrennt oder Rolle geändert.
    /// `TeamReportStore` lädt daraufhin neu, `TeamAutoReporter` startet/stoppt.
    static let teamServerChanged = Notification.Name("teamServerChanged")
    static let fleetMonitoringChanged = Notification.Name("fleetMonitoringChanged")

    // MARK: - Window Related

    // MARK: - Error Related

    /// 开机启动设置错误通知
    /// 当设置开机启动失败时发送
    static let launchAtLoginError = Notification.Name("launchAtLoginError")
}

// MARK: - UserInfo Keys

/// 通知 userInfo 字典的键名常量
/// 提供类型安全的 userInfo 键访问
extension Notification {
    /// UserInfo 键名枚举
    enum UserInfoKey {
        /// 账户变更的 Provider 键
        /// 用于 accountChanged 通知，值类型为 ProviderType.rawValue
        static let provider = "provider"
    }
}
