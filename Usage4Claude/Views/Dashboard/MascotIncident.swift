//
//  MascotIncident.swift
//  Usage4Claude
//
//  Der Zwischenfall auf dem Laufsteg — jetzt mit Sheriff.
//
//  Regelmäßig (im Schnitt alle anderthalb Minuten) patrouilliert ein Sheriff
//  durch die Parade: Cowboyhut, goldener Stern, und er hüpft beim Gehen. Die
//  meisten Sheriffs schauen nur nach dem Rechten. Aber ungefähr jeder fünfte
//  zieht: Der Claudie hinter ihm bleibt mitten im Streifen stehen, der Sheriff
//  hält an, dreht sich um und schießt ihn ab. Er kippt um, zerplatzt zu orangem
//  Matsch, und ein paar Sekunden später wächst an der Stelle ein kleiner
//  Grabstein aus dem Boden. Der steht nur eine knappe Minute — eine kleine
//  Erinnerung, kein Denkmal. Alle, die in der Zeit vorbeikommen, bleiben kurz
//  davor stehen und weinen, bevor sie weitergehen.
//
//  Es schießt genau einer: der Sheriff, der als Vordermann des Opfers läuft.
//  Der Hintermann bekommt deshalb gar keine Rolle: Er ist ein gewöhnlicher
//  Vorbeikommender, hält am frisch Gefallenen und weint wie alle nach ihm.
//  Das ist nebenbei auch die ruhigere Variante — ein Schütze hinter dem Opfer
//  stünde länger als ein Trauernder und nähme dem Nächsten in der Reihe den
//  Abstand weg.
//
//  Warum das ohne gespeicherten Zustand geht: Die Parade ist eine reine Funktion
//  der Uhrzeit, und dieser Zwischenfall auch. Ob eine Läufer-Nummer ein Sheriff
//  ist und ob er zieht, entscheidet allein ihr Hash — nicht der Zufall des
//  Augenblicks. Das Opfer ist immer der Läufer direkt hinter einem ziehenden
//  Sheriff (`rawVictim`). Daraus folgt alles Weitere: wann der Vorfall beginnt
//  (wenn das Opfer die Mitte erreicht) und wie lange er dauert. Das Fenster kann zwischendurch zu sein,
//  der Rechner schlafen, die Ansicht neu gebaut werden — beim nächsten Blick
//  steht der Grabstein trotzdem an der richtigen Stelle und ist genau so alt,
//  wie er sein müsste.
//
//  Der heikle Teil sind die Pausen. Solange alle Läufer exakt gleich schnell
//  sind, bleiben ihre Abstände stabil und niemand läuft auf den Vordermann auf.
//  Steht jemand still, schrumpft die Lücke um `Pause × Tempo`. Deshalb ist die
//  Pause (a) für alle Trauernden gleich lang, (b) eine reine Funktion aus
//  Nummer und Vorfall — nie davon abhängig, wo der Läufer gerade steht, sonst
//  spränge seine Position in dem Moment, in dem der Grabstein auftaucht — und
//  (c) kurz genug, dass die vergrößerten Startabstände der Parade (siehe
//  `MascotParadeTiming.minInterval`) sie auffangen.
//
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI

// MARK: - Rollen

/// Rolle eines Läufers in einem Zwischenfall — reine Funktion seiner Nummer,
/// deshalb steht schon beim Einlaufen fest, wer wer ist.
enum MascotIncidentRole: Equatable {
    /// Bleibt in der Mitte stehen und wird abgeschossen
    case victim
    /// Der Sheriff davor: früher gestartet, steht deshalb rechts vom Opfer
    /// und dreht sich zum Zielen um. Der Einzige, der schießt.
    case shooter
}

/// Ein gerade laufender Zwischenfall, abgeleitet aus Uhrzeit und Streifenbreite.
struct MascotIncidentState: Equatable {
    /// Nummer des Opfers im Läuferstrom
    let victimIndex: Int
    /// Absoluter Zeitpunkt, an dem das Opfer stehen bleibt — Nullpunkt des Ablaufs
    let start: TimeInterval
    /// Linke Kante des Opfer-Sprites; dort steht später der Grabstein
    let x: CGFloat
    /// Sekunden seit `start`
    let elapsed: TimeInterval
}

// MARK: - Ablauf und Zeitplan

