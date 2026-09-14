//
//  DashboardView.swift
//  Usage4Claude
//
//  多账户总览：一屏之内并排显示所有已添加的 Claude / Codex 账户，
//  不再需要先切账户才能看另一个账号的余量。
//
//  Ein Klick auf eine Karte tut bewusst nichts mehr: Seit die Menüleiste alle
//  Konten zeigt, hatte „aktives Konto" keine sichtbare Wirkung mehr — der Klick
//  verstellte also etwas, das niemand sehen konnte. Umstellen geht weiterhin
//  über das Rechtsklick-Menü der Karte.
//
//  同一个视图既用于菜单栏 popover，也用于独立的总览窗口（isStandaloneWindow）。
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI

// MARK: - 尺寸计算

/// Dashboard 的布局常量与高度推算。
/// popover 依赖 `NSHostingController.sizingOptions = .preferredContentSize` 取内容
/// 理想尺寸，因此这里必须给出确定的高度——把卡片高度按行数算出来，而不是交给
/// 会无限伸展的 ScrollView 自行决定。
enum DashboardMetrics {
    static let cardWidth: CGFloat = 372
    static let ringSlotWidth: CGFloat = 68
    /// Höhe des Kopfblocks einer Karte (Stundenlimit | Wochenlimit).
    /// Label (13) + Wasserstand (ringSlotWidth) + Reset-Zeile (17) + Abstände.
    /// `AccountUsageCard.headline` pinnt sich auf genau diesen Wert.
    static let headlineHeight: CGFloat = 104
    static let cardSpacing: CGFloat = 10
    static let outerPadding: CGFloat = 12
    static let headerHeight: CGFloat = 36
    static let footerHeight: CGFloat = 24
    /// 网格区域的最大高度，超过则内部滚动
    static let maxGridHeight: CGFloat = 520

    private static let rowHeight: CGFloat = 26
    private static let rowSpacing: CGFloat = 4
    // Innenabstand oben/unten + Kopfzeile (Name + Email) + Abstände + Headline-Block
    private static let cardChromeHeight: CGFloat = 12 * 2 + 30 + 10 + 10

    /// 卡片里要展示的限制行：显示所有有数据的类型（智能规则）。
    static func activeTypes(for snapshot: AccountUsageSnapshot) -> [LimitType] {
        switch snapshot.provider {
        case .claude:
            guard let data = snapshot.usageData else { return [] }
            return UserSettings.shared.getActiveDisplayTypes(usageData: data)
                .filter { $0.provider == .claude }
        case .codex:
            guard let codex = snapshot.codexUsageData else { return [] }
            return UserSettings.shared.getActiveDisplayTypes(usageData: nil, codexUsageData: codex)
                .filter { $0.provider == .codex }
        }
    }

    /// 第三个及以后的每周模型限制（如同时出现 Fable + Opus + Sonnet），
    /// 避免 Dashboard 少显示指标。
    static func overflowWeeklyModels(for snapshot: AccountUsageSnapshot) -> [(offset: Int, element: UsageData.WeeklyModelLimit)] {
        guard snapshot.provider == .claude,
              let data = snapshot.usageData else { return [] }
        return Array(Array(data.weeklyModels.enumerated()).dropFirst(2))
    }

    static func cardHeight(for snapshot: AccountUsageSnapshot) -> CGFloat {
        guard snapshot.hasData else {
            // 错误 / 加载占位：两行文字 + 按钮的高度，取一个足够的固定值
            return cardChromeHeight + (snapshot.errorMessage != nil ? 86 : ringSlotWidth)
        }
        // Sitzungs- und Wochenfenster stehen im Headline-Block, nicht in den Zeilen
        let promoted: Set<LimitType> = snapshot.provider == .claude
            ? [.fiveHour, .sevenDay]
            : [.codexPrimary, .codexSecondary]
        let rowCount = activeTypes(for: snapshot).filter { !promoted.contains($0) }.count
            + overflowWeeklyModels(for: snapshot).count
        var rowsHeight = CGFloat(rowCount) * rowHeight + CGFloat(max(0, rowCount - 1)) * rowSpacing
        if rowCount > 0 { rowsHeight += 10 }
        if snapshot.errorMessage != nil {
            rowsHeight += 16  // Hinweiszeile "Daten möglicherweise veraltet"
        }
        return cardChromeHeight + headlineHeight + rowsHeight
    }

    static func gridHeight(for snapshots: [AccountUsageSnapshot], columns: Int) -> CGFloat {
        guard !snapshots.isEmpty else { return 120 }
        let columns = max(1, columns)
        var total: CGFloat = 0
        var index = 0
        while index < snapshots.count {
            let end = min(index + columns, snapshots.count)
            let rowMax = snapshots[index..<end].map { cardHeight(for: $0) }.max() ?? ringSlotWidth
            total += rowMax
            index = end
            if index < snapshots.count { total += cardSpacing }
        }
        return total
    }

