//
//  AccountUsageCard.swift
//  Usage4Claude
//
//  Eine Konto-Karte der Übersicht.
//
//  Aufbau: links der Wasserstand für das Stundenlimit, durch eine senkrechte
//  Linie getrennt rechts groß das Wochenlimit — die Zahl, an der die Planung
//  hängt. Beide Seiten tragen ihr eigenes Label und ihre eigene Reset-Zeit.
//  Ist ein Fenster aufgebraucht, steht daneben eine Sperr-Plakette: sie
//  benennt, *was* gesperrt ist (Sitzung oder Woche), und zählt bis zur
//  Freischaltung genau dieses Fensters herunter. Darunter die frei
//  konfigurierbaren übrigen Limits als Zeilen.
//
//  Die Karte selbst ist nicht anklickbar: Sie machte das Konto früher zum
//  „aktiven", was die Menüleiste steuerte — die zeigt inzwischen alle Konten,
//  der Klick verstellte also etwas Unsichtbares und der blaue Rand markierte
//  eine Auswahl ohne Wirkung. Umstellen geht weiter über das Rechtsklick-Menü.
//  Angeklickt werden nur noch die Limit-Zeilen (verbraucht ↔ übrig).
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI

struct AccountUsageCard: View {
    let snapshot: AccountUsageSnapshot
    @Binding var showRemainingMode: Bool
    /// Konto zum aktiven Konto seines Anbieters machen — nur aus dem
    /// Rechtsklick-Menü heraus, siehe Dateikopf.
    let onSelect: () -> Void
    let onRefresh: () -> Void
    let onOpenAuthSettings: () -> Void

    @State private var isHovering = false

    /// Unterhalb dieser Restzeit zeigt die Karte einen Countdown statt eines Datums.
    private static let countdownWindow: TimeInterval = 3 * 24 * 3600

    /// Feste Maße des Kopfblocks. Die Übersicht rechnet ihre Fensterhöhe aus den
    /// Kartenhöhen vor (DashboardMetrics.cardHeight) — der Block muss deshalb
    /// eine bekannte Höhe haben und darf nicht mit dem Inhalt wachsen. Der Wert
    /// steht in DashboardMetrics, damit Vorausrechnung und Darstellung nicht
    /// auseinanderlaufen können.
    private static let headlineHeight = DashboardMetrics.headlineHeight
    private static let sessionColumnWidth: CGFloat = 96
    private static let weeklyColumnWidth: CGFloat = 92

    /// Limits für die Zeilen unter dem Kopfbereich. Sitzungs- und Wochenfenster
    /// sind oben schon prominent vertreten und werden hier nicht wiederholt.
    private var rowTypes: [LimitType] {
        let promoted: Set<LimitType> = snapshot.provider == .claude
            ? [.fiveHour, .sevenDay]
            : [.codexPrimary, .codexSecondary]
        return DashboardMetrics.activeTypes(for: snapshot).filter { !promoted.contains($0) }
    }

