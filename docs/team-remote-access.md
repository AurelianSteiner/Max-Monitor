# Fernzugriff mit persönlichem Max-Monitor-Zugang

## Persönliche Admin-Freigabe vom 18.10.2026

Die ausdrücklich freigegebenen Admin-Zugänge **vale mac** (`vale-mac-b67a`)
und **Reli Mac** (`reli-mac-a947`) dürfen auf alle eingerichteten Worker zugreifen.
Ihre Mitgliedskennungen stehen als `adminMemberIds` sowohl in der separaten
Relay-Policy als auch in der Hub-Teamkonfiguration. Der Relay prüft zusätzlich
die aktuelle Rolle `admin`. Die Freigabe gilt nicht automatisch für weitere Admins.

Der persönliche Terminal-Client unten funktioniert mit dem eigenen Einladungscode
und einem lokal erzeugten SSH-Schlüssel. Er benötigt für diese beiden Zugänge
keinen vorher freigegebenen Quell-Mac. Die Bastion akzeptiert dafür ausschließlich
den zur jeweiligen Mitgliedskennung gehörenden Admin-Principal in einem kurzlebigen
Team-Zertifikat; die bisherigen Beschränkungen auf konkrete Worker-Ports bleiben.
Neue Worker werden beim normalen Hub-Abgleich in diese Freigabe aufgenommen.
Die bereits eingerichteten Quell-Mac-Schlüssel bleiben unverändert gültig.

Rollenänderungen und gelöschte Mitgliedschaften verhindern neue Zertifikate.
Der Relay prüft Mitgliedschaft und Rolle auch nach dem Signieren erneut.
Bereits offene SSH-Sitzungen werden dadurch nicht nachträglich beendet.
Der Zugriff erfolgt als jeweiliger Worker-Benutzer. `sudo` und macOS-Datenschutz-
freigaben richten sich weiterhin nach der tatsächlichen Einstellung auf dem Ziel.

Die folgenden Abschnitte dokumentieren zusätzlich die ältere, an konkrete
Quell-Macs gebundene Wartung und deren damalige Prüfstände.

## Automatische Wartung aus AI Newsletter Creation

Auf Till Main und Till Main 2 ist der gemeinsame Client
`~/.local/bin/max-monitor-worker` installiert. Im Projekt AI Newsletter Creation
nutzen die Agenten automatisch dieselbe Max-Monitor-Freigabe:

```bash
bash ops/macos/worker-admin.sh list
bash ops/macos/worker-admin.sh check macworker-5-schwarz
bash ops/macos/worker-admin.sh diagnose macworker-5-schwarz
bash ops/macos/worker-admin.sh exec macworker-5-schwarz -- 'id -un'
```

Die Projektanweisung steht in `AGENTS.md`, der Ablauf in
`docs/macworker-wartung.md`. `list` verbindet registrierte Ziele mit dem aktuellen
Fleet-Stand. `diagnose` liest den echten launchd-Produktionspfad, Zustand,
laufende Aufträge und Dienste, ohne Datenbankmigration oder Neustart.

Der Hub-Helfer `worker-admin-hub.mjs` verwendet den genau zugeordneten normalen
Mitgliedszugang des Quell-Macs. Bei fehlendem lokalem Gerätecache verwendet er
die eindeutige bestehende Worker-/Gerätebindung auf dem Hub; eine neue Identität
wird nicht erzeugt. Der freigegebene Quell-Schlüssel bleibt in jedem Fall nötig.
Der Client erhält nur ein kurzlebiges öffentliches SSH-Ticket. Zugangscodes,
private Schlüssel und der Inhaberzugang werden nicht zwischen Macs kopiert.

Installation aus Max Monitor: `bash scripts/install-worker-admin.sh`. Sie prüft
zuerst die zentrale Freigabe, verwendet das bereits registrierte Node und
installiert nur den Wartungsclient. Newsletter-Dienste bleiben unberührt.

