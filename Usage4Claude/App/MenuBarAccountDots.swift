//
//  MenuBarAccountDots.swift
//  Usage4Claude
//
//  Datenquelle der Menüleisten-Punktreihe (ein Wasserstand je Konto).
//
//  `DataRefreshManager` kennt nur das *aktuelle* Konto. Für „ein Wasserstand je
//  Konto" braucht es alle Konten — die liegen bereits in
//  `DashboardRefreshManager.shared.snapshots`. Diese Klasse abonniert sie einmalig,
//  bringt sie über `AccountUsageSnapshot.ordered(_:mode:groupByProvider:)` in *dieselbe* Reihenfolge
//  wie die Übersicht, destilliert jeden Snapshot auf das, was ein Punkt tatsächlich
//  zeigt (gerasterter Wochenpegel + Sitzung aufgebraucht), und legt das Ergebnis
//  hinter einem Lock ab: Der Renderer darf so von jedem Thread lesen, ohne den
//  Main-Thread zu blockieren oder `@Published`-State nebenläufig anzufassen.
//
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import Combine

// MARK: - Zustand eines Punkts

/// Was ein einzelner Menüleisten-Wasserstand anzeigt — der Wochenpegel wird
/// beim Erzeugen auf 2-%-Stufen gerastert (statt roher Prozentzahlen), damit
/// der Icon-Cache nur dann verworfen wird, wenn sich das *Bild* wirklich
/// ändert: Feiner als 2 % ist bei ~10 pt Durchmesser ohnehin nichts zu sehen.
struct MenuBarDotState: Equatable {

    /// Wochen-Auslastung des Kontos in Prozent, gerastert auf 2-%-Stufen;
    /// `nil` = noch keine Wochendaten (mattes Grau, wie `MiniWaterGauge`).
    let weeklyUtilization: Double?
    /// Roter Ring außen: das 5-Stunden-Fenster (bzw. Codex primary) ist aufgebraucht
    let sessionExhausted: Bool
    /// Anbieter des Kontos — Codex-Pegel steigen durch die blaue Farbreihe
    var provider: ProviderType = .claude

    /// Rastert auf ganze 2-%-Stufen — abrundend, damit die Schwellen der
    /// `DashboardPalette` (50/75/90) exakt beim echten Überschreiten kippen
    /// und Menüleiste und Kopfzeile nie verschiedene Farben zeigen.
    static func quantized(_ utilization: Double?) -> Double? {
        utilization.map { min(100, max(0, ($0 / 2).rounded(.down) * 2)) }
    }

    /// Kürzel für den Icon-Cache-Key in `MenuBarUI` („42", „100!", „n", …)
    var cacheToken: String {
        let level = weeklyUtilization.map { String(Int($0)) } ?? "n"
        let token = sessionExhausted ? "\(level)!" : level
        return provider == .codex ? "\(token)x" : token
    }
}

// MARK: - Store

/// Thread-sicherer Zwischenspeicher der Punktreihe.
///
/// Schreiben passiert ausschließlich auf dem Main-Thread (Combine-Abos mit
/// `receive(on: .main)`), Lesen über `currentStates()` von überall — deshalb das
/// `NSLock` statt eines `DispatchQueue.main.sync`, das aus dem Renderer heraus
/// im ungünstigen Fall verklemmen könnte.
final class MenuBarAccountDots {

    /// Menüleiste und (später) andere Leser teilen sich einen Stand
    static let shared = MenuBarAccountDots()

    /// Meldet jede *tatsächliche* Änderung der Punktreihe, bereits auf dem Main-Thread.
    /// `MenuBarUI` hängt sich hier ein und zeichnet das Statusleisten-Symbol neu.
    var didChange: AnyPublisher<Void, Never> { changeSubject.eraseToAnyPublisher() }

    private let changeSubject = PassthroughSubject<Void, Never>()
    private let lock = NSLock()
    private var states: [MenuBarDotState] = []
    private var cancellables = Set<AnyCancellable>()
    private var isStarted = false

