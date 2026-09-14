//
//  AwakeMascotView.swift
//  Usage4Claude
//
//  Die Maskottchen-Parade im Kopf der Übersicht: Solange „Claude Always On"
//  aktiv ist, laufen kleine Pixel-Wesen von links nach rechts durch einen
//  schmalen Streifen — links blenden sie ein, rechts aus. Ist der Modus aus,
//  bleibt der Streifen leer.
//
//  Seit 2.8 richtet sich die Besetzung nach den Konten (`MascotRoster`): Jedes
//  Claude-Konto schickt einen korallenfarbenen Claudie, jedes Codex-Konto ein
//  blaues Codex-Pet mit Prompt-Gesicht (`>_`), und es sind nie mehr Wesen
//  gleichzeitig unterwegs, als Konten eingetragen sind (`MascotParadeTiming`).
//
//  Seit die Wasserstände der Konten in die Kopfzeile gewandert sind, gehört der
//  Parade die ganze Zeilenbreite: Sie läuft von ganz links nach ganz rechts und
//  teilt sich den Platz nicht mehr mit einer Punktreihe.
//
//  Die kleine Parade-Engine: Jeder Läufer ist eine Nummer im unendlichen
//  Strom. Aus der Nummer werden deterministisch (Splitmix-Hash) sein
//  Startzeitpunkt (Abstände zufällig zwischen ~3,0 s und ~4,2 s bei voller
//  Besetzung — nie so knapp, dass zwei aufeinandersitzen; bei wenigen Konten
//  entsprechend weiter) und sein Kostüm abgeleitet: Die Hälfte
//  läuft normal, die andere Hälfte fällt auf — Partyhut, Zylinder, ein
//  Raucher mit Rauchfahne, ein Sprinter, der alle überholt, einer, der
//  seelenruhig rückwärts stapft, und einer, der im kleinen roten Auto an
//  allen vorbeirollt. Dazu patrouilliert etwa jede Minute ein hüpfender
//  Sheriff mit Colt im Halfter — gezogen wird öfter, geschossen nur
//  manchmal (siehe `MascotIncident`).
//  Alle Normalen laufen exakt gleich schnell, damit die Abstände stabil
//  bleiben und niemand auf den Vordermann aufläuft.
//
//  Die Startabstände sind größer als in 2.2. Grund ist der seltene
//  Zwischenfall (`MascotIncident`): Dort bleiben Läufer kurz stehen, und jede
//  Standsekunde frisst 26 pt Abstand. Die Lücke muss das auffangen können,
//  sonst liefe der Hintermann in den Vordermann. Weil die Parade zugleich über
//  die volle Breite läuft statt über 300 pt, sind trotzdem mehr Wesen
//  gleichzeitig zu sehen als vorher.
//
//  Technik: `TimelineView(.periodic)` treibt eine reine Funktion der Uhrzeit —
//  kein eigener Timer, kein gespeicherter Zustand, nichts läuft, wenn die
//  Ansicht unsichtbar ist. Die Wesen sind einzelne Canvas-Rechtecke im festen
//  Pixelraster (Zelle 4 pt) — eigenes Sprite, kein fremdes Bildmaterial,
//  nur an Claudes Pixel-Look angelehnt.
//
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI

struct AwakeMascotView: View {

    @ObservedObject private var sleepGuard = SleepGuard.shared

    /// Wer mitläuft: ein Läufer je Konto, Art nach Anbieter
    let roster: MascotRoster
    /// Breite, auf die die Obergrenze „nie mehr Läufer als Konten" gerechnet
    /// wird — die Wunschbreite aus der Spaltenwahl, nicht die Live-Breite
    /// (Begründung in `MascotParadeTiming`).
    let referenceWidth: CGFloat

    static let height: CGFloat = 34

    init(roster: MascotRoster = MascotRoster(claudeCount: 1, codexCount: 0),
         referenceWidth: CGFloat = 400) {
        self.roster = roster
        self.referenceWidth = referenceWidth
    }

    private var timing: MascotParadeTiming {
        MascotParadeTiming.capped(
            walkers: roster.walkerCap,
            width: Double(referenceWidth),
            speed: MascotParadeCanvas.baseSpeed,
            overshoot: Double(MascotParadeCanvas.overshoot)
        )
    }

