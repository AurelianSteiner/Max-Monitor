//
//  MascotParadeTiming.swift
//  Usage4Claude
//
//  Der rechnende Teil der Parade — ohne SwiftUI, damit er per `swift test`
//  prüfbar ist: Wer läuft (Claudie oder Codex-Pet), wie viele gleichzeitig,
//  und wann Nummer n startet.
//
//  Seit 2.8 richtet sich die Parade nach den Konten: Ein Claude-Konto schickt
//  einen Claudie, ein Codex-Konto ein blaues Codex-Pet, und es sind höchstens
//  so viele Wesen gleichzeitig unterwegs, wie Konten eingetragen sind. Zwei
//  Konten heißt zwei Läufer im Streifen, sieben Konten ergeben die alte dichte
//  Parade. Das Verhältnis der Arten stimmt dabei genau: Bei vier Claude- und
//  drei Codex-Konten wechseln sich die Arten ab (Bresenham-Verteilung), statt
//  in Blöcken zu kommen.
//
//  Die Obergrenze entsteht über den Startabstand: Ein Läufer braucht
//  `Reisezeit = Streifenbreite / Tempo`; startet alle `interval` Sekunden
//  einer, sind rund `Reisezeit / interval` gleichzeitig zu sehen. Also wird
//  der Abstand so gestreckt, dass diese Zahl die Kontenzahl nicht übersteigt.
//  Gestreckt werden Mittel- und Mindestabstand gemeinsam — alle Garantien der
//  Zwischenfall-Logik (`MascotIncident`), die an der Lücke hängen, werden
//  damit nur großzügiger, nie enger.
//
//  Die Breite kommt bewusst nicht aus dem live gemessenen Streifen, sondern
//  aus der Spaltenwahl (Referenzbreite): Jede Änderung des Abstands mischt die
//  Parade komplett neu (Nummer × Abstand ist bei Nummern um 10⁸ eine
//  beliebige Verschiebung). Hinge sie an der Fensterbreite, flackerte beim
//  Ziehen am Fenster die ganze Reihe. So springt sie nur, wenn jemand die
//  Spaltenzahl umstellt.
//
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation

// MARK: - Arten

/// Wer da läuft: der korallenfarbene Claudie für Claude-Konten, das blaue
/// Codex-Pet für Codex-Konten. Bewusst getrennt von `MascotVariant` (Hut,
/// Auto, Sheriff …): Die Variante ist das Kostüm, die Art das Wesen.
nonisolated enum MascotSpecies: Equatable, Sendable {
    case claudie
    case codex
}

// MARK: - Zufall

/// Stabiler Pseudozufall 0…1 aus Läufer-Nummer und Salz (Splitmix64) — keine
/// gespeicherten Zustände, dieselbe Nummer würfelt immer dasselbe.
nonisolated enum MascotRandom {
    static func roll(_ index: Int, _ salt: UInt64) -> Double {
        var z = UInt64(bitPattern: Int64(index)) &+ (salt &* 0x9E37_79B9_7F4A_7C15)
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z % 1_000_000) / 1_000_000
    }
}

// MARK: - Besetzung

/// Wie viele Konten je Anbieter mitlaufen — daraus folgen Art und Zahl der Läufer.
nonisolated struct MascotRoster: Equatable, Sendable {
    let claudeCount: Int
    let codexCount: Int

    init(claudeCount: Int, codexCount: Int) {
        self.claudeCount = max(0, claudeCount)
        self.codexCount = max(0, codexCount)
    }

    /// Ohne Konten läuft niemand mit — aber die Rechnung darf nicht durch null teilen.
    var total: Int { claudeCount + codexCount }

    /// Höchstzahl gleichzeitig sichtbarer Läufer: eins je Konto, mindestens eins,
    /// damit der Streifen bei leerer Kontoliste nicht tot ist (ein Claudie).
    var walkerCap: Int { max(1, total) }

    /// Art des Läufers mit dieser Nummer. Innerhalb jedes Zyklus von `total`
    /// Nummern kommen genau `codexCount` Codex-Pets — gleichmäßig verteilt
    /// (Bresenham), nicht als Block: 4 Claude + 3 Codex ergibt C X C X C X C.
    func species(for index: Int) -> MascotSpecies {
        guard total > 0, codexCount > 0 else { return .claudie }
        guard claudeCount > 0 else { return .codex }
        let slot = ((index % total) + total) % total
        let before = (slot * codexCount) / total
        let after = ((slot + 1) * codexCount) / total
        return after > before ? .codex : .claudie
    }
}

// MARK: - Taktung

/// Startabstände der Parade. `interval` ist der mittlere Abstand, `minInterval`
/// die Lücke, die nie unterschritten wird (sonst säßen zwei aufeinander, sobald
/// einer am Grab hält).
nonisolated struct MascotParadeTiming: Equatable, Sendable {
    /// Mittlerer Startabstand in Sekunden (2.2–2.7: fest 3,6 s)
    let interval: Double
    /// Nie enger als das
    let minInterval: Double

    /// Die alte, dichte Parade — Untergrenze für alles Weitere
    static let baseInterval: Double = 3.6
    static let baseMinInterval: Double = 3.0

    /// Streckt beide Abstände um denselben Faktor (nie unter 1: dichter als die
    /// Grundtaktung wird es nie, sonst liefen Läufer aufeinander auf).
    init(scale: Double) {
        let factor = max(1, scale.isFinite ? scale : 1)
        interval = Self.baseInterval * factor
        minInterval = Self.baseMinInterval * factor
    }

    /// Die Grundtaktung
    static let base = MascotParadeTiming(scale: 1)

    /// Taktung, bei der auf einem Streifen von `width` Punkten höchstens
    /// `walkerCap` Läufer gleichzeitig unterwegs sind.
    /// - Parameters:
    ///   - walkerCap: Obergrenze (mindestens 1)
    ///   - width: sichtbare Streifenbreite in Punkten
    ///   - speed: Tempo der Normalen in pt/s
    ///   - overshoot: Anlauf links und Auslauf rechts, außerhalb des Streifens
    static func capped(walkers walkerCap: Int, width: Double, speed: Double, overshoot: Double) -> MascotParadeTiming {
        guard width > 0, speed > 0 else { return .base }
        let travel = (width + 2 * overshoot) / speed
        let cap = Double(max(1, walkerCap))
        return MascotParadeTiming(scale: travel / (cap * baseInterval))
    }

    /// Startzeitpunkt des Läufers `index`: fixes Raster plus Jitter, der die
    /// Lücken zwischen `minInterval` und ~2 × `interval − minInterval` streut.
    func spawnTime(_ index: Int) -> Double {
        let jitterMax = interval - minInterval
        return Double(index) * interval + MascotRandom.roll(index, 1) * jitterMax
    }

    /// Wie viele Läufer bei dieser Taktung höchstens gleichzeitig auf einem
    /// Streifen sind (Normale; Sprinter und Auto sind schneller weg).
    func simultaneousWalkers(width: Double, speed: Double, overshoot: Double) -> Double {
        guard speed > 0 else { return 0 }
        return ((width + 2 * overshoot) / speed) / interval
    }
}