enum MascotIncident {

    // MARK: Wie oft

    /// Wahrscheinlichkeit je Läufer, ein Sheriff zu sein — im Schnitt
    /// patrouilliert so etwa jede Minute einer durchs Bild. Der Sheriff ist
    /// Stammgast auf dem Laufsteg, kein seltenes Ereignis.
    static let sheriffChance: Double = 1.0 / 16.0

    /// Nur ungefähr jeder fünfte Sheriff schießt wirklich — die anderen
    /// schauen nach dem Rechten (und ziehen höchstens mal zum Angeben den
    /// Colt, siehe AwakeMascotView). Zusammen mit `sheriffChance` und der
    /// Sperrfrist unten fällt so im Schnitt alle sechs bis sieben Minuten
    /// ein Schuss.
    static let killChance: Double = 0.2

    /// So viele Nummern zurück darf kein zweites Opfer liegen. Muss über der
    /// Lebensdauer eines Vorfalls in Startabständen liegen
    /// (`lifetime / minInterval` ≈ 33), sonst stünden zwei Gräber gleichzeitig
    /// auf demselben Fleck. Reine Funktion der Nummer — bewusst ohne die
    /// Streifenbreite, denn `MascotParadeCanvas.variant` fragt sie mit ab und
    /// kennt keine Breite.
    static let cooldown = 40

    /// Unter dieser Streifenbreite fällt der Zwischenfall aus: Die Schützen
    /// stehen gut 80 pt neben dem Opfer und wären sonst außerhalb des Bildes.
    static let minimumWidth: CGFloat = 260

    // MARK: Ablauf (Sekunden nach `start`)

    /// Das Opfer steht, die Schützen zielen — dann fällt der Schuss
    static let shotAt: TimeInterval = 0.9
    /// Die Geschosse sind da
    static let hitAt: TimeInterval = 1.3
    /// Das Opfer liegt
    static let fallEnd: TimeInterval = 1.9
    /// So lange blendet der Körper aus, während der Matsch einblendet
    static let splatFade: TimeInterval = 0.3
    /// Ab hier wächst der Grabstein aus dem Boden, der Matsch verblasst
    static let stoneRiseAt: TimeInterval = 5.0
    static let stoneRiseEnd: TimeInterval = 6.0
    /// Ab hier verblasst der Grabstein — er steht bewusst nur eine knappe
    /// Minute: eine kleine Erinnerung, kein Denkmal.
    static let stoneFadeAt: TimeInterval = 50
    /// Gesamtdauer des *sichtbaren* Teils — danach ist die Stelle wieder leer
    static let total: TimeInterval = 55

    /// Nachlauf: So lange bleibt der Vorfall über sein Ende hinaus bekannt,
    /// obwohl längst nichts mehr zu sehen ist.
    ///
    /// Das ist keine Kosmetik, sondern Pflicht. Wer am Grab gestanden hat,
    /// hinkt für den Rest seines Wegs um `mournHold × Tempo` hinterher — diese
    /// Standzeit steckt in der Positionsformel und wird bei jedem Bild neu
    /// abgezogen. Verschwände der Vorfall, während so jemand noch im Bild ist,
    /// fiele der Abzug weg und er spränge einen halben Streifen nach vorn.
    /// Der Nachlauf reicht, bis auch der Letzte hinausgelaufen ist; für sehr
    /// breite Fenster sichert `pause` das zusätzlich einzeln ab.
    static let trailingGrace: TimeInterval = 45

    /// So lange kennt `active` den Vorfall insgesamt
    static var lifetime: TimeInterval { total + trailingGrace }

    /// So lange steht der Schütze — bis der Körper liegt. Hinter ihm steht nur
    /// das für immer stehende Opfer, deshalb kann diese Standzeit niemandem den
    /// Abstand wegnehmen.
    static let shooterHold: TimeInterval = 1.9
    /// So lange bleibt ein Vorbeikommender am Grab stehen und weint
    static let mournHold: TimeInterval = 1.2
    /// Längste Pause überhaupt — die Parade rechnet damit, wie weit sie in der
    /// Vergangenheit nach noch sichtbaren Läufern suchen muss
    static let maxHold: TimeInterval = 1.9

    // MARK: Farben