    /// Spaltenzahl der Übersicht — nie mehr Spalten als Karten.
    /// Gilt für das popover (feste Breite) und für die Startbreite des Fensters.
    static func columnCount(for snapshotCount: Int, setting: Int) -> Int {
        min(max(1, setting), max(1, snapshotCount))
    }

    /// Spaltenzahl aus der tatsächlich verfügbaren Breite: so viele Karten, wie
    /// nebeneinander passen. Nur das eigene Fenster rechnet so — es ist frei
    /// skalierbar, das popover dagegen hat eine feste Breite.
    /// Die Karten behalten ihre feste Breite, sie brechen nur um.
    static func columnCount(fittingWidth width: CGFloat, snapshotCount: Int) -> Int {
        let usable = width - outerPadding * 2 + cardSpacing
        // Halber Punkt Toleranz: Die Spaltenwahl im Menü zieht das Fenster auf
        // *exakt* die Breite, die n Spalten brauchen. Meldet SwiftUI davon durch
        // Rundung 777,999 statt 778, fiele ohne Toleranz eine ganze Spalte weg
        // und der Menüeintrag sähe kaputt aus.
        let fitting = Int(floor((usable + 0.5) / (cardWidth + cardSpacing)))
        return min(max(1, fitting), max(1, snapshotCount))
    }

    static func width(columns: Int) -> CGFloat {
        let columns = max(1, columns)
        return CGFloat(columns) * cardWidth
            + CGFloat(columns - 1) * cardSpacing
            + outerPadding * 2
    }
}

/// Meldet die Breite, die dem Übersicht-Inhalt tatsächlich zur Verfügung steht.
/// Nur das eigene Fenster liest sie aus (responsives Gitter).
private struct DashboardWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Dashboard

struct DashboardView: View {
    @ObservedObject var manager: DashboardRefreshManager
    /// 菜单操作回调
    var onMenuAction: ((MenuAction) -> Void)?
    /// 独立窗口模式：不再提供"在窗口中打开"入口，也不需要退出按钮之外的窗口管理
    var isStandaloneWindow: Bool = false

    @ObservedObject private var settings = UserSettings.shared
    @StateObject private var localization = LocalizationManager.shared
    /// Konten-Gitter oder Team-Ansicht — geteilt zwischen Popover und Fenster
    @ObservedObject private var mode = DashboardMode.shared
    /// „Bleib wach" im Kopf — beobachtet, damit Schalter und Maskottchen
    /// sofort mitziehen, egal wo umgeschaltet wurde.
    @ObservedObject private var sleepGuard = SleepGuard.shared
    /// Systemweite Schlaf-Einstellungen (pmset): Steht der Mac ohnehin auf
    /// „nie schlafen", bekommt der Wach-Schalter eine Markierung und einen
    /// erklärenden Tooltip, statt Wirkung vorzutäuschen.
    @ObservedObject private var systemSleep = SystemSleepInfo.shared

    /// Gemessene Inhaltsbreite des eigenen Fensters (0 = noch nicht gemessen).
    /// Im popover bleibt sie 0, dort gilt weiterhin die Spaltenwahl.
    @State private var measuredWidth: CGFloat = 0

    /// 与详情窗口共用同一个开关，两处的"剩余 / 已用"显示保持一致
    @AppStorage("showRemainingMode") private var savedRemainingMode = false
    @State private var showRemainingMode = UserDefaults.standard.bool(forKey: "showRemainingMode")
    /// Info-Popover zu „Claude Always On" (das ⓘ neben dem Schalter)
    @State private var showAwakeInfo = false

    // MARK: - Derived data

    /// Anzeigereihenfolge — dieselbe Regel wie die Menüleisten-Punktreihe.
    /// Sie steht bewusst nur an *einer* Stelle: Solange die Übersicht hier eine
    /// eigene Kopie hielt, konnten Karten und Punkte auseinanderlaufen.
    private var orderedSnapshots: [AccountUsageSnapshot] {
        AccountUsageSnapshot.ordered(manager.snapshots, mode: settings.dashboardSortMode)
    }

    /// 当前最空闲的账户 id：只有存在至少两个有数据的账户时才标注，
    /// 否则这个徽章没有比较意义。
    private var mostFreeAccountId: UUID? {
        let withData = manager.snapshots.filter { $0.peakUtilization != nil }
        guard withData.count >= 2 else { return nil }
        return withData.min {
            ($0.peakUtilization ?? 100) < ($1.peakUtilization ?? 100)
        }?.id
    }

    /// Spaltenwahl aus den Einstellungen. Sie bestimmt das popover vollständig
    /// und beim Fenster nur noch die Startbreite (danach entscheidet die Größe).
    private var settingColumnCount: Int {
        DashboardMetrics.columnCount(for: orderedSnapshots.count, setting: settings.dashboardColumns)
    }

