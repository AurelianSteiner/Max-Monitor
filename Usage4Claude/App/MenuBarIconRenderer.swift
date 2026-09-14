//
//  MenuBarIconRenderer.swift
//  Usage4Claude
//
//  Created by Claude Code on 2025-12-02.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI
import AppKit

/// 菜单栏图标渲染器
/// Zeichnet die Wasserstand-Reihe der Menüleiste: ein kleines Gefäß je Konto,
/// der Pegel steigt mit der Wochen-Auslastung. Die frühere Ring-/Prozent-
/// Darstellung des aktuellen Kontos ist mit der Umstellung auf die Punktreihe
/// komplett entfallen.
class MenuBarIconRenderer {

    // MARK: - Settings Reference

    /// 用户设置实例
    private let settings: UserSettings
    /// 菜单栏指标图标尺寸
    private let metricIconSize: CGFloat = 18

    // MARK: - Initialization

    init(settings: UserSettings = .shared) {
        self.settings = settings
    }

    // MARK: - Public API

    /// Baut das Statusleisten-Symbol aus den übergebenen Punktzuständen.
    ///
    /// `MenuBarUI` liefert entweder die echten Zustände aus `MenuBarAccountDots`
    /// oder — solange noch kein Konto Daten gemeldet hat — graue Platzhalter,
    /// damit die Menüleiste nie leer aussieht.
    ///
    /// Für die Wasserstände zählt allein die Theme-Wahl: die Farben kommen aus
    /// der `DashboardPalette`, im Einfarbig-Modus färbt macOS das Template-Bild
    /// selbst ein.
    func createIcon(
        states: [MenuBarDotState],
        hasUpdate: Bool,
        button: NSStatusBarButton?
    ) -> NSImage {
        let isMonochrome = settings.iconStyleMode == .monochrome
        var icon = createAccountDotsIcon(states: states, isMonochrome: isMonochrome, button: button)
        if hasUpdate { icon = addBadgeToImage(icon) }
        return icon
    }

    // MARK: - Account Dots (Punktreihe aller Konten)

    /// Maße der Menüleisten-Wasserstände. Bewusst kleiner als die Wasserstände
    /// der Übersicht (`MiniGaugeMetrics`): hier zählt jeder Punkt Breite. Fünf
    /// Konten belegen so ~85 pt — kompakt genug für MacBooks mit Notch, wo
    /// macOS zu breite Statusleisten-Symbole ausblendet, aber groß genug, dass
    /// der Pegel als Pegel lesbar ist.
    private enum AccountDotMetrics {
        /// Durchmesser der Wasserfläche (Wochenpegel)
        static let fillDiameter: CGFloat = 10.5
        /// Luft zwischen Fläche und Sitzungsring
        static let ringGap: CGFloat = 1
        /// Strichstärke des Sitzungsrings
        static let ringWidth: CGFloat = 1
        /// Abstand zwischen zwei Punkten
        static let spacing: CGFloat = 3
        /// Platzbedarf eines Punkts inklusive Ring (7,5 + 2 × (1 + 1) = 11,5)
        static var footprint: CGFloat { fillDiameter + 2 * (ringGap + ringWidth) }

        // Wach-Kapsel: Umriss um die ganze Punktreihe, solange „Bleib wach"
        // aktiv ist — ein Blick auf die Menüleiste genügt dann.
        /// Strichstärke der Kapsel
        static let capsuleLineWidth: CGFloat = 1.5
        /// Luft zwischen Punktreihe und Kapsel-Innenkante
        static let capsuleGap: CGFloat = 2
        /// Zusätzlicher Rand des Bilds je Seite, damit die Kapsel nicht
        /// beschnitten wird (Luft + volle Strichstärke)
        static var capsuleInset: CGFloat { capsuleGap + capsuleLineWidth }
    }