    /// Der Matsch: Claudes Korallenton, aber deutlich sattere Tomate
    static let splat = Color(red: 0.878, green: 0.478, blue: 0.196)
    static let splatDark = Color(red: 0.718, green: 0.353, blue: 0.133)
    /// Matsch eines Codex-Pets: dessen Blau, satter
    static let codexSplat = Color(red: 0.239, green: 0.478, blue: 0.859)
    static let codexSplatDark = Color(red: 0.157, green: 0.325, blue: 0.639)

    /// Matschfarben nach Art des Opfers
    static func splatColors(for species: MascotSpecies) -> (light: Color, dark: Color) {
        species == .codex ? (codexSplat, codexSplatDark) : (splat, splatDark)
    }
    /// Mittleres Grau — trägt in hellem wie dunklem Erscheinungsbild
    static let stone = Color(red: 0.612, green: 0.620, blue: 0.659)
    static let stoneDark = Color(red: 0.427, green: 0.435, blue: 0.478)
    static let earth = Color(red: 0.408, green: 0.337, blue: 0.267)
    /// Träne
    static let tear = Color(red: 0.478, green: 0.706, blue: 0.937)
    /// Mündungsfeuer
    static let flash = Color(red: 0.996, green: 0.855, blue: 0.400)

    // MARK: - Wer ist wer

    /// Ist diese Nummer ein Sheriff? Reine Funktion der Nummer — der Sheriff
    /// läuft von Anfang an mit Hut und Stern ein, nichts springt um.
    static func isSheriff(_ index: Int) -> Bool {
        MascotParadeCanvas.roll(index, 29) < sheriffChance
    }

    /// Zieht dieser Sheriff wirklich? Nur sinnvoll, wenn `isSheriff` wahr ist.
    private static func sheriffDraws(_ index: Int) -> Bool {
        MascotParadeCanvas.roll(index, 31) < killChance
    }

    /// Roher Würfelwurf: Wäre diese Nummer ein Opfer, wenn nichts dagegenspräche?
    /// Das Opfer ist immer der Läufer direkt *hinter* einem ziehenden Sheriff —
    /// der Sheriff startete früher, läuft vorneweg und dreht sich um.
    /// Getrennt von `isVictim`, damit die Sperrfrist unten nicht in eine
    /// Endlosschleife läuft (sie fragt ausschließlich den rohen Wurf ab).
    private static func rawVictim(_ index: Int) -> Bool {
        isSheriff(index - 1) && sheriffDraws(index - 1)
    }

    /// Ist diese Nummer das Opfer eines Zwischenfalls?
    static func isVictim(_ index: Int) -> Bool {
        guard rawVictim(index) else { return false }
        // Sperrfrist: Solange der letzte Grabstein noch stehen könnte, gibt es
        // kein zweites Opfer. Die Schleife läuft nur im Trefferfall (1 von 125),
        // kostet also praktisch nichts.
        for back in 1...cooldown where rawVictim(index - back) { return false }
        return true
    }

    /// Rolle dieser Nummer. Die beiden Fälle schließen sich gegenseitig aus:
    /// Wegen der Sperrfrist kann neben einem Opfer kein zweites liegen.
    static func role(of index: Int) -> MascotIncidentRole? {
        if isVictim(index) { return .victim }
        // Nummer + 1 ist das Opfer → dieser hier ist der ziehende Sheriff:
        // früher gestartet, läuft vorneweg und steht rechts vom Opfer.
        if isVictim(index + 1) { return .shooter }
        return nil
    }

    // MARK: - Zeitplan

    /// Wo das Opfer stehen bleibt: mittig im Streifen.
    static func victimX(width: CGFloat) -> CGFloat {
        (width - MascotParadeCanvas.spriteWidth) / 2
    }

    /// Wann Läufer `index` die Mitte erreicht — der Nullpunkt des Ablaufs.
    static func stopTime(victim index: Int, width: CGFloat, timing: MascotParadeTiming) -> TimeInterval {
        timing.spawnTime(index)
            + Double(victimX(width: width) + MascotParadeCanvas.overshoot) / MascotParadeCanvas.baseSpeed
    }