    private init() {}

    // MARK: - Lifecycle

    /// Beobachtung starten (idempotent). Muss auf dem Main-Thread aufgerufen werden;
    /// `MenuBarUI` tut das beim Aufbau der Statusleiste.
    func start() {
        guard !isStarted else { return }
        isStarted = true

        DashboardRefreshManager.shared.$snapshots
            .receive(on: DispatchQueue.main)
            .sink { [weak self] snapshots in
                self?.apply(snapshots, mode: UserSettings.shared.dashboardSortMode)
            }
            .store(in: &cancellables)

        // Sortierwunsch: Die Punktreihe muss auch dann neu sortieren, wenn sich
        // *nur* der Modus ändert — sonst behielte die Menüleiste bis zum nächsten
        // Refresh die alte Folge, während die Übersicht schon umsortiert hat.
        // Der Modus kommt aus dem Sink (ein `@Published` meldet sich im `willSet`,
        // gelesen würde also unter Umständen noch der alte Wert).
        UserSettings.shared.$dashboardSortMode
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] mode in
                self?.apply(DashboardRefreshManager.shared.snapshots, mode: mode)
            }
            .store(in: &cancellables)

        // Gruppierung: Trennt die Übersicht nach Anbieter, folgt die Punktreihe —
        // sonst stünden Punkte und Karten in verschiedener Folge. Gleicher Grund
        // wie beim Sortiermodus, deshalb auch hier der Wert aus dem Sink.
        UserSettings.shared.$dashboardGroupByProvider
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] grouped in
                self?.apply(
                    DashboardRefreshManager.shared.snapshots,
                    mode: UserSettings.shared.dashboardSortMode,
                    groupByProvider: grouped
                )
            }
            .store(in: &cancellables)

        apply(DashboardRefreshManager.shared.snapshots, mode: UserSettings.shared.dashboardSortMode)

        // Die Punktreihe braucht Daten *aller* Konten. Ohne geöffnete Übersicht
        // holt sie sonst niemand — deshalb hängt sich die Menüleiste dauerhaft
        // als zusätzlicher „Zuschauer" an den DashboardRefreshManager (der
        // Referenzzähler dort wird auch vom Übersichtsfenster benutzt).
        DashboardRefreshManager.shared.activate()
    }

    // MARK: - Lesen

    /// Aktueller Stand der Punktreihe.
    /// Leeres Ergebnis heißt „noch kein Konto hat Daten gemeldet" — `MenuBarUI`
    /// zeigt dann graue Platzhalter-Gefäße (eins je konfiguriertem Konto).
    func currentStates() -> [MenuBarDotState] {
        lock.lock()
        defer { lock.unlock() }
        return states
    }

    // MARK: - Schreiben (nur Main-Thread)

    private func apply(
        _ snapshots: [AccountUsageSnapshot],
        mode: DashboardSortMode,
        groupByProvider: Bool = UserSettings.shared.dashboardGroupByProvider
    ) {
        // Dieselbe Reihenfolge wie die Übersicht — die Regel steht nur einmal,
        // in `AccountUsageSnapshot.ordered(_:mode:groupByProvider:)`.
        let ordered = AccountUsageSnapshot.ordered(snapshots, mode: mode, groupByProvider: groupByProvider)

        // Solange kein einziges Konto Daten geliefert hat, bleibt die Reihe leer.
        let hasAnyData = ordered.contains { $0.hasData }
        let next: [MenuBarDotState] = hasAnyData
            ? ordered.map {
                MenuBarDotState(
                    weeklyUtilization: MenuBarDotState.quantized($0.weeklyPeakUtilization),
                    sessionExhausted: $0.sessionExhausted,
                    provider: $0.provider
                )
            }
            : []

        lock.lock()
        let changed = next != states
        if changed { states = next }
        lock.unlock()

        if changed { changeSubject.send() }
    }
}
