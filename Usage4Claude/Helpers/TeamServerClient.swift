//
//  TeamServerClient.swift
//  Usage4Claude
//
//  Team-Übersicht — Server-Anbindung Teil 2: der HTTP-Client.
//
//  Spricht mit dem Team-Relay (team-server/server.js), einem winzigen
//  Dienst, der pro Team nichts weiter speichert als Prozentwerte, Labels
//  und Reset-Zeitpunkte. Endpunkte:
//
//      GET    /v1/teams/<ID>/me                  Rolle + Name des Tokens
//      GET    /v1/teams/<ID>/reports             Meldungen (jede Rolle: alle)
//      POST   /v1/reports                        eigene Meldung speichern
//      GET    /v1/teams/<ID>/members             Mitglieder (super: mit Tokens)
//      POST   /v1/teams/<ID>/members             Mitglied anlegen (nur super)
//      DELETE /v1/teams/<ID>/members/<memberId>  Mitglied entfernen (nur super)
//      GET    /v1/teams/<ID>/members/<memberId>/history?days=7
//                                                Verlauf (member: nur der eigene)
//
//  Alles außer /health trägt "Authorization: Bearer <token>". Fehler kommen
//  als {"error":"…"} mit 4xx/5xx und werden hier in lesbare `TeamServerError`
//  übersetzt — kaputtes JSON bringt nie die App um, es fällt nur der eine
//  Eintrag bzw. der eine Aufruf aus.
//
//  Der Client selbst ist bewusst „dumm": reine async-Aufrufe ohne eigenen
//  Zustand. Wer Haupt-Thread-Garantien braucht (Projekt-Konvention für
//  Completions), bekommt sie eine Ebene höher — `TeamServerConnection`
//  und `TeamReportStore` springen nach jedem await zurück auf den Main-Thread.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import Foundation
import OSLog

// MARK: - Fehler

/// Warum ein Aufruf des Team-Servers scheiterte.
enum TeamServerError: Error, Equatable {
    /// Es ist gar keine Verbindung eingerichtet
    case notConnected
    /// Team-ID entspricht nicht dem Muster (4–16 Zeichen A–Z, 0–9)
    case invalidTeamId
    /// Token leer oder vom Server abgelehnt (401)
    case invalidToken
    /// Server-URL ohne TLS — es wurde nichts gesendet, das Token bliebe
    /// sonst im Klartext im Netz (nur `localhost` darf http)
    case insecureURL
    /// Netz weg, Timeout, DNS — alles, was vor einer Antwort schiefgeht
    case network(String)
    /// Der Server hat geantwortet, aber mit einem Fehler ({"error": …})
    case server(status: Int, message: String)
    /// Antwort war kein verwertbares JSON
    case invalidResponse
}

extension TeamServerError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .notConnected:               return L.Team.serverNotConnected
        case .invalidTeamId:              return L.Team.serverInvalidTeamId
        case .invalidToken:               return L.Team.serverInvalidToken
        case .insecureURL:                return L.Team.serverInsecureURL
        case .network:                    return L.Team.serverUnreachable
        case .server(_, let message):     return message
        case .invalidResponse:            return L.Team.serverBadResponse
        }
    }
}

// MARK: - Antwort-Typen

/// Antwort von GET /me: Wer ist dieses Token?
struct TeamServerIdentity: Equatable {
    let role: TeamServerRole
    /// Eingetragener Name — nur bei Mitgliedern, `nil` beim Super-Token
    let name: String?
    /// Server-interne Mitglieds-ID — nur bei Mitgliedern
    let memberId: String?
}

extension TeamServerIdentity: Decodable {
    private enum CodingKeys: String, CodingKey { case role, name, memberId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = TeamServerRole(lenient: try? container.decodeIfPresent(String.self, forKey: .role))
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? nil
        memberId = (try? container.decodeIfPresent(String.self, forKey: .memberId)) ?? nil
    }
}

/// Ein Eintrag aus GET /members.
struct TeamServerMember: Identifiable, Equatable {
    let id: String
    let name: String
    let role: TeamServerRole
    /// Nur der Super-Admin bekommt die Tokens mitgeliefert — er gibt sie an
    /// die Kollegen weiter. Admins sehen `nil`.
    let token: String?
    let createdAt: Date?
}

