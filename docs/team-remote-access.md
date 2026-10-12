# Fernzugriff mit persönlichem Max-Monitor-Zugang

Alle aktiven Max-Monitor-Mitglieder dürfen die fünf eingerichteten Macs per
Terminal warten: Inhaber, Admin, Mitglied und Gast. Die MacWorker-Einstellung
bleibt davon unabhängig. Neue Mitglieder erhalten dieselbe Freigabe durch ihren
bestehenden Team-Zugang; es ist keine eigene SSH-Schlüsselverteilung nötig.
Till Main 2 ist als Ziel weiterhin ausdrücklich ausgenommen. Sein Benutzer darf
mit seinem Team-Zugang auf die anderen fünf Macs zugreifen.

## Verbindung öffnen

Im Terminal auf dem eigenen Mac, beispielsweise für Mac 1:

```bash
python3 <(curl -fsSL https://api.ruegamer-steiner.de/max-monitor/remote-client.py) connect macbook-1
```

Am Prompt den **eigenen Max-Monitor-Zugangscode** aus der persönlichen Einladung
eingeben. Er wird verdeckt gelesen, nur im HTTPS-Authorization-Header verwendet
und nicht gespeichert. Der Client erzeugt für diese Verbindung einen eigenen
kurzlebigen SSH-Schlüssel. Der private Wartungsschlüssel des Inhabers und der
Worker-Hub-Schlüssel sind dafür nicht erforderlich.

| Mac | Kennung für den Befehl |
| --- | --- |
| Till Main | `macbook-till-main` |
| Mac 1 | `macbook-1` |
| Mac 2 | `macbook-2` |
| Mac 4 / Newsletter Mac | `newsletter-mac-141b2976` |
| Mac 5 schwarz | `macworker-5-schwarz` |

Mit `check` statt `connect` wird die echte SSH-Verbindung einschließlich
Hostschlüssel und erwartetem Benutzer geprüft. Ein Fernbefehl kann nach `--`
stehen. `--token-stdin` liest den persönlichen Code aus geschütztem stdin;
Zugangscodes niemals als Befehlsargument oder URL übergeben. Python 3 ist für
regelmäßige Terminal-Wartung auf dem zugreifenden Mac erforderlich.

Der Zugang hat die Rechte des Worker-Benutzers auf dem Ziel-Mac. Der freigegebene
Worker-Code und seine Zustandsdateien sind darüber wartbar. Administrative
macOS-Befehle benötigen weiterhin die normale lokale sudo-Authentifizierung.

## Team-Freigabe und Widerruf

Der Relay prüft die persönliche Team-Mitgliedschaft bei jedem Zertifikatsantrag
neu, auch nach dem Signieren. `GET /v1/teams/:teamId/remote-access` liefert die
freigegebenen Ziele; `POST /v1/teams/:teamId/remote-access/certificate` signiert nur
den öffentlichen Client-Schlüssel für das angefragte, eingerichtete Ziel.
Es gibt keinen HTTP-Endpunkt zum Ausführen von Terminal-Befehlen.

Die SSH-Zertifikate gelten für neue Anmeldungen 90 Sekunden. Ein entfernter
Team-Zugang erhält sofort keine neuen Zertifikate mehr; zuvor ausgestellte
Zertifikate laufen spätestens nach diesen 90 Sekunden ab. Bereits angemeldete
Terminal-Sitzungen werden durch Tokenentzug oder Zertifikatsablauf nicht
nachträglich beendet. Temporäre Client-Schlüssel werden beim Beenden entfernt.

Der separate Hub-Benutzer `max-monitor-access` hat eine erzwungene `/usr/bin/false`-
Shell. Er darf ausschließlich zu den registrierten Hub-Loopback-Ports weiterleiten;
Shell, PTY, StreamLocal, Reverse-Forwarding und weitere Hub-Ports sind gesperrt.
Auf jedem Ziel-Mac gilt der Team-Prüfschlüssel nur vom lokalen Tunnel-Endpunkt und
für den exakten Team-/Mac-Principal. Dort ist Terminal-Bedienung mit PTY erlaubt,
Port-/Agent-/X11-Weiterleitung und `~/.ssh/rc` bleiben gesperrt.

## Betrieb auf dem Hub

- `/etc/max-monitor/remote-team.json`: private, ausdrücklich eingerichtete
  Team-Freigabe mit Hub-Host und ausgeschlossener Worker-ID von Till Main 2.
- `/var/lib/max-monitor/RSMACS01/remote-ca`: privater SSH-Signierschlüssel des
  Relay-Benutzers; der private Schlüssel bleibt auf dem Hub.
- `remote-ca.pub` daneben: öffentliche Prüfbasis auf den Ziel-Macs.
- `remote-access.json` daneben: veröffentlichte Ziele und Hostschlüssel, ohne
  Mitgliedertokens oder private Schlüssel.
- `remote-access-audit.jsonl`: Mitglied, Ziel, Zeitpunkt und Zertifikatsnummer;
  keine Zugangscodes oder Schlüssel. Ab 1 MiB wird eine Vorgängerdatei gehalten.
- `/var/lib/max-monitor-access/.ssh/authorized_keys`: ausschließlich der
  eingeschränkte Team-Prüfschlüssel und die konkreten Zielports.
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

## Live-Prüfung vom 12.10.2026, 21:29 Uhr

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
