//
//  DashboardComponents.swift
//  Usage4Claude
//
//  Bausteine der Mehrkonten-Übersicht: Farbskala, Wasserstand-Anzeige, Statusabzeichen.
//  Die Karte selbst liegt in AccountUsageCard.swift, der Container in DashboardView.swift.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI
import AppKit

// MARK: - Farbskala

/// Vierstufige Auslastungsskala — je Anbieter eine eigene Farbreihe.
///
/// **Claude:** Blau → Gelb → Orange → Rot. Bewusst nicht die Ampelskala der
/// Originalapp — Blau als Ruhezustand nimmt sich zurück, statt ein entspanntes
/// Konto grün anzustrahlen. Die dritte Stufe ist Claudes Clay-Orange, dadurch
/// bleibt die Skala in der Hausfarbe.
///
/// **Codex:** alles in Blaurichtung — Himmelblau → Azur → Königsblau → Indigo.
/// Die Warnstufen liegen in Sättigung und Tiefe statt im Farbton: Je enger es
/// wird, desto dunkler und dichter das Blau. So sind Claude- und Codex-Karten
/// auf einen Blick auseinanderzuhalten, und die Codex-Seite trägt nicht mehr
/// Claudes Orange (seit 2.8).
///
/// Jede Stufe hat zwei Töne: `fill` für Flächen (Wasser, Balken) und `ink` für Text.
/// Der Flächenton wäre als Schrift auf hellem Grund zu schwach — besonders Gelb.
enum DashboardPalette {

    enum Level {
        case calm       // 0–49 %
        case moderate   // 50–74 %
        case high       // 75–89 %
        case full       // 90–100 %

        static func forPercentage(_ percentage: Double) -> Level {
            switch percentage {
            case ..<50: return .calm
            case ..<75: return .moderate
            case ..<90: return .high
            default:    return .full
            }
        }
    }

    /// Flächenton (Wasser, Balken)
    static func fill(_ percentage: Double, provider: ProviderType = .claude) -> Color {
        Color(nsColor: nsFill(percentage, provider: provider))
    }

    /// Flächenton als NSColor — für AppKit-Zeichnung (Wasserstände in der
    /// Menüleiste). Löst sich wie alle Töne hier dynamisch nach der beim
    /// Zeichnen aktiven Appearance auf.
    static func nsFill(_ percentage: Double, provider: ProviderType = .claude) -> NSColor {
        switch (provider, Level.forPercentage(percentage)) {
        case (.claude, .calm):     return dynamicNS(light: 0x5E86C4, dark: 0x6E96D4)
        case (.claude, .moderate): return dynamicNS(light: 0xE0A93F, dark: 0xE8B855)
        case (.claude, .high):     return dynamicNS(light: 0xD97757, dark: 0xE08767)
        case (.claude, .full):     return dynamicNS(light: 0xC9503F, dark: 0xD9604F)

        case (.codex, .calm):      return dynamicNS(light: 0x7FB5E9, dark: 0x86BCEE)
        case (.codex, .moderate):  return dynamicNS(light: 0x4A92DB, dark: 0x5A9EE4)
        case (.codex, .high):      return dynamicNS(light: 0x2B5FC7, dark: 0x3E74D6)
        case (.codex, .full):      return dynamicNS(light: 0x2C2F9E, dark: 0x4A4CC0)
        }
    }

    /// Textton derselben Stufe — dunkler, damit Zahlen auf hellem Grund tragen
    static func ink(_ percentage: Double, provider: ProviderType = .claude) -> Color {
        switch (provider, Level.forPercentage(percentage)) {
        case (.claude, .calm):     return dynamic(light: 0x3E6DA8, dark: 0x8FB0DC)
        case (.claude, .moderate): return dynamic(light: 0xA9761B, dark: 0xE0B45C)
        case (.claude, .high):     return dynamic(light: 0xB4553A, dark: 0xE59A80)
        case (.claude, .full):     return dynamic(light: 0xA33528, dark: 0xE8796A)

        case (.codex, .calm):      return dynamic(light: 0x2F6FB5, dark: 0x9DC4EE)
        case (.codex, .moderate):  return dynamic(light: 0x1F5EA6, dark: 0x8DB8EA)
        case (.codex, .high):      return dynamic(light: 0x1B479C, dark: 0x7FA4E4)
        case (.codex, .full):      return dynamic(light: 0x1E1F78, dark: 0x9C9EE8)
        }
    }