extension TeamServerMember: Decodable {
    private enum CodingKeys: String, CodingKey { case id, name, role, token, createdAt }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        role = TeamServerRole(lenient: try? container.decodeIfPresent(String.self, forKey: .role))
        token = (try? container.decodeIfPresent(String.self, forKey: .token)) ?? nil
        if let raw = (try? container.decodeIfPresent(String.self, forKey: .createdAt)) ?? nil {
            createdAt = TeamDateFormat.parse(raw)
        } else {
            createdAt = nil
        }
    }
}

// MARK: - Client

/// Ein Client pro Verbindung: Basis-URL, Team und Token stehen fest.
final class TeamServerClient {

    let baseURL: URL
    let teamId: String
    private let token: String
    private let session: URLSession

    /// Der Server antwortet in Millisekunden — wer 15 Sekunden nichts hört,
    /// hört auch nach 60 nichts mehr.
    static let requestTimeout: TimeInterval = 15

    init(baseURL: URL, teamId: String, token: String) {
        self.baseURL = baseURL
        self.teamId = teamId.uppercased()
        self.token = token
        // Ephemeral: keine Cookies, kein Cache — die Autorisierung läuft
        // ausschließlich über das Bearer-Token.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.requestTimeout
        configuration.timeoutIntervalForResource = Self.requestTimeout * 2
        configuration.waitsForConnectivity = false
        self.session = URLSession(configuration: configuration)
    }

    // MARK: - Endpunkte

    /// GET /v1/teams/<ID>/me — Rolle und Name dieses Tokens.
    func me() async throws -> TeamServerIdentity {
        let data = try await request("GET", "/v1/teams/\(teamId)/me")
        return try Self.decode(TeamServerIdentity.self, from: data)
    }

    /// GET /v1/teams/<ID>/reports — alle Meldungen des Teams (jede Rolle).
    ///
    /// Jeder Eintrag läuft einzeln durch den toleranten `TeamReport.parse`:
    /// Ein kaputter Eintrag fliegt still raus, die anderen bleiben. Einträge
    /// mit fremder Team-ID werden übersprungen.
    func reports() async throws -> [TeamReport] {
        let data = try await request("GET", "/v1/teams/\(teamId)/reports")
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawReports = object["reports"] as? [Any] else {
            throw TeamServerError.invalidResponse
        }

        var reports: [TeamReport] = []
        for element in rawReports {
            guard let dictionary = element as? [String: Any],
                  JSONSerialization.isValidJSONObject(dictionary),
                  let elementData = try? JSONSerialization.data(withJSONObject: dictionary) else { continue }
            do {
                var report = try TeamReport.parse(elementData)
                guard report.teamId.caseInsensitiveCompare(teamId) == .orderedSame else { continue }
                // Stabile Identität für die UI: die Mitglieds-ID des Servers,
                // ersatzweise der Namens-Slug (Super/Admin melden ohne ID).
                let memberId = dictionary["memberId"] as? String
                report.fileName = "server-" + (memberId ?? TeamReport.slug(report.person))
                // Für den Verlaufs-Endpunkt: die echte ID getrennt merken —
                // der Rückfall dort ist der Slug des *Servers*, nicht unserer.
                report.serverMemberId = memberId
                reports.append(report)
            } catch {
                Logger.team.debug("Server-Meldung übersprungen (nicht lesbar)")
                continue
            }
        }
        return reports
    }

    /// POST /v1/reports — die eigene Meldung speichern.
    /// Für Mitglieds-Tokens erzwingt der Server den eingetragenen Namen.
    func postReport(_ report: TeamReport) async throws {
        let body: Data
        do {
            body = try report.canonicalJSONData()
        } catch {
            throw TeamServerError.invalidResponse
        }
        _ = try await request("POST", "/v1/reports", body: body)
    }

    /// POST /v1/teams/<ID>/heartbeat — liveness plus every local Claude account.
    func postHeartbeat(_ heartbeat: FleetHeartbeat) async throws {
        _ = try await request("POST", "/v1/teams/\(teamId)/heartbeat", body: heartbeat.jsonData())
    }

    var fleetDashboardURL: URL { baseURL.appendingPathComponent("fleet") }

