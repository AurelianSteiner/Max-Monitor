//
//  OAuthGrantFailure.swift
//  Usage4Claude
//
//  Erkennt, ob eine Antwort des Token-Endpunkts „die Autorisierung ist tot"
//  bedeutet — im Gegensatz zu einem gewöhnlichen, vorübergehenden Fehler.
//
//  Refresh-Tokens sind Einmal-Tokens: Mit jeder Erneuerung gibt der Server ein
//  neues aus und macht das alte ungültig. Ein verbrauchtes oder widerrufenes
//  Token lässt sich durch nichts wiederbeleben; nur eine Neuanmeldung hilft.
//
//  Die beiden Anbieter melden das verschieden: RFC 6749 §5.2 sieht dafür
//  HTTP 400 mit `invalid_grant` vor — so macht es Anthropic. OpenAI antwortet
//  mit 401. Wer nur auf 401 prüft, hält Anthropics 400 für einen allgemeinen
//  HTTP-Fehler, zeigt „HTTP-Fehler 400" an und versucht es beim nächsten
//  Abruf wieder — bei jedem Konto, jede Minute. Genau das hat den
//  Token-Endpunkt für dieses Netz in die Drosselung (429) getrieben, wodurch
//  dann auch Neuanmeldungen scheiterten.
//
//  Reine Funktion, keine Abhängigkeiten — wird per SwiftPM getestet.
//

import Foundation

nonisolated enum OAuthGrantFailure {

    /// Bedeutet diese Antwort, dass die Autorisierung tot ist und nur eine
    /// Neuanmeldung hilft?
    /// - Parameters:
    ///   - statusCode: HTTP-Status der Antwort
    ///   - body: Antworttext (JSON oder HTML, wird nur durchsucht)
    static func isDeadGrant(statusCode: Int, body: String) -> Bool {
        // OpenAI: „refresh_token nicht mehr gültig" kommt als 401
        if statusCode == 401 { return true }

        // RFC 6749 §5.2: verbrauchtes/widerrufenes Token → 400 + invalid_grant (Anthropic)
        if statusCode == 400, body.contains("invalid_grant") { return true }

        // Auffangnetz: Klartext, dass das Token schon benutzt wurde
        // (OpenAI liefert das auf einzelnen Pfaden auch mit 400)
        if body.localizedCaseInsensitiveContains("refresh token has already been used") { return true }

        return false
    }
}