Live am 13.10.2026 geprüft: beide Quell-Macs erreichen alle sechs Ziele
über den neuen Client (12 erfolgreiche SSH-Prüfungen). Till Main 2 liest aus
AI Newsletter Creation die Diagnose von Mac 5 und schreibt, liest und entfernt
dort eine temporäre Testdatei. Unicode-Fernbefehle funktionieren ebenfalls.
Die Projektanweisungen, der Wrapper und die identische Wartungsanleitung sind
auf beiden Quell-Macs vorhanden. Sechs andere Mitglieder erhalten weiterhin
HTTP 403 für Zielliste und Zertifikat, ihre Fleet-Abfrage bleibt HTTP 200.
Ein nicht freigegebener Schlüssel wird auch mit Inhaberzugang abgewiesen;
die Bastion enthält exakt zwei Quell-Schlüssel. 18 Wartungs-/Hub-Installer- und
sechs Python-Client-Tests bestanden. Die Hub-Installer-Sicherung liegt unter
`/var/backups/max-monitor/newsletter-maintenance-installer-20261013T000234Z`.

## Verbindung öffnen

Im Terminal auf dem eigenen Mac, beispielsweise für Mac 1:

```bash
python3 <(curl -fsSL https://api.ruegamer-steiner.de/max-monitor/remote-client.py) connect macbook-1
```

Am Prompt den **eigenen Max-Monitor-Zugangscode** aus der persönlichen Einladung
eingeben. Er wird verdeckt gelesen, nur im HTTPS-Authorization-Header verwendet
und nicht gespeichert. Der Client verwendet den lokalen Schlüssel
`~/.ssh/max_monitor_remote_ed25519`, sofern vorhanden. Fehlt er, erzeugt der Client
für die persönliche Admin-Freigabe einen temporären Schlüssel und entfernt ihn
beim Beenden. `--identity-file` kann einen bestehenden lokalen Schlüssel auswählen.
Für die ältere Quell-Mac-Freigabe bleibt der dort ausdrücklich erlaubte Schlüssel
erforderlich.

| Mac | Kennung für den Befehl |
| --- | --- |
| Rot / Mac 1 | `macbook-1` |
| Blau / Mac 2 | `macbook-2` |
| Gelb / Mac 4 | `newsletter-mac-141b2976` |
| Schwarz / Mac 5 | `macworker-5-schwarz` |
| Grün / Walle | `mac-f121ae17` |
| Orange / Mac 6 | `mac-worker-6-64d66918` |
| Lila / Mac 7 | `macbook-air-von-gustav-ccdf84ef` |
| Türkis / Mac 8 | `macbook-air-von-nachteule-cdb5c505` |

Mit `check` statt `connect` wird die echte SSH-Verbindung einschließlich
Hostschlüssel und erwartetem Benutzer geprüft. Ein Fernbefehl kann nach `--`
stehen. `--token-stdin` liest den persönlichen Code aus geschütztem stdin;
Zugangscodes niemals als Befehlsargument oder URL übergeben. Python 3 ist für
regelmäßige Terminal-Wartung auf dem zugreifenden Mac erforderlich.

Der Zugang hat die Rechte des Worker-Benutzers auf dem Ziel-Mac. Der freigegebene
Worker-Code und seine Zustandsdateien sind darüber wartbar. Administrative
macOS-Befehle benötigen weiterhin die normale lokale sudo-Authentifizierung.

## Team-Freigabe und Widerruf

Der Relay prüft Team-Mitgliedschaft und die separate Fernzugriffsfreigabe bei jedem
Zertifikatsantrag neu, auch nach dem Signieren. Für Quell-Macs bindet die Freigabe
die erlaubte Mitgliedskennung an den hinterlegten öffentlichen Schlüssel. Für die
beiden benannten Admins verlangt sie die aktuelle Admin-Rolle und die persönliche
Kennung in `adminMemberIds`.
`GET /v1/teams/:teamId/remote-access` liefert nur erlaubten Identitäten die Ziele;
`POST /v1/teams/:teamId/remote-access/certificate` signiert nur freigegebene
Client-Schlüssel für das angefragte, eingerichtete Ziel.
Es gibt keinen HTTP-Endpunkt zum Ausführen von Terminal-Befehlen.

Die SSH-Zertifikate gelten für neue Anmeldungen 90 Sekunden. Ein entfernter
Team-Zugang erhält sofort keine neuen Zertifikate mehr; zuvor ausgestellte
Zertifikate laufen spätestens nach diesen 90 Sekunden ab. Bereits angemeldete
Terminal-Sitzungen werden durch Tokenentzug oder Zertifikatsablauf nicht
nachträglich beendet. Temporäre Zertifikate werden beim Beenden entfernt;
die privaten Quell-Mac-Schlüssel bleiben lokal erhalten.

