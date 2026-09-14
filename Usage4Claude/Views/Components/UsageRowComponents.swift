//
//  UsageRowComponents.swift
//  Usage4Claude
//
//  Created by Claude Code on 2025-12-18.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI

// MARK: - Usage Ring Helpers

/// Rest des früheren Detailfenster-Ringpakets: Nur das Klemmen auf 0…100
/// wird noch gebraucht (UnifiedLimitRow), alles andere ist mit dem
/// Einzelkonto-Detailfenster verschwunden.
enum UsageRingDisplay {
    static func clampedPercentage(_ percentage: Double) -> Double {
        min(100, max(0, percentage))
    }
}

// MARK: - Mini Progress Icon Component

/// 迷你进度图标（带百分比数字和进度弧，与菜单栏图标风格一致）
struct MiniProgressIcon: View {
    let type: LimitType
    let color: Color
    let percentage: Double
    let size: CGFloat = 22

    var body: some View {
        Canvas { context, canvasSize in
            let lineWidth: CGFloat = 2.2
            let rect = CGRect(origin: .zero, size: canvasSize)
            let fullPath = IconShapePaths.pathForLimitType(type, in: rect)

            // 1. 形状边框（彩色）
            context.stroke(fullPath, with: .color(color), lineWidth: lineWidth)

            // 2. 百分比数字（居中）
            let fontSize = percentage >= 100 ? canvasSize.width * 0.28 : canvasSize.width * 0.38
            let text = Text("\(Int(percentage))")
                .font(.system(size: fontSize, weight: .bold))
                .foregroundColor(color)
            context.draw(text, at: CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2))
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Provider Divider

/// 双 Provider 主窗口中央的柔和竖线，视觉与设置页标签分隔线一致
struct ProviderDivider: View {
    let height: CGFloat

    var body: some View {
        LinearGradient(
            gradient: Gradient(colors: [
                Color.secondary.opacity(0.0),
                Color.secondary.opacity(0.3),
                Color.secondary.opacity(0.3),
                Color.secondary.opacity(0.0)
            ]),
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(width: 1, height: height)
    }
}

// MARK: - Unified Limit Row Component

/// 统一的限制行组件（支持所有 Claude 和 Codex 限制类型）
struct UnifiedLimitRow: View {
    let type: LimitType
    var data: UsageData? = nil
    var codexData: CodexUsageData? = nil
    let showRemainingMode: Bool
    /// 溢出模型行覆盖：提供时，行的百分比/标签/重置时间直接取自这个模型条目，
    /// `type` 仅用于决定外观（圆角方/斜切方形状与配色的槽位）。用于 popover 展示
    /// 超出前两个槽位的第三个及以后的模型（如同时出现 Fable / Opus / Sonnet）。
    var weeklyModelOverride: UsageData.WeeklyModelLimit? = nil
    /// Einfärbung nach Auslastung statt nach Limit-Typ. Das Dashboard nutzt die
    /// vierstufige Skala, damit eine Karte in sich eine Farbsprache spricht;
    /// das klassische Detailfenster behält seine typbezogenen Farben.
    var usesUtilizationTint: Bool = false

    var body: some View {
        Group {
            if isWeeklyModelRow {
                weeklyModelRow
            } else {
                standardRow
            }
        }
        .padding(.vertical, 2)
        .padding(.horizontal, 12)
        .background(Color.gray.opacity(0.1))
        .cornerRadius(8)
    }

    /// 5h / 7d / Codex：图标 + 名称 + 重置时间（或剩余额度）
    private var standardRow: some View {
        HStack(spacing: 8) {
            // 图标（含百分比数字和进度弧）
            MiniProgressIcon(type: type, color: iconColor, percentage: percentageValue ?? 0)

            // 限制类型名称
            Text(limitName)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.9)

            Spacer(minLength: 8)

            // 右侧：重置时间或剩余额度
            // TimelineView 让这行文字自己按分钟粒度刷新，不再依赖外层每秒 objectWillChange
            // 触发整个 popover 重建（displayValue 精度只到分钟，60s 间隔足够）
            TimelineView(.periodic(from: .now, by: 60)) { _ in
                Text(displayValue)
                    .font(.system(size: 12))
                    .fontWeight(.medium)
                    .foregroundColor(isExhausted ? .red : .primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.9)
                    .id(effectiveRemainingMode ? "remaining" : "reset")  // 强制识别为不同视图
                    .transition(.asymmetric(
                        insertion: .move(edge: .top).combined(with: .opacity),
                        removal: .move(edge: .bottom).combined(with: .opacity)
                    ))
            }
        }
    }

    /// Wochen-Modelllimits (Fable / Opus / Sonnet) zeigen nur noch, wie voll sie
    /// sind: ein füllender Balken plus Prozentzahl. Die Reset-Zeit entfällt hier
    /// bewusst — das Fenster ist ohnehin immer die Woche, die Uhrzeit stand nur
    /// im Weg. Die Zeilenhöhe bleibt die der Symbolzeilen, damit die Übersicht
    /// ihre Kartenhöhe weiter vorausrechnen kann.
    private var weeklyModelRow: some View {
        let percentage = UsageRingDisplay.clampedPercentage(percentageValue ?? 0)

        return HStack(spacing: 8) {
            Text(limitName)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: Self.weeklyModelNameWidth, alignment: .leading)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.gray.opacity(0.25))
                    Capsule()
                        .fill(iconColor)
                        .frame(width: max(3, geometry.size.width * CGFloat(percentage) / 100))
                }
            }
            .frame(height: 6)
            .animation(.easeInOut(duration: 0.35), value: percentage)

