# Planbarkeit

Der Reiter unter **Verbrauch & Aufwand → Planbarkeit** besteht aus zwei
Umschaltern und drei Mengenreglern:

- **Aktuelle Kapazität / Alles bei 0 %** verwendet die verbleibenden Limits oder
  volle Limits aller sichtbaren Claude-Accounts.
- **Pro Tag / Pro Woche** wählt die Mengenrate.
- **Newsletter / Korrekturen / Uploads** verteilt die Kapazität.

Anfangs steht die gesamte Kapazität bei Newslettern; Korrekturen und Uploads
stehen auf null. Beim Ändern der Newsletter-Menge werden zunächst ebenso viele
Uploads berücksichtigt, soweit sie passen. Der verbleibende Raum wird als
Korrekturen angezeigt. Upload-Änderungen berechnen die Korrekturen neu;
Korrektur-Änderungen verteilen den übrigen Raum auf Uploads. Mengen können auch
direkt eingegeben werden. Es gibt keinen Speicher-, Entwurfs- oder Exportablauf.

Alle Accounts haben laut Vorgabe denselben Max-Plan. Deshalb verwendet die
Berechnung die gemeinsamen Mittelwerte aus `summary.by_kind`, identisch mit dem
Reiter Verbrauch, für jede Aufgabenart und alle Accounts. Diese Mittelwerte umfassen
die in den letzten fünf Tagen abgeschlossenen Aufgaben (rollierende 120 Stunden,
Abschlusszeit zählt). Jede Verbrauchsaktualisierung berechnet die Planbarkeit mit
demselben Stand neu: ohne Mengenauswahl steigt oder sinkt die maximal mögliche
Newsletterzahl; bei einer gewählten Menge wird der verbleibende Raum neu verteilt.
Eigene Stichproben je
Account, Laufzeitmodelle, Tageskalender, Queue-Abzüge und zusätzliche Reserven
entfallen. Geteilte Account-IDs werden einmal gezählt. Auch pausierte Macs und
Accounts ohne eigene Aufgabenstichprobe zählen; ihre Auftragsannahme ist keine
Eigenschaft des Claude-Kontingents.

Eine Wochenmenge verbraucht `Anzahl × mittlere Wochenprozentpunkte`. Eine
Tagesmenge ist eine Rate über sieben Tage und verbraucht entsprechend siebenmal
so viel vom Wochenkontingent. Die zugehörige 5-h-Rate wird über `5/168` bzw.
`5/24` des Mengenverbrauchs begrenzt. Beide Fenster müssen gleichzeitig passen.
Es werden keine zukünftigen Resets als bereits verfügbares Kontingent addiert.
Die Anzeige ist eine Rechnung mit den beobachteten Mittelwerten, kein Auftrag
oder garantierter Liefertermin.

Die UI verändert keine Aufträge, Policies oder gespeicherten Teampläne. Der
frühere Schreib-Endpunkt `/planning` ist entfernt; alte Planungsdateien werden
nicht mehr gelesen. Ein Account ohne beide aktuellen Fenster (etwa eines
stillgelegten oder schweigenden Macs) wird in der aktuellen Kapazität
ausgelassen statt als unverbraucht gezählt; der Hinweis nennt die Anzahl der
ausgelassenen Accounts. Bei fehlender Verbindung, fehlenden Verbrauchswerten
oder ohne einen einzigen Account mit aktuellen Limits bleiben die Regler
deaktiviert, statt Kapazität zu erfinden.

Prüfung:

```sh
npm test --prefix team-server
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/review-planning.cjs
```