    /// Farbe für Text, der auf der Wasserfläche liegt
    static let onFill = Color.white

    /// Hex-Paar als NSColor mit Dynamic Provider: heller und dunkler Modus je eigener
    /// Wert, damit die Töne in beiden Erscheinungsbildern tragen.
    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(nsColor: dynamicNS(light: light, dark: dark))
    }

    private static func dynamicNS(light: Int, dark: Int) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return nsColor(isDark ? dark : light)
        }
    }

    private static func nsColor(_ hex: Int) -> NSColor {
        NSColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: 1.0
        )
    }
}

// MARK: - Wochen-Schwellen

/// Die eine geteilte Schwelle der Wochen-Auslastung: Ab wann gilt eine Woche
/// als praktisch aufgebraucht? Übersicht, Menüleiste und Team-Ansicht fragen
/// alle hier nach, damit „durch" überall dasselbe heißt.
///
/// Die frühere dreistufige Ampel (Grün/Blau/Rot) ist Geschichte — Menüleiste
/// und Kopfzeile zeigen inzwischen beide echte Wasserstände mit der
/// vierstufigen `DashboardPalette`.
enum WeeklyTrafficLight {
    /// Ab hier gilt die Woche als praktisch aufgebraucht → rot
    static let exhaustedThreshold: Double = 90
}

// MARK: - Wasserstand-Miniatur (Kopfzeile)

/// Maße der Miniatur-Wasserstände in der Kopfzeile. Die Kopfzeile probiert
/// mehrere Durchmesser durch (siehe `DashboardView.headerRow`), Abstand und
/// Ringmaße bleiben dabei fest — deshalb liegen sie hier und nicht als
/// Literale in der View.
enum MiniGaugeMetrics {
    /// Luft zwischen Wasserkreis und Sitzungsring, damit ein roter Ring auf
    /// roter Wasserfläche nicht zu einem Klumpen verschmilzt
    static let ringGap: CGFloat = 1
    /// Strichstärke des Sitzungsrings
    static let ringWidth: CGFloat = 1.6
    /// Abstand zwischen zwei Miniaturen
    static let spacing: CGFloat = 3

    /// Platzbedarf einer Miniatur inklusive Ring
    static func footprint(_ diameter: CGFloat) -> CGFloat {
        diameter + 2 * (ringGap + ringWidth)
    }
}

/// Ein Konto in der Kopfzeile: **Wasserstand = Woche, Ring = Sitzung**.
///
/// Dieselbe Aussage wie der frühere Ampelpunkt, nur nicht mehr in drei Stufen
/// gerastert: Der Pegel steigt mit der Wochen-Auslastung und läuft dabei durch
/// dieselbe vierstufige `DashboardPalette` wie die großen Anzeigen auf den
/// Karten — blau, gelb, orange, ab 90 % rot und randvoll. Sechs Konten
/// nebeneinander sagen so auf einen Blick, wie viel Woche noch übrig ist,
/// statt nur „grün / blau / rot".
///
/// · leerer bis halbvoller blauer Kreis → Woche hat Luft
/// · roter, fast voller Kreis           → Woche praktisch durch
/// · roter Ring außen                   → 5-Stunden-Fenster aufgebraucht
/// · grauer, leerer Kreis               → noch keine Daten
///
/// Der Ring liegt außen auf dem vollen Platzbedarf, die Wasserfläche behält
/// ihre Größe — so bleibt die Reihe ruhig, egal wie viele Ringe an sind.
struct MiniWaterGauge: View {
    /// Wochen-Auslastung (0–100), `nil` = keine Daten
    let weeklyUtilization: Double?
    /// Sitzungsfenster praktisch aufgebraucht?
    let sessionExhausted: Bool
    var diameter: CGFloat = 16
    /// Farbreihe des Anbieters (Codex läuft in Blau, siehe `DashboardPalette`)
    var provider: ProviderType = .claude

    private var clamped: Double? {
        weeklyUtilization.map { min(100, max(0, $0)) }
    }

