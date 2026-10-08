//
//  TeamServerConnection.swift
//  Usage4Claude
//
//  Team-Übersicht — Server-Anbindung Teil 1: die Verbindung selbst.
//
//  Die App spricht direkt mit dem Team-Relay — das ist der einzige Weg in
//  ein Team. Eine Verbindung besteht aus Server-URL, Team-ID und einem
//  Token; die Rolle („super", „admin", „member") kommt vom Server (GET /me)
//  und entscheidet, was die Oberfläche zeigt.
//
//  Persistenz: URL, Team-ID und Rolle liegen in UserDefaults (mit dem
//  üblichen DEBUG_-Präfix), das Token dagegen im
//  Schlüsselbund über den bestehenden `KeychainManager` (der in DEBUG
//  seinerseits bewusst UserDefaults nutzt — die Konvention steckt dort).
//
//  Transport: Die Server-URL muss `https` sein — `http` nur zum eigenen
//  Rechner (localhost/127.0.0.1/::1), damit ein selbst gehostetes Relay
//  lokal ausprobiert werden kann. Sonst ginge das Bearer-Token im Klartext
//  durchs Netz. `isSecureServerURL` ist die eine Stelle, die das entscheidet.
//
//  Thread-Regel wie im Projekt: Öffentliche Methoden vom Main-Thread,
//  Completions kommen auf dem Main-Thread zurück, `@Published` wird nur
//  auf dem Main-Thread geschrieben.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import Combine
import OSLog

// MARK: - Rolle

/// Was ein Token auf dem Team-Server darf.
enum TeamServerRole: String, Codable, Equatable, CaseIterable {
    /// Team owner: manages identities and invitation tokens.
    case superAdmin = "super"
    /// Reads the team, synchronizes the queue and permanently deletes member Macs.
    case admin
    /// Participates with a reporting Mac.
    case member
    /// Reads all team data and resolves tasks, without reporting a Mac.
    case guest

    init(lenient raw: String?) {
        switch raw?.lowercased() {
        case "super": self = .superAdmin
        case "admin": self = .admin
        case "guest": self = .guest
        default: self = .member
        }
    }

    var seesAllReports: Bool { true }
    var canManageMembers: Bool { self == .superAdmin }
    var canViewMembers: Bool { self != .member }
    var canDeleteMacs: Bool { self == .superAdmin || self == .admin }
    var reportsDevice: Bool { self == .member }
}

// MARK: - Persistenz-Schlüssel

/// UserDefaults-Schlüssel der Server-Verbindung — DEBUG-Präfix wie überall
/// im Projekt (vgl. `AccountStore`, `UserSettings`).
enum TeamServerDefaultsKeys {
    #if DEBUG
    private static let prefix = "DEBUG_"
    #else
    private static let prefix = ""
    #endif

    static let serverURL  = prefix + "teamServerURL"
    static let teamId     = prefix + "teamServerTeamId"
    static let role       = prefix + "teamServerRole"
    static let memberName = prefix + "teamServerMemberName"
    static let memberId   = prefix + "teamServerMemberId"
}

// MARK: - Verbindung

/// Hält die eine Server-Verbindung der App und ist deren einziger Besitzer:
/// verbinden, Rolle prüfen, trennen. `TeamReportStore` fragt hier nach dem
/// Client, `TeamAutoReporter` nach Name und Team.
final class TeamServerConnection: ObservableObject {

    /// Gemeinsame Instanz für Einstellungen, Übersicht und Meldeschleife
    static let shared = TeamServerConnection()

    /// Das produktive Team-Relay — vorbelegt, damit niemand URLs abtippt.
    static let defaultServerURL = URL(string: "https://api.ruegamer-steiner.de/max-monitor")!

    // MARK: - Veröffentlichter Zustand

    /// Basis-URL des Relays (ohne Pfad)
    @Published private(set) var serverURL: URL
    /// Team-ID auf dem Server (4–16 Zeichen A–Z/0–9), `nil` = nicht verbunden
    @Published private(set) var teamId: String?
    /// Rolle laut letztem erfolgreichen GET /me; `nil` nach 401
    @Published private(set) var role: TeamServerRole?
    /// Eingetragener Name — nur bei Mitgliedern, Super/Admin melden namenlos
    @Published private(set) var memberName: String?
    /// Server-interne Mitglieds-ID (nur Mitglieder)
    @Published private(set) var memberId: String?
    /// Läuft gerade ein Verbindungsversuch?
    @Published private(set) var isConnecting = false
    /// Letzter Fehler in Alltagssprache („Token ungültig.") — `nil`, wenn alles gut
    @Published private(set) var lastError: String?

