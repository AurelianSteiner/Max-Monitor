# Max Monitor Offene fachliche Entscheidung

## F11 Datenquelle der älteren Teamberichte

Soll die ältere Teamfunktion weiterhin lokale Claude-Kontingente und deren Anzeigenamen teilen, oder sollen Worker-Anzeigen ausschließlich die getrennten Monitoring-Konten verwenden?

Der technische Audit zeigt zwei parallele Meldepfade: `FleetReporter` verwendet die getrennten Monitoring-Konten, `TeamAutoReporter` verwendet lokale Dashboard-Snapshots. Beide Pfade wurden für diese Reparatur beibehalten. Eine Änderung der Datenquelle wurde nicht vorweggenommen.

Nach der Entscheidung sind Datenquelle, Oberflächenhinweise und ausgehender Payload gemeinsam anzupassen und zu prüfen. Die übrigen technischen Korrekturen hängen davon nicht ab.