    var body: some View {
        ZStack {
            water
            if sessionExhausted {
                Circle().strokeBorder(Color.red, lineWidth: MiniGaugeMetrics.ringWidth)
            }
        }
        .frame(
            width: MiniGaugeMetrics.footprint(diameter),
            height: MiniGaugeMetrics.footprint(diameter)
        )
    }

    private var water: some View {
        ZStack {
            Circle().fill(Color(NSColor.windowBackgroundColor))

            if let clamped {
                WaterShape(level: clamped / 100.0)
                    .fill(DashboardPalette.fill(clamped, provider: provider))
                    .clipShape(Circle())
            } else {
                // Ohne Daten ein durchgehend mattes Grau statt eines leeren
                // Kreises: Bei 11 pt wäre „noch nichts geladen" sonst nicht von
                // „Woche frisch, 2 %" zu unterscheiden — beide fast leer.
                Circle().fill(Color.secondary.opacity(0.32))
            }

            Circle().strokeBorder(Color.primary.opacity(0.16), lineWidth: 1)
        }
        .frame(width: diameter, height: diameter)
        .animation(.easeInOut(duration: 0.45), value: clamped)
    }
}

// MARK: - Wasserstand

/// Kreis, der sich wie ein Gefäß füllt — der Pegel ist die Auslastung des
/// Sitzungsfensters (5 Stunden bzw. Codex primary).
///
/// Die Prozentzahl wird zweimal gezeichnet: einmal in der Textfarbe, einmal in Weiß
/// und auf die Wasserfläche beschnitten. Dadurch schneidet die Wellenlinie mitten
/// durch die Ziffern, statt dass die Zahl an einem Schwellwert umspringt — und sie
/// bleibt in jedem Füllstand lesbar.
struct WaterLevelGauge: View {
    let percentage: Double
    let caption: String
    var diameter: CGFloat = 74
    /// Farbreihe des Anbieters (Codex läuft in Blau, siehe `DashboardPalette`)
    var provider: ProviderType = .claude

    private var clamped: Double { min(100, max(0, percentage)) }

    var body: some View {
        ZStack {
            Circle().fill(Color(NSColor.windowBackgroundColor))

            WaterShape(level: clamped / 100.0)
                .fill(DashboardPalette.fill(clamped, provider: provider))
                .clipShape(Circle())

            Circle().strokeBorder(Color.primary.opacity(0.18), lineWidth: 1)

            numberStack(color: DashboardPalette.ink(clamped, provider: provider))
            numberStack(color: DashboardPalette.onFill)
                .clipShape(WaterShape(level: clamped / 100.0))
        }
        .frame(width: diameter, height: diameter)
        .animation(.easeInOut(duration: 0.45), value: clamped)
    }

    private func numberStack(color: Color) -> some View {
        VStack(spacing: 0) {
            // Normale Systemschrift statt Schreibmaschinenschnitt; `monospacedDigit`
            // hält die Ziffern trotzdem in Spur, wenn der Wert springt.
            Text("\(Int(clamped.rounded()))%")
                .font(.system(size: diameter * 0.19, weight: .semibold).monospacedDigit())
                .foregroundColor(color)
            Text(caption)
                .font(.system(size: diameter * 0.11))
                .foregroundColor(color.opacity(0.75))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: diameter * 0.8)
        }
    }
}

/// Wasserfläche mit leichter Welle an der Oberkante.
/// `level` 0…1 misst von unten: 0 bleibt leer, 1 ist randvoll.
struct WaterShape: Shape {
    var level: Double

    var animatableData: Double {
        get { level }
        set { level = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard level > 0 else { return path }

        // Die Welle braucht oben und unten Luft, damit sie bei 0 % und 100 %
        // nicht über den Rand schwappt.
        let waveHeight = min(rect.height * 0.035, 3.0)
        let surfaceY = rect.maxY - (rect.height - waveHeight * 2) * level - waveHeight

        path.move(to: CGPoint(x: rect.minX, y: surfaceY))
        path.addQuadCurve(
            to: CGPoint(x: rect.midX, y: surfaceY),
            control: CGPoint(x: rect.width * 0.25, y: surfaceY - waveHeight)
        )
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: surfaceY),
            control: CGPoint(x: rect.width * 0.75, y: surfaceY + waveHeight)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}
