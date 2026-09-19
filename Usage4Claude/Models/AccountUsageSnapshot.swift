//
//  AccountUsageSnapshot.swift
//  Usage4Claude
//
//  Dashboard（多账户总览）的单账户状态容器。
//  经典 popover 一次只看当前账户，Dashboard 则为每个账户各拉一次用量，
//  把「数据 / 错误 / 加载中 / 更新时间」打包在一起，卡片视图直接渲染，
//  不用在视图层再去拼多个并行字典。
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation

/// 单个账户在 Dashboard 中的用量快照
struct AccountUsageSnapshot: Identifiable {
    /// 快照所属账户（含 provider、displayName 等展示信息）
    let account: Account
    /// Claude 用量数据（provider == .claude 时有效）
    var usageData: UsageData?
    /// Codex 用量数据（provider == .codex 时有效）
    var codexUsageData: CodexUsageData?
    /// 本账户最近一次拉取的错误描述，nil 表示无错误
    var errorMessage: String?
    /// Der letzte Fehler war eine abgelaufene oder widerrufene Anmeldung: Ein
    /// erneuter Abruf hilft nicht, nur eine Neuanmeldung. Die Karte zeigt dann
    /// „Neu anmelden" statt „Erneut versuchen".
    var needsReauth: Bool = false
    /// 是否正在拉取
    var isLoading: Bool = false
    /// 最近一次成功拉取的时间
    var updatedAt: Date?

    var id: UUID { account.id }
    var provider: ProviderType { account.provider }

    /// 是否已有可展示的数据
    var hasData: Bool {
        switch provider {
        case .claude: return usageData != nil
        case .codex:  return codexUsageData != nil
        }
    }

    // MARK: - 排序 / 高亮用的派生值

    /// 本账户所有限制里最紧张的一项的使用率（0-100）。
    /// Dashboard 用它排序、并标出"还最空的账户"——也就是用户要的
    /// "welcher Claude ist gerade am Ende"。nil 表示尚无数据。
    var peakUtilization: Double? { criticalLimit?.percentage }

    /// Auslastung des **kontoweiten** Wochenfensters (0-100). Treibt die
    /// Wasserstände oben in der Übersicht und die Punktreihe in der Menüleiste —
    /// bewusst ohne das 5-Stunden-Fenster, das sich viel schneller auffüllt.
    ///
    /// Claude: ausschließlich das 7-Tage-Fenster (`seven_day` / `weekly_all`).
    /// Codex: das secondary-Fenster (Wochen-Äquivalent), sonst als Näherung `peakUtilization`.
    ///
    /// Die Modell-Wochenlimits (Fable, Opus, Sonnet) stecken hier absichtlich
    /// **nicht** drin: Ein aufgebrauchtes Fable-Kontingent sperrt das Konto
    /// nicht, es sperrt genau ein Modell — über Sonnet und Opus läuft die Woche
    /// weiter. Solange sie mitgezählt wurden, zeigte die Übersicht ein Konto rot
    /// und „Woche gesperrt", obwohl praktisch die ganze Woche noch offen war.
    /// Wer den Modellstand braucht, liest `weeklyModelPeakUtilization`.
    ///
    /// nil, solange keine Daten vorliegen bzw. es kein Wochenfenster gibt.
    var weeklyPeakUtilization: Double? {
        switch provider {
        case .claude:
            return usageData?.sevenDay?.percentage
        case .codex:
            guard codexUsageData != nil else { return nil }
            if let secondary = codexUsageData?.secondary { return secondary.percentage }
            return peakUtilization
        }
    }

    /// Das vollste **Modell**-Wochenkontingent (Fable/Opus/Sonnet), 0-100.
    /// Bewusst getrennt von `weeklyPeakUtilization`: Es beantwortet „welches
    /// Modell ist durch", nicht „ist das Konto zu". nil ohne Daten oder ohne
    /// Modelllimits (Codex kennt keine).
    var weeklyModelPeakUtilization: Double? {
        guard provider == .claude else { return nil }
        return usageData?.weeklyModels.map { $0.limit.percentage }.max()
    }

    /// Schwelle, ab der ein Konto als "praktisch aufgebraucht" gilt: In der
    /// Übersicht wird es ausgegraut und (im Verfügbarkeits-Sortiermodus) ans
    /// Ende geschoben, weil man es bis zum Reset ohnehin nicht mehr nutzt.
    static let nearExhaustionThreshold: Double = 96