    /// Der gerade laufende Zwischenfall — oder nil, wenn gerade keiner läuft.
    ///
    /// Gesucht wird rückwärts vom jüngsten Läufer aus: weit genug, dass auch ein
    /// Grabstein gefunden wird, dessen Opfer längst aus dem Bild wäre.
    /// `timing` ist die Taktung der Parade — bei wenigen Konten weiter
    /// gestreckt, dann liegen weniger Nummern in derselben Zeitspanne.
    static func active(at time: TimeInterval, width: CGFloat, timing: MascotParadeTiming) -> MascotIncidentState? {
        guard width >= minimumWidth else { return nil }

        let x = victimX(width: width)
        let travel = Double(x + MascotParadeCanvas.overshoot) / MascotParadeCanvas.baseSpeed
        let lookback = Int(((lifetime + travel) / timing.minInterval).rounded(.up)) + 6
        let newest = Int((time / timing.interval).rounded(.down)) + 1

        var index = newest
        while index >= newest - lookback {
            if isVictim(index) {
                let start = timing.spawnTime(index) + travel
                if time >= start, time < start + lifetime {
                    return MascotIncidentState(victimIndex: index, start: start,
                                               x: x, elapsed: time - start)
                }
            }
            index -= 1
        }
        return nil
    }

    // MARK: - Pausen

    /// Wo ein Vorbeikommender stehen bleibt: knapp links neben dem Grab. Der
    /// kleine Versatz nach Nummer verhindert, dass alle auf exakt demselben
    /// Fleck halten — drei Positionen reichen, dazwischen liegt immer ein
    /// Startabstand.
    static func mournStopX(_ index: Int, incident: MascotIncidentState) -> CGFloat {
        incident.x - MascotParadeCanvas.spriteWidth - 14 - CGFloat(index % 3) * 6
    }

    /// Pause dieses Läufers: ab wann und wie lange er steht. nil = läuft durch.
    ///
    /// Bewusst nur aus Nummer, Rolle und Vorfall gerechnet — nie aus der
    /// aktuellen Position. Sonst bekäme ein Läufer, der den Fleck längst
    /// passiert hat, im Moment des Grabstein-Auftauchens rückwirkend eine Pause
    /// und spränge nach hinten.
    static func pause(
        for index: Int,
        role: MascotIncidentRole?,
        incident: MascotIncidentState?,
        spawn: TimeInterval,
        speed: Double
    ) -> (start: TimeInterval, length: TimeInterval)? {
        guard let incident else { return nil }

        guard let role else {
            // Unbeteiligter: bleibt am Grab stehen, wenn er dort ankommt,
            // *während* dort etwas liegt. Wer schon vorbei war, bekommt keine
            // Pause nachgereicht — sein x spränge sonst zurück.
            let stopX = mournStopX(index, incident: incident)
            let arrival = spawn + Double(stopX + MascotParadeCanvas.overshoot) / speed
            guard arrival > incident.start, arrival < incident.start + total else { return nil }

            // Und nur, wenn er danach das Bild verlässt, bevor der Vorfall aus
            // dem Gedächtnis fällt: Sonst verschwände seine Standzeit unter ihm
            // und er spränge nach vorn. Bei üblichen Breiten greift die Grenze
            // nie — der Grabstein ist längst weg, bevor sie zählt.
            let width = incident.x * 2 + MascotParadeCanvas.spriteWidth
            let exit = arrival + mournHold
                + Double(width + MascotParadeCanvas.overshoot - stopX) / speed
            guard exit < incident.start + lifetime else { return nil }

            return (arrival, mournHold)
        }

        switch role {
        case .victim:
            // Das Opfer bleibt für immer stehen — dafür sorgt die Zeichenroutine.
            return nil

        case .shooter:
            // Nur der Vordermann des *aktuellen* Opfers hält an.
            guard index == incident.victimIndex - 1 else { return nil }
            return (incident.start, shooterHold)
        }
    }

    /// Wo ein Schütze steht, während er zielt: genau dort, wo ihn der Halt des
    /// Opfers überrascht hat. Dieselbe Zahl, die auch die Parade über ihre
    /// Pausenrechnung herausbekommt — hier direkt, damit die Geschosse an der
    /// richtigen Stelle losfliegen, ohne dass die Zeichenschleife etwas
    /// zwischenspeichern muss.
    static func frozenX(of index: Int, incident: MascotIncidentState, timing: MascotParadeTiming) -> CGFloat {
        CGFloat((incident.start - timing.spawnTime(index)) * MascotParadeCanvas.baseSpeed)
            - MascotParadeCanvas.overshoot
    }

