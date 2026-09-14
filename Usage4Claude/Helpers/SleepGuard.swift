//
//  SleepGuard.swift
//  Usage4Claude
//
//  Hält Bildschirm und Mac wach — wie Amphetamine/Caffeine, aber ohne
//  Hilfsprogramm. Zwei Stufen:
//
//    1. IOKit-Power-Assertions (IOPMAssertionCreateWithName /
//       IOPMAssertionRelease) — brauchen weder root noch ein Entitlement,
//       wirken aber nur bei OFFENEM Deckel.
//    2. Die Deckel-Stufe: `pmset -a disablesleep 1` über PrivilegedPower —
//       hält den Mac auch ZUGEKLAPPT wach. Verlangt root; beim allerersten
//       Einschalten fragt macOS deshalb EINMAL nach dem Passwort
//       (sudoers-Einmal-Regel), danach schaltet es lautlos.
//
//  Der Schalter zeigt die ABSICHT (Assertions gesetzt); ob die Deckel-Stufe
//  wirklich greift, sagt der Tooltip anhand von SystemSleepInfo
//  (SleepDisabled 1/0). Wird der Passwortdialog abgebrochen, bleiben die
//  Assertions bestehen — wach bei offenem Deckel, ehrlicher Hinweis im
//  Tooltip, kein Fehlerdialog.
//
//  Copyright © 2025 f-is-h. All rights reserved.
//

import AppKit
import Foundation
import Combine
import OSLog
import IOKit.pwr_mgt

/// Wach-Wächter: verwaltet die Power-Assertions der App.
///
/// Nach außen gibt es genau EINEN Schalter — „Bleib wach“
/// (`DashboardView.stayAwakeToggle`). Er setzt intern BEIDE Assertions
/// gleichzeitig:
///
/// - `kIOPMAssertionTypeNoDisplaySleep` — der Bildschirm schaltet sich nicht
///   von selbst aus.
/// - `kIOPMAssertionTypePreventUserIdleSystemSleep` — das System geht bei
///   Untätigkeit nicht in den Ruhezustand.
///
/// Früher waren das zwei getrennte Schalter („Bildschirm an“ / „Always On“).
/// In der Praxis wollte niemand nur eines von beidem — wer wach halten will,
/// will wach halten. Die alten UserDefaults-Schlüssel werden beim ersten Start
/// still übernommen: war EINER der beiden an, startet der neue Schalter an
/// (siehe `storedAwakeFlag()`).
///
/// Alles gilt nur, solange die App läuft: `releaseAll()` beim Beenden gibt die
/// Assertions frei und nimmt eine selbst gesetzte Deckel-Stufe still zurück,
/// danach greifen wieder die Systemeinstellungen. Ob Zuklappen (Clamshell)
/// abgedeckt ist, hängt an der Deckel-Stufe — siehe Dateikopf.
final class SleepGuard: ObservableObject {

    // MARK: - Singleton

    static let shared = SleepGuard()

    // MARK: - Published State

    /// „Bleib wach“ ist an: Bildschirm UND Mac werden wach gehalten
    @Published private(set) var isAwake: Bool = false

    /// Wahr, wenn die Deckel-Stufe von außen kam (Terminal), nicht von uns.
    /// Dann bleibt sie beim Beenden stehen — sie gehört dem Benutzer.
    private var externallyEnabled = false

    // MARK: - Private State

    /// 0 gilt als „keine Assertion aktiv“ — IOKit vergibt nur Werte > 0
    private var displayAssertionID: IOPMAssertionID = 0
    private var systemAssertionID: IOPMAssertionID = 0

    private let defaults = UserDefaults.standard

    private enum DefaultsKey {
        /// Der eine Schalter von heute
        static let awake = "sleepGuard.awake"
        /// Alte Schlüssel der zwei getrennten Schalter. Sie werden nur noch
        /// gelesen (einmalige Übernahme), nie mehr geschrieben — wer auf eine
        /// ältere Version zurückgeht, findet seine Werte unverändert vor.
        static let legacyDisplayAwake = "sleepGuard.displayAwake"
        static let legacySystemAwake = "sleepGuard.systemAwake"
    }