    var body: some View {
        Group {
            if sleepGuard.isAwake {
                TimelineView(.periodic(from: .now, by: 0.1)) { timeline in
                    MascotParadeCanvas(
                        time: timeline.date.timeIntervalSinceReferenceDate,
                        roster: roster,
                        timing: timing
                    )
                }
            } else {
                // Aus = leerer Streifen (gleiche Größe, damit der Kopf nicht springt)
                Color.clear
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Self.height)
        .clipped()   // Rauch, Hüte und der aufsteigende Grabstein bleiben im Streifen
        .help(sleepGuard.isAwake ? L.Dashboard.mascotAwakeHelp : L.Dashboard.mascotAsleepHelp)
        .accessibilityLabel(sleepGuard.isAwake ? L.Dashboard.mascotAwakeHelp : L.Dashboard.mascotAsleepHelp)
    }
}

// MARK: - Parade-Engine

/// Art eines Läufers. `internal`, damit der Vorschau-Renderer im Modul die
/// Varianten einzeln zeichnen kann.
enum MascotVariant {
    case normal
    case partyHat
    case topHat
    case smoker
    case sprinter
    /// Läuft verkehrt herum — kommt von rechts und schaut nach links
    case backwards
    /// Der Sheriff: Cowboyhut, goldener Stern, Colt im Halfter, hüpft beim
    /// Patrouillieren. Zieht gelegentlich zum Angeben — und ungefähr jeder
    /// fünfte schießt wirklich (siehe `MascotIncident`).
    case sheriff
    /// Fährt im kleinen roten Auto durch die Parade — wem das Laufen zu
    /// langsam ist, der überholt eben alle.
    case driver
}

/// Haltung eines Läufers. Trennt sich bewusst von `MascotVariant`: Die Variante
/// sagt, *wer* jemand ist (und hängt nur an seiner Nummer), die Haltung sagt,
/// *was er gerade tut* (und hängt an der Uhrzeit).
enum MascotPose: Equatable {
    /// Läuft — Beinchen wechseln
    case walking
    /// Steht still
    case standing
    /// Zielt; `facingLeft` dreht das Wesen um
    case aiming(facingLeft: Bool)
    /// Steht am Grab und weint
    case mourning
}

/// Eine Momentaufnahme der Parade. Alle Maße leben im Pixelraster (Zelle 4 pt);
/// die Läufer verteilen sich über die tatsächliche Breite.
struct MascotParadeCanvas: View {

    let time: TimeInterval
    /// Besetzung — bestimmt Art (Claudie/Codex-Pet) je Nummer
    var roster = MascotRoster(claudeCount: 1, codexCount: 0)
    /// Startabstände — gestreckt, wenn wenige Konten mitlaufen
    var timing = MascotParadeTiming.base

    static let cell: CGFloat = 4

    // Korallen-Pixel, an Claudes Pixel-Look angelehnt, plus Deko-Töne
    static let coral = Color(red: 0.910, green: 0.573, blue: 0.486)     // #e8927c
    static let coralDark = Color(red: 0.753, green: 0.416, blue: 0.333) // #c06a55
    static let faceInk = Color(red: 0.227, green: 0.122, blue: 0.086)   // #3a1f16
    // Das Codex-Pet: Blau wie die Codex-Farbreihe der Karten, helle
    // Terminalschrift fürs Prompt-Gesicht
    static let codexBody = Color(red: 0.322, green: 0.588, blue: 0.886) // #5296e2
    static let codexDark = Color(red: 0.180, green: 0.400, blue: 0.741) // #2e66bd
    static let codexFace = Color(red: 0.925, green: 0.957, blue: 1.0)   // #ecf4ff
    static let partyPink = Color(red: 0.855, green: 0.353, blue: 0.545) // Partyhut
    static let partyTip = Color(red: 0.980, green: 0.800, blue: 0.235)  // Bommel & Sheriffstern
    static let hatBlack = Color(red: 0.16, green: 0.16, blue: 0.19)     // Zylinder
    static let sheriffHat = Color(red: 0.478, green: 0.322, blue: 0.184)     // Cowboyhut, Leder
    static let sheriffHatDark = Color(red: 0.361, green: 0.235, blue: 0.129) // Krempe & Halfter
    static let carBody = Color(red: 0.769, green: 0.259, blue: 0.231)   // das kleine Auto
    static let carDark = Color(red: 0.573, green: 0.161, blue: 0.145)
    static let wheel = Color(red: 0.13, green: 0.13, blue: 0.15)
    static let smoke = Color.secondary