    // MARK: - Intern

    /// Das Token — im Speicher gehalten, dauerhaft nur im Schlüsselbund
    private(set) var token: String?
    private let defaults = UserDefaults.standard

    // MARK: - Abfragen

    /// Besteht eine Verbindung (Team-ID und Token vorhanden)?
    /// Die Rolle kann trotzdem `nil` sein — dann wurde das Token zuletzt
    /// abgelehnt und `lastError` sagt warum.
    var isConnected: Bool { teamId != nil && token != nil }

    /// Die gespeicherte Adresse trägt das Token unverschlüsselt (http auf
    /// einen fremden Rechner) — aus einer älteren Version übrig geblieben.
    /// Die Verbindung bleibt gespeichert, wird aber nicht benutzt; die
    /// Oberfläche zeigt deshalb wieder das Verbinden-Formular.
    var isServerURLInsecure: Bool { !Self.isSecureServerURL(serverURL) }

    /// Fertig konfigurierter Client für die aktuelle Verbindung, `nil` ohne.
    ///
    /// Hier hängt alles dran, was mit dem Server spricht (Meldeschleife,
    /// Übersicht, Verlauf, Mitgliederverwaltung) — deshalb ist das die eine
    /// Stelle, an der eine unsichere URL alles anhält: kein Client, keine
    /// Anfrage, das Token verlässt den Rechner nicht.
    var client: TeamServerClient? {
        guard let teamId, let token, Self.isSecureServerURL(serverURL) else { return nil }
        return TeamServerClient(baseURL: serverURL, teamId: teamId, token: token)
    }

    // MARK: - Lebenslauf

    /// Vom App-Start (MenuBarManager) aufgerufen: lädt die gespeicherte
    /// Verbindung, prüft die Rolle und weckt die automatische Eigenmeldung —
    /// auch wenn nie ein Team-Fenster geöffnet wird.
    static func bootstrap() {
        _ = shared
    }

