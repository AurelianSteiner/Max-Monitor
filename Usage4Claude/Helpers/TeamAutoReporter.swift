//
//  TeamAutoReporter.swift
//  Usage4Claude
//
//  Team-Übersicht — Server-Anbindung Teil 3: die eigene Meldung.
//
//  Solange eine Server-Verbindung besteht (jede Rolle), meldet die App die
//  EIGENE Auslastung selbst — das Melde-Skript (scripts/team-report.sh)
//  braucht dann niemand mehr. Datenquelle sind die Snapshots des
//  `DashboardRefreshManager` (ein Snapshot je Konto mit `UsageData`);
//  damit sie auch ohne offenes Übersichtsfenster fließen, hängt sich die
//  Meldeschleife dort als zusätzlicher „Zuschauer" ein — derselbe Griff,
//  den `MenuBarAccountDots` für den Punktmodus benutzt.
//
//  Aufbau der Meldung (siehe `buildReport`):
//    • Das Claude-Konto mit der NIEDRIGSTEN Wochenauslastung ist das
//      „am besten verfügbare" und liefert die Hauptzeilen — beschriftet
//      exakt wie das Skript und die Karten: „5 Stunden", „7 Tage",
//      „<Modellname> 7 Tage" (das Wort „7 Tage" muss enthalten sein,
//      sonst zählt `TeamSummary.weeklyMarkers` die Zeile nicht als
//      Wochenlimit).
//    • Gibt es mehrere Claude-Konten, folgt zusätzlich pro Konto eine
//      Zeile „<Kontoname> 7 Tage" mit dessen Wochen-Spitzenwert
//      (`weeklyPeakUtilization`) — eine Zeile pro Konto, mehr nicht,
//      damit die Karte lesbar bleibt.
//    • Codex-Konten werden bewusst nicht gemeldet — die Team-Übersicht
//      beantwortet „welcher Claude ist noch frei".
//
//  Takt: höchstens alle 15 Minuten, und nur wenn seit der letzten Meldung
//  frische Nutzungsdaten eingetroffen sind. Fehlschläge bleiben still —
//  der nächste Zyklus (neuer Snapshot oder der 5-Minuten-Zeitgeber)
//  versucht es erneut. Kein Alarm, kein Dialog.
//
//  Thread-Regel: alles auf dem Main-Thread, nur der POST selbst läuft
//  asynchron und springt für die Buchführung zurück.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import Combine
import OSLog

final class TeamAutoReporter {

    /// Eine Meldeschleife pro App — angelegt von `TeamServerConnection.bootstrap()`
    static let shared = TeamAutoReporter()

    // MARK: - Takt

    /// Höchstens alle 15 Minuten eine Meldung
    static let minimumPostInterval: TimeInterval = 15 * 60
    /// Nach einem Versuch (auch einem gescheiterten) mindestens eine Minute Ruhe
    static let minimumAttemptGap: TimeInterval = 60
    /// Zeitgeber für Wiederholungen, falls kein neuer Snapshot mehr eintrifft
    private static let checkInterval: TimeInterval = 5 * 60

    /// UserDefaults-Schlüssel für den Zeitpunkt der letzten erfolgreichen
    /// Meldung — dauerhaft, damit der 15-Minuten-Takt auch einen Neustart der
    /// App überlebt (sonst meldete jede Startschleife sofort erneut).
    private static let lastPostDefaultsKey: String = {
        #if DEBUG
        return "DEBUG_teamServerLastReportAt"
        #else
        return "teamServerLastReportAt"
        #endif
    }()

    // MARK: - Intern

    private let defaults = UserDefaults.standard
    private var timer: Timer?
    private var cancellables = Set<AnyCancellable>()
    private var isPosting = false
    /// Wann zuletzt erfolgreich gemeldet wurde — gespiegelt in UserDefaults,
    /// damit die 15-Minuten-Untergrenze App-Neustarts übersteht
    private var lastPostAt: Date? {
        didSet {
            if let lastPostAt {
                defaults.set(lastPostAt, forKey: Self.lastPostDefaultsKey)
            } else {
                defaults.removeObject(forKey: Self.lastPostDefaultsKey)
            }
        }
    }
    /// Wann zuletzt ein Versuch lief (erfolgreich oder nicht)
    private var lastAttemptAt: Date?
    /// Datenstand (jüngstes `updatedAt`), der in der letzten erfolgreichen
    /// Meldung steckte — nur neuere Daten lösen die nächste Meldung aus
    private var lastPostedDataStamp: Date?
    /// Hält den DashboardRefreshManager am Leben, solange verbunden —
    /// paarweises activate()/deactivate() wie bei `MenuBarAccountDots`
    private var isDrivingDashboardRefresh = false