Der separate Hub-Benutzer `max-monitor-access` hat eine erzwungene `/usr/bin/false`-
Shell. Seine SSH-Freigabe akzeptiert die hinterlegten öffentlichen Quell-Mac-
Schlüssel und zusätzlich ausschließlich die beiden persönlichen Admin-Principals,
keine allgemeine Team-CA-Freigabe. Er darf
ausschließlich zu den registrierten Hub-Loopback-Ports weiterleiten;
Shell, PTY, StreamLocal, Reverse-Forwarding und weitere Hub-Ports sind gesperrt.
Auf jedem Ziel-Mac gilt der Team-Prüfschlüssel nur vom lokalen Tunnel-Endpunkt und
für den exakten Team-/Mac-Principal. Dort ist Terminal-Bedienung mit PTY erlaubt,
Port-/Agent-/X11-Weiterleitung und `~/.ssh/rc` bleiben gesperrt.

## Betrieb auf dem Hub

- `/etc/max-monitor/remote-team.json`: private Team-Freigabe mit Hub-Host,
  Ziel-Ausnahmen, `sourcePublicKeys` und den beiden `adminMemberIds`.
  Aktuell sind acht Worker als Ziele eingerichtet; die beiden persönlichen
  Till-Macs sind ausgenommen.
- `/etc/max-monitor-remote-policy/RSMACS01.json`: separate, root-eigene Freigabe
  der Quell-Mac-Schlüssel, ihrer erlaubten Mitgliedskennungen und der beiden
  persönlichen Admin-Zugänge. Der Relay liest
  sie über `MAX_MONITOR_REMOTE_CLIENT_POLICY_FILE` aus seiner Dienstumgebung.
  Eine fehlende, unlesbare oder ungültige ausdrücklich konfigurierte Datei
  sperrt die Zertifikatsausgabe. Worker-Registrierungen ändern diese Datei nicht.
- `/var/lib/max-monitor/RSMACS01/remote-ca`: privater SSH-Signierschlüssel des
  Relay-Benutzers; der private Schlüssel bleibt auf dem Hub.
- `remote-ca.pub` daneben: öffentliche Prüfbasis auf den Ziel-Macs.
- `remote-access.json` daneben: veröffentlichte Ziele und Hostschlüssel, ohne
  Mitgliedertokens oder private Schlüssel.
- `remote-access-audit.jsonl`: Mitglied, Quell-Mac, Ziel, Zeitpunkt und Zertifikatsnummer;
  keine Zugangscodes oder Schlüssel. Ab 1 MiB wird eine Vorgängerdatei gehalten.
- `/var/lib/max-monitor-access/.ssh/authorized_keys`: drei eingeschränkte
  Quell-Mac-Schlüssel und zwei auf persönliche Admin-Principals beschränkte
  CA-Zeilen, jeweils mit den konkreten Zielports.
- Markierter `Match User max-monitor-access`-Block am Ende von
  `/etc/ssh/sshd_config`; vor Änderungen stets `sshd -t` prüfen.
- `/etc/ssh/sshd_config.d/00-max-monitor-capacity.conf`: `MaxStartups 50:30:100`.
  Der Hub hatte echte Verbindungen beim bisherigen Beginn der Drosselung ab zehn
  gleichzeitig offenen Anmeldungen verworfen. Der Beginn liegt jetzt bei 50;
  die Obergrenze von 100 bleibt erhalten. `sshd -t`, effektive Konfiguration und
  laufender Listener wurden geprüft, bestehende Tunnel blieben verbunden. Die
  vorherige Konfiguration liegt unter
  `/var/backups/max-monitor/team-ssh-capacity-20261012T190838Z`.

Nach einer neuen Worker-Fernzugriff-Registrierung aktualisiert der Hub-Helfer
idempotent die Ziel-Liste und Bastion-Portfreigabe; der Mac-Installer übernimmt
zusätzlich die öffentliche Team-CA-Zeile. Der reguläre Hub-Installer enthält
Relay-Modul und persönlichen Terminal-Client. Das schafft keine pauschale
Freigabe auf einem noch nicht eingerichteten Mac.