    /// Spalten des Gitters. Im eigenen Fenster fließt der Inhalt in die vorhandene
    /// Breite (schmal ziehen → eine Spalte, breit ziehen → mehr Spalten), im
    /// popover bleibt es bei der eingestellten Spaltenzahl.
    private var columnCount: Int {
        guard isStandaloneWindow, measuredWidth > 0 else { return settingColumnCount }
        return DashboardMetrics.columnCount(
            fittingWidth: measuredWidth,
            snapshotCount: orderedSnapshots.count
        )
    }

    private var gridColumns: [GridItem] {
        Array(
            repeating: GridItem(.fixed(DashboardMetrics.cardWidth), spacing: DashboardMetrics.cardSpacing, alignment: .top),
            count: columnCount
        )
    }

    private var gridHeight: CGFloat {
        min(
            DashboardMetrics.gridHeight(for: orderedSnapshots, columns: columnCount),
            DashboardMetrics.maxGridHeight
        )
    }

    /// Wunschbreite des Inhalts (= exakte Breite im popover, Startbreite des Fensters).
    /// Bewusst an der Einstellung festgemacht und nicht an `columnCount`: sonst
    /// hinge die Idealbreite an der gemessenen Breite und beide würden sich
    /// gegenseitig nachziehen.
    private var contentWidth: CGFloat {
        DashboardMetrics.width(columns: settingColumnCount)
    }

    /// Untergrenze: im eigenen Fenster genau eine Spalte, damit man es wirklich
    /// schmal ziehen kann; im popover die volle Inhaltsbreite.
    private var minContentWidth: CGFloat {
        isStandaloneWindow ? DashboardMetrics.width(columns: 1) : contentWidth
    }

    /// Im eigenen Fenster darf der Inhalt mitwachsen, im popover nicht:
    /// dort liefert die Idealgröße die feste popover-Größe.
    private var stretchWidth: CGFloat? {
        isStandaloneWindow ? .infinity : contentWidth
    }