    private init() {
        Self.removeLegacyFolderConfiguration()

        if let raw = defaults.string(forKey: TeamServerDefaultsKeys.serverURL),
           let url = URL(string: raw) {
            serverURL = url
        } else {
            serverURL = Self.defaultServerURL
        }
        teamId = defaults.string(forKey: TeamServerDefaultsKeys.teamId)
        role = defaults.string(forKey: TeamServerDefaultsKeys.role).flatMap(TeamServerRole.init(rawValue:))
        memberName = defaults.string(forKey: TeamServerDefaultsKeys.memberName)
        memberId = defaults.string(forKey: TeamServerDefaultsKeys.memberId)
        token = KeychainManager.shared.loadTeamServerToken()

        // Nachgelagert (nicht im init!), damit sich die Singletons nicht
        // gegenseitig beim Erzeugen aufrufen: Meldeschleife anlegen und die
        // gespeicherte Rolle einmal gegen den Server prüfen.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            _ = TeamAutoReporter.shared
            _ = FleetReporter.shared
            guard self.isConnected else { return }
            guard !self.isServerURLInsecure else {
                // Eine http-Adresse aus einer älteren Version: Die
                // Einstellung bleibt stehen, wie sie ist — still auf https
                // umzuschreiben hieße, jemandem eine andere Verbindung
                // unterzuschieben. Stattdessen bleibt sie ungenutzt (`client`
                // gibt nichts heraus) und der Grund steht in `lastError`,
                // direkt unter dem Server-Abschnitt der Einstellungen.
                self.lastError = L.Team.serverInsecureSavedURL
                Logger.team.notice("Gespeicherte Team-Server-URL ist unverschlüsselt — Verbindung wird nicht benutzt")
                return
            }
            self.verifyIdentity()
        }
    }

    // MARK: - Server-URL

    /// Darf über diese Adresse ein Token gehen? `https` immer — `http` nur
    /// zum eigenen Rechner, damit sich ein selbst gehostetes Relay lokal
    /// ausprobieren lässt. Alles andere trüge das Bearer-Token im Klartext
    /// durchs Netz. (ATS unterbindet Klartext-http heute ohnehin; die Zusage
    /// gehört trotzdem in den Code und nicht in die Plattform.)
    static func isSecureServerURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host, !host.isEmpty else { return false }
        switch scheme {
        case "https": return true
        case "http":  return isLoopbackHost(host)
        default:      return false
        }
    }

    /// Der eigene Rechner. IPv6-Literale kommen je nach Eingabe mit oder ohne
    /// eckige Klammern an — beides abfangen.
    private static func isLoopbackHost(_ host: String) -> Bool {
        let cleaned = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        return cleaned == "localhost" || cleaned == "127.0.0.1" || cleaned == "::1"
    }

    // MARK: - Team-ID

    /// Räumt eine eingetippte Team-ID auf: Großschreibung, Trennzeichen raus.
    /// Der Server erlaubt 4–16 Zeichen A–Z/0–9 (die App selbst erzeugt 8).
    static func normalizeTeamId(_ raw: String) -> String? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        let cleaned = String(raw.uppercased().filter { allowed.contains($0) })
        guard (4...16).contains(cleaned.count) else { return nil }
        return cleaned
    }

    // MARK: - Verbinden / Trennen

    /// Verbindet mit dem Relay: prüft die Eingaben, ruft GET /me und
    /// speichert bei Erfolg URL + Team-ID (UserDefaults) und Token
    /// (Schlüsselbund). Completion kommt auf dem Main-Thread.
    func connect(serverURL: URL = TeamServerConnection.defaultServerURL,
                 teamId rawTeamId: String,
                 token rawToken: String,
                 completion: @escaping (Result<TeamServerIdentity, TeamServerError>) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))

        // Zuerst das Ziel: Wohin das Token ginge, entscheidet sich hier —
        // die Oberfläche prüft dasselbe, ist aber nicht die einzige Aufruferin.
        guard Self.isSecureServerURL(serverURL) else {
            lastError = TeamServerError.insecureURL.errorDescription
            completion(.failure(.insecureURL))
            return
        }

        guard let teamId = Self.normalizeTeamId(rawTeamId) else {
            lastError = TeamServerError.invalidTeamId.errorDescription
            completion(.failure(.invalidTeamId))
            return
        }
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            lastError = TeamServerError.invalidToken.errorDescription
            completion(.failure(.invalidToken))
            return
        }

        let client = TeamServerClient(baseURL: serverURL, teamId: teamId, token: token)
        isConnecting = true
        Task { [weak self] in
            let outcome = await Self.identify(with: client)
            await MainActor.run {
                guard let self else { return }
                self.isConnecting = false
                switch outcome {
                case .success(let identity):
                    self.store(serverURL: serverURL, teamId: teamId, token: token, identity: identity)
                    self.lastError = nil
                case .failure(let error):
                    // Nichts speichern — die bisherige Verbindung (falls
                    // vorhanden) bleibt unangetastet.
                    self.lastError = error.errorDescription
                }
                completion(outcome)
            }
        }
    }

    /// Prüft die gespeicherte Verbindung erneut gegen GET /me.
    /// 401 → Rolle löschen und „Token ungültig" melden; Netzfehler lassen
    /// die Rolle stehen (der Server kann auch einfach gerade weg sein).
    func verifyIdentity(completion: ((Result<TeamServerIdentity, TeamServerError>) -> Void)? = nil) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let client else {
            completion?(.failure(.notConnected))
            return
        }
        Task { [weak self] in
            let outcome = await Self.identify(with: client)
            await MainActor.run {
                guard let self else { return }
                switch outcome {
                case .success(let identity):
                    let changed = identity.role != self.role || identity.name != self.memberName
                    self.apply(identity: identity)
                    self.lastError = nil
                    if changed {
                        NotificationCenter.default.post(name: .teamServerChanged, object: nil)
                    }
                case .failure(.invalidToken):
                    self.role = nil
                    self.defaults.removeObject(forKey: TeamServerDefaultsKeys.role)
                    self.lastError = TeamServerError.invalidToken.errorDescription
                    Logger.team.notice("Team-Server: Token abgelehnt, Rolle verworfen")
                case .failure(let error):
                    self.lastError = error.errorDescription
                }
                completion?(outcome)
            }
        }
    }

    /// Trennt die Verbindung: UserDefaults-Schlüssel und Schlüsselbund-Token
    /// weg, Zustand zurück auf Anfang. Auf dem Server wird nichts gelöscht.
    func disconnect() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard teamId != nil || token != nil else { return }

        teamId = nil
        token = nil
        role = nil
        memberName = nil
        memberId = nil
        lastError = nil
        serverURL = Self.defaultServerURL

        for key in [TeamServerDefaultsKeys.serverURL,
                    TeamServerDefaultsKeys.teamId,
                    TeamServerDefaultsKeys.role,
                    TeamServerDefaultsKeys.memberName,
                    TeamServerDefaultsKeys.memberId] {
            defaults.removeObject(forKey: key)
        }
        KeychainManager.shared.deleteTeamServerToken()

        NotificationCenter.default.post(name: .teamServerChanged, object: nil)
        Logger.team.notice("Vom Team-Server getrennt")
    }

    // MARK: - Mitgliederverwaltung (Durchreicher mit Main-Thread-Completion)

    /// GET /members — super sieht die Tokens, admin nicht.
    func fetchMembers(completion: @escaping (Result<[TeamServerMember], TeamServerError>) -> Void) {
        perform({ try await $0.members() }, completion: completion)
    }

    /// POST /members — Mitglied anlegen (nur super). Die Antwort enthält das
    /// frische Token zum Weitergeben.
    func addMember(name: String, role: TeamServerRole,
                   completion: @escaping (Result<TeamServerMember, TeamServerError>) -> Void) {
        perform({ try await $0.addMember(name: name, role: role) }, completion: completion)
    }

    /// Changes a role without rotating the member's existing invitation token.
    func updateMember(id: String, role: TeamServerRole,
                      completion: @escaping (Result<TeamServerMember, TeamServerError>) -> Void) {
        perform({ try await $0.updateMember(id: id, role: role) }, completion: completion)
    }

    /// DELETE /members/<id> — Mitglied samt Meldung entfernen (nur super).
    func deleteMember(id: String, completion: @escaping (Result<Void, TeamServerError>) -> Void) {
        perform({ try await $0.deleteMember(id: id) }, completion: completion)
    }

    // MARK: - Intern

    /// Führt einen Client-Aufruf aus und bringt das Ergebnis zurück auf den
    /// Main-Thread — die Projekt-Konvention für alle öffentlichen Completions.
    private func perform<T>(_ operation: @escaping (TeamServerClient) async throws -> T,
                            completion: @escaping (Result<T, TeamServerError>) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let client else {
            completion(.failure(.notConnected))
            return
        }
        Task {
            let outcome: Result<T, TeamServerError>
            do {
                outcome = .success(try await operation(client))
            } catch let error as TeamServerError {
                outcome = .failure(error)
            } catch {
                outcome = .failure(.network(error.localizedDescription))
            }
            await MainActor.run { completion(outcome) }
        }
    }

    private static func identify(with client: TeamServerClient) async -> Result<TeamServerIdentity, TeamServerError> {
        do {
            return .success(try await client.me())
        } catch let error as TeamServerError {
            return .failure(error)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }

    /// Einmaliges Aufräumen: Der geteilte Ordner als Meldeweg ist abgeschafft.
    /// Reste aus früheren Versionen — das Sicherheits-Lesezeichen des Ordners
    /// und die lokale Team-Konfiguration — werden still aus den UserDefaults
    /// entfernt (kein Dialog; der Ordner selbst bleibt unangetastet). Läuft
    /// beim Start und nach jedem erfolgreichen Verbinden.
    static func removeLegacyFolderConfiguration() {
        #if DEBUG
        let prefix = "DEBUG_"
        #else
        let prefix = ""
        #endif
        let defaults = UserDefaults.standard
        for key in [prefix + "teamConfig", prefix + "teamFolderBookmark"] where defaults.object(forKey: key) != nil {
            defaults.removeObject(forKey: key)
            Logger.team.notice("Alte Ordner-Konfiguration entfernt: \(key, privacy: .public)")
        }
    }

    /// Erfolgreiche Verbindung übernehmen und dauerhaft ablegen.
    private func store(serverURL: URL, teamId: String, token: String, identity: TeamServerIdentity) {
        Self.removeLegacyFolderConfiguration()

        self.serverURL = serverURL
        self.teamId = teamId
        self.token = token
        apply(identity: identity)

        defaults.set(serverURL.absoluteString, forKey: TeamServerDefaultsKeys.serverURL)
        defaults.set(teamId, forKey: TeamServerDefaultsKeys.teamId)
        KeychainManager.shared.saveTeamServerToken(token)

        NotificationCenter.default.post(name: .teamServerChanged, object: nil)
        Logger.team.notice("Mit Team-Server verbunden (Rolle: \(identity.role.rawValue, privacy: .public))")
    }

    /// Rolle/Name/Mitglieds-ID übernehmen und in UserDefaults spiegeln.
    private func apply(identity: TeamServerIdentity) {
        role = identity.role
        memberName = identity.name
        memberId = identity.memberId

        defaults.set(identity.role.rawValue, forKey: TeamServerDefaultsKeys.role)
        if let name = identity.name {
            defaults.set(name, forKey: TeamServerDefaultsKeys.memberName)
        } else {
            defaults.removeObject(forKey: TeamServerDefaultsKeys.memberName)
        }
        if let memberId = identity.memberId {
            defaults.set(memberId, forKey: TeamServerDefaultsKeys.memberId)
        } else {
            defaults.removeObject(forKey: TeamServerDefaultsKeys.memberId)
        }
    }
}
