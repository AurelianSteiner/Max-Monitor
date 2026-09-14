//
//  PrivilegedPower.swift
//  Usage4Claude
//
//  Der privilegierte Teil von „Bleib wach“: `pmset -a disablesleep 1/0` —
//  die einzige Einstellung, die den Mac auch ZUGEKLAPPT wach hält. Sie
//  verlangt root; IOKit-Assertions (SleepGuard) reichen dafür nicht.
//
//  Einmal-Freigabe statt Dauergefrage:
//
//    1. Erst der stille Versuch: `sudo -n /usr/bin/pmset -a disablesleep …`.
//       Er gelingt nur, wenn die Einmal-Regel schon installiert ist.
//    2. Schlägt er fehl (und ist ein interaktiver Aufruf erlaubt), zeigt
//       macOS über osascript („do shell script … with administrator
//       privileges“) EINMAL den System-Passwortdialog. In diesem einen
//       Admin-Kontext passiert beides: die sudoers-Regel wird installiert
//       UND disablesleep sofort auf den gewünschten Wert gesetzt. Danach
//       läuft jeder weitere Schaltvorgang lautlos über Schritt 1.
//
//  Was die Regel erlaubt — und was nicht:
//
//      <kurzname> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1,
//                                      /usr/bin/pmset -a disablesleep 0
//                                      (in der Datei EINE Zeile)
//
//    Genau die zwei Aufrufe, die diese Datei absetzt — sudoers vergleicht
//    die Argumentliste Zeichen für Zeichen, jeder andere pmset-Aufruf bleibt
//    passwortpflichtig. Kein „NOPASSWD: ALL“, kein Shell-Zugriff, und auch
//    kein freies pmset (das sonst Zeitpläne stellen, den Mac aufwecken oder
//    Batterie-Schwellen verstellen könnte).
//    Wieder loswerden:  sudo rm /etc/sudoers.d/claude-max-monitor
//
//  Sicherheitsregeln in diesem File:
//    • Der Kurzname (NSUserName()) wird gegen ^[a-z_][a-z0-9_-]*$ geprüft.
//      Passt er nicht, wird KEINE Regel installiert — dann bleibt nur der
//      Admin-Dialog pro Schaltvorgang (pmset direkt, ohne sudoers-Zeile).
//      Niemals wandert ein ungeprüfter String in eine root-Shell.
//    • Die Regel wird erst mit `visudo -cf` validiert und nur bei Erfolg
//      nach /etc/sudoers.d installiert (440, root:wheel) — eine kaputte
//      Datei dort kann sudo systemweit lahmlegen.
//    • Ältere Versionen installierten die Regel noch OHNE Argumentliste
//      (freies pmset als root). Die Datei ist 440 root:wheel und für die App
//      unlesbar, also wird die alte Regel an ihrer Wirkung erkannt (siehe
//      `hasLegacyBroadRule`) und beim nächsten bewussten Schaltvorgang durch
//      die enge ersetzt — sonst bliebe sie für immer liegen.
//    • Das Passwort sieht ausschließlich der System-Dialog. Die App liest,
//      loggt und speichert nichts dergleichen — hier gibt es schlicht keinen
//      Code-Pfad, der es je zu Gesicht bekäme.
//
//  Thread-Regel: Alle Completions kommen auf dem Main-Thread zurück; die
//  Prozess-Arbeit läuft auf einer eigenen seriellen Queue.
//
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import OSLog

/// Fehlerbild des privilegierten Schaltvorgangs.
enum PrivilegedPowerError: Error {
    /// Der Benutzer hat den System-Passwortdialog abgebrochen.
    case cancelled
    /// Alles andere — Meldung fürs Log, nie fürs Passwort.
    case failed(String)
}

enum PrivilegedPower {

    // MARK: - Konstanten

    private static let pmsetPath = "/usr/bin/pmset"
    // Der Dateiname bleibt beim alten Produktnamen: Er ist auf bestehenden Macs
    // schon installiert (Einmal-Freigabe). Ein neuer Name hieße neue Passwortabfrage
    // und eine verwaiste alte Regel.
    private static let sudoersFile = "/etc/sudoers.d/claude-max-monitor"

    private static let queue = DispatchQueue(
        label: "xyz.fi5h.Usage4Claude.privileged-power",
        qos: .userInitiated
    )