    // Taktung der Parade. Die Startabstände (früher fest 3,6 s / 3,0 s) leben
    // in `MascotParadeTiming` und hängen an der Kontenzahl.
    static let baseSpeed: Double = 26        // pt/s, alle Normalen exakt gleich
    static let sprintSpeed: Double = 74      // der Eilige
    static let carSpeed: Double = 96         // das Auto überholt sogar den
    static let stepsPerSecond: Double = 4
    static let fadeZone: CGFloat = 34
    static let spriteWidth: CGFloat = 32
    static let overshoot: CGFloat = 36

    // MARK: Deterministischer Zufall (Splitmix64)

    /// Stabiler Pseudozufall 0…1 aus Läufer-Nummer und Salz — keine gespeicherten
    /// Zustände, dieselbe Nummer würfelt immer dasselbe. Die Rechnung selbst
    /// liegt in `MascotRandom` (ohne SwiftUI, damit `swift test` sie prüfen kann).
    static func roll(_ index: Int, _ salt: UInt64) -> Double {
        MascotRandom.roll(index, salt)
    }

    /// Je 10 % für die klassischen Sonderformen, 8 % fürs Auto, gut 40 %
    /// laufen ganz normal — und der Sheriff kommt obendrauf
    /// (siehe `MascotIncident.sheriffChance`).
    static func variant(_ index: Int) -> MascotVariant {
        // Der Schütze ist immer der Sheriff, das Opfer läuft unauffällig: Ein
        // Sprinter als Opfer wäre vor dem Schuss längst über alle Berge. Die
        // Regel hängt nur an der Nummer — beide laufen also von Anfang an so,
        // und beim Beginn des Vorfalls springt nichts um.
        if let role = MascotIncident.role(of: index) {
            return role == .shooter ? .sheriff : .normal
        }

        // Sheriffs, die nur nach dem Rechten schauen. Vor den übrigen
        // Sonderformen, damit ein Sheriff nie zugleich Sprinter oder
        // Rückwärtsläufer ist — er muss im Takt der Normalen patrouillieren.
        if MascotIncident.isSheriff(index) { return .sheriff }

        let r = roll(index, 7)
        if r < 0.10 { return .partyHat }
        if r < 0.20 { return .topHat }
        if r < 0.30 { return .smoker }
        if r < 0.40 { return .sprinter }
        if r < 0.50 { return .backwards }
        if r < 0.58 { return .driver }
        return .normal
    }

    // MARK: Zeichnen