    private init() {
        lastPostAt = defaults.object(forKey: Self.lastPostDefaultsKey) as? Date

        NotificationCenter.default.publisher(for: .teamServerChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.connectionDidChange() }
            .store(in: &cancellables)

        // Jeder neue Snapshot ist ein Anlass nachzusehen, ob eine Meldung
        // fällig ist — die Wächter in `reportIfDue` sind billig.
        DashboardRefreshManager.shared.$snapshots
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.reportIfDue() }
            .store(in: &cancellables)

        // Nachgelagert, damit die Singletons sich nicht im init gegenseitig
        // erzeugen (TeamServerConnection legt diese Klasse ihrerseits an).
        DispatchQueue.main.async { [weak self] in self?.connectionDidChange() }
    }

    // MARK: - Verbindungswechsel

    /// Verbunden → Datenquelle und Zeitgeber an; getrennt → beides aus.
    func connectionDidChange() {
        dispatchPrecondition(condition: .onQueue(.main))
        let connected = TeamServerConnection.shared.isConnected && TeamServerConnection.shared.role?.reportsDevice == true
        syncDashboardRefresh(connected)
        updateTimer(connected)
        if connected {
            reportIfDue()
        } else {
            // Getrennt: Buchführung (auch die dauerhafte) zurücksetzen — eine
            // neue Verbindung ist eine bewusste Entscheidung und darf sofort
            // melden. Die Neustart-Schleife bleibt trotzdem gebremst, denn
            // solange verbunden, wird hier nie gelöscht.
            lastPostAt = nil
            lastPostedDataStamp = nil
        }
    }

    // MARK: - Melden

    /// Meldet die eigene Auslastung, wenn alle Bedingungen stimmen:
    /// verbunden, frische Daten, 15 Minuten seit der letzten Meldung.
    /// Sonst passiert still gar nichts.
    func reportIfDue(now: Date = Date()) {
        dispatchPrecondition(condition: .onQueue(.main))

        let connection = TeamServerConnection.shared
        guard let teamId = connection.teamId, let client = connection.client else { return }
        // Kein Melden mit bekannt abgelehntem Token: Nach einem 401 setzt
        // `verifyIdentity` die Rolle auf `nil` — erst eine erfolgreiche
        // Prüfung (oder ein neues Verbinden) setzt sie wieder und öffnet
        // damit auch diese Schleife wieder.
        guard connection.role?.reportsDevice == true else { return }
        guard !isPosting else { return }

        let snapshots = DashboardRefreshManager.shared.snapshots
        guard let dataStamp = Self.dataStamp(of: snapshots) else { return }

        // Nur melden, wenn seit der letzten Meldung neue Daten kamen …
        if let posted = lastPostedDataStamp, dataStamp <= posted { return }
        // … höchstens alle 15 Minuten …
        if let last = lastPostAt, now.timeIntervalSince(last) < Self.minimumPostInterval { return }
        // … und nicht in schneller Folge erneut nach einem Fehlschlag.
        if let attempt = lastAttemptAt, now.timeIntervalSince(attempt) < Self.minimumAttemptGap { return }

        // Für Mitglieder erzwingt der Server ohnehin den eingetragenen Namen;
        // Super/Admin melden unter dem Namen des Mac-Benutzers.
        let person = connection.memberName ?? Self.fallbackPersonName()
        guard let report = Self.buildReport(teamId: teamId, person: person,
                                            snapshots: snapshots, now: now) else { return }

        isPosting = true
        lastAttemptAt = now
        Task { [weak self] in
            do {
                try await client.postReport(report)
                await MainActor.run {
                    guard let self else { return }
                    self.isPosting = false
                    self.lastPostAt = Date()
                    self.lastPostedDataStamp = dataStamp
                    Logger.team.notice("Eigene Auslastung an den Team-Server gemeldet")
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    // Stiller Fehlschlag: Buchführung unverändert lassen,
                    // der nächste Zyklus versucht es erneut.
                    self.isPosting = false
                    if let serverError = error as? TeamServerError, serverError == .invalidToken {
                        // Token abgelehnt (z. B. Mitglied entfernt): die
                        // Verbindung prüfen lassen. Bestätigt sich das 401,
                        // löscht sie die Rolle — und der Wächter oben hält
                        // die Meldeschleife an, statt minütlich gegen den
                        // toten Token zu klopfen. War es nur ein Ausrutscher,
                        // bleibt die Rolle stehen und es geht normal weiter.
                        TeamServerConnection.shared.verifyIdentity()
                    }
                    Logger.team.info("Meldung an den Team-Server fehlgeschlagen: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    // MARK: - Meldung bauen

    /// Baut die eigene Meldung aus den aktuellen Konto-Snapshots.
    ///
    /// - Returns: `nil`, solange kein Claude-Konto Daten hat — dann gibt es
    ///   schlicht nichts zu melden.
    static func buildReport(teamId: String,
                            person: String,
                            snapshots: [AccountUsageSnapshot],
                            now: Date = Date()) -> TeamReport? {
        let claude = snapshots.filter { $0.provider == .claude && $0.usageData != nil }
        guard !claude.isEmpty else { return nil }

        // „Am besten verfügbar" = niedrigste Wochenauslastung; bei
        // Gleichstand das älteste Konto, damit die Wahl nicht springt.
        let best = claude.min { lhs, rhs in
            let left = lhs.weeklyPeakUtilization ?? .greatestFiniteMagnitude
            let right = rhs.weeklyPeakUtilization ?? .greatestFiniteMagnitude
            if left != right { return left < right }
            return lhs.account.createdAt < rhs.account.createdAt
        }!

        var limits: [TeamLimit] = []

        // Hauptzeilen: das beste Konto, beschriftet wie Karten und Skript.
        // Jede Zeile trägt zusätzlich ihre maschinenlesbare Art (`kind`),
        // damit Auswertung und Detailansicht nicht mehr an der Beschriftung
        // schnüffeln müssen. Alte Leser ignorieren das Feld einfach.
        if let data = best.usageData {
            if let fiveHour = data.fiveHour {
                limits.append(TeamLimit(label: "5 Stunden",
                                        percent: percent(fiveHour.percentage),
                                        resetsAt: fiveHour.resetsAt,
                                        kind: .session))
            }
            if let sevenDay = data.sevenDay {
                limits.append(TeamLimit(label: "7 Tage",
                                        percent: percent(sevenDay.percentage),
                                        resetsAt: sevenDay.resetsAt,
                                        kind: .weekly))
            }
            for model in data.weeklyModels {
                let name = model.modelName ?? "Modell"
                limits.append(TeamLimit(label: weeklyLabel(prefixedWith: name),
                                        percent: percent(model.limit.percentage),
                                        resetsAt: model.limit.resetsAt,
                                        kind: .modelWeekly))
            }
        }

        // Mehrere Konten: je Konto eine Wochenzeile mit dem Kontonamen davor.
        // Bei nur einem Konto wäre das eine Wiederholung der Zeilen darüber.
        if claude.count > 1 {
            for snapshot in claude {
                guard let weekly = snapshot.weeklyPeakUtilization else { continue }
                limits.append(TeamLimit(label: weeklyLabel(prefixedWith: snapshot.account.displayName),
                                        percent: percent(weekly),
                                        resetsAt: snapshot.usageData?.sevenDay?.resetsAt,
                                        kind: .accountWeekly))
            }
        }

        // Mehr Zeilen zeigt keine Karte an — und der tolerante Leser würde
        // sie ohnehin abschneiden (TeamReport.maxLimits).
        limits = Array(limits.prefix(TeamReport.maxLimits))
        guard !limits.isEmpty else { return nil }

        return TeamReport(teamId: teamId, person: person, reportedAt: now, limits: limits)
    }

    /// Jüngster Datenstand über alle Claude-Konten — `nil`, wenn noch kein
    /// Konto erfolgreich abgefragt wurde.
    static func dataStamp(of snapshots: [AccountUsageSnapshot]) -> Date? {
        snapshots
            .filter { $0.provider == .claude && $0.usageData != nil }
            .compactMap(\.updatedAt)
            .max()
    }

    /// Name für Super/Admin-Meldungen: der Mac-Benutzer.
    static func fallbackPersonName() -> String {
        let full = NSFullUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        if !full.isEmpty { return full }
        let short = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        return short.isEmpty ? "Mac" : short
    }

    private static func percent(_ value: Double) -> Int {
        Int(value.rounded())
    }

    /// „<Name> 7 Tage", wobei der Name so gekürzt wird, dass das „7 Tage" die
    /// Längenklemme von `TeamLimit` (40 Zeichen) sicher übersteht — sonst
    /// erkennt `TeamSummary.weeklyMarkers` die Zeile nicht als Wochenlimit.
    static func weeklyLabel(prefixedWith name: String) -> String {
        let suffix = " 7 Tage"
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let room = TeamLimit.maxLabelLength - suffix.count
        let shortened = String(trimmed.prefix(room)).trimmingCharacters(in: .whitespaces)
        return (shortened.isEmpty ? "Konto" : shortened) + suffix
    }

    // MARK: - Zeitgeber & Datenquelle

    private func updateTimer(_ connected: Bool) {
        guard connected else {
            timer?.invalidate()
            timer = nil
            return
        }
        guard timer == nil else { return }
        let timer = Timer(timeInterval: Self.checkInterval, repeats: true) { [weak self] _ in
            self?.reportIfDue()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Solange verbunden, zählt die Meldeschleife als „Zuschauer" des
    /// DashboardRefreshManager — sonst kämen ohne offenes Fenster nie
    /// frische Zahlen (vgl. `MenuBarAccountDots.syncDashboardRefresh`).
    private func syncDashboardRefresh(_ connected: Bool) {
        guard connected != isDrivingDashboardRefresh else { return }
        isDrivingDashboardRefresh = connected
        if connected {
            DashboardRefreshManager.shared.activate()
        } else {
            DashboardRefreshManager.shared.deactivate()
        }
    }
}