    private static let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "xyz.fi5h.Usage4Claude",
        category: "PrivilegedPower"
    )

    // MARK: - Öffentliche API

    /// Setzt `pmset -a disablesleep` — erst still, notfalls mit dem EINEN
    /// Admin-Dialog (siehe Dateikopf). Nur aus einer ausdrücklichen
    /// Benutzeraktion aufrufen (Schalter in der Übersicht), nie beim Start.
    static func setSleepDisabled(_ on: Bool, completion: @escaping (Result<Void, PrivilegedPowerError>) -> Void) {
        queue.async {
            let result = apply(on)
            DispatchQueue.main.async { completion(result) }
        }
    }

    /// Schaltvorgang inklusive Regel-Upgrade. Blockierend, läuft auf `queue`.
    private static func apply(_ on: Bool) -> Result<Void, PrivilegedPowerError> {
        // Die Prüfung muss VOR dem stillen Weg stehen: die alte, weite Regel
        // deckt `pmset -a disablesleep` mit ab, `runSilently` würde also
        // gelingen und sie stillschweigend für immer liegen lassen.
        if hasLegacyBroadRule() {
            log.notice("Alte, zu weite sudoers-Regel erkannt — wird durch die enge ersetzt")
            let upgraded = runInteractively(on)
            if case .success = upgraded { return upgraded }
            // Abgebrochen oder fehlgeschlagen: die alte Regel liegt noch und
            // trägt den Schaltvorgang weiter — daran darf der Schalter nicht
            // scheitern. Der nächste Schaltvorgang versucht das Upgrade erneut.
            return runSilently(on) ? .success(()) : upgraded
        }

        if runSilently(on) { return .success(()) }
        return runInteractively(on)
    }

    /// Nur der stille Weg (`sudo -n`) — für den Start der App (Re-Apply des
    /// gemerkten Schalters) und andere Stellen, an denen NIEMALS ein
    /// Passwortdialog erscheinen darf. Regel installiert → wirkt; Regel
    /// fehlt → still übersprungen, `false`.
    static func setSleepDisabledSilently(_ on: Bool, completion: ((Bool) -> Void)? = nil) {
        queue.async {
            let ok = runSilently(on)
            if let completion {
                DispatchQueue.main.async { completion(ok) }
            }
        }
    }

    /// Synchrone Variante des stillen Wegs — einzig fürs Beenden der App
    /// gedacht (applicationWillTerminate wartet nicht auf Queues). `sudo -n`
    /// antwortet in Millisekunden, mit wie ohne Regel.
    @discardableResult
    static func setSleepDisabledSilentlyAndWait(_ on: Bool) -> Bool {
        runSilently(on)
    }

    // MARK: - Stiller Weg

    /// `sudo -n pmset …`: gelingt genau dann, wenn die Einmal-Regel
    /// installiert ist. Kein Dialog, keine Rückfrage — `-n` bricht sonst
    /// sofort ab.
    private static func runSilently(_ on: Bool) -> Bool {
        let ok = sudoAllowsWithoutPassword([pmsetPath, "-a", "disablesleep", on ? "1" : "0"])
        if ok {
            log.notice("disablesleep still auf \(on ? "1" : "0", privacy: .public) gesetzt")
        }
        return ok
    }

    /// Ein `sudo -n`-Versuch: `true`, wenn der Befehl ohne Passwort durchlief.
    /// `-n` bricht ab, statt zu fragen — hier erscheint nie ein Dialog.
    /// Ausgabe geht nach /dev/null statt in eine Pipe, damit kein ungelesener
    /// Puffer den Prozess vor `waitUntilExit` festhalten kann.
    private static func sudoAllowsWithoutPassword(_ arguments: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sudo")
        process.arguments = ["-n"] + arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            log.notice("sudo -n ließ sich nicht starten: \(error.localizedDescription, privacy: .public)")
            return false
        }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    // MARK: - Alte, zu weite Regel erkennen

    /// Liegt noch die alte Regel ohne Argumentliste (freies pmset als root)?
    ///
    /// Die Regeldatei ist 440 root:wheel und für die App unlesbar; geprüft
    /// wird deshalb ihre Wirkung. `pmset -g` liest nur Einstellungen (keine
    /// Nebenwirkung) und ist von der ALTEN Regel gedeckt, von der engen nicht.
    private static func hasLegacyBroadRule() -> Bool {
        // Die Gegenprobe erst, wenn die erste anschlägt: sonst spawnt jeder
        // Schaltvorgang ein sudo für nichts und hinterlässt im Systemlog eine
        // überflüssige „not allowed“-Zeile.
        guard sudoAllowsWithoutPassword([pmsetPath, "-g"]) else { return false }
        return needsRuleUpgrade(
            pmsetAllowedWithoutRuleArguments: true,
            anyCommandAllowedWithoutPassword: sudoAllowsWithoutPassword(["/usr/bin/true"])
        )
    }

    /// Auswertung der beiden Proben. Wer ohnehin ein pauschales `NOPASSWD: ALL`
    /// eingerichtet hat, lässt auch `/usr/bin/true` durch — dann sagt die
    /// pmset-Probe nichts über UNSERE Regel aus, und ein „Upgrade“ brächte nur
    /// einen Passwortdialog bei jedem Schaltvorgang.
    static func needsRuleUpgrade(pmsetAllowedWithoutRuleArguments: Bool,
                                 anyCommandAllowedWithoutPassword: Bool) -> Bool {
        pmsetAllowedWithoutRuleArguments && !anyCommandAllowedWithoutPassword
    }

    // MARK: - Einmal-Freigabe (interaktiv)

    /// Der EINE Admin-Dialog: installiert die sudoers-Regel und setzt
    /// disablesleep im selben Aufruf. Läuft blockierend auf `queue`.
    private static func runInteractively(_ on: Bool) -> Result<Void, PrivilegedPowerError> {
        let value = on ? "1" : "0"
        let user = NSUserName()
        let shell: String

        if isValidShortUserName(user) {
            // Regel + Schaltvorgang in EINEM Admin-Kontext. `set -e` bricht
            // beim ersten Fehler ab: scheitert visudo, wird nichts
            // installiert und pmset nicht ausgeführt.
            let rule = sudoersRule(for: user)
            shell = [
                "set -e",
                "umask 077",
                "tmp=$(/usr/bin/mktemp /private/tmp/max-monitor-sudoers.XXXXXX)",
                "/usr/bin/printf '%s\\n' '\(rule)' > \"$tmp\"",
                "/usr/sbin/visudo -cf \"$tmp\"",
                "/usr/bin/install -m 440 -o root -g wheel \"$tmp\" \(sudoersFile)",
                "/bin/rm -f \"$tmp\"",
                "\(pmsetPath) -a disablesleep \(value)"
            ].joined(separator: "; ")
        } else {
            // Kurzname außerhalb des sicheren Musters: KEINE Regel
            // installieren (nichts Ungeprüftes in eine root-Shell) — dann
            // eben ein Admin-Dialog pro Schaltvorgang.
            log.notice("Kurzname passt nicht ins sudoers-Muster — Einmal-Regel wird nicht installiert")
            shell = "\(pmsetPath) -a disablesleep \(value)"
        }

        let script = "do shell script \(appleScriptStringLiteral(shell)) with administrator privileges"

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        process.standardOutput = Pipe()
        let stderrPipe = Pipe()
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return .failure(.failed("osascript ließ sich nicht starten: \(error.localizedDescription)"))
        }

        // Erst die Pipe leer lesen, dann warten — sonst kann ein voller
        // Puffer beide Seiten festhalten.
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        if process.terminationStatus == 0 {
            log.notice("Einmal-Freigabe erteilt, disablesleep auf \(value, privacy: .public) gesetzt")
            return .success(())
        }

        let message = String(data: stderrData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        // Abbruch im Passwortdialog: osascript endet mit Status 1 und
        // AppleScript-Fehler -128 („User canceled“ — lokalisiert, die Nummer
        // bleibt). Das ist kein Fehler, sondern eine Entscheidung.
        if message.contains("-128") {
            log.notice("Einmal-Freigabe abgebrochen — Deckel-Schutz bleibt aus")
            return .failure(.cancelled)
        }

        log.error("Einmal-Freigabe fehlgeschlagen: \(message, privacy: .public)")
        return .failure(.failed(message))
    }

    // MARK: - Die Regel

    /// Die Einmal-Regel — eine Zeile, exakt die beiden Aufrufe aus
    /// `runSilently`. sudoers deckt nur Argumentlisten ab, die Zeichen für
    /// Zeichen passen; ohne Liste stünde jeder pmset-Aufruf offen. Wer den
    /// Aufruf in `runSilently` ändert, muss diese Zeile mitziehen, sonst
    /// fragt die App wieder bei jedem Schaltvorgang nach dem Passwort.
    /// - Parameter user: MUSS `isValidShortUserName` bestanden haben.
    static func sudoersRule(for user: String) -> String {
        "\(user) ALL=(root) NOPASSWD: \(pmsetPath) -a disablesleep 1, \(pmsetPath) -a disablesleep 0"
    }

    // MARK: - Validierung & Escaping

    /// Klassisches POSIX-Kurznamen-Muster. Alles außerhalb (Leerzeichen,
    /// Quotes, Unicode …) fliegt raus — solche Namen kommen NIE in die Regel.
    static func isValidShortUserName(_ name: String) -> Bool {
        name.range(of: "^[a-z_][a-z0-9_-]*$", options: .regularExpression) != nil
    }

    /// Baut ein AppleScript-String-Literal: Backslashes zuerst, dann
    /// Anführungszeichen — die einzigen zwei Zeichen, die AppleScript in
    /// "…" interpretiert.
    static func appleScriptStringLiteral(_ raw: String) -> String {
        let escaped = raw
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