    var body: some View {
        Canvas { context, size in
            guard size.width > 4 else { return }
            let span = Double(size.width + Self.overshoot * 2)
            let incident = MascotIncident.active(at: time, width: size.width, timing: timing)

            // Matsch und Grabstein liegen hinter allen Läufern — die Trauernden
            // gehen davor vorbei, nicht dahinter. Der Matsch trägt die Farbe des
            // Opfers: koralle für einen Claudie, blau für ein Codex-Pet.
            if let incident {
                MascotIncident.drawGround(in: context, incident: incident,
                                          species: roster.species(for: incident.victimIndex))
            }

            // Nur die Nummern anschauen, die jetzt überhaupt sichtbar sein können:
            // Langsamste Reisezeit rückwärts vom aktuellen Zeitpunkt, plus die
            // längste Pause, die ein Zwischenfall verursachen kann.
            let slowestTravel = span / Self.baseSpeed + MascotIncident.maxHold
            let newest = Int((time / timing.interval).rounded(.down)) + 1
            let oldest = Int(((time - slowestTravel - 1) / timing.interval).rounded(.down))

            for index in oldest...newest {
                let spawn = timing.spawnTime(index)
                let rawElapsed = time - spawn
                guard rawElapsed > 0 else { continue }

                let role = MascotIncident.role(of: index)
                let species = roster.species(for: index)

                // Das Opfer übernimmt ab seinem Halt die Vorfall-Logik: erst
                // stehen, dann kippen, dann ausblenden. Danach steht dort nur
                // noch Matsch bzw. der Grabstein.
                if role == .victim, let incident, incident.victimIndex == index {
                    MascotIncident.drawVictim(in: context, incident: incident,
                                              time: time, seed: index, species: species)
                    continue
                }

                let kind = Self.variant(index)
                let speed = kind == .sprinter ? Self.sprintSpeed
                    : (kind == .driver ? Self.carSpeed : Self.baseSpeed)

                // Pause am Grab bzw. beim Zielen. Sie zieht nur *vergangene*
                // Standzeit ab, deshalb bleibt die Position stetig.
                let hold = MascotIncident.pause(for: index, role: role, incident: incident,
                                                spawn: spawn, speed: speed)
                var elapsed = rawElapsed
                var isHolding = false
                if let hold {
                    elapsed -= min(hold.length, max(0, time - hold.start))
                    isHolding = time >= hold.start && time < hold.start + hold.length
                }

                let x = CGFloat(elapsed * speed) - Self.overshoot
                guard x < size.width + Self.overshoot else { continue }

                var alpha: Double = 1
                if x < Self.fadeZone {
                    alpha = max(0, Double(x / Self.fadeZone))
                }
                let rightStart = size.width - Self.fadeZone - Self.spriteWidth
                if x > rightStart {
                    alpha = min(alpha, max(0, Double((size.width - Self.spriteWidth - x) / Self.fadeZone)))
                }
                guard alpha > 0.02 else { continue }

                // Wer steht, zielt (der Schütze, nach links zum Opfer) oder
                // trauert (alle anderen).
                let pose: MascotPose
                if isHolding {
                    pose = role == .some(.shooter) ? .aiming(facingLeft: true) : .mourning
                } else {
                    pose = .walking
                }

                let stepRate = kind == .sprinter ? Self.stepsPerSecond * 2.2 : Self.stepsPerSecond
                let step = Int(time * stepRate + Double(index) * 0.7) % 2 == 0
                Self.drawWalker(in: context, x: x, step: step, alpha: alpha,
                                variant: kind, time: time, seed: index,
                                species: species, pose: pose)
            }

            // Mündungsfeuer und Geschosse liegen vor allem anderen
            if let incident {
                MascotIncident.drawShots(in: context, incident: incident, timing: timing,
                                         species: roster.species(for: incident.victimIndex))
            }
        }
    }

    // MARK: Ein Läufer