    /// True, wenn das knappste Limit dieses Kontos nahezu erschöpft ist.
    /// Erst ab vorhandenen Daten aussagekräftig (sonst false).
    var isNearExhausted: Bool {
        guard let peak = peakUtilization else { return false }
        return peak >= Self.nearExhaustionThreshold
    }

    /// True, wenn das **Sitzungsfenster** (5 Stunden bzw. Codex primary) praktisch
    /// aufgebraucht ist. Trägt in der Übersicht den roten Ring um den Ampelpunkt,
    /// während die Füllung weiterhin die Wochenlage zeigt.
    /// Bewusst dieselbe Schwelle wie `isNearExhausted` (`nearExhaustionThreshold`),
    /// damit die App nur einen Begriff von „praktisch aufgebraucht" kennt.
    /// Ohne Daten (kein Sitzungslimit geliefert) false.
    var sessionExhausted: Bool {
        guard let session = sessionLimit else { return false }
        return session.percentage >= Self.nearExhaustionThreshold
    }

    /// 圆环要展示的一项限制，标签已解析好
    struct RingLimit {
        let type: LimitType
        let percentage: Double
        let resetsAt: Date?
        /// 圆环中心的短标签（"5h" / "7d" / Modellname …），damit klar ist,
        /// worauf sich die Prozentzahl bezieht
        let label: String

        var isExhausted: Bool { percentage >= 100 }
    }

    /// 本账户所有限制的清单（顺序无关，仅用于挑选与排序）
    private var allLimits: [RingLimit] {
        switch provider {
        case .claude:
            guard let data = usageData else { return [] }
            var result: [RingLimit] = []
            if let fiveHour = data.fiveHour {
                result.append(RingLimit(type: .fiveHour, percentage: fiveHour.percentage,
                                        resetsAt: fiveHour.resetsAt, label: L.Usage.fiveHourLimitShort))
            }
            if let sevenDay = data.sevenDay {
                result.append(RingLimit(type: .sevenDay, percentage: sevenDay.percentage,
                                        resetsAt: sevenDay.resetsAt, label: L.Usage.sevenDayLimitShort))
            }
            for (index, model) in data.weeklyModels.enumerated() {
                // 类型按模型名解析（Fable/Opus/Sonnet），决定配色与形状；
                // 标签优先用 API 返回的真实模型名，缺失时按类型回退默认短标签
                let type = LimitType.weeklyType(forModelName: model.modelName, slot: index)
                let fallback: String
                switch type {
                case .fableWeekly: fallback = L.Dashboard.ringFable
                case .sonnetWeekly: fallback = L.Dashboard.ringSonnet
                default: fallback = L.Dashboard.ringOpus
                }
                result.append(RingLimit(type: type, percentage: model.limit.percentage,
                                        resetsAt: model.limit.resetsAt, label: model.modelName ?? fallback))
            }
            if let extra = data.extraUsage, extra.enabled, let percentage = extra.percentage {
                result.append(RingLimit(type: .extraUsage, percentage: percentage,
                                        resetsAt: nil, label: L.Dashboard.ringExtra))
            }
            return result

        case .codex:
            guard let codex = codexUsageData else { return [] }
            var result: [RingLimit] = []
            if let primary = codex.primary {
                result.append(RingLimit(type: .codexPrimary, percentage: primary.percentage,
                                        resetsAt: primary.resetsAt, label: L.Usage.fiveHourLimitShort))
            }
            if let secondary = codex.secondary {
                result.append(RingLimit(type: .codexSecondary, percentage: secondary.percentage,
                                        resetsAt: secondary.resetsAt, label: L.Usage.sevenDayLimitShort))
            }
            if let extra = codex.extraUsage, let percentage = extra.percentage {
                result.append(RingLimit(type: .codexExtraUsage, percentage: percentage,
                                        resetsAt: nil, label: L.Dashboard.ringExtra))
            }
            return result
        }
    }

    /// Der große Ring zeigt das **engste** Limit, nicht fix das 5-Stunden-Fenster.
    /// Sonst steht auf der Karte „0 %", während in Wahrheit das Wochenlimit voll ist —
    /// genau die Verwechslung, die die Übersicht verhindern soll.
    var criticalLimit: RingLimit? {
        allLimits.max { $0.percentage < $1.percentage }
    }