    private var overflowWeeklyModels: [(offset: Int, element: UsageData.WeeklyModelLimit)] {
        DashboardMetrics.overflowWeeklyModels(for: snapshot)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            content
        }
        .padding(12)
        .frame(width: DashboardMetrics.cardWidth, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(NSColor.controlBackgroundColor).opacity(isHovering ? 0.95 : 0.7))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(borderColor, lineWidth: 1)
        )
        // Trägt das Rechtsklick-Menü über die ganze Karte, auch über die
        // Leerflächen zwischen den Zahlen.
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onHover { isHovering = $0 }
        .animation(.easeInOut(duration: 0.15), value: isHovering)
        .contextMenu {
            Button(action: onRefresh) {
                Label(L.Dashboard.refreshAccount, systemImage: "arrow.clockwise")
            }
            Button(action: onSelect) {
                Label(L.Dashboard.makeActive, systemImage: "checkmark.circle")
            }
        }
    }

    private var borderColor: Color {
        Color.primary.opacity(isHovering ? 0.18 : 0.08)
    }

    // MARK: - Kopfbereich

    private var header: some View {
        HStack(alignment: .top, spacing: 6) {
            providerIcon
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(snapshot.account.displayName)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)

                    kindBadge
                    cancellationBadge
                }

                // Anmelde-Email als zweite Zeile — bei Konten, deren Anzeigename
                // ohnehin die Email ist, entfällt sie (siehe Account.secondaryLabel).
                if let email = snapshot.account.secondaryLabel {
                    Text(email)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Spacer(minLength: 4)

            if isHovering {
                Button(action: onRefresh) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .focusable(false)
                .help(L.Dashboard.refreshAccount)
            }
        }
    }

    /// Firma oder privat — beides kann auf derselben Email liegen, dann ist die
    /// Plakette das einzige Unterscheidungsmerkmal der beiden Karten. Bis 2.9
    /// stand hier nur ein graues 9-pt-Symbol; wer zwei Konten desselben Namens
    /// nebeneinander hatte, musste es suchen. Jetzt steht die Art ausgeschrieben
    /// in einer getönten Plakette — grün privat, violett Firma.
    /// Bei unbekannter Art bleibt die Stelle leer, statt eine Vermutung zu zeigen.
    @ViewBuilder
    private var kindBadge: some View {
        if let symbol = snapshot.account.kind.symbolName {
            let kind = snapshot.account.kind
            let tone = DashboardPalette.kindInk(kind)
            let label = "\(L.Account.kindLabel): \(kind.localizedName)"

            HStack(spacing: 3) {
                Image(systemName: symbol)
                    .font(.system(size: 9, weight: .bold))
                Text(kind.localizedName)
                    .font(.system(size: 10, weight: .bold))
                    .lineLimit(1)
            }
            .foregroundColor(tone)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(tone.opacity(0.14)))
            .overlay(Capsule().strokeBorder(tone.opacity(0.30), lineWidth: 0.5))
            .fixedSize()
            .help(label)
            .accessibilityLabel(label)
        }
    }

    // MARK: - Kündigungs-Plakette

    /// Gekündigtes Abo: „endet 9. Okt." neben dem Namen, mit Tooltip samt vollem
    /// Datum und Restzeit. Der Ton kommt aus der Anbieter-Farbreihe — kräftig,
    /// sobald weniger als eine Woche bleibt. Ohne eingetragenes Datum bleibt die
    /// Stelle leer; das Datum kommt von Hand aus den Einstellungen, keine
    /// Schnittstelle liefert es.
    @ViewBuilder
    private var cancellationBadge: some View {
        if let end = snapshot.account.subscriptionEndsAt {
            let days = snapshot.account.subscriptionDaysRemaining() ?? 0
            let level: Double = days <= 7 ? 100 : 80
            let shortDate = Self.shortDate(end)
            let text = days < 0
                ? L.Account.cancellationEnded(shortDate)
                : L.Account.cancellationEndsOn(shortDate)

            HStack(spacing: 2) {
                Image(systemName: "calendar.badge.exclamationmark")
                    .font(.system(size: 8, weight: .semibold))
                Text(text)
                    .font(.system(size: 9, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundColor(days < 0 ? .secondary : DashboardPalette.ink(level, provider: snapshot.provider))
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(
                Capsule().fill(
                    days < 0
                        ? Color.secondary.opacity(0.12)
                        : DashboardPalette.fill(level, provider: snapshot.provider).opacity(0.14)
                )
            )
            .fixedSize()
            .help(L.Account.cancellationHelp(Self.longDate(end), L.Account.cancellationDaysLeft(days)))
            .accessibilityLabel(L.Account.cancellationHelp(Self.longDate(end), L.Account.cancellationDaysLeft(days)))
        }
    }

    /// „9. Okt." / „Oct 9" — für die Plakette
    private static func shortDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = UserSettings.shared.appLocale
        formatter.setLocalizedDateFormatFromTemplate("dMMM")
        return formatter.string(from: date)
    }

    /// „Freitag, 9. Oktober 2026" — für den Tooltip
    private static func longDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = UserSettings.shared.appLocale
        formatter.setLocalizedDateFormatFromTemplate("EEEEdMMMMyyyy")
        return formatter.string(from: date)
    }

    /// Dasselbe Bild wie im Kopf der Anbieter-Bahn und in den Einstellungen —
    /// eine Karte muss auch dann zuzuordnen sein, wenn sie allein dasteht.
    private var providerIcon: some View {
        ProviderLogo(provider: snapshot.provider, size: 14)
    }

    // MARK: - Inhalt

    @ViewBuilder
    private var content: some View {
        if !snapshot.hasData, let error = snapshot.errorMessage {
            errorContent(error)
        } else if !snapshot.hasData {
            placeholderContent
        } else {
            VStack(alignment: .leading, spacing: 9) {
                headline
                // Trennstrich: unten steht ein eigener, frei konfigurierbarer Block —
                // die Kante macht sichtbar, dass er nicht zum Kopfbereich gehört.
                if !rowTypes.isEmpty || !overflowWeeklyModels.isEmpty || snapshot.errorMessage != nil {
                    Divider().opacity(0.6)
                    limitRows
                }
            }
        }
    }

    /// Stundenlimit (Wasserstand) und Wochenlimit nebeneinander, getrennt durch
    /// eine senkrechte Linie. Beide Seiten: Label oben, Wert in der Mitte,
    /// Reset-Zeit darunter — sonst ist nicht erkennbar, welche Zahl zu welchem
    /// Fenster gehört. Rechts außen der Countdown fast erschöpfter Konten.
    private var headline: some View {
        HStack(alignment: .center, spacing: 8) {
            sessionColumn
            ProviderDivider(height: Self.headlineHeight - 12)
            weeklyColumn

            Spacer(minLength: 4)

            if let lock = lockState {
                lockBadge(lock)
            }
        }
        .frame(height: Self.headlineHeight)
    }

    /// Linke Spalte: Sitzungsfenster (5 Stunden bzw. Codex primary)
    private var sessionColumn: some View {
        let session = snapshot.sessionLimit
        return VStack(spacing: 2) {
            columnLabel(L.Dashboard.sessionLimit)

            WaterLevelGauge(
                percentage: session?.percentage ?? 0,
                caption: session?.label ?? L.Usage.fiveHourLimitShort,
                diameter: DashboardMetrics.ringSlotWidth,
                provider: snapshot.provider
            )

            resetLine(for: session)
        }
        .frame(width: Self.sessionColumnWidth)
    }

    /// Rechte Spalte: Wochenfenster — die große Zahl der Karte
    private var weeklyColumn: some View {
        let weekly = snapshot.weeklyLimit
        let percentage = weekly?.percentage ?? 0

        return VStack(alignment: .leading, spacing: 2) {
            columnLabel(L.Dashboard.weeklyLimit)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text("\(Int(percentage.rounded()))%")
                .font(.system(size: 30, weight: .semibold).monospacedDigit())
                .foregroundColor(DashboardPalette.ink(percentage, provider: snapshot.provider))
                .lineLimit(1)

            resetLine(for: weekly)
        }
        .frame(width: Self.weeklyColumnWidth, alignment: .leading)
    }

    private func columnLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    // MARK: - Sperr-Plakette

    /// Welches Fenster blockiert dieses Konto gerade? Der Unterschied ist groß:
    /// ein aufgebrauchtes Sitzungsfenster ist in Stunden zurück, ein
    /// aufgebrauchtes Wochenlimit kann Tage blockieren. Ein reiner Countdown
    /// („noch 3h 12m") sagt nicht, welches der beiden gemeint ist — deshalb
    /// benennt die Plakette zuerst das Fenster und erst danach die Restzeit.
    private enum LockState {
        /// Nur das Sitzungsfenster (5 Stunden bzw. Codex primary) ist aufgebraucht
        case session
        /// Die Woche ist aufgebraucht
        case weekly
    }

    /// Die Wochenlage entscheidet zuerst — sie ist die bindende Sperre. Ist die
    /// Woche zu, läuft über das Konto ohnehin nichts mehr; ob die Sitzung
    /// zusätzlich voll ist, ändert daran nichts und bleibt deshalb unerwähnt.
    /// `nil` heißt: nichts ist zu, die Plakette bleibt weg.
    ///
    /// Gemeint ist immer das **kontoweite** Wochenfenster. Ein aufgebrauchtes
    /// Modellkontingent (Fable, Opus, Sonnet) sperrt das Konto nicht — es sperrt
    /// ein Modell, während die anderen weiterlaufen — und trägt deshalb keine
    /// Plakette. Es steht als eigene Zeile im Block darunter, dort rot getönt.
    /// Ein volles Extra-Kontingent allein sperrt ebenfalls nichts.
    private var lockState: LockState? {
        if hasWeeklyWindow, (snapshot.weeklyPeakUtilization ?? 0) >= AccountUsageSnapshot.nearExhaustionThreshold {
            return .weekly
        }
        return snapshot.sessionExhausted ? .session : nil
    }

    /// „Woche gesperrt" nur behaupten, wenn es überhaupt ein Wochenfenster gibt.
    /// Liefert Codex kein 7-Tage-Fenster, ist `weeklyPeakUtilization` dort nur
    /// eine Näherung aus dem Sitzungsfenster — die Plakette hätte sonst die Woche
    /// benannt und dazu einen leeren Countdown gezeigt, obwohl die Sitzung zu ist.
    private var hasWeeklyWindow: Bool {
        snapshot.weeklyLimit != nil
    }

    private func lockTitle(_ state: LockState) -> String {
        switch state {
        case .session: return L.Dashboard.lockSession
        case .weekly:  return L.Dashboard.lockWeekly
        }
    }

    private func lockDetail(_ state: LockState) -> String {
        switch state {
        case .session: return L.Dashboard.lockSessionHelp
        case .weekly:  return L.Dashboard.lockWeeklyHelp
        }
    }

    /// Der Countdown gehört immer zu dem Fenster, das die Plakette benennt —
    /// sonst stünde unter „Woche gesperrt" die Restzeit der Sitzung.
    private func lockResetsAt(_ state: LockState) -> Date? {
        switch state {
        case .session: return snapshot.sessionLimit?.resetsAt
        case .weekly:  return weeklyLockResetsAt
        }
    }

    /// Ende der Wochensperre: der Reset des kontoweiten Wochenfensters — genau
    /// des Fensters, das die Plakette benennt. Die Modell-Wochenlimits zählen
    /// hier nicht mit; sie sperren das Konto nicht und dürfen den Countdown
    /// deshalb auch nicht verlängern.
    private var weeklyLockResetsAt: Date? {
        snapshot.weeklyLimit?.resetsAt
    }

    /// Ersetzt das frühere Ausgrauen: Statt die Karte zu dämpfen, benennt eine
    /// Plakette das gesperrte Fenster und zählt bis zu dessen Freischaltung herunter.
    /// Die Sitzung bekommt den milderen Ton (sie kommt bald zurück), die Woche den
    /// kräftigen.
    private func lockBadge(_ state: LockState) -> some View {
        let isWeekly = state == .weekly
        // Farbstufe der Skala: 80 % = Clay-Orange (mild), 100 % = Rot (kräftig)
        let level: Double = isWeekly ? 100 : 80
        let resetsAt = lockResetsAt(state)

        return VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 3) {
                Image(systemName: isWeekly ? "lock.fill" : "hourglass")
                    .font(.system(size: 9, weight: .semibold))
                Text(lockTitle(state))
                    .font(.system(size: 10, weight: isWeekly ? .semibold : .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }

            // Eigene Zeitachse: der Countdown läuft weiter, ohne dass die
            // ganze Übersicht neu gebaut wird.
            TimelineView(.periodic(from: .now, by: 60)) { _ in
                Text(countdownText(for: resetsAt))
                    .font(.system(size: 14, weight: .bold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .foregroundColor(DashboardPalette.ink(level, provider: snapshot.provider))
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(DashboardPalette.fill(level, provider: snapshot.provider).opacity(isWeekly ? 0.20 : 0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    DashboardPalette.fill(level, provider: snapshot.provider).opacity(isWeekly ? 0.75 : 0.40),
                    lineWidth: isWeekly ? 1.5 : 1
                )
        )
        .help(lockHelp(state, resetsAt: resetsAt))
    }

    /// Tooltip der Plakette: Überschrift, Klartext dazu und der genaue Zeitpunkt
    /// der Freischaltung — der Countdown allein nennt keinen Wochentag.
    private func lockHelp(_ state: LockState, resetsAt: Date?) -> String {
        var text = "\(lockTitle(state))\n\n\(lockDetail(state))"
        if let resetsAt {
            text += "\n\n\(L.Dashboard.freeAgain): \(fullResetDescription(resetsAt))"
        }
        return text
    }

    private func countdownText(for resetsAt: Date?) -> String {
        guard let resetsAt else { return "–" }
        return UsageData.LimitData(percentage: 100, resetsAt: resetsAt).formattedCompactRemaining
    }

    /// Dritte Zeile: Countdown, wenn die Freischaltung in weniger als drei Tagen
    /// ansteht, sonst das Datum. Der genaue Tag mit Uhrzeit steht immer im Tooltip.
    @ViewBuilder
    private func resetLine(for limit: AccountUsageSnapshot.RingLimit?) -> some View {
        if let limit, let resetsAt = limit.resetsAt {
            let data = UsageData.LimitData(percentage: limit.percentage, resetsAt: resetsAt)
            let remaining = resetsAt.timeIntervalSinceNow
            let isSoon = remaining > 0 && remaining < Self.countdownWindow

            // Die Zeile zählt selbst herunter, ohne dass die ganze Karte neu gebaut wird
            TimelineView(.periodic(from: .now, by: 60)) { _ in
                Text(isSoon ? data.formattedCompactRemaining : data.formattedCompactResetDate)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(limit.isExhausted ? DashboardPalette.ink(100, provider: snapshot.provider) : .secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .help(fullResetDescription(resetsAt))
        } else {
            Text("–")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.secondary)
        }
    }

    private func fullResetDescription(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = UserSettings.shared.appLocale
        formatter.setLocalizedDateFormatFromTemplate("EEEEdMMMM")
        let day = formatter.string(from: date)
        return "\(day) · \(TimeFormatHelper.formatTimeOnly(date))"
    }

    private var limitRows: some View {
        VStack(spacing: 4) {
            ForEach(rowTypes, id: \.self) { type in
                UnifiedLimitRow(
                    type: type,
                    data: snapshot.usageData,
                    codexData: snapshot.codexUsageData,
                    showRemainingMode: showRemainingMode,
                    usesUtilizationTint: true
                )
            }
            ForEach(overflowWeeklyModels, id: \.offset) { entry in
                UnifiedLimitRow(
                    type: LimitType.weeklyType(forModelName: entry.element.modelName, slot: entry.offset),
                    data: snapshot.usageData,
                    showRemainingMode: showRemainingMode,
                    weeklyModelOverride: entry.element,
                    usesUtilizationTint: true
                )
            }

            // Abruf fehlgeschlagen, aber alte Daten noch vorhanden: Hinweis, dass
            // die Zahlen veraltet sein können. Ist die Anmeldung abgelaufen, hängt
            // der Weg zur Neuanmeldung direkt daneben — der Hinweis allein ließe
            // die Karte sonst still veralten.
            if let error = snapshot.errorMessage {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9))
                    Text(error)
                        .font(.system(size: 9))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if snapshot.needsReauth {
                        Spacer(minLength: 4)
                        reauthButton
                    }
                }
                .foregroundColor(DashboardPalette.ink(80, provider: snapshot.provider))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.spring(response: 0.42, dampingFraction: 0.78)) {
                showRemainingMode.toggle()
            }
        }
    }

    private func errorContent(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 22))
                .foregroundColor(DashboardPalette.ink(80, provider: snapshot.provider))
                .frame(width: DashboardMetrics.ringSlotWidth)

            VStack(alignment: .leading, spacing: 6) {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    if snapshot.needsReauth {
                        // Abgelaufene Anmeldung: „Erneut versuchen" kann nichts
                        // ausrichten, der Login ist der einzige Weg zurück.
                        reauthButton
                    } else {
                        Button(action: onRefresh) {
                            Text(L.Dashboard.retry).font(.system(size: 10))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }

                    Button(action: onOpenAuthSettings) {
                        Text(L.Usage.goToSettings).font(.system(size: 10))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        .frame(minHeight: DashboardMetrics.ringSlotWidth)
    }

    /// Öffnet den Browser-Login des passenden Anbieters. Nach der Anmeldung
    /// bleiben ID, Alias, Art und Kündigungsdatum des Kontos erhalten — nur die
    /// Zugangsdaten werden ersetzt (siehe `AccountStore.replaceClaudeCredentials`).
    private var reauthButton: some View {
        Button(action: openLogin) {
            Text(L.Dashboard.reauth).font(.system(size: 10))
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .help(L.Error.sessionExpired)
    }

    private func openLogin() {
        switch snapshot.provider {
        case .claude: WebLoginWindowManager.shared.showLoginWindow()
        case .codex:  WebLoginWindowManager.shared.showCodexLoginWindow()
        }
    }

    private var placeholderContent: some View {
        HStack(alignment: .center, spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .frame(width: DashboardMetrics.ringSlotWidth)
            Text(L.Usage.loading)
                .font(.system(size: 11))
                .foregroundColor(.secondary)
            Spacer(minLength: 0)
        }
        .frame(minHeight: DashboardMetrics.ringSlotWidth)
    }
}