Der vorhandene Operator-Zugang bleibt für Wartung und Rückbau verfügbar. Der
Worker-Client entfernt beim `uninstall` sowohl seine Operator- als auch seine
Team-CA-Zeile und erhält andere SSH-Schlüssel. Für einen vollständigen Rückbau
zuerst die Team-CA-Zeilen auf den Ziel-Macs entfernen, dann die Team-Zielliste
und Bastion-Freigabe entfernen und den markierten SSH-Block zurücknehmen.
CA nicht ungeprüft neu erzeugen: eine Rotation benötigt neue öffentliche
Freigaben auf den Ziel-Macs.

Die Hub-Runtime und SSH-Konfiguration vor dieser Erweiterung sind unter
`/var/backups/max-monitor/team-remote-20261012T185242Z` gesichert. Auf jedem Ziel
liegen private Sicherungen unter `~/.local/share/max-monitor-remote/backups/`.

Die SSH-Mechanik folgt den offiziellen Beschreibungen von
[ssh-keygen](https://man.openbsd.org/ssh-keygen) und
[authorized_keys in sshd](https://man.openbsd.org/sshd).

## Historische Live-Prüfung vom 12.10.2026, 21:29 Uhr

Alle neun aktuellen persönlichen Team-Zugänge erhielten ein auf ihre tatsächliche
Mitgliedskennung gebundenes Zertifikat. Mit Vales und Relis persönlichen
Admin-Zugängen wurde jeweils die vollständige SSH-Anmeldung auf allen fünf Macs
und der erwartete Zielbenutzer bestätigt: zehn erfolgreiche Verbindungen.
Ein anfänglicher Banner-Timeout auf Relis Verbindung zu Mac 4 wurde beim
gezielten erneuten Test erfolgreich überwunden. Die Prüfung lief von Till Main
mit diesen Zugangsdaten, nicht auf den physischen Macs von Vale und Reli.
Der veröffentlichte Client stimmt mit dem geprüften Quelltext überein.

Ein fremder Team-Token wurde live mit HTTP 401 abgewiesen, Till Main 2 als Ziel
mit HTTP 404. Hub-Shell, ein nicht freigegebener Hub-Port und Reverse-Forwarding
wurden separat live abgewiesen. Die Gastrolle und der sofortige Entzug eines
persönlichen Team-Tokens sind zusätzlich im echten HTTP-Server-Test abgedeckt.
145 Skript-, 70 Relay- und drei Python-Client-Tests bestanden.

## Till Main entfernt, 12.10.2026, 21:50 Uhr

Auf erneuten Nutzerwunsch ist auch `macbook-till-main` als Fernzugriffsziel
entfernt. Die Team-Policy sperrt beide persönlichen Till-Macs. Der Hub-Helfer
weist für ausgeschlossene IDs sowohl `enroll` als auch `lookup` ab, selbst bei
einem noch vorhandenen alten Operator-Registereintrag. Das Team-Manifest enthält
nur Mac 1, Mac 2, Mac 4 und Mac 5; die Bastion erlaubt deren vier Zielports.

Auf Till Main wurden nur der Wartungs-LaunchAgent, sein Profil und seine beiden
SSH-Freigaben entfernt. Bestehende fremde SSH-Schlüssel und die macOS-Fernanmeldung
bleiben erhalten. Der Newsletter-Worker blieb beim Rückbau unverändert PID 15368.
Sicherungen liegen lokal unter
`~/.local/share/max-monitor-remote/backups/remove-personal-main-20261012T194925Z`
und auf dem Hub unter
`/var/backups/max-monitor/remove-personal-main-20261012T194946Z`.

Die erneuten Live-Anträge für beide ausgeschlossenen Macs liefern HTTP 404;
Operator-Registrierung und Lookup werden ebenfalls abgewiesen. Mac 1 bestand
nach dem Rückbau erneut den echten SSH-Check als `tuck2`. Ein zusätzlicher
Mac-2-Check hatte eine SSH-Zeitüberschreitung; daraus wird keine neue erfolgreiche
Verbindung abgeleitet. Seine Freigabe und die drei anderen Zielbindungen wurden
beim Rückbau nicht verändert.