    // MARK: - Zeichnen: Boden (Matsch, Grabstein)

    /// Matsch und Grabstein. Wird **vor** den Läufern gezeichnet, damit die
    /// Trauernden davor vorbeigehen und der Stein nicht wie ein Hindernis
    /// mitten im Weg klebt.
    static func drawGround(in ctx: GraphicsContext, incident: MascotIncidentState,
                           species: MascotSpecies = .claudie) {
        let t = incident.elapsed
        // Der Vorfall bleibt danach noch bekannt (siehe `trailingGrace`),
        // sichtbar ist ab hier aber nichts mehr.
        guard t < total else { return }
        let cell = MascotParadeCanvas.cell
        let (splat, splatDark) = splatColors(for: species)

        var ground = ctx
        ground.translateBy(x: incident.x, y: 13)

        func px(_ col: Double, _ row: Double, _ color: Color, _ w: Double = 1, _ h: Double = 1) {
            let rect = CGRect(x: col * cell, y: row * cell, width: w * cell, height: h * cell)
            ground.fill(Path(rect), with: .color(color))
        }

        // --- Matsch: blendet ein, während der Körper ausblendet, und verblasst,
        //     sobald der Stein wächst. Ein blasser Rest bleibt am Sockel liegen.
        let splatAlpha: Double = {
            // Der Matsch wächst schon unter dem Einsackenden hervor — dadurch
            // wird aus „Körper weg, Matsch da" ein Übergang statt eines Schnitts.
            let begins = hitAt + 0.3
            if t < begins { return 0 }
            if t < fallEnd + splatFade { return (t - begins) / (fallEnd + splatFade - begins) }
            if t < stoneRiseAt { return 1 }
            if t < stoneRiseEnd {
                let fade = (t - stoneRiseAt) / (stoneRiseEnd - stoneRiseAt)
                return 1 - fade * 0.75          // 25 % bleiben als Fleck
            }
            // Der Fleck bleibt liegen und verblasst am Ende mit dem Stein
            guard t >= stoneFadeAt else { return 0.25 }
            return 0.25 * max(0, 1 - (t - stoneFadeAt) / (total - stoneFadeAt))
        }()

        if splatAlpha > 0.02 {
            let a = splatAlpha
            px(0.4, 4.55, splatDark.opacity(a * 0.85), 7.2, 0.45)
            px(1.4, 4.05, splat.opacity(a), 5.2, 0.6)
            px(2.5, 3.6, splat.opacity(a * 0.9), 3.0, 0.5)
            // Spritzer
            px(-1.4, 4.35, splat.opacity(a * 0.8), 0.6, 0.5)
            px(-2.3, 4.75, splatDark.opacity(a * 0.7), 0.45, 0.35)
            px(8.6, 4.15, splat.opacity(a * 0.8), 0.7, 0.6)
            px(9.6, 4.6, splatDark.opacity(a * 0.7), 0.45, 0.4)
        }

        // --- Grabstein: wächst aus dem Boden (der Streifen ist beschnitten,
        //     der Stein kommt also wirklich von unten) und verblasst am Ende.
        guard t >= stoneRiseAt else { return }
        let stoneAlpha = t < stoneFadeAt ? 1.0 : max(0, 1 - (t - stoneFadeAt) / (total - stoneFadeAt))
        guard stoneAlpha > 0.02 else { return }

        let rise = min(1, max(0, (t - stoneRiseAt) / (stoneRiseEnd - stoneRiseAt)))
        let eased = 1 - pow(1 - rise, 3)        // schnell raus, sanft ankommen

        // Erdhügel bleibt am Boden, nur der Stein fährt hoch
        px(0.9, 4.85, earth.opacity(stoneAlpha * 0.9), 6.2, 0.5)

        var slab = ground
        slab.translateBy(x: 0, y: (1 - eased) * 22)
        func spx(_ col: Double, _ row: Double, _ color: Color, _ w: Double = 1, _ h: Double = 1) {
            let rect = CGRect(x: col * cell, y: row * cell, width: w * cell, height: h * cell)
            slab.fill(Path(rect), with: .color(color))
        }
        spx(2.6, 0.75, stone.opacity(stoneAlpha), 2.8, 0.6)          // gerundete Kuppe
        spx(2.2, 1.3, stone.opacity(stoneAlpha), 3.6, 3.3)           // Korpus
        spx(2.2, 4.35, stoneDark.opacity(stoneAlpha), 3.6, 0.5)      // Schattenkante unten
        spx(1.4, 4.6, stone.opacity(stoneAlpha), 5.2, 0.45)          // Sockel
        spx(3.0, 2.0, stoneDark.opacity(stoneAlpha * 0.8), 2.0, 0.3) // Gravur
        spx(3.2, 2.7, stoneDark.opacity(stoneAlpha * 0.8), 1.6, 0.3)
    }