    /// Das schnell laufende Sitzungsfenster (5 Stunden bzw. Codex primary).
    /// Füllt die Wasserstandsanzeige auf der Karte.
    var sessionLimit: RingLimit? {
        let type: LimitType = provider == .claude ? .fiveHour : .codexPrimary
        return allLimits.first { $0.type == type }
    }

    /// Das Wochenfenster — die Zahl, an der laut Nutzer "eigentlich alles hängt".
    var weeklyLimit: RingLimit? {
        let type: LimitType = provider == .claude ? .sevenDay : .codexSecondary
        return allLimits.first { $0.type == type }
    }
}

// MARK: - Anzeigereihenfolge

extension AccountUsageSnapshot {

    /// Die **eine** Stelle, an der festgelegt ist, in welcher Reihenfolge Konten
    /// angezeigt werden — Übersicht wie Menüleisten-Punktreihe.
    ///
    /// Vorher lag die Regel als privates `orderedSnapshots` in `DashboardView`,
    /// während `MenuBarAccountDots` stumpf die Roh-Reihenfolge nahm: Übersicht und
    /// Menüleiste zeigten dieselben Konten in unterschiedlicher Folge. Wer die
    /// Sortierung ändern will, ändert sie ab jetzt hier — `DashboardView` und
    /// `MenuBarAccountDots` rufen beide nur noch diesen Helfer auf.
    ///
    /// - Parameters:
    ///   - snapshots: Roh-Reihenfolge, wie sie der `DashboardRefreshManager` liefert
    ///     (Hinzufüge-Reihenfolge, Claude vor Codex)
    ///   - mode: Sortierwunsch des Nutzers
    /// - Returns: Die Konten in Anzeigereihenfolge — bei `.availability` das freieste
    ///   zuerst, das vollste zuletzt.
    ///   - groupByProvider: Konten desselben Anbieters zusammenhalten (Claude
    ///     zuerst, dann Codex). Die Sortierung greift dann innerhalb jeder
    ///     Gruppe — genau das, was die zweibahnige Übersicht zeigt.
    static func ordered(
        _ snapshots: [AccountUsageSnapshot],
        mode: DashboardSortMode,
        groupByProvider: Bool = false
    ) -> [AccountUsageSnapshot] {
        guard groupByProvider else { return sorted(snapshots, mode: mode) }
        return grouped(snapshots, mode: mode).flatMap { $0.snapshots }
    }

    /// Dieselben Konten, aber nach Anbieter getrennt: Claude zuerst, dann Codex,
    /// jede Gruppe für sich nach `mode` sortiert. Leere Gruppen fallen weg — wer
    /// nur einen Anbieter nutzt, bekommt genau eine.
    ///
    /// Die Übersicht rendert daraus ihre zwei Bahnen, die Menüleisten-Punktreihe
    /// hängt dieselben Gruppen einfach hintereinander. Beide teilen sich damit
    /// weiterhin *eine* Reihenfolge-Regel.
    static func grouped(_ snapshots: [AccountUsageSnapshot], mode: DashboardSortMode) -> [ProviderGroup] {
        ProviderType.allCases.compactMap { provider in
            let members = sorted(snapshots.filter { $0.provider == provider }, mode: mode)
            guard !members.isEmpty else { return nil }
            return ProviderGroup(provider: provider, snapshots: members)
        }
    }

    private static func sorted(_ snapshots: [AccountUsageSnapshot], mode: DashboardSortMode) -> [AccountUsageSnapshot] {
        switch mode {
        case .accountOrder:
            // Layout-Stabilität geht vor: die Karten sollen nicht herumspringen
            return snapshots
        case .availability:
            return snapshots.sorted { lhs, rhs in
                // Konten ohne Daten ans Ende, damit sie nicht den Platz
                // „am freiesten" besetzen
                let left = lhs.peakUtilization ?? .greatestFiniteMagnitude
                let right = rhs.peakUtilization ?? .greatestFiniteMagnitude
                if left == right { return lhs.account.createdAt < rhs.account.createdAt }
                return left < right
            }
        }
    }
}

// MARK: - Anbieter-Bahn

/// Eine Bahn der Übersicht: alle Konten eines Anbieters, schon sortiert.
/// `ProviderType` ist der Schlüssel — je Anbieter gibt es genau eine Bahn.
struct ProviderGroup: Identifiable {
    let provider: ProviderType
    let snapshots: [AccountUsageSnapshot]

    var id: ProviderType { provider }
}