    /// Only the ephemeral fleet WebView receives this script. It is scoped to
    /// this exact origin/path and kept in memory; never put credentials in URLs.
    func fleetBootstrapScript() throws -> String {
        guard let origin = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let scheme = origin.scheme, let host = origin.host else { throw TeamServerError.invalidResponse }
        let hostText = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let defaultPort = scheme.lowercased() == "https" ? 443 : 80
        let portText = origin.port.flatMap { $0 == defaultPort ? nil : ":\($0)" } ?? ""
        let context: [String: String] = [
            "teamId": teamId, "token": token,
            "origin": "\(scheme)://\(hostText)\(portText)", "path": fleetDashboardURL.path
        ]
        let data = try JSONSerialization.data(withJSONObject: context)
        guard let json = String(data: data, encoding: .utf8) else { throw TeamServerError.invalidResponse }
        return """
        (() => {
          const context = \(json);
          if (location.origin === context.origin && (location.pathname === context.path || location.pathname === context.path + '/')) {
            window.__MAX_MONITOR__ = { teamId: context.teamId, token: context.token };
          }
        })();
        """
    }

    /// GET /v1/teams/<ID>/members — super (mit Tokens) oder admin (ohne).
    func members() async throws -> [TeamServerMember] {
        struct Envelope: Decodable { let members: [TeamServerMember] }
        let data = try await request("GET", "/v1/teams/\(teamId)/members")
        return try Self.decode(Envelope.self, from: data).members
    }

    /// POST /v1/teams/<ID>/members — Mitglied anlegen (nur super).
    /// Die Antwort enthält das frische Token zum Weitergeben.
    func addMember(name: String, role: TeamServerRole) async throws -> TeamServerMember {
        struct Envelope: Decodable { let member: TeamServerMember }
        let payload: [String: String] = ["name": name, "role": role.rawValue]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            throw TeamServerError.invalidResponse
        }
        let data = try await request("POST", "/v1/teams/\(teamId)/members", body: body)
        return try Self.decode(Envelope.self, from: data).member
    }

    func updateMember(id: String, role: TeamServerRole) async throws -> TeamServerMember {
        struct Envelope: Decodable { let member: TeamServerMember }
        guard let body = try? JSONSerialization.data(withJSONObject: ["role": role.rawValue]) else {
            throw TeamServerError.invalidResponse
        }
        let data = try await request("PATCH", "/v1/teams/\(teamId)/members/\(id)", body: body)
        return try Self.decode(Envelope.self, from: data).member
    }

    /// GET /v1/teams/<ID>/members/<memberId>/history?days=7 — der
    /// Auslastungs-Verlauf einer Person (super/admin: jede, member: nur die
    /// eigene). Kaputte Zeilen fliegen einzeln raus, wie bei `reports()`;
    /// eine Person ohne Verlauf liefert schlicht ein leeres Array.
    func history(memberId: String, days: Int = 7) async throws -> [TeamHistorySample] {
        let escaped = memberId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? memberId
        let data = try await request("GET", "/v1/teams/\(teamId)/members/\(escaped)/history?days=\(days)")
        do {
            return try TeamHistorySample.parseList(data)
        } catch {
            throw TeamServerError.invalidResponse
        }
    }

    /// DELETE /v1/teams/<ID>/members/<memberId> — Mitglied entfernen (nur super).
    func deleteMember(id: String) async throws {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await request("DELETE", "/v1/teams/\(teamId)/members/\(escaped)")
    }

    // MARK: - Transport

    /// Führt einen Aufruf aus und übersetzt jede Art von Scheitern in einen
    /// `TeamServerError`. 2xx liefert die Rohdaten, 401 wird zu
    /// `.invalidToken`, alles andere trägt die {"error": …}-Nachricht.
    private func request(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + path) else { throw TeamServerError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw TeamServerError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else { throw TeamServerError.invalidResponse }
        switch http.statusCode {
        case 200..<300:
            return data
        case 401:
            throw TeamServerError.invalidToken
        default:
            throw TeamServerError.server(status: http.statusCode,
                                         message: Self.errorMessage(from: data, status: http.statusCode))
        }
    }

    /// {"error":"…"} → lesbarer Text; ersatzweise „HTTP 500".
    private static func errorMessage(from data: Data, status: Int) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = object["error"] as? String,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }
        return "HTTP \(status)"
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw TeamServerError.invalidResponse
        }
    }
}