    /// Zeichnet eine Wasserstand-Reihe: ein kleines Gefäß je Konto, der Pegel
    /// steigt mit der Wochen-Auslastung — dieselbe Darstellung wie die
    /// Kopfzeile der Übersicht, nur kleiner.
    ///
    /// Die Reihenfolge kommt fertig sortiert aus `MenuBarAccountDots` und ist
    /// **dieselbe wie in der Übersicht** (`AccountUsageSnapshot.ordered(_:mode:)`):
    /// im Standardmodus das freieste Konto links, das vollste rechts. Hier wird
    /// nur noch von links nach rechts gezeichnet, nicht mehr umsortiert.
    /// - Parameters:
    ///   - states: Zustände aus `MenuBarAccountDots` (gerasterter Wochenpegel,
    ///     in Anzeigereihenfolge)
    ///   - isMonochrome: Einfarbig-Modus → Template-Bild ohne Farbe
    private func createAccountDotsIcon(
        states: [MenuBarDotState],
        isMonochrome: Bool,
        button: NSStatusBarButton?
    ) -> NSImage {
        let footprint = AccountDotMetrics.footprint
        let height = metricIconSize
        let dotsWidth = max(
            CGFloat(states.count) * footprint
                + CGFloat(max(0, states.count - 1)) * AccountDotMetrics.spacing,
            footprint
        )

        // „Bleib wach" aktiv → Kapsel um die ganze Reihe. Das Bild bekommt
        // dafür links und rechts etwas Rand, sonst würde der Strich beschnitten.
        // Der Cache-Key in `MenuBarUI.generateCacheKey` enthält dieses Flag,
        // sonst klebte das alte Bild nach dem Umschalten fest.
        let keepAwake = SleepGuard.shared.isAwake
        let inset = keepAwake ? AccountDotMetrics.capsuleInset : 0
        let width = dotsWidth + 2 * inset

        let image = NSImage(size: NSSize(width: width, height: height))
        image.lockFocus()

        // Dynamische Systemfarben (systemGreen, labelColor …) lösen sich nach der
        // *aktuellen* Zeichen-Appearance auf. Ohne diesen Wechsel zöge die Fenster-
        // statt der Menüleisten-Darstellung, und die Punkte wären im dunklen Modus
        // zu blass.
        let appearance = button?.effectiveAppearance ?? NSApp.effectiveAppearance
        appearance.performAsCurrentDrawingAppearance {
            drawAccountDots(states, isMonochrome: isMonochrome, height: height, xOffset: inset)
            if keepAwake {
                drawKeepAwakeCapsule(width: width, height: height, isMonochrome: isMonochrome)
            }
        }

        image.unlockFocus()
        // Einfarbig = Template-Bild: macOS wertet nur die Deckkraft aus und färbt
        // selbst ein. Farbe wäre dort wirkungslos, deshalb codiert im Einfarbig-Modus
        // die *Füllung* den Zustand (siehe `drawAccountDots`).
        image.isTemplate = isMonochrome
        return image
    }

    /// Kapsel-Umriss um die gesamte Wasserstand-Reihe — das Menüleisten-Zeichen
    /// für „Bleib wach". Farbe: Orange im Farbmodus (warm, passt zum Maskottchen,
    /// kollidiert nicht mit der Blau-bis-Rot-Palette der Pegel), `labelColor`
    /// im Einfarbig-/Template-Modus (macOS färbt selbst ein).
    private func drawKeepAwakeCapsule(width: CGFloat, height: CGFloat, isMonochrome: Bool) {
        let lineWidth = AccountDotMetrics.capsuleLineWidth
        let capsuleHeight = AccountDotMetrics.footprint + 2 * AccountDotMetrics.capsuleGap
        let rect = NSRect(
            x: lineWidth / 2,
            y: (height - capsuleHeight) / 2,
            width: width - lineWidth,
            height: capsuleHeight
        )
        let capsule = NSBezierPath(roundedRect: rect, xRadius: capsuleHeight / 2, yRadius: capsuleHeight / 2)
        capsule.lineWidth = lineWidth
        (isMonochrome ? NSColor.labelColor : NSColor.systemOrange).setStroke()
        capsule.stroke()
    }

