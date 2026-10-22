# Pink: Claude-Kontingente nach TLS-Abbruch erneut abrufen

## Diagnose

Am 22.10.2026 um 17:27:45 und 17:49:42 Europe/Berlin protokolliert Pinks
Max-Monitor-Prozess Fehler im OAuth-Usage-GET. CFNetwork meldet
`NSURLErrorDomain -1200`, darunter `-9816`, und im zugehörigen Verbindungsverlauf
`Connection reset by peer` während des TLS-Handshakes. Es wurden jeweils keine
HTTP-Anfrage- oder Antwortbytes übertragen. Der erste fehlschlagende Pfad war
IPv6; parallele IPv4-Verbindungsversuche wurden danach verworfen.

Die Logs belegen den Verbindungsabbruch auf dem Weg zum Claude-Endpunkt. Sie
identifizieren nicht, ob Anthropic, ein vorgelagertes Netzsystem oder ein
Zwischenknoten den Reset ausgelöst hat. Ein bestimmter Router oder ein dauerhaft
defektes IPv6 wird deshalb nicht als Ursache behauptet.

Direkte Prüfungen auf Pink erreichten `api.anthropic.com/api/oauth/usage` über
IPv4 und IPv6 in ungefähr 0,2 Sekunden. Beide meldeten Zertifikatsprüfung 0 und
HTTP 401, wie bei diesen ausdrücklich nicht authentifizierten Netzwerkproben
erwartet. Systemzeit und Route waren plausibel, ein Systemproxy war nicht
konfiguriert. Ein Zertifikats- oder Accountwechsel wurde nicht vorgenommen.

Der bisherige Abruf meldete jeden Transportfehler sofort an das Monitoring.
`FleetMonitoringManager` behält dann die letzte erfolgreiche Messung und erhöht
das Abrufintervall von fünf auf zehn, zwanzig und maximal dreißig Minuten.
Dadurch blieb die Anzeige nach kurzen Verbindungsabbrüchen lange unbestätigt.
Eine erfolgreiche automatische Messung um 18:00:37 erfolgte bereits vor der
Reparatur; sie ist kein Nachweis für den neuen Code.

## Korrektur

Nur der lesende Claude-OAuth-Usage-GET wird nach TLS-Transportfehler,
Verbindungsverlust oder Timeout einmal wiederholt. Vor dem zweiten Versuch
erzwingt `URLSession.flush` eine neue TCP-Verbindung. Danach greifen die
bisherigen Fehler- und Backoff-Regeln unverändert. Zertifikatsfehler, Abbruch,
HTTP-Antworten einschließlich 401/429 sowie POST-Anfragen werden von dieser
Transportkorrektur nicht erneut ausgeführt. OAuth-Token-Erneuerungen und
Modellanfragen verwenden diesen Pfad nicht.

