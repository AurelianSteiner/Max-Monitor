# Änderungen

## 2.8.1

- **Speichern funktioniert nach Updates wieder.** Der Schlüsselbund bindet jeden
  Eintrag an den Code-Hash des Builds, der ihn angelegt hat („partition ID").
  Ein neuer Build darf den Eintrag nach der Einmal-Frage lesen, aber weder
  ändern noch löschen — seit dem Update auf 2.8 schlug deshalb jedes Speichern
  still fehl (Schlüsselbund-Fehler -25299, „Duplikat"): erneuerte Refresh-
  Tokens, Neuanmeldungen, Aliase und Kündigungsdaten lebten nur bis zum
  nächsten Start. Das Problem ist alt und traf jedes Update, es fiel nur nie
  auf. Zugangsdaten liegen jetzt AES-GCM-verschlüsselt in einer Datei im
  App-Container; im Schlüsselbund steht nur noch der Schlüssel dazu, der nach
  dem Anlegen nie mehr geschrieben wird. Bestehende Einträge werden beim
  ersten Start übernommen. Beim Update fragt der Schlüsselbund künftig
  höchstens einmal (nach dem Schlüssel) statt je Eintrag. Der Speicher ist
  ohne SwiftUI und per `swift test` abgedeckt.

## 2.8

Die App heißt jetzt **Max Monitor** — sie zeigt längst nicht mehr nur Claude.

- **Neuer Name, überall.** „Claude Max Monitor" wird zu „Max Monitor": App,
  Menü, Fenster, About, Einladungstext, Release-Skript, DMG-Name und das
  GitHub-Repository (`AurelianSteiner/Max-Monitor`; die alten Adressen leiten
  weiter, installierte Kopien finden ihren Update-Feed also weiterhin). Was
  auf den Macs der Nutzer bereits hinterlegt ist, behält bewusst den alten
  Namen: Bundle-ID, Schlüsselbund-Dienst, die sudoers-Datei der Einmal-Freigabe
  und der Name des Signatur-Zertifikats — sonst fragte der Schlüsselbund nach
  dem Update wieder nach jedem Konto.
- **Claude-Konten lassen sich wieder verbinden.** Anthropic hatte alle
  hinterlegten Refresh-Tokens für ungültig erklärt (HTTP 400 `invalid_grant`).
  Die App hielt das für einen allgemeinen HTTP-Fehler und versuchte es bei
  jedem Konto jede Minute erneut — über 3 000 Fehlversuche an einem Vormittag,
  bis der Token-Endpunkt das ganze Netz drosselte (429) und damit auch jede
  Neuanmeldung scheitern ließ. Jetzt erkennt die App ein totes Token (nach
  RFC 6749: 400 + `invalid_grant`), meldet „Anmeldung abgelaufen – bitte neu
  anmelden" und fragt mit genau diesem Token nie wieder an. Die Karte zeigt
  dafür den Knopf **Neu anmelden**, der direkt den Browser-Login öffnet. Eine
  Drosselung beim Anmelden wird als solche benannt („ein paar Minuten warten")
  statt als „Anmeldung fehlgeschlagen". Fehlertexte des Token-Endpunkts
  stehen ungeschwärzt im Log — sie enthalten keine Geheimnisse und sind die
  einzige Spur, warum eine Anmeldung scheitert.
- **Neuanmeldung behält das Konto.** Wer sich für ein bekanntes Konto neu
  anmeldet, bekommt keine neue Karte mehr: Die Zugangsdaten werden an Ort und
  Stelle ersetzt, ID, Alias, Art und Kündigungsdatum bleiben. Vorher wurde das
  Konto gelöscht und neu angelegt, und der Alias war weg.
- **Codex in Blau.** Codex-Karten, ihre Wasserstände, Limit-Zeilen und die
  Punkte in der Menüleiste laufen durch eine eigene Farbreihe in Blaurichtung:
  Himmelblau → Azur → Königsblau → Indigo. Je enger es wird, desto dunkler
  und dichter das Blau. Claude behält Blau → Gelb → Clay-Orange → Rot. So
  sind die Anbieter auf einen Blick auseinanderzuhalten, und die Codex-Seite
  trägt nicht mehr Claudes Orange.
- **Gekündigt bis.** In den Konten-Einstellungen hat jedes Konto ein Häkchen
  „Gekündigt" und daneben einen Datumswähler für den letzten Tag des Abos.
  Die Karte zeigt es als kleine Plakette neben dem Namen („endet 9. Okt."),
  der Tooltip nennt das volle Datum und die Restzeit; ab einer Woche vor dem
  Ende wird die Plakette kräftig, danach steht „beendet". Das Datum kommt von
  Hand: Keine Schnittstelle liefert es — Anthropics OAuth-Profil kennt nur
  `subscription_status`, kein Enddatum.
- **Die Parade richtet sich nach den Konten.** Jedes Claude-Konto schickt
  einen Claudie, jedes Codex-Konto ein blaues Codex-Pet mit Prompt-Gesicht
  (`>_`, der Cursor blinkt), und es sind nie mehr Wesen gleichzeitig
  unterwegs, als Konten eingetragen sind — zwei Konten heißt zwei Läufer im
  Streifen, sieben Konten die gewohnte dichte Parade. Das Verhältnis der Arten
  stimmt genau und wechselt sich ab, statt in Blöcken zu kommen. Hüte, Auto,
  Sheriff und Zwischenfall gibt es für beide Arten; ein getroffenes Codex-Pet
  zerplatzt zu blauem Matsch. Die Taktung hängt an der Spaltenwahl, nicht an
  der Fensterbreite, damit beim Ziehen am Fenster nichts flackert. Der
  rechnende Teil (Besetzung, Verteilung, Startabstände) ist ohne SwiftUI
  ausgelagert und per `swift test` abgedeckt.
- Der Reihenfolge-/Spalten-Regler ist von oben rechts zu den Karten gezogen,
  die er ordnet — eine schmale Zeile direkt über dem Kartenbereich.
- Der Sheriff kommt jetzt etwa jede Minute, trägt einen unübersehbaren
  goldenen Stern auf Hut und Brust und einen Colt im Halfter. Alle paar
  Sekunden zieht er ihn zum Angeben in die Luft — gezogen wird oft,
  geschossen weiterhin nur manchmal. Wenn er schießt, sitzt das
  Mündungsfeuer jetzt an der Laufspitze des gezogenen Colts.
- Neu in der Parade: ein Läufer im kleinen roten Auto — schneller als der
  Sprinter, mit Rädern statt Beinchen, Windschutzscheibe und Auspuffwölkchen.

## 2.7.1

- Alle sehen alle: Der Team-Server liefert Meldungen und Verläufe jetzt an
  jede Rolle — wer seine Auslastung teilt, bekommt die Übersicht auch zurück.
  Vorher sahen Mitglieder nur die eigene Meldung. Die Mitgliederverwaltung
  (Liste mit Tokens) bleibt Inhabern und Admins vorbehalten.

## 2.7

Großer Aufräum- und Ausbau-Durchgang.

- **Wasserstände in der Menüleiste.** Die Punktreihe der Konten zeigt jetzt
  dieselben Miniatur-Pegel wie die Kopfzeile der Übersicht: Der Pegel steigt
  mit der Wochen-Auslastung durch die vierstufige Farbskala, der rote Ring
  außen bleibt das Zeichen für ein aufgebrauchtes 5-Stunden-Fenster. Im
  Einfarbig-Modus kodiert die Füllhöhe den Stand — mehr Aussage, als der alte
  volle/hohle Punkt je hatte.
- **Ein Klick, ein Ort.** Ist das Übersichtsfenster offen, holt der Klick aufs
  Menüleisten-Symbol dieses Fenster nach vorn, statt das identische Popover
  darüberzulegen. Und das Popover bleibt nicht mehr oben rechts stehen, wenn
  man in ein Fenster wechselt.
- **Team-Ansicht in der Übersicht.** Das dritte Fenster ist weg: Das Team ist
  jetzt ein Modus der Übersicht (Knopf mit den drei Figuren im Kopf, Eintrag im
  Rechtsklick-Menü). Neu als zwei Ebenen: kompakte Zeilen je Person mit
  Mini-Pegel — und ein Klick öffnet das Detail mit Sitzungs-Wasserstand,
  Wochenwert und jeder gemeldeten Limit-Zeile samt sichtbarer Reset-Zeit.
  Mitglieder ohne Meldung erscheinen für Inhaber/Admins als gedämpfte
  „Noch keine Meldung"-Zeilen; die Kopfzahl wird zum ehrlichen
  „n von m gemeldet". Sortiert wird nach der Woche (der bindenden Sperre),
  Veraltetes sinkt ans Ende und zählt nicht mehr in „Fast am Limit".
- **Meldungen tragen jetzt eine maschinenlesbare Art** (`kind`: Sitzung, Woche,
  Modell-Woche, Konto-Woche) — Auswertung und Gruppierung hängen nicht mehr am
  freien Beschriftungstext. Additiv und abwärtskompatibel.
- **Der Team-Server führt Verlauf**: Jede Meldung wird zusätzlich als kompakte
  Zeile je Mitglied angehängt (30 Tage), abrufbar über einen neuen, nach Rollen
  gesicherten History-Endpunkt — die Grundlage für Auslastungs-Verläufe.
- **Verläufe in der App.** Die Detailansicht einer Person zeichnet unter jeder
  Wochen-Zeile eine kleine 7-Tage-Verlaufslinie (schlichter `Path`, keine
  Chart-Abhängigkeit), und die Team-Liste trägt einen Trend-Pfeil, sobald sich
  die Woche gegenüber ~24 Stunden zuvor spürbar bewegt hat. Geladen wird träge
  über den neuen History-Endpunkt (`TeamHistoryStore`, einmal je Person und
  Sitzung); die Verlaufs-ID kommt aus der Mitglieds-ID der Meldung,
  Super-/Admin-Meldungen liegen unter dem Namens-Slug des Servers. Läuft
  draußen noch ein Relay ohne den Endpunkt, fehlen schlicht Linie und Pfeil.
- **Sheriff auf dem Laufsteg.** Alle anderthalb Minuten patrouilliert ein
  Sheriff-Claudie (Cowboyhut, goldener Stern) hüpfend durch die Parade.
  Ungefähr jeder fünfte zieht — der Zwischenfall ist damit häufiger als
  vorher, und der Grabstein steht nur noch eine knappe Minute statt drei.
- **Einstellungen entschlackt.** Ein Menüeintrag „Einstellungen …" statt der
  verwirrenden zwei (es war immer dasselbe Fenster mit anderem Reiter); die
  Statusseiten-Links, die Benachrichtigungen samt Schalter, das
  Zeitformat und die doppelte Sortier-/Spalten-Karte sind weg. Cookie- und
  Handeingabe-Login stehen eingeklappt unter „Weitere Anmeldewege".
- **Willkommensfenster entfernt.** Der Erststart öffnet die Übersicht mit ihrem
  Leerzustand — der Knopf dort führt direkt in die Konten-Einstellungen.
- **Totes Gewicht raus**: das komplette, unerreichbare Diagnose-Subsystem
  (~1.900 Zeilen), die Überreste des alten Einzelkonto-Detailfensters, der tote
  Codex-Cookie-Login, ungenutzte Refresh-Verwaltung und über 100 verwaiste
  Übersetzungs-Schlüssel. Das Schließen der Einstellungen wirft dem noch
  offenen Übersichtsfenster nicht mehr das Dock-Symbol weg.
- **Alte Menüleisten-Malerei entfernt.** Die Ring-/Prozent-Darstellung des
  aktuellen Kontos (Kreise, Quadrate, Rauten, Sechsecke samt eigenem
  Farbschema, den Anzeigemodi und der „intelligent/benutzerdefiniert"-Auswahl —
  über 2.300 Zeilen) war seit der Punktreihe unerreichbar und ist raus. Bevor
  das erste Konto Daten meldet, zeigt die Menüleiste jetzt graue
  Platzhalter-Gefäße (eins je Konto) statt des alten 0-%-Rings.

## 2.6

- Ein volles Modellkontingent sperrt kein Konto mehr. War das Fable-Wochenlimit
  durch, stand auf der Karte „Woche gesperrt" und der Punkt oben wurde rot,
  obwohl über Sonnet und Opus die ganze Woche noch offen war. Gesperrt heißt ab
  jetzt ausschließlich: das kontoweite Wochenfenster ist aufgebraucht. Welches
  Modell durch ist, steht weiterhin in der Zeile darunter und im Tooltip.
- Aus den Ampelpunkten sind Wasserstände geworden — dieselben Pegel wie auf den
  Karten, nur in Miniatur: leer und blau, wenn die Woche Luft hat, randvoll und
  rot, wenn sie durch ist. Sie sind in die Kopfzeile gewandert, ein roter Ring
  außen zeigt wie bisher ein aufgebrauchtes 5-Stunden-Fenster. Wird die Zeile
  eng, schrumpfen erst die Pegel, dann fällt die Beschriftung des
  Wach-Schalters weg — die Reihe bleibt vollständig.
- Dadurch gehört der Claudie-Parade jetzt die ganze Zeile: Sie läuft von ganz
  links nach ganz rechts statt auf 300 pt am rechten Rand. Im Fenster sind
  dadurch mehr Claudies gleichzeitig unterwegs als vorher.
- „Aktualisieren" ist aus dem Kopf ins „…"-Menü gezogen und hat den Platz für
  die Pegel frei gemacht.
- Die Startabstände der Parade sind größer. Das ist die Voraussetzung dafür,
  dass Läufer stehen bleiben können, ohne dass jemand auffährt.
- Und sehr selten — im Schnitt alle gut dreizehn Minuten — passiert auf dem
  Laufsteg etwas: Ein Claudie bleibt mitten im Streifen stehen, sein Vordermann
  hält an, dreht sich um und schießt ihn ab. Er kippt um, zerplatzt zu orangem
  Matsch, und kurz darauf wächst dort ein kleiner Grabstein aus dem Boden. Der
  steht gut drei Minuten; wer vorbeikommt, bleibt kurz davor stehen und weint,
  bevor er weitergeht.

## 2.4

- Schalter und System stimmen jetzt immer überein. Ein Wächter sieht alle
  fünfzehn Sekunden nach, was `pmset` meldet, und zieht die Anzeige nach — egal
  ob im Terminal oder in der App geschaltet wurde. Die Anzeige kann nichts mehr
  behaupten, was der Mac nicht tut.
- In 2.3 lief dieser Abgleich nur beim Start: Der Takt hing an einer Run-Loop,
  die es im Hintergrund nicht gab, und feuerte deshalb nie.

## 2.3

- Claude Always On zeigt jetzt, was wirklich eingestellt ist: Wer
  `sudo pmset -a disablesleep 1` im Terminal setzt, sieht den Schalter
  umspringen — beim Start und immer, wenn die App in den Vordergrund kommt.
- Übernommen wird nur gelesen. Die App schreibt die Einstellung ausschließlich,
  wenn der Schalter angeklickt wird, und nimmt beim Beenden nur zurück, was sie
  selbst eingeschaltet hat. Eine im Terminal gesetzte Einstellung bleibt.

## 2.2

- Die Claudies sind doppelt so groß und haben deutlich mehr Auslauf: Die Parade
  ist aus dem Kopf in die Statuszeile gewandert — links die Punkte je Account,
  rechts der Laufsteg.
- Die Sonderformen kommen jetzt zehnmal so oft vorbei, und eine ist neu: Einer
  stapft den ganzen Weg rückwärts. Der Raucher zieht eine richtige Rauchfahne
  hinter sich her.

## 2.1

- Die Claudies halten jetzt Abstand: Ihre Startzeiten streuen, die Lücken sind
  unterschiedlich groß, aber nie kleiner als ein Wesen breit ist. Niemand läuft
  mehr auf den Vordermann auf.
- Jeder zehnte ist besonders — Partyhut, Zylinder, ein Raucher mit einem Hauch
  Rauch, oder ein Sprinter, der sich in die Kurve legt und alle überholt.

## 2.0

- Claude Always On: Der Wach-Schalter heißt jetzt so, wie er wirkt. Beim ersten
  Einschalten fragt macOS einmal nach dem Passwort; danach hält der Schalter den
  Mac auch zugeklappt wach — laufende Claude-Sessions arbeiten einfach weiter.
  Ausschalten gibt alles wieder frei, ein ⓘ daneben erklärt es in zwei Sätzen.
- Solange Claude Always On aktiv ist, laufen kleine Pixel-Claudies durch den
  Kopf der Übersicht — links blenden sie ein, rechts aus. Aus = leerer Streifen.
- Die App verlässt die Sandbox (nur so darf sie den privilegierten
  pmset-Befehl ausführen); alle Einstellungen werden beim ersten Start einmalig
  übernommen.
- Neue Versionen sind mit einer festen Signatur signiert. Der Schlüsselbund
  fragt nach diesem Update ein letztes Mal („Immer erlauben") und danach nie
  wieder.

## 1.9

- Der Weg über den geteilten Ordner ist entfallen — das Team läuft ausschließlich
  über den Server. Eine vorhandene Ordner-Verbindung wird beim Start still
  entfernt; die Team-Karte besteht nur noch aus Verbinden, Rolle und
  Mitglieder-Verwaltung.
- Die Wachhalte-Schalter kennen jetzt die Systemeinstellungen: Steht der Mac
  systemweit auf „nie schlafen" (sudo pmset disablesleep 1), sagt Always On das
  offen im Tooltip, statt Wirkung vorzutäuschen. Die Einstellungen zeigen die
  aktuellen pmset-Werte live über den kopierbaren Befehlen.

## 1.8

- Team-Übersicht: Alle Claude-Konten des Teams auf einen Blick, eine Karte pro
  Person, sortiert nach Auslastung, mit Hinweis auf veraltete Meldungen.
- Drei Rollen über den Team-Server: Der Inhaber legt Mitglieder mit Namen an,
  bekommt deren Token einmalig zum Kopieren und einen fertigen Einladungstext.
  Admins sehen alle Meldungen, Mitglieder nur die eigene.
- Verbunden meldet die App die eigene Auslastung alle fünfzehn Minuten von
  selbst — es braucht kein Skript. Übertragen werden nur Prozentwerte, Labels
  und Reset-Zeitpunkte, niemals Zugangsdaten. Das Token liegt im Schlüsselbund.
- Alternativ funktioniert ein geteilter Ordner (iCloud/Dropbox) ohne Server;
  `scripts/team-report.sh` schreibt die Meldung dort hinein, und einzelne
  Meldungen lassen sich auch als Text einfügen.
- Die Schalter zum Wachhalten heißen jetzt Always On und Bildschirm an; ein
  eingeklappter Bereich in den Einstellungen zeigt die stärkeren
  pmset-Systembefehle zum Kopieren.
- Ein Klick auf eine Karte wechselt nicht mehr das aktive Konto; der blaue
  Rahmen ist entfallen.

## 1.7

- Die Karte kennt nur noch zwei Sperrzustände. Eine gesperrte Woche schließt das
  Sitzungsfenster ohnehin ein, deshalb entfällt „Alles gesperrt".
- Neben den beiden Symbolen zum Wachhalten steht jetzt ein kurzes Wort, sodass
  ohne Mauszeiger klar ist, was sie tun.
- Accounts lassen sich als Firma oder privat markieren und zeigen ein passendes
  Symbol neben dem Namen. Die Anmeldung versucht die Art aus dem Profil zu lesen
  und lässt sie andernfalls offen, statt zu raten.

## 1.6

- Die Meldung „neue Version verfügbar" verschwindet endlich. Die App trug intern
  dauerhaft die Nummer 1.0, weshalb der Update-Dienst dieselbe Fassung endlos
  angeboten hat.
- Die Einstellungen enthalten nur noch, was gebraucht wird. Die Menüleiste zeigt
  fest einen Punkt je Account; Symbol- und Prozentauswahl, die Limit-Kästchen,
  der Verbindungstest, die Session-Key-Anleitung und die Kontoauswahl sind
  entfallen. Bestehende Installationen werden auf die Punkte umgestellt.
- Die Schalter zum Wachhalten stehen nur noch als Symbole in der Übersicht. Ihre
  Kurzinfo erklärt jetzt, was sie bewirken — und dass ein geschlossener Deckel den
  Mac weiterhin schlafen legt.
- Die Karten benennen, was gesperrt ist: die Sitzung, die Woche oder alles. Der
  Countdown zählt zu genau dem Limit, das im Text steht.
- Zwischen Warnschwelle und wirklich aufgebrauchtem Fenster sagt die Kurzinfo der
  Punkte „fast aufgebraucht".

## 1.5

- Die beiden Schalter zum Wachhalten sitzen jetzt als Symbole oben in der
  Übersicht. Ein Klick genügt, der Zustand ist sichtbar.
- Das Übersichtsfenster ordnet die Karten nach seiner Breite: schmal gezogen
  stapeln sie sich in einer Spalte, breit gezogen verteilen sie sich auf mehrere.
  Die Spaltenauswahl im Menü setzt die Fensterbreite entsprechend.
- Die Punkte in der Menüleiste stehen in derselben Reihenfolge wie die Karten in
  der Übersicht und ordnen sich mit, wenn die Sortierung wechselt.

## 1.4

- Die Punkte oben zeigen jetzt beide Fenster auf einmal: Die Füllung folgt dem
  Wochenlimit — grün bis fünf Prozent, blau während der Nutzung, rot ab neunzig
  Prozent — und ein roter Ring markiert ein aufgebrauchtes Fünf-Stunden-Fenster.
  Der Tooltip nennt beide Werte.
- Neue Anzeigeart für die Menüleiste: ein Punkt je Konto statt der Ringe. Das ist
  schmal genug, um neben der Notch nicht zu verschwinden.
- Die Schalter zum Wachhalten stehen auch im Menü der Übersicht, nicht mehr nur
  im Rechtsklick-Menü.
- Über-Fenster, Einrichtungshilfe und Diagnosebericht verweisen auf dieses
  Projekt; die letzten Reste des früheren Produktnamens sind verschwunden.

## 1.3

- Fast erschöpfte Konten werden nicht mehr ausgegraut. Stattdessen läuft auf der
  Karte ein Countdown, der zeigt, wann das Limit wieder frei ist.
- Der Kopf der Karte trennt Stunden- und Wochenlimit durch einen Strich, beide
  beschriftet und jeweils mit eigener Restzeit. Die Restzeit des
  Fünf-Stunden-Fensters fehlte bisher ganz.
- Wochenlimits einzelner Modelle (Fable, Opus, Sonnet) erscheinen als
  Prozentbalken ohne Uhrzeit statt als Symbol.
- Die Ampelpunkte oben folgen einer klareren Regel: grün bis fünf Prozent, blau
  während der Nutzung, rot ab hundert Prozent, grau ohne Daten.
- Die Version steht unten in der Übersicht.
- Das Übersichtsfenster lässt sich in der Größe ziehen und merkt sich Lage und
  Größe. Es wird breiter, sobald mehr Spalten nötig sind.
- Zwei Schalter im Menü halten Bildschirm oder Mac wach. Sie überstehen einen
  Neustart der App und brauchen keine Administratorrechte.
- Ein Klick auf die App im Dock, im Finder oder über Spotlight öffnet die
  Übersicht, statt scheinbar nichts zu tun.

## 1.2

- Nur noch die Gesamtübersicht: Die Einzelansicht ist entfallen, ein Klick auf das
  Menüleistensymbol zeigt immer alle Konten. Ohne Konten führt ein schlichter
  Hinweis zum Hinzufügen.
- Ampelzeile über den Karten: ein Punkt je Konto, eingefärbt nach dem Wochenlimit
  (grün bis rot, grau ohne Daten) — der Blick genügt, um zu sehen, wo noch Luft ist.
- Konten sortieren sich nach freier Kapazität; fast erschöpfte (ab 96 %) werden
  gedämpft dargestellt und rutschen nach unten. Beim Überfahren kommen sie zurück.
- Fable-Wochenlimit als eigenständiges Limit mit eigener Farbe und Form, in den
  Anzeigeoptionen wählbar und in der Menüleiste darstellbar. Wochenlimits werden
  jetzt am Modellnamen erkannt statt an der Position.
- Restzeit auf den Karten größer und kräftiger gesetzt.
- Weniger „Zu viele Anfragen": Abfragen mehrerer Konten sind stärker entzerrt, und
  ein Limit überschreibt vorhandene Daten nicht mehr mit einer Fehlermeldung.
- Beim Hinzufügen eines Kontos erzwingt die Anmeldung eine frische Sitzung — zuvor
  konnte ein zweites Konto die Kennung des bereits angemeldeten übernehmen.
- Die App heißt durchgehend Claude Max Monitor; Reste des ursprünglichen Namens sind
  verschwunden.

## 1.1

- Neues App-Symbol: Wasserstand im Ring, passend zur Übersicht. Wird über
  `scripts/make_icon.swift` gezeichnet, statt als Binärdatei mitzureisen.

## 1.0

Erste Veröffentlichung dieses Forks.

- Mehrkonten-Übersicht: alle Claude- und Codex-Konten gleichzeitig, eine Karte pro Zugang
- Wochenlimit als große Leitzahl, Sitzungsfenster als Wasserstand mit zweifarbiger Zahl
- Vierstufige Farbskala von Blau bis Rot
- Countdown bei Freischaltung in unter drei Tagen, Datum darüber
- Anmelde-Email auf der Karte
- Anmeldung im App-Fenster per Cookie-Session als Alternative zum OAuth-Weg
- Build ohne Xcode über `scripts/build_without_xcode.sh`
- Selbst gehostete Updates über `scripts/release.sh`, stündliche Prüfung
- Oberfläche auf Deutsch und Englisch