    private func drawAccountDots(_ states: [MenuBarDotState], isMonochrome: Bool, height: CGFloat, xOffset: CGFloat = 0) {
        let footprint = AccountDotMetrics.footprint
        let fill = AccountDotMetrics.fillDiameter
        let centerY = height / 2
        var x: CGFloat = xOffset

        for state in states {
            let centerX = x + footprint / 2
            let fillRect = NSRect(
                x: centerX - fill / 2,
                y: centerY - fill / 2,
                width: fill,
                height: fill
            )

            // Wasserstand wie in der Kopfzeile der Übersicht (`MiniWaterGauge`):
            // ein Gefäß-Umriss, in dem der Pegel mit der Wochen-Auslastung von
            // unten nach oben steigt — dieselbe vierstufige `DashboardPalette`,
            // damit Menüleiste und Übersicht nie verschiedene Farben zeigen.
            // NSBezierPath zeichnet y-aufwärts, „von unten füllen" ist hier also
            // schlicht ein Rechteck ab `minY`. Die Welle der großen Anzeigen
            // entfällt: Bei ~10 pt wäre sie kleiner als ein halbes Pixel.
            if let utilization = state.weeklyUtilization {
                let level = min(100, max(0, utilization)) / 100
                let water = NSRect(
                    x: fillRect.minX,
                    y: fillRect.minY,
                    width: fillRect.width,
                    height: fillRect.height * CGFloat(level)
                )

                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(ovalIn: fillRect).addClip()
                if isMonochrome {
                    // Template-Bild: macOS wertet nur die Deckkraft aus und
                    // färbt selbst ein — der Pegel bleibt trotzdem ablesbar.
                    NSColor.labelColor.setFill()
                } else {
                    DashboardPalette.nsFill(utilization, provider: state.provider).setFill()
                }
                NSBezierPath(rect: water).fill()
                NSGraphicsContext.restoreGraphicsState()

                let rim = NSBezierPath(ovalIn: fillRect.insetBy(dx: 0.5, dy: 0.5))
                rim.lineWidth = 1
                NSColor.labelColor.withAlphaComponent(isMonochrome ? 0.45 : 0.32).setStroke()
                rim.stroke()
            } else {
                // Noch keine Daten → durchgehend mattes Grau statt eines leeren
                // Gefäßes, wie beim `MiniWaterGauge`: „nichts geladen" darf
                // nicht aussehen wie „Woche frisch, 2 %".
                if isMonochrome {
                    NSColor.labelColor.withAlphaComponent(0.35).setFill()
                } else {
                    NSColor.secondaryLabelColor.withAlphaComponent(0.5).setFill()
                }
                NSBezierPath(ovalIn: fillRect).fill()
            }

            if state.sessionExhausted {
                // Sitzungsfenster aufgebraucht → Ring außen, genau wie beim
                // Wasserstand der Übersicht: Pegel = Woche, Ring = Sitzung.
                let ringDiameter = footprint - AccountDotMetrics.ringWidth
                let ringRect = NSRect(
                    x: centerX - ringDiameter / 2,
                    y: centerY - ringDiameter / 2,
                    width: ringDiameter,
                    height: ringDiameter
                )
                let ringPath = NSBezierPath(ovalIn: ringRect)
                ringPath.lineWidth = AccountDotMetrics.ringWidth
                (isMonochrome ? NSColor.labelColor : NSColor.systemRed).setStroke()
                ringPath.stroke()
            }

            x += footprint + AccountDotMetrics.spacing
        }
    }

    // MARK: - Badge

    /// 在图标上添加徽章（小红点）
    private func addBadgeToImage(_ baseImage: NSImage) -> NSImage {
        let size = baseImage.size
        let expandedSize = NSSize(width: size.width + 2.5, height: size.height + 2.5)
        let badgedImage = NSImage(size: expandedSize)

        badgedImage.lockFocus()
        baseImage.draw(in: NSRect(origin: .zero, size: size))

        let badgeRadius: CGFloat = 2.0
        let badgeDiameter = badgeRadius * 2
        let badgeX = expandedSize.width - badgeDiameter - 1.5
        let badgeY = expandedSize.height - badgeDiameter - 1.5
        let badgeRect = NSRect(x: badgeX, y: badgeY, width: badgeDiameter, height: badgeDiameter)

        NSGraphicsContext.saveGraphicsState()
        NSColor.systemRed.setFill()
        NSBezierPath(ovalIn: badgeRect).fill()
        NSGraphicsContext.restoreGraphicsState()

        badgedImage.unlockFocus()
        badgedImage.isTemplate = baseImage.isTemplate

        return badgedImage
    }

}