    /// Eigene Log-Kategorie, gleiches Muster wie `Logger.menuBar` & Co.
    private static let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "xyz.fi5h.Usage4Claude",
        category: "SleepGuard"
    )

    private init() {
        startWatchdog()
    }

    // MARK: - Abgleich mit dem System

    /// Der Takt, der Anzeige und Wirklichkeit zusammenhält.
    ///
    /// `disablesleep` lässt sich jederzeit im Terminal umstellen. Damit der
    /// Schalter nie etwas anderes behauptet als das System tut, wird alle 15
    /// Sekunden nachgesehen und bei Abweichung nachgezogen.
    ///
    /// Bewusst ein `DispatchSourceTimer` und kein `Timer`: Letzterer hängt an
    /// der Run-Loop des erzeugenden Threads und feuert nicht, wenn das
    /// Singleton im Hintergrund entsteht — genau daran ist eine frühere
    /// Fassung stillschweigend gescheitert. Die Dispatch-Quelle läuft auf
    /// ihrer eigenen Queue und ist davon unabhängig.
    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: watchdogQueue)
        timer.schedule(deadline: .now() + 2, repeating: 15, leeway: .seconds(3))
        timer.setEventHandler { [weak self] in
            self?.checkSystemState()
        }
        timer.resume()
        watchdog = timer
    }

    /// Liest `pmset` direkt (kurz, eigenständig) und zieht den Schalter nach.
    private func checkSystemState() {
        guard let systemOn = Self.readSleepDisabled() else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, systemOn != self.isAwake else { return }
            self.adopt(systemOn)
        }
    }

    /// `pmset -g` lesen und die Zeile „SleepDisabled" auswerten. `nil`, wenn
    /// der Aufruf scheitert — dann bleibt alles, wie es ist.
    private static func readSleepDisabled() -> Bool? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        process.arguments = ["-g"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") where line.contains("SleepDisabled") {
            return line.split(whereSeparator: { $0 == " " || $0 == "\t" }).last == "1"
        }
        return nil
    }

    private var watchdog: DispatchSourceTimer?
    private let watchdogQueue = DispatchQueue(label: "xyz.fi5h.Usage4Claude.sleepWatchdog", qos: .utility)

    // MARK: - Lifecycle

    /// Beim Start den gemerkten Schalter erneut anwenden.
    /// Assertions überleben den Prozess nicht, müssen also neu erzeugt werden.
    ///
    /// WICHTIG: `interactive: false` — beim Login darf NIE ein Passwortdialog
    /// aufgehen. Die Deckel-Stufe wird nur still versucht (`sudo -n`): Regel
    /// installiert → greift wieder; Regel fehlt → nur Assertions, fertig.
    func restoreFromDefaults() {
        if storedAwakeFlag() {
            setAwake(true, interactive: false)
        }
        adoptSystemStateIfNeeded()
    }

    /// Gleicht den Schalter mit der Wirklichkeit ab.
    ///
    /// `disablesleep` lässt sich auch im Terminal setzen (`sudo pmset -a
    /// disablesleep 1`). Zeigte der Schalter dann weiter „aus“, log er: Der Mac
    /// schläft nicht, und die Anzeige behauptet das Gegenteil. Also folgt der
    /// Schalter dem System — aber nur in EINE Richtung: Er übernimmt, was er
    /// vorfindet, und schreibt dabei selbst nichts. Wer die Einstellung im
    /// Terminal gesetzt hat, behält sie.
    ///
    /// Übernommen wird der Zustand nur, wenn er dem gemerkten widerspricht;
    /// die Assertions werden passend nachgezogen, damit „an“ auch bei offenem
    /// Deckel hält. `externallyEnabled` merkt sich, dass die Deckel-Stufe nicht
    /// von uns stammt — dann fassen wir sie beim Beenden auch nicht an.
    func adoptSystemStateIfNeeded() {
        // Nur anstoßen. Übernommen wird in `adopt(_:)`, sobald der frische Wert
        // eintrifft — ein festes Warten wäre ein Wettlauf: Käme die Antwort
        // später, läse man den alten Wert und hielte alles für unverändert.
        SystemSleepInfo.shared.refresh(force: true)
    }

    /// Übernimmt einen frisch gelesenen Systemzustand.
    private func adopt(_ systemOn: Bool) {
        do {
            if systemOn {
                // Von außen eingeschaltet: Anzeige und Assertions nachziehen,
                // `disablesleep` NICHT anfassen (steht ja schon richtig).
                externallyEnabled = true
                syncAssertions(to: true)
                Self.log.notice("Systemzustand übernommen: „Claude Always On“ steht auf an")
            } else {
                // Von außen ausgeschaltet: Anzeige und Assertions zurücknehmen.
                externallyEnabled = false
                syncAssertions(to: false)
                Self.log.notice("Systemzustand übernommen: „Claude Always On“ steht auf aus")
            }
            isAwake = systemOn
            defaults.set(systemOn, forKey: DefaultsKey.awake)
            NotificationCenter.default.post(name: .settingsChanged, object: nil)
        }
    }

    /// Nur die Assertions auf einen Stand bringen — ohne `pmset`, ohne Dialog.
    private func syncAssertions(to on: Bool) {
        if on {
            _ = createAssertion(type: kIOPMAssertionTypeNoDisplaySleep,
                                reason: "Max Monitor: Bildschirm wach halten",
                                id: &displayAssertionID)
            _ = createAssertion(type: kIOPMAssertionTypePreventUserIdleSystemSleep,
                                reason: "Max Monitor: Mac wach halten",
                                id: &systemAssertionID)
        } else {
            releaseAssertion(&displayAssertionID, label: "NoDisplaySleep")
            releaseAssertion(&systemAssertionID, label: "PreventUserIdleSystemSleep")
        }
    }

    /// Liest den gemerkten Zustand — mit stiller, einmaliger Übernahme der
    /// alten zwei Schlüssel: Gibt es den neuen Schlüssel noch nicht, gilt
    /// „an“, wenn EINER der beiden alten Schalter an war. Das Ergebnis wird
    /// sofort unter dem neuen Schlüssel gemerkt, danach zählt nur noch der.
    private func storedAwakeFlag() -> Bool {
        if defaults.object(forKey: DefaultsKey.awake) != nil {
            return defaults.bool(forKey: DefaultsKey.awake)
        }
        let migrated = defaults.bool(forKey: DefaultsKey.legacyDisplayAwake)
            || defaults.bool(forKey: DefaultsKey.legacySystemAwake)
        defaults.set(migrated, forKey: DefaultsKey.awake)
        if migrated {
            Self.log.notice("Alte Wach-Schalter übernommen: „Bleib wach“ startet an")
        }
        return migrated
    }

    /// Beim Beenden alle Assertions freigeben.
    /// Der gemerkte Schalter in den UserDefaults bleibt unangetastet,
    /// damit er beim nächsten Start wieder greift.
    ///
    /// Die Deckel-Stufe wird dabei still zurückgenommen (synchron, `sudo -n`
    /// antwortet in Millisekunden): `disablesleep` ist eine SYSTEM-Einstellung
    /// und überlebt den Prozess — ohne diesen Schritt bliebe nach dem Beenden
    /// ein Mac zurück, der nie schläft und nirgends anzeigt, warum. Beim
    /// nächsten Start setzt `restoreFromDefaults()` sie still wieder.
    /// War der Schalter aus, wird disablesleep NICHT angefasst — eine etwaige
    /// 1 dort gehört dann dem Benutzer, nicht der App.
    func releaseAll() {
        let wasAwake = isAwake
        releaseAssertion(&displayAssertionID, label: "NoDisplaySleep")
        releaseAssertion(&systemAssertionID, label: "PreventUserIdleSystemSleep")
        isAwake = false
        // Zurückgenommen wird nur, was die App selbst eingeschaltet hat. Hat der
        // Benutzer `disablesleep` im Terminal gesetzt und wir haben den Zustand
        // bloß übernommen, bleibt er beim Beenden bestehen — sonst nähme die App
        // ihm still eine Einstellung weg, die ihr nie gehört hat.
        if wasAwake && !externallyEnabled {
            PrivilegedPower.setSleepDisabledSilentlyAndWait(false)
        }
    }

    // MARK: - Toggle

    /// „Bleib wach“ an/aus — setzt bzw. löst immer BEIDE Assertions und
    /// zieht die Deckel-Stufe (`pmset disablesleep`) mit.
    ///
    /// - Parameter interactive: `true` nur bei einer ausdrücklichen
    ///   Benutzeraktion (Schalter in der Übersicht) — dann darf beim ersten
    ///   Mal der EINE Passwortdialog erscheinen. `false` beim Start
    ///   (Re-Apply): dort läuft die Deckel-Stufe ausschließlich still.
    func setAwake(_ enabled: Bool, interactive: Bool = true) {
        // Ein Klick macht die Deckel-Stufe zu unserer: Ab jetzt räumen wir sie
        // beim Beenden auch wieder weg. (Beim stillen Re-Apply nach dem Start
        // gilt dasselbe — wir setzen sie ja selbst.)
        externallyEnabled = false
        let hadAssertions = displayAssertionID != 0 || systemAssertionID != 0
        guard enabled != hadAssertions else {
            // Schon im gewünschten Zustand — trotzdem Flag synchron halten
            isAwake = enabled
            defaults.set(enabled, forKey: DefaultsKey.awake)
            return
        }

        if enabled {
            let displayCreated = createAssertion(
                type: kIOPMAssertionTypeNoDisplaySleep,
                reason: "Max Monitor: Bildschirm wach halten",
                id: &displayAssertionID
            )
            let systemCreated = createAssertion(
                type: kIOPMAssertionTypePreventUserIdleSystemSleep,
                reason: "Max Monitor: Mac wach halten",
                id: &systemAssertionID
            )
            isAwake = displayCreated || systemCreated
        } else {
            releaseAssertion(&displayAssertionID, label: "NoDisplaySleep")
            releaseAssertion(&systemAssertionID, label: "PreventUserIdleSystemSleep")
            isAwake = false
        }

        applyLidTier(enabled, interactive: interactive)

        defaults.set(isAwake, forKey: DefaultsKey.awake)

        // Die Menüleiste zeichnet die Wach-Kapsel um die Punktreihe — sie muss
        // sofort mitziehen. `.settingsChanged` löst in `MenuBarManager` genau
        // das aus: Icon-Cache leeren + neu zeichnen.
        NotificationCenter.default.post(name: .settingsChanged, object: nil)
    }

    /// Umschalten für den Kopf der Übersicht — DIE Benutzeraktion, aus der
    /// heraus die Einmal-Freigabe erscheinen darf.
    func toggleAwake() {
        setAwake(!isAwake, interactive: true)
    }

    // MARK: - Deckel-Stufe (pmset disablesleep)

    /// Zieht `pmset -a disablesleep` hinter dem Schalter her.
    ///
    /// Ergebnisbehandlung bewusst leise:
    ///   • Erfolg → SystemSleepInfo neu lesen, damit der Tooltip sofort
    ///     „läuft auch zugeklappt“ sagt.
    ///   • Abbruch im Passwortdialog → KEIN Fehlerdialog. Die Assertions
    ///     bleiben (wach bei offenem Deckel), der Tooltip erklärt die Lage
    ///     über die Deckel-Zeile — auch dafür SystemSleepInfo auffrischen.
    ///   • Sonstiger Fehler → nur loggen; funktional ist das derselbe
    ///     Zustand wie der Abbruch.
    private func applyLidTier(_ on: Bool, interactive: Bool) {
        let refresh = { SystemSleepInfo.shared.refresh(force: true) }

        // AUSschalten darf nur dann einen Admin-Dialog kosten, wenn wirklich
        // eine 1 zurückzunehmen ist. Meldet pmset gar kein `SleepDisabled 1`
        // (typisch: die Einmal-Freigabe wurde beim Einschalten abgebrochen,
        // Regel und disablesleep existieren nie), wäre der Passwortdialog
        // beim Ausschalten sinnlos — und ein Passwort-Ja an dieser Stelle
        // würde die sudoers-Regel aus einer „mach es aus“-Geste heraus
        // installieren. Dann reicht der stille Versuch: mit Regel räumt er
        // auf, ohne Regel passiert schlicht nichts.
        let nothingToUndo = !on && SystemSleepInfo.shared.sleepDisabled != true

        if interactive && !nothingToUndo {
            PrivilegedPower.setSleepDisabled(on) { result in
                switch result {
                case .success:
                    Self.log.notice("Deckel-Stufe: disablesleep = \(on ? "1" : "0", privacy: .public)")
                case .failure(.cancelled):
                    Self.log.notice("Deckel-Stufe abgelehnt — Assertions bleiben, Deckel schläfert weiter ein")
                case .failure(.failed(let message)):
                    Self.log.error("Deckel-Stufe fehlgeschlagen: \(message, privacy: .public)")
                }
                refresh()
            }
        } else {
            // Start/Re-Apply: ausschließlich still — ohne Regel passiert
            // schlicht nichts, und genau so soll es sein.
            PrivilegedPower.setSleepDisabledSilently(on) { _ in
                refresh()
            }
        }
    }

    // MARK: - IOKit

    /// Assertion anfordern
    /// - Returns: true, wenn IOKit die Assertion vergeben hat
    private func createAssertion(type: String, reason: String, id: inout IOPMAssertionID) -> Bool {
        var newID: IOPMAssertionID = 0
        let result = IOPMAssertionCreateWithName(
            type as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason as CFString,
            &newID
        )

        guard result == kIOReturnSuccess else {
            Self.log.error("Power-Assertion \(type, privacy: .public) fehlgeschlagen: \(result)")
            return false
        }

        id = newID
        Self.log.notice("Power-Assertion \(type, privacy: .public) aktiv (id \(newID))")
        return true
    }

    /// Assertion freigeben (idempotent)
    private func releaseAssertion(_ id: inout IOPMAssertionID, label: String) {
        guard id != 0 else { return }

        let result = IOPMAssertionRelease(id)
        if result != kIOReturnSuccess {
            Self.log.error("Power-Assertion \(label, privacy: .public) konnte nicht freigegeben werden: \(result)")
        } else {
            Self.log.notice("Power-Assertion \(label, privacy: .public) freigegeben")
        }
        id = 0
    }

    deinit {
        // Singleton lebt bis Prozessende; hier nur als Sicherheitsnetz.
        releaseAssertion(&displayAssertionID, label: "NoDisplaySleep")
        releaseAssertion(&systemAssertionID, label: "PreventUserIdleSystemSleep")
        watchdog?.cancel()
    }
}