            Text("\(Int(percentage.rounded()))%")
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundColor(isExhausted ? .red : .primary)
                .frame(width: Self.weeklyModelValueWidth, alignment: .trailing)
        }
        .frame(height: 22)
    }

    // MARK: - Computed Properties

    private static let weeklyModelNameWidth: CGFloat = 96
    private static let weeklyModelValueWidth: CGFloat = 38

    /// Wochen-Modelllimits werden als Balken gezeichnet, alles andere als Symbolzeile.
    private var isWeeklyModelRow: Bool {
        switch type {
        case .fableWeekly, .opusWeekly, .sonnetWeekly: return true
        default: return false
        }
    }

    /// Limit ist ausgeschöpft. Ab hier ist die einzig nützliche Information,
    /// *wann* es wieder freigeschaltet wird — nicht der Reset-Zeitpunkt als Datum.
    private var isExhausted: Bool {
        (percentageValue ?? 0) >= 100
    }

    /// Bei ausgeschöpftem Limit wird die Restzeit erzwungen, sonst gilt der Umschalter.
    private var effectiveRemainingMode: Bool {
        isExhausted || showRemainingMode
    }

    private var limitName: String {
        if let override = weeklyModelOverride {
            return override.modelName ?? weeklyDefaultLabel
        }
        switch type {
        case .fiveHour, .codexPrimary:
            return L.DetailRow.fiveHour
        case .sevenDay, .codexSecondary:
            return L.DetailRow.sevenDay
        case .opusWeekly:
            // Claude 5 时代：每周模型限制按模型名解析，读到对应条目的真实模型名；
            // 无名称时回退到默认的 “Opus Weekly” 文案。
            return data?.weeklyModel(matching: .opusWeekly)?.modelName ?? L.DetailRow.opusWeekly
        case .sonnetWeekly:
            return data?.weeklyModel(matching: .sonnetWeekly)?.modelName ?? L.DetailRow.sonnetWeekly
        case .fableWeekly:
            return data?.weeklyModel(matching: .fableWeekly)?.modelName ?? L.DetailRow.fableWeekly
        case .extraUsage, .codexExtraUsage:
            return L.DetailRow.extraUsage
        }
    }

    /// 溢出模型行（weeklyModelOverride）在缺少模型名时的回退标签，按外观槽位类型取默认文案
    private var weeklyDefaultLabel: String {
        switch type {
        case .fableWeekly: return L.DetailRow.fableWeekly
        case .sonnetWeekly: return L.DetailRow.sonnetWeekly
        default: return L.DetailRow.opusWeekly
        }
    }

    private var iconColor: Color {
        if usesUtilizationTint {
            return DashboardPalette.fill(percentageValue ?? 0, provider: type.provider)
        }
        switch type {
        case .fiveHour:
            return .green
        case .sevenDay:
            return .purple
        case .opusWeekly:
            return .orange
        case .sonnetWeekly:
            return .blue
        case .fableWeekly:
            return .cyan
        case .extraUsage:
            return .pink
        case .codexPrimary:
            return Color(red: 45/255.0, green: 212/255.0, blue: 191/255.0)   // #2DD4BF
        case .codexSecondary:
            return Color(red: 96/255.0, green: 165/255.0, blue: 250/255.0)   // #60A5FA
        case .codexExtraUsage:
            return Color(red: 245/255.0, green: 158/255.0, blue: 11/255.0)    // #F59E0B
        }
    }

    private var percentageValue: Double? {
        if let override = weeklyModelOverride {
            return override.limit.percentage
        }
        switch type {
        case .fiveHour:       return data?.fiveHour?.percentage
        case .sevenDay:       return data?.sevenDay?.percentage
        case .opusWeekly:     return data?.weeklyModel(matching: .opusWeekly)?.limit.percentage
        case .sonnetWeekly:   return data?.weeklyModel(matching: .sonnetWeekly)?.limit.percentage
        case .fableWeekly:    return data?.weeklyModel(matching: .fableWeekly)?.limit.percentage
        case .extraUsage:     return data?.extraUsage?.percentage
        case .codexPrimary:   return codexData?.primary?.percentage
        case .codexSecondary: return codexData?.secondary?.percentage
        case .codexExtraUsage: return codexData?.extraUsage?.percentage
        }
    }

    private var displayValue: String {
        if let override = weeklyModelOverride {
            return effectiveRemainingMode
                ? override.limit.formattedCompactRemaining
                : override.limit.formattedCompactResetDate
        }
        switch type {
        case .fiveHour:
            guard let fiveHour = data?.fiveHour else { return "-" }
            return effectiveRemainingMode ? fiveHour.formattedCompactRemaining : detailCompactResetTime(fiveHour)

        case .sevenDay:
            guard let sevenDay = data?.sevenDay else { return "-" }
            return effectiveRemainingMode ? sevenDay.formattedCompactRemaining : sevenDay.formattedCompactResetDate

        case .opusWeekly:
            guard let limit = data?.weeklyModel(matching: .opusWeekly)?.limit else { return "-" }
            return effectiveRemainingMode ? limit.formattedCompactRemaining : limit.formattedCompactResetDate

        case .sonnetWeekly:
            guard let limit = data?.weeklyModel(matching: .sonnetWeekly)?.limit else { return "-" }
            return effectiveRemainingMode ? limit.formattedCompactRemaining : limit.formattedCompactResetDate

        case .fableWeekly:
            guard let limit = data?.weeklyModel(matching: .fableWeekly)?.limit else { return "-" }
            return effectiveRemainingMode ? limit.formattedCompactRemaining : limit.formattedCompactResetDate

        case .extraUsage:
            guard let extra = data?.extraUsage else { return "-" }
            return effectiveRemainingMode ? extra.formattedRemainingAmount : extra.formattedCompactAmount

        case .codexPrimary:
            guard let limitData = codexData?.primary?.asUsageLimitData() else { return "-" }
            return effectiveRemainingMode ? limitData.formattedCompactRemaining : detailCompactResetTime(limitData)

        case .codexSecondary:
            guard let limitData = codexData?.secondary?.asUsageLimitData() else { return "-" }
            return effectiveRemainingMode ? limitData.formattedCompactRemainingWithMinutes : limitData.formattedCompactResetDateWithMinutes

        case .codexExtraUsage:
            guard let extra = codexData?.extraUsage else { return "-" }
            return effectiveRemainingMode ? extra.formattedDetailRemainingAmount : extra.formattedDetailCompactAmount
        }
    }

    private func detailCompactResetTime(_ limitData: UsageData.LimitData) -> String {
        guard let resetsAt = limitData.resetsAt else {
            return "-"
        }

        var calendar = Calendar.current
        calendar.locale = UserSettings.shared.appLocale
        let timeString = TimeFormatHelper.formatTimeOnly(resetsAt)

        if calendar.isDateInToday(resetsAt) {
            return "\(L.DetailRow.today) \(timeString)"
        }
        if calendar.isDateInTomorrow(resetsAt) {
            return "\(L.UsageData.tomorrow) \(timeString)"
        }
        return TimeFormatHelper.formatDateTime(resetsAt, dateTemplate: "Md")
    }
}