    /// Zeichnet einen Läufer bei `x` (linke Kante). `internal` für den
    /// Vorschau-Renderer und die Vorfall-Logik; die Engine oben ist der
    /// gewöhnliche Aufrufer.
    ///
    /// - Parameters:
    ///   - species: Claudie (koralle, zwei Augen) oder Codex-Pet (blau,
    ///     Prompt-Gesicht `>_` mit blinkendem Cursor). Kostüme (Hüte, Auto,
    ///     Sheriffstern) sitzen auf beiden gleich, der Körperblock ist derselbe.
    ///   - pose: Was er gerade tut. `.walking` ist der Normalfall; die übrigen
    ///     Haltungen stehen still und tauchen nur im seltenen Zwischenfall auf.
    ///   - collapse: 0 = steht aufrecht, 1 = liegt platt am Boden. Dazwischen
    ///     kippt und staucht sich das Wesen um seine Füße herum. Nur das
    ///     getroffene Opfer nutzt das.
    static func drawWalker(in ctx: GraphicsContext, x: CGFloat, step: Bool,
                           alpha: Double, variant: MascotVariant,
                           time: TimeInterval, seed: Int,
                           species: MascotSpecies = .claudie,
                           pose: MascotPose = .walking, collapse: Double = 0) {
        var walker = ctx
        walker.opacity = alpha

        // Körperfarben nach Art — alles Weitere (Hüte, Auto, Rauch) ist artneutral
        let body = species == .codex ? codexBody : coral
        let bodyDark = species == .codex ? codexDark : coralDark

        // Leichtes Hüpfen im Schritt-Takt; Grundlinie so, dass die Beinchen
        // am unteren Rand des 24-pt-Streifens aufsetzen. Wer steht, hüpft nicht —
        // außer beim Schluchzen, das ist ein halber Punkt Bewegung.
        var baseline: CGFloat
        switch pose {
        case .walking:  baseline = step ? 12.0 : 13.0
        case .mourning: baseline = step ? 12.5 : 13.0
        default:        baseline = 13.0
        }

        // Der Sheriff hüpft beim Patrouillieren: alle gut zwei Sekunden ein
        // kleiner Bogen. Reine Funktion der Uhrzeit, Phase je Nummer versetzt —
        // zwei Sheriffs im Bild hüpfen also nie synchron. Nur die Höhe ändert
        // sich, nie die x-Position, deshalb bleiben die Abstände stabil.
        if variant == .sheriff, pose == .walking, collapse == 0 {
            let period = 2.3
            let phase = (time + roll(seed, 37) * period).truncatingRemainder(dividingBy: period)
            let airtime = 0.55
            if phase < airtime {
                baseline -= CGFloat(sin(phase / airtime * .pi)) * 5
            }
        }

        // Ein Auto wippt nicht im Schritt-Takt — es rollt.
        if variant == .driver {
            baseline = 13.0
        }
        walker.translateBy(x: x, y: baseline)

        // Umkippen: bewusst kein starres Drehen um 90°. Das Sprite ist breiter
        // (32 pt) als hoch (24 pt) — flach gedreht stünde es *höher* als vorher
        // und ragte unten aus dem 34-pt-Streifen. Stattdessen sackt es zusammen:
        // ein kleiner Kipper, dazu in die Breite gezogen und flach gedrückt.
        // Das trifft auch besser, was danach kommt — ein Matschfleck.
        // Der Kipper bleibt klein: Über 38 pt Breite hebt schon ein flacher
        // Winkel die eine Seite so weit, dass aus dem Häufchen ein schräges
        // Brett wird. Das Anheben gleicht aus, dass die gekippte Fläche sonst
        // unter die Bodenlinie rutscht.
        let fall = min(1, max(0, collapse))
        if fall > 0 {
            walker.translateBy(x: 4 * cell, y: 5 * cell - 3 * fall)
            walker.rotate(by: .radians(0.16 * fall))
            walker.scaleBy(x: 1 + 0.2 * fall, y: 1 - 0.82 * fall)
            walker.translateBy(x: -4 * cell, y: -5 * cell)
        }

        // Sprinter legen sich in die Kurve: obere Reihen wandern nach vorn
        let lean: Double = (variant == .sprinter && pose == .walking) ? 0.22 : 0

        // Gespiegelt wird um die Sprite-Mitte (4 Zellen). Zwei Gründe dafür:
        // Der Rückwärtsläufer wandert mit dem Strom nach rechts, blickt und
        // stapft dabei aber nach links — als hätte er die Richtung verpasst.
        // Und der rechte Schütze dreht sich zum Zielen zum Opfer um.
        let facesLeft = (variant == .backwards && pose == .walking)
            || pose == .aiming(facingLeft: true)
        if facesLeft {
            walker.translateBy(x: 8 * cell, y: 0)
            walker.scaleBy(x: -1, y: 1)
        }

        func px(_ col: Double, _ row: Double, _ color: Color, _ w: Double = 1, _ h: Double = 1) {
            let shift = lean * (3 - row)
            let rect = CGRect(x: (col + shift) * cell, y: row * cell,
                              width: w * cell, height: h * cell)
            walker.fill(Path(rect), with: .color(color))
        }

        // Ohren-Nubs (der Zylinder verdeckt sie ohnehin fast)
        px(1, -1, body)
        px(6, -1, body)

        // Körperblock 8 × 4, Ecken frei, Kanten dunkler
        for row in 0..<4 {
            for col in 0..<8 {
                if row == 0 && (col == 0 || col == 7) { continue }
                let edge = (col == 0 || col == 7 || row == 3)
                px(Double(col), Double(row), edge ? bodyDark : body)
            }
        }

        switch species {
        case .claudie:
            // Augen — beim Weinen und beim Umkippen zugekniffen, sonst offen und
            // in Laufrichtung
            if pose == .mourning || fall > 0.3 {
                px(2.8, 1.3, faceInk, 1.4, 0.4)
                px(5.8, 1.3, faceInk, 1.4, 0.4)
            } else {
                px(3, 1, faceInk)
                px(6, 1, faceInk)
            }

        case .codex:
            // Prompt-Gesicht: ein „>" und dahinter der Cursor „_", der blinkt.
            // Die Spiegelung für Rückwärtsläufer und Schützen dreht das Zeichen
            // mit — es schaut immer in Laufrichtung, wie Claudies Augen.
            if pose == .mourning || fall > 0.3 {
                px(2.4, 1.3, codexFace, 1.4, 0.4)
                px(4.8, 1.3, codexFace, 1.4, 0.4)
            } else {
                px(2.3, 0.7, codexFace, 0.6, 0.6)
                px(2.9, 1.25, codexFace, 0.6, 0.6)
                px(2.3, 1.8, codexFace, 0.6, 0.6)
                // Blinken: Phase je Nummer versetzt, damit nicht alle im Takt zucken
                let blink = (time * 1.6 + roll(seed, 61)).truncatingRemainder(dividingBy: 1)
                if blink < 0.72 {
                    px(4.0, 1.85, codexFace, 1.7, 0.5)
                }
            }
        }

        // Beinchen: wechseln nur beim Gehen, sonst ruhiger Stand.
        // Der Fahrer hat keine — seine stecken im Auto, unten rollen Räder.
        if variant == .driver {
            // keine Beinchen
        } else if pose == .walking, fall == 0 {
            if step {
                px(1, 4, bodyDark)
                px(4.5, 4, bodyDark)
                px(6.5, 4.6, bodyDark, 0.9, 0.7)
            } else {
                px(1.5, 4.6, bodyDark, 0.9, 0.7)
                px(3.5, 4, bodyDark)
                px(6, 4, bodyDark)
            }
        } else {
            px(1, 4, bodyDark)
            px(6, 4, bodyDark)
        }

        drawPoseExtras(px: px, pose: pose, time: time, seed: seed)

        // Die Besonderen — Deko gibt es nur unterwegs; wer zielt, weint oder
        // umkippt, hat gerade anderes zu tun (Hüte bleiben trotzdem auf).
        switch variant {
        case .normal, .backwards:
            // Der Rückwärtsläufer braucht keine Deko: Die Spiegelung erledigt
            // den Gag schon.
            break

        case .partyHat:
            // Spitzer Hut mit Bommel, mittig über dem Kopf
            px(3.6, -3.2, partyPink, 0.8, 1)
            px(3.1, -2.3, partyPink, 1.8, 1)
            px(2.6, -1.5, partyPink, 2.8, 0.7)
            px(3.7, -3.8, partyTip, 0.6, 0.6)

        case .topHat:
            // Zylinder: breite Krempe, hohe Krone
            px(1.8, -1.6, hatBlack, 4.4, 0.6)
            px(2.6, -3.6, hatBlack, 2.8, 2.1)

        case .smoker:
            // Zigarette vorn am Gesicht, dahinter eine richtige Rauchfahne:
            // vier Wolken, die aufsteigen, größer werden und verwehen.
            px(8, 2, Color.white.opacity(0.9), 1.6, 0.6)
            px(9.6, 2, Color.orange, 0.5, 0.6)
            for puff in 0..<4 {
                let phase = (time * 0.5 + Double(puff) * 0.25 + roll(seed, 11))
                    .truncatingRemainder(dividingBy: 1)
                let puffAlpha = (1 - phase) * 0.7
                guard puffAlpha > 0.04 else { continue }
                let grow = 0.9 + phase * 1.4          // Wolke wächst beim Aufsteigen
                px(9.4 + Double(puff) * 0.4 + phase * 2.2,
                   1.4 - phase * 5.0,
                   smoke.opacity(puffAlpha), grow, grow)
            }

        case .sprinter:
            // Tempolinien hinter dem Eiligen — nur, wenn er auch eilt
            if pose == .walking {
                px(-1.6, 1, bodyDark.opacity(0.35), 1.2, 0.5)
                px(-2.6, 2.2, bodyDark.opacity(0.25), 1.4, 0.5)
            }

        case .sheriff:
            // Cowboyhut: breite Krempe, flache Krone — bewusst flach, damit
            // er beim Hüpfen nicht aus dem Streifen ragt. Bleibt beim Zielen
            // auf, wie alle Hüte.
            px(1.2, -1.5, sheriffHatDark, 5.6, 0.6)   // Krempe
            px(2.4, -2.7, sheriffHat, 3.2, 1.2)       // Krone
            px(2.4, -1.9, sheriffHatDark, 3.2, 0.4)   // Hutband
            // Der Sheriffstern — unübersehbar golden auf der Krone …
            px(3.4, -2.55, partyTip, 1.2, 0.9)
            px(3.7, -2.85, partyTip, 0.6, 0.35)
            // … und als Marke auf der Brust (Plus-Form: mehr Stern geben
            // vier Punkt Zellgröße nicht her).
            px(1.15, 1.95, partyTip, 0.9, 0.9)
            px(1.4, 1.65, partyTip, 0.4, 0.3)
            px(1.4, 2.85, partyTip, 0.4, 0.3)

            // Colt im Halfter an der Hüfte — und ab und zu zieht er ihn zum
            // Angeben in die Luft. Ziehen heißt noch lange nicht schießen:
            // Ob er wirklich abdrückt, entscheidet `MascotIncident.killChance`.
            if pose == .walking {
                px(6.6, 2.9, sheriffHatDark, 1.0, 1.3)              // Halfter
                let drawPeriod = 8.5
                let drawPhase = (time + roll(seed, 43) * drawPeriod)
                    .truncatingRemainder(dividingBy: drawPeriod)
                if drawPhase < 1.1 {
                    // Gezogen: Arm hoch, Lauf in die Luft
                    px(7.4, 0.9, faceInk, 0.5, 1.5)                 // Arm
                    px(7.1, 0.35, faceInk, 1.1, 0.55)               // Colt quer
                    px(7.35, -0.45, faceInk, 0.45, 0.8)             // Lauf nach oben
                } else {
                    px(6.8, 2.55, faceInk, 0.55, 0.6)               // Griff schaut raus
                }
            }

        case .driver:
            // Ein kleines rotes Blechauto ums Untergestell: Karosserie über
            // den Beinen, Räder darunter, Auspuffwölkchen hinterher. Der
            // Fahrer ist ein ganz normales Wesen, dem das Laufen zu langsam
            // wurde — Claudie oder Codex-Pet.
            px(-1.2, 2.4, carDark, 1.2, 1.4)                        // Heck
            px(-0.6, 2.7, carBody, 9.6, 1.7)                        // Karosserie
            px(8.4, 2.2, carBody, 0.9, 0.7)                         // Haube vorn
            px(8.15, 1.4, Color.white.opacity(0.4), 0.45, 1.0)      // Windschutzscheibe
            px(0.4, 4.1, wheel, 1.4, 1.2)                           // Hinterrad
            px(6.4, 4.1, wheel, 1.4, 1.2)                           // Vorderrad
            px(0.8, 4.45, Color.white.opacity(0.85), 0.5, 0.5)      // Radkappen
            px(6.8, 4.45, Color.white.opacity(0.85), 0.5, 0.5)
            // Auspuff: kleine Wölkchen, die hinten abreißen und verwehen
            for puff in 0..<3 {
                let phase = (time * 0.9 + Double(puff) * 0.33 + roll(seed, 41))
                    .truncatingRemainder(dividingBy: 1)
                let puffAlpha = (1 - phase) * 0.55
                guard puffAlpha > 0.04 else { continue }
                let grow = 0.7 + phase * 0.8
                px(-1.6 - phase * 2.4, 3.3 - phase * 1.1,
                   smoke.opacity(puffAlpha), grow, grow)
            }
        }
    }