    // MARK: - Zeichnen: das Opfer

    /// Das Opfer ab dem Moment, in dem es stehen bleibt: erst still, dann kippt
    /// es, dann blendet es aus und überlässt dem Matsch die Stelle.
    /// Gibt `false` zurück, wenn nichts mehr zu zeichnen ist — dann überspringt
    /// die Parade diese Nummer ganz.
    @discardableResult
    static func drawVictim(in ctx: GraphicsContext, incident: MascotIncidentState,
                           time: TimeInterval, seed: Int,
                           species: MascotSpecies = .claudie) -> Bool {
        let t = incident.elapsed
        guard t < fallEnd + 0.2 else { return false }

        // Zusammensacken: beschleunigt wie unter Schwerkraft — erst kippt er
        // kaum, am Ende geht es schnell.
        var collapse: Double = 0
        if t >= hitAt {
            let progress = min(1, (t - hitAt) / (fallEnd - hitAt))
            collapse = progress * progress
        }
        // Blendet aus, während der Matsch schon steht — die letzten Bilder
        // überlagern sich bewusst.
        let alpha = t <= fallEnd - 0.1 ? 1 : max(0, 1 - (t - (fallEnd - 0.1)) / 0.3)

        MascotParadeCanvas.drawWalker(
            in: ctx, x: incident.x, step: false, alpha: alpha,
            variant: .normal, time: time, seed: seed,
            species: species, pose: .standing, collapse: collapse
        )
        return true
    }

    // MARK: - Zeichnen: Schüsse

    /// Mündungsfeuer, Geschosse und der kleine Einschlag. Kommt **nach** den
    /// Läufern, damit nichts davorliegt.
    static func drawShots(in ctx: GraphicsContext, incident: MascotIncidentState,
                          timing: MascotParadeTiming, species: MascotSpecies = .claudie) {
        let t = incident.elapsed
        guard t >= shotAt, t < hitAt + 0.35 else { return }

        let shots = ctx
        let cell = MascotParadeCanvas.cell
        let chestY: CGFloat = 13 + 2.2 * cell
        // Brusthöhe des Opfers, die dem Schützen zugewandte Kante
        let target = incident.x + 6.5 * cell
        // Der Colt des Sheriffs ragt einen guten Zentimeter über den alten
        // bloßen Arm hinaus — das Mündungsfeuer sitzt an der Laufspitze.
        let muzzle = frozenX(of: incident.victimIndex - 1, incident: incident, timing: timing) - 2.3 * cell
        let splat = splatColors(for: species).light

        func dot(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: Color) {
            shots.fill(Path(CGRect(x: x, y: y, width: w, height: h)), with: .color(color))
        }

        // Mündungsfeuer — zwei Bilder lang
        if t < shotAt + 0.14 {
            dot(muzzle - 5, chestY - 2, 5, 5, flash)
        }

        // Geschoss unterwegs
        if t < hitAt {
            let p = CGFloat((t - shotAt) / (hitAt - shotAt))
            let x = muzzle + (target - muzzle) * p
            dot(x - 6, chestY, 6, 3, MascotParadeCanvas.faceInk)
        }

        // Einschlag: ein paar Tropfen fliegen weg
        if t >= hitAt {
            let p = (t - hitAt) / 0.35
            let a = 1 - p
            guard a > 0.05 else { return }
            let cx = incident.x + 4 * cell
            for spark in 0..<6 {
                let angle = Double(spark) * (.pi / 3) + 0.4
                let reach = CGFloat(14 * p)
                dot(cx + reach * CGFloat(cos(angle)) - 1.5,
                    chestY + reach * CGFloat(sin(angle)) - 1.5,
                    3, 3, splat.opacity(a))
            }
        }
    }
}