    private var stretchHeight: CGFloat? {
        isStandaloneWindow ? .infinity : nil
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            header
            mascotRow
            Divider()
            if mode.showsTeam {
                teamContent
            } else {
                grid
            }
            Divider()
            footer
        }
        // popover: min = ideal = max, also exakt so breit wie früher.
        // Eigenes Fenster: Ideal bleibt die Inhaltsbreite (davon leitet sich die
        // Startgröße ab), nach unten ist eine Spalte erlaubt, nach oben darf der
        // Inhalt beliebig mitwachsen.
        .frame(
            minWidth: minContentWidth,
            idealWidth: contentWidth,
            maxWidth: stretchWidth,
            maxHeight: stretchHeight
        )
        .background(widthReader)
        .onPreferenceChange(DashboardWidthKey.self) { width in
            measuredWidth = width
        }
        .id(localization.updateTrigger)  // 语言变化时重新创建视图
        .onAppear {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                showRemainingMode = savedRemainingMode
            }
            manager.activate()
            // Drosselt sich selbst auf einen Lauf pro Minute.
            systemSleep.refresh()
            // Wurde `disablesleep` zwischenzeitlich im Terminal umgestellt,
            // zieht der Schalter jetzt nach — die Anzeige soll nie etwas
            // anderes behaupten als das System tut.
            sleepGuard.adoptSystemStateIfNeeded()
        }
        .onDisappear {
            manager.deactivate()
        }
        .onChange(of: showRemainingMode) { newValue in
            savedRemainingMode = newValue
        }
    }

    // MARK: - Header

    /// Eine Dichtestufe der Kopfzeile. Von oben nach unten wird gespart:
    /// erst schrumpfen die Wasserstände, dann fällt die Beschriftung des
    /// Wach-Schalters weg, dann der Konto-Zähler, zuletzt der Titel.
    private struct HeaderDensity {
        let gauge: CGFloat
        let showsCount: Bool
        let showsTitle: Bool
        let showsSleepLabel: Bool
    }

    /// Die Stufen in der Reihenfolge, in der `ViewThatFits` sie durchprobiert —
    /// großzügig zuerst. Bewusst keine eigene Breitenrechnung: Titel und
    /// Schalterbeschriftung sind übersetzt und in jeder Sprache anders breit,
    /// eine Formel dafür wäre in genau einer Sprache richtig. SwiftUI misst
    /// stattdessen selbst und nimmt die erste Stufe, die wirklich passt.
    private static let headerDensities: [HeaderDensity] = [
        HeaderDensity(gauge: 18, showsCount: true,  showsTitle: true,  showsSleepLabel: true),
        HeaderDensity(gauge: 16, showsCount: true,  showsTitle: true,  showsSleepLabel: true),
        HeaderDensity(gauge: 15, showsCount: true,  showsTitle: true,  showsSleepLabel: false),
        HeaderDensity(gauge: 13, showsCount: false, showsTitle: true,  showsSleepLabel: false),
        HeaderDensity(gauge: 11, showsCount: false, showsTitle: true,  showsSleepLabel: false),
        HeaderDensity(gauge: 11, showsCount: false, showsTitle: false, showsSleepLabel: false)
    ]

    /// Kopfzeile mit den Wasserständen je Konto. Sie sind aus der Statuszeile
    /// hier hoch gewandert — dadurch gehört die Zeile darunter komplett der
    /// Claudie-Parade, die vorher nur rechts am Rand Platz hatte.
    private var header: some View {
        ViewThatFits(in: .horizontal) {
            headerRow(Self.headerDensities[0])
            headerRow(Self.headerDensities[1])
            headerRow(Self.headerDensities[2])
            headerRow(Self.headerDensities[3])
            headerRow(Self.headerDensities[4])
            headerRow(Self.headerDensities[5])
        }
        .padding(.horizontal, DashboardMetrics.outerPadding)
        .frame(height: DashboardMetrics.headerHeight)
    }

    private func headerRow(_ density: HeaderDensity) -> some View {
        HStack(spacing: 8) {
            if let icon = ImageHelper.createAppIcon(size: 18) {
                Image(nsImage: icon).resizable().frame(width: 18, height: 18)
            }

            if density.showsTitle {
                Text(L.Dashboard.title)
                    .font(.headline)
                    .lineLimit(1)
                    // Ohne feste Größe würde der Titel bei Platzmangel einfach
                    // abgeschnitten — und damit läge „passt" vor, obwohl die
                    // Zeile längst überläuft. So scheitert die Stufe ehrlich
                    // und `ViewThatFits` geht eine Stufe enger.
                    .fixedSize()
            }

            if density.showsCount {
                Text("\(orderedSnapshots.count)")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                    .fixedSize()
            }

            accountGauges(diameter: density.gauge)

            Spacer(minLength: 8)

            // Etwas enger als der Rest des Kopfes: Der beschriftete
            // Wach-Schalter braucht den Platz, und die Symbolknöpfe haben in
            // ihren 20-pt-Feldern ohnehin Luft.
            HStack(spacing: 6) {
                stayAwakeToggle(showsLabel: density.showsSleepLabel)
                stayAwakeInfoButton
                teamToggle
                // Der Reihenfolge-/Spalten-Regler wohnt bei den Karten, die er
                // ordnet (siehe `grid`) — nicht mehr hier oben rechts.
                actionMenu
            }
            .fixedSize()
        }
    }

    /// Ein Wasserstand je Konto, in derselben Reihenfolge wie die Karten:
    /// Pegel = Wochenfenster, roter Ring außen = Sitzung aufgebraucht.
    /// Ohne Konten (Leerzustand) bleibt die Reihe weg.
    @ViewBuilder
    private func accountGauges(diameter: CGFloat) -> some View {
        if !orderedSnapshots.isEmpty {
            HStack(spacing: MiniGaugeMetrics.spacing) {
                ForEach(orderedSnapshots) { snapshot in
                    MiniWaterGauge(
                        weeklyUtilization: snapshot.weeklyPeakUtilization,
                        sessionExhausted: snapshot.sessionExhausted,
                        diameter: diameter,
                        provider: snapshot.provider
                    )
                    .help(gaugeHelp(for: snapshot))
                }
            }
            .fixedSize()
        }
    }

    /// Der Laufsteg unter dem Kopf. Früher teilte sich die Zeile die Parade mit
    /// der Punktreihe und blieb auf 300 pt beschränkt — seit die Pegel oben in
    /// der Kopfzeile sitzen, laufen die Maskottchen über die volle Breite.
    ///
    /// Die Besetzung folgt den Konten: ein Claudie je Claude-Konto, ein blaues
    /// Codex-Pet je Codex-Konto, und nie mehr Läufer gleichzeitig als Konten.
    /// Als Breite bekommt die Parade die Wunschbreite aus der Spaltenwahl, nicht
    /// die live gemessene — jede Breitenänderung mischt die Reihe neu, und das
    /// soll beim Ziehen am Fenster nicht passieren (siehe `MascotParadeTiming`).
    private var mascotRow: some View {
        AwakeMascotView(
            roster: MascotRoster(
                claudeCount: settings.accounts.count,
                codexCount: settings.codexAccounts.count
            ),
            referenceWidth: contentWidth - DashboardMetrics.outerPadding * 2
        )
        .padding(.horizontal, DashboardMetrics.outerPadding)
        .padding(.top, 2)
        .padding(.bottom, 4)
    }

    /// Misst die verfügbare Breite für das responsive Gitter. Nur im eigenen
    /// Fenster aktiv: das popover nimmt seine Größe aus der Idealbreite des
    /// Inhalts, dort hätte eine zweite Breitenquelle nichts zu suchen.
    @ViewBuilder
    private var widthReader: some View {
        if isStandaloneWindow {
            GeometryReader { proxy in
                Color.clear.preference(key: DashboardWidthKey.self, value: proxy.size.width)
            }
        }
    }

    // MARK: - Wach halten

    /// Der EINE Wach-Schalter direkt im Kopf: „Bleib wach" hält Bildschirm UND
    /// Mac wach — früher zwei getrennte Schalter („Bildschirm an" / „Always
    /// On"), aber in der Praxis wollte niemand nur eines von beidem.
    ///
    /// Symbol *und* die kurze Beschriftung sind eine gemeinsame Schaltfläche.
    /// Aktiv = gefüllter Blitz in Akzentfarbe auf getönter Fläche,
    /// inaktiv = Umriss in Grau. Der Zustand ist damit ohne Häkchen und ohne
    /// Tooltip zu erkennen.
    ///
    /// In engen Kopfzeilen fällt die Beschriftung weg (`showsLabel: false`) —
    /// „Claude Always On" ist der längste Text der Zeile, und der Blitz allein
    /// sagt dasselbe. Der Tooltip nennt den Namen weiterhin.
    ///
    /// Der kleine Punkt oben rechts erscheint, wenn das System per
    /// `pmset disablesleep 1` nie schläft, OBWOHL der Schalter aus ist — dann
    /// hat der Benutzer das selbst eingestellt und der Schalter hätte nichts
    /// mehr beizutragen. Ist der Schalter an, ist `SleepDisabled 1` dagegen
    /// schlicht die eigene Deckel-Stufe und kein Grund für eine Markierung.
    private func stayAwakeToggle(showsLabel: Bool) -> some View {
        let isOn = sleepGuard.isAwake
        let redundant = systemSleep.sleepDisabled == true && !isOn
        return Button(action: { sleepGuard.toggleAwake() }) {
            HStack(spacing: 3) {
                Image(systemName: isOn ? "bolt.fill" : "bolt")
                    .font(.system(size: 12))
                if showsLabel {
                    Text(L.Dashboard.sleepLabel)
                        .font(.system(size: 10))
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .foregroundColor(isOn ? .accentColor : .secondary)
            .padding(.horizontal, showsLabel ? 4 : 3)
            .frame(height: 20)
            // Ohne Beschriftung bleibt der Knopf trotzdem 20 pt breit, damit er
            // dieselbe Trefferfläche hat wie die Symbolknöpfe daneben. Zwei
            // Aufrufe, weil `minWidth` und `height` in verschiedenen
            // frame-Überladungen liegen und sich nicht mischen lassen.
            .frame(minWidth: showsLabel ? 0 : 20)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(isOn ? Color.accentColor.opacity(0.15) : Color.clear)
            )
            .overlay(alignment: .topTrailing) {
                if redundant {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 5, height: 5)
                        .offset(x: 1, y: -1)
                }
            }
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help(stayAwakeHelp)
        .accessibilityLabel(L.Dashboard.sleepLabel)
    }

    /// Kleines ⓘ neben dem Schalter: ein Klick erklärt in zwei Sätzen, was
    /// „Claude Always On" tut — vor allem, dass der Laptop nach der einmaligen
    /// Freischaltung auch zugeklappt anbleibt.
    private var stayAwakeInfoButton: some View {
        Button(action: { showAwakeInfo.toggle() }) {
            Image(systemName: "info.circle")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .frame(width: 16, height: 20)
        }
        .buttonStyle(.plain)
        .focusable(false)
        .popover(isPresented: $showAwakeInfo, arrowEdge: .bottom) {
            Text(L.Dashboard.sleepInfo)
                .font(.system(size: 11))
                .lineSpacing(2)
                .padding(12)
                .frame(width: 260)
        }
    }

    /// Tooltip des Wach-Schalters: Beschriftung samt aktuellem Zustand,
    /// darunter Klartext zur Deckel-Frage. Der Schalter zeigt die ABSICHT
    /// (Assertions); ob der Deckel wirklich abgedeckt ist, sagt `pmset`
    /// (SystemSleepInfo) — vier ehrliche Fälle:
    ///
    ///   • AN + `SleepDisabled 1` → die Deckel-Stufe greift: läuft auch
    ///     zugeklappt weiter.
    ///   • AN, aber ohne `SleepDisabled 1` → Freigabe fehlt (abgelehnt oder
    ///     nie erteilt): Zuklappen schläfert weiter ein, das nächste
    ///     Einschalten fragt einmal nach dem Passwort.
    ///   • AUS + `SleepDisabled 1` → das System schläft aus eigenem Recht
    ///     nie (Benutzer-Einstellung), der Schalter hätte nichts beizutragen.
    ///   • AUS, normal schlafender Mac → Erklärtext plus Deckel-Zeile.
    private var stayAwakeHelp: String {
        let state = sleepGuard.isAwake ? L.Dashboard.sleepStateOn : L.Dashboard.sleepStateOff
        var text = "\(L.Dashboard.sleepLabel) — \(state)\n\n\(L.Dashboard.sleepHelp)"
        if sleepGuard.isAwake {
            text += systemSleep.sleepDisabled == true
                ? "\n\n\(L.Dashboard.sleepLidActive)"
                : "\n\n\(L.Dashboard.sleepLidNote)"
        } else if systemSleep.sleepDisabled == true {
            text += "\n\n\(L.Dashboard.sleepSystemOverride)"
        } else {
            text += "\n\n\(L.Dashboard.sleepLidNote)"
        }
        return text
    }

    // MARK: - Tooltip der Wasserstände

    /// Tooltip je Pegel: „Name – Woche 87 %, Sitzung 42 %". Aufgebrauchte Fenster
    /// werden benannt, fehlende Daten ebenfalls — der Pegel allein sagt sonst nicht,
    /// ob 0 % „frisch" oder „noch nichts geladen" heißt.
    ///
    /// Ist zusätzlich ein Modellkontingent voll, steht das als eigene Zeile
    /// darunter. Es zählt bewusst nicht in den Wochenwert hinein (es sperrt das
    /// Konto nicht), soll aber trotzdem auffindbar sein — sonst wirkt ein Konto
    /// „frei", obwohl ein Modell nicht mehr geht.
    private func gaugeHelp(for snapshot: AccountUsageSnapshot) -> String {
        let weekly = snapshot.weeklyPeakUtilization
        let weeklyExhausted = (weekly ?? 0) >= WeeklyTrafficLight.exhaustedThreshold
        var text = L.Dashboard.dotHelp(
            snapshot.account.displayName,
            gaugeValueText(weekly, exhausted: weeklyExhausted),
            gaugeValueText(snapshot.sessionLimit?.percentage, exhausted: snapshot.sessionExhausted)
        )
        if let model = fullestCappedModelName(of: snapshot) {
            text += "\n\(L.Dashboard.dotModelFull(model))"
        }
        return text
    }

    /// Ein Wert im Tooltip: „87 %", „93 % (fast aufgebraucht)", „100 % (aufgebraucht)",
    /// ohne Daten „keine Daten".
    ///
    /// Die Optik schlägt früher um als die Sperre: Die Füllung wird ab 90 % rot, der
    /// Ring ab 96 % — gesperrt ist ein Fenster aber erst bei 100 %. Deshalb sagt der
    /// Tooltip dazwischen „fast aufgebraucht" statt fälschlich „aufgebraucht".
    private func gaugeValueText(_ percentage: Double?, exhausted: Bool) -> String {
        guard let percentage else { return L.Dashboard.dotNoData }
        let value = "\(Int(percentage.rounded()))%"
        guard exhausted else { return value }
        let note = percentage >= 100 ? L.Dashboard.dotUsedUp : L.Dashboard.dotAlmostUsedUp
        return "\(value) (\(note))"
    }

    /// Name des vollsten Modell-Wochenkontingents, sofern eines praktisch durch
    /// ist — sonst nil. Fehlt der Anzeigename (alte `seven_day_opus`-Felder),
    /// tritt das Kurzlabel des erkannten Typs an seine Stelle.
    private func fullestCappedModelName(of snapshot: AccountUsageSnapshot) -> String? {
        guard let models = snapshot.usageData?.weeklyModels else { return nil }
        let capped = models.enumerated()
            .filter { $0.element.limit.percentage >= WeeklyTrafficLight.exhaustedThreshold }
            .max { $0.element.limit.percentage < $1.element.limit.percentage }
        guard let capped else { return nil }
        if let name = capped.element.modelName, !name.isEmpty { return name }
        switch LimitType.weeklyType(forModelName: nil, slot: capped.offset) {
        case .fableWeekly:  return L.Dashboard.ringFable
        case .sonnetWeekly: return L.Dashboard.ringSonnet
        default:            return L.Dashboard.ringOpus
        }
    }

    private var sortMenu: some View {
        // Bewusst Buttons mit Häkchen statt Picker: ein Picker mit verstecktem Label
        // rendert im Menü als unbeschriftetes Untermenü — dieselbe Machart wie die
        // Account-Auswahl im klassischen Detailfenster.
        Menu {
            ForEach(DashboardSortMode.allCases, id: \.self) { mode in
                Button(action: { settings.dashboardSortMode = mode }) {
                    HStack {
                        Text(mode.localizedName)
                        if settings.dashboardSortMode == mode {
                            Spacer(); Image(systemName: "checkmark")
                        }
                    }
                }
            }
            Divider()
            ForEach(1...3, id: \.self) { count in
                Button(action: { applyColumns(count) }) {
                    HStack {
                        Text(L.Dashboard.columns(count))
                        if settings.dashboardColumns == count {
                            Spacer(); Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .frame(width: 20, height: 20)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .buttonStyle(.plain)
        .focusable(false)
        .help(L.Dashboard.sortHelp)
    }

    /// Spaltenwahl anwenden. Im popover legt die Einstellung die Breite direkt fest.
    /// Im eigenen Fenster richtet sich das Gitter dagegen nach der Fenstergröße —
    /// dort muss die Wahl also das Fenster ziehen, sonst bliebe der Menüeintrag
    /// wirkungslos (angeklickt, Häkchen wandert, Ansicht unverändert).
    private func applyColumns(_ count: Int) {
        settings.dashboardColumns = count
        if isStandaloneWindow {
            DashboardWindowManager.shared.resize(toColumns: count)
        }
    }

    /// Der Umschalter zwischen Konten-Gitter und Team-Ansicht. Aktiv =
    /// gefüllte Figuren in Akzentfarbe, dieselbe Formensprache wie der
    /// Wach-Schalter daneben. Die Team-Ansicht ist damit einen Klick entfernt
    /// statt in einem dritten Fenster versteckt.
    private var teamToggle: some View {
        Button(action: {
            withAnimation(.easeInOut(duration: 0.18)) { mode.showsTeam.toggle() }
        }) {
            Image(systemName: mode.showsTeam ? "person.3.fill" : "person.3")
                .font(.system(size: 12))
                .foregroundColor(mode.showsTeam ? .accentColor : .secondary)
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help(L.Dashboard.openTeamWindow)
    }

    private var actionMenu: some View {
        Menu {
            // „Aktualisieren" saß bis 2.5 als eigener Knopf im Kopf. Dort war er
            // der einzige Knopf, den man selten braucht — die App holt ohnehin
            // von selbst nach —, und er nahm den Wasserständen den Platz weg.
            // Im Menü ist er weiter einen Klick entfernt und niemandem im Weg.
            Button(action: { manager.refresh(force: true) }) {
                Label(L.Usage.refresh, systemImage: "arrow.clockwise")
            }
            .disabled(manager.isRefreshing)

            Divider()

            if !isStandaloneWindow {
                Button(action: { onMenuAction?(.openDashboardWindow) }) {
                    Label(L.Dashboard.openWindow, systemImage: "macwindow")
                }
            }
            // Die Team-Ansicht ist ein Modus der Übersicht (Kopfzeilen-Knopf);
            // der Menüeintrag spiegelt ihn nur, für alle, die hier suchen.
            Button(action: {
                withAnimation(.easeInOut(duration: 0.18)) { mode.showsTeam.toggle() }
            }) {
                Label(L.Dashboard.openTeamWindow, systemImage: "person.3")
            }
            Divider()
            // Ein Einstellungen-Eintrag statt zwei: „Allgemein" und „Konten"
            // waren nur zwei Reiter desselben Fensters — der zweite Eintrag hat
            // mehr verwirrt als abgekürzt. Konto-Tiefenlinks (.authSettings)
            // gibt es weiterhin aus den Leerzuständen heraus.
            Button(action: { onMenuAction?(.generalSettings) }) {
                Label(L.Menu.generalSettings, systemImage: "gearshape")
            }
            Button(action: { onMenuAction?(.checkForUpdates) }) {
                Label(L.Menu.checkUpdates, systemImage: "arrow.triangle.2.circlepath")
            }
            Button(action: { onMenuAction?(.about) }) {
                Label(L.Menu.about, systemImage: "info.circle")
            }
            Divider()
            Button(action: { onMenuAction?(.quit) }) {
                Label(L.Menu.quit, systemImage: "power")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 13))
                .foregroundColor(.secondary)
                .rotationEffect(.degrees(90))
                .frame(width: 20, height: 20)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .buttonStyle(.plain)
        .focusable(false)
    }

    // MARK: - Grid

    /// Die Team-Ansicht im selben Rahmen wie das Gitter: gleiche Höhenregeln,
    /// damit das Popover beim Umschalten nicht springt und das Fenster
    /// weiter frei skaliert. Mindestens 320 pt hoch — eine Team-Liste unter
    /// einer einzelnen Kartenzeile wäre sonst ein Sehschlitz.
    @ViewBuilder
    private var teamContent: some View {
        let boxHeight = max(gridHeight + DashboardMetrics.outerPadding * 2, 320)
        TeamView(onMenuAction: onMenuAction)
            .frame(
                minHeight: isStandaloneWindow ? min(boxHeight, 200) : boxHeight,
                idealHeight: boxHeight,
                maxHeight: isStandaloneWindow ? .infinity : boxHeight
            )
    }

    @ViewBuilder
    private var grid: some View {
        let boxHeight = gridHeight + DashboardMetrics.outerPadding * 2
        if manager.snapshots.isEmpty {
            emptyState
                .frame(
                    minHeight: isStandaloneWindow ? min(boxHeight, 160) : boxHeight,
                    idealHeight: boxHeight,
                    maxHeight: isStandaloneWindow ? .infinity : boxHeight
                )
        } else {
            // Der Reihenfolge-/Spalten-Regler steht direkt über den Karten,
            // die er ordnet — dort, wo seine Wirkung zu sehen ist, statt oben
            // rechts in der Kopfzeile. Die schmale Zeile kommt auf die
            // Wunschhöhe obendrauf, damit die Karten nicht gestaucht werden.
            let sortRowHeight: CGFloat = 24
            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    sortMenu
                }
                .padding(.horizontal, DashboardMetrics.outerPadding)
                .padding(.top, 4)
                .frame(height: sortRowHeight)

                ScrollView(.vertical, showsIndicators: true) {
                    // Im eigenen Fenster mittig, damit der Rest der Breite links und
                    // rechts gleichmäßig verteilt wird; im popover deckungsgleich.
                    LazyVGrid(columns: gridColumns, alignment: isStandaloneWindow ? .center : .leading, spacing: DashboardMetrics.cardSpacing) {
                        ForEach(orderedSnapshots) { snapshot in
                            AccountUsageCard(
                                snapshot: snapshot,
                                showRemainingMode: $showRemainingMode,
                                onSelect: { select(snapshot) },
                                onRefresh: { manager.refreshAccount(id: snapshot.id) },
                                onOpenAuthSettings: { onMenuAction?(.authSettings) }
                            )
                        }
                    }
                    .padding(.horizontal, DashboardMetrics.outerPadding)
                    .padding(.bottom, DashboardMetrics.outerPadding)
                    .padding(.top, 2)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .frame(
                minHeight: isStandaloneWindow ? min(boxHeight, 160) + sortRowHeight : boxHeight + sortRowHeight,
                idealHeight: boxHeight + sortRowHeight,
                maxHeight: isStandaloneWindow ? .infinity : boxHeight + sortRowHeight
            )
        }
    }

    /// Leerer Zustand: kein Konto hinterlegt. Statt einer leeren Karten-Grid
    /// ein freundlicher Hinweis mit direktem Weg in die Authentifizierung.
    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "person.crop.circle.badge.plus")
                .font(.system(size: 40))
                .foregroundColor(.secondary)

            Text(L.Welcome.subtitle)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .padding(.horizontal, DashboardMetrics.outerPadding * 2)

            Button(action: { onMenuAction?(.authSettings) }) {
                Label(L.Account.addAccount, systemImage: "plus")
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .cornerRadius(8)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 6) {
            // Der Hinweis nennt die einzige Klickfunktion, die es auf einer
            // Karte noch gibt: die Limit-Zeilen schalten zwischen verbraucht
            // und übrig um.
            Text(L.Dashboard.tapHint)
                .font(.system(size: 10))
                .foregroundColor(.secondary)
                .lineLimit(1)

            Spacer(minLength: 8)

            if let last = manager.lastRefreshAt {
                Text(L.Dashboard.updatedAt(TimeFormatHelper.formatTimeOnly(last)))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            // Laufende Version, damit man ohne Umweg über „Über" sieht,
            // welcher Stand gerade läuft. Reine Ziffernfolge, daher kein
            // eigener Sprachschlüssel — der Tooltip nutzt den vorhandenen.
            if let version = appVersion {
                Text(verbatim: "v\(version)")
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundColor(.secondary)
                    .opacity(0.7)
                    .lineLimit(1)
                    .fixedSize()
                    .help(L.SettingsAbout.version(version))
            }
        }
        .padding(.horizontal, DashboardMetrics.outerPadding)
        .frame(height: DashboardMetrics.footerHeight)
    }

    /// CFBundleShortVersionString, z. B. „1.3"
    private var appVersion: String? {
        let value = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    // MARK: - Actions

    /// Setzt das Konto als aktives Konto des jeweiligen Anbieters. Aufgerufen
    /// wird das nur noch aus dem Rechtsklick-Menü der Karte — als Klickaktion
    /// der ganzen Karte war es eine unsichtbare Umstellung.
    private func select(_ snapshot: AccountUsageSnapshot) {
        switch snapshot.provider {
        case .claude:
            settings.switchToAccount(snapshot.account)
        case .codex:
            settings.switchToCodexAccount(snapshot.account)
        }
    }
}