    /// Was nur zu einer Haltung gehört: der Arm des Schützen, die Tränen des
    /// Trauernden. Ausgelagert, damit `drawWalker` nicht noch länger wird.
    private static func drawPoseExtras(
        px: (Double, Double, Color, Double, Double) -> Void,
        pose: MascotPose, time: TimeInterval, seed: Int
    ) {
        switch pose {
        case .walking, .standing:
            break

        case .aiming:
            // Ausgestreckter Arm mit gezogenem Colt plus finstere Brauen.
            // Die Spiegelung oben dreht alles mit, wenn er nach links zielt.
            px(8, 2.1, faceInk, 1.4, 0.5)                // Arm
            px(9.35, 1.95, faceInk, 1.0, 0.5)            // Lauf
            px(9.15, 2.45, faceInk, 0.45, 0.65)          // Griff
            px(2.7, 0.45, faceInk, 1.4, 0.3)
            px(5.7, 0.45, faceInk, 1.4, 0.3)

        case .mourning:
            // Zwei Tränen je Auge, versetzt, fallen und verblassen
            for drop in 0..<2 {
                let phase = (time * 1.1 + Double(drop) * 0.5 + roll(seed, 23))
                    .truncatingRemainder(dividingBy: 1)
                let dropAlpha = (1 - phase) * 0.95
                guard dropAlpha > 0.05 else { continue }
                let fall = 1.9 + phase * 2.4
                px(3.1, fall, MascotIncident.tear.opacity(dropAlpha), 0.5, 0.5)
                px(6.1, fall, MascotIncident.tear.opacity(dropAlpha), 0.5, 0.5)
            }
        }
    }
}