Apple beschreibt `-9816` als Ende der Verbindung ohne TLS-Benachrichtigung:
[errSSLClosedNoNotify](https://developer.apple.com/documentation/security/errsslclosednonotify).
Die dokumentierte Wirkung von
[URLSession.flush](https://developer.apple.com/documentation/foundation/urlsession/flush(completionhandler:))
ist eine neue TCP-Verbindung für folgende Anfragen; laufende Aufgaben werden
dabei nicht abgebrochen.

## Prüfung und Bereitstellung

- Acht gezielte Transporttests bestanden, einschließlich Erholung nach dem
  ersten Fehler, Begrenzung auf zwei Versuche und Erhalt der Zertifikatsfehler.
- Alle 216 Swift-Tests bestanden.
- Vollständiger App-Build für arm64 und x86_64 erfolgreich; Signaturprüfung
  `codesign --verify --deep --strict` erfolgreich.
- Grundlage ist der native Quellstand von Pinks tatsächlich installiertem
  2.16.3-Artefakt, `ea2aed27bad0eca6af66b77212f1f36635c72a69`.
- Die Pink-Version heißt `2.16.3+pink-tls1`. Der numerische Release-Teil bleibt
  kompatibel mit der vorhandenen Wartung, damit diese den Reparaturbuild nicht
  allein wegen einer Versionsabweichung wieder durch 2.16.3 ersetzt.
- Paket-SHA256:
  `a0a74e218d1ddcb8f0c1d213f589550ad18b85c33dbcf7ea8316a46b34c059a4`.
- Patch-Digest im App-Bundle:
  `93b65a06943f34ef8d8242ba225affa1e8778cc7df26ceea43d9d41eb0dc189d`.

Die Bereitstellung betrifft ausschließlich die Monitoring-App auf Pink. Der
vorhandene Installer erhält Gerätebindung und Kontoeinstellungen. Während des
Austauschs wird nur der Monitor-Abgleich kurz durch dessen vorhandenen Lock
serialisiert. Newsletter-Dienst, Worker-Beobachter, Wartungstunnel und
unabhängiger Wachschutz werden nicht angehalten. Ihre Prozessidentitäten werden
vorher und nachher verglichen.

Eine Kopie der vorherigen App und des Installationsbelegs liegt auf Pink unter
`~/.local/share/max-monitor-repairs/pink-tls-20261022/before/`. Lokale Prüfbelege
liegen im Reparatur-Worktree unter `build/`; sie enthalten keine Provider-Tokens.

## Live-Abnahme

Der vorhandene Installer tauschte die App am 22.10.2026 von 18:14:18 bis
18:14:20 Europe/Berlin erfolgreich aus, Exit 0. Die App meldet
`2.16.3+pink-tls1`. Eine echte neue Provider-Messung um **18:14:22** lieferte
**25 % im Fünfstundenfenster und 40 % im Wochenfenster**, `usageStatus=fresh`,
`usageError=null`. Die Geräte-ID und Monitoring-Kontobindung sind unverändert.
Hub-Abnahme und tatsächliche Pink-Detailansicht in Max Monitor bestätigen diese
Werte und „Freies Kontingent“ um 18:15 Uhr. Der native Wartungsabgleich von
18:15 Uhr hat den Reparaturbuild erhalten.

Auch der nächste reguläre Provider-Abruf um **18:19:22** ist erfolgreich:
erneut 25 % / 40 %, `fresh`, kein Fehler und weiterhin `2.16.3+pink-tls1`.
Das bestätigt die automatische Aktualisierung nach dem ersten App-Start.

Newsletter-Dienst PID **75414**, Worker-Beobachter **69112**, unabhängiger
Wachschutz **2305** und dienstgebundener Wachschutz **75415** blieben beim
App-Austausch identisch. Ein erfolgreicher neuer Worker-Poll ist bestätigt;
der Readback um 18:15 Uhr meldete aktive Aufgabenannahme. Beim Austausch war kein Produktionslauf als
laufend oder wartend registriert. Der zuvor beobachtete Sales-Lauf war bereits
vorher beendet. Es wurden keine Job-Prozesse signalisiert oder neu gestartet.

Der konservative Diagnosewrapper meldete nach dem erfolgreichen Installer
trotzdem Exit 1, weil ein kurzlebiger Claude-Prozess PID 85223 inzwischen
beendet war. Für diesen PID bestand kein registrierter Auftrag; der Worker,
dessen Beobachter und die beiden Wachprozesse blieben unverändert. Der
unveränderte Rohbeleg `deployment.json` bleibt erhalten und wird nicht in einen
scheinbar fehlerfreien Wrapperlauf umgeschrieben.

Vor der Installation war zusätzlich Pinks separater Wartungstunnel gestört:
sein Hub-Port nahm TCP-Verbindungen an, lieferte aber keinen SSH-Banner. Nur
der eindeutig diesem Port zugeordnete SSH-Verbindungsprozess auf dem Hub wurde
beendet; der vorhandene LaunchAgent stellte die Verbindung neu her. Auch die
SSH-Paketübertragung scheiterte zeitweise. Das geprüfte Paket wurde schließlich
über den bereits verwendeten HTTPS-Releaseweg geladen und vor Ort gegen
SHA-256 und Code-Signatur geprüft. Netzwerk, SSH-Zugangsdaten und macOS-Rechte
wurden nicht umgestellt.

Der Quellcode liegt in [PR #70](https://github.com/AurelianSteiner/Max-Monitor/pull/70).
Das explizit auf Pink installierte Paket liegt im separaten
[Canary-Prerelease](https://github.com/AurelianSteiner/Max-Monitor/releases/tag/pink-tls-canary-20261022).
Der reguläre Release und das Flotten-Manifest wurden nicht geändert. Für ein
reguläres Folge-Release die Korrektur aus PR #70 übernehmen; bis dahin belegt
der Versionszusatz auf Pink den separat geprüften Reparaturstand.

Die Prüfung belegt funktionierende aktuelle Messungen und die getestete
Erholung nach einem ersten Transportfehler. Sie beweist nicht, dass der
vorgelagerte Netzpfad künftig keine Verbindungsresets mehr erzeugt.
