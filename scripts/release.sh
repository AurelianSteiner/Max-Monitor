#!/bin/bash
#
# Release: bauen, DMG packen, signieren, appcast.xml fortschreiben und als
# GitHub-Release veröffentlichen.
#
# Verwendung:
#   ./scripts/release.sh 1.1 ["Was ist neu"]
#
# Voraussetzungen:
#   - gh (GitHub CLI), angemeldet
#   - sign_update unter build/vendor/sparkle-tools/ — einmalig selbst dort ablegen.
#     build_without_xcode.sh legt dieses Verzeichnis NICHT an; es lädt den
#     Sparkle-Release-Tarball, prüft ihn gegen eine fest hinterlegte SHA-256 und
#     entpackt ihn nach build/vendor/Sparkle-<version>/ — inklusive bin/sign_update.
#     Von dort kopieren/verlinken. Niemals ein ungeprüftes Binary dort ablegen:
#     es signiert die Updates aller installierten Kopien.
#   - privater EdDSA-Schlüssel im Anmeldeschlüsselbund (einmalig via generate_keys)
#
# Nach dem Durchlauf melden sich installierte Kopien innerhalb einer Stunde
# und bieten das Update an.

set -e
set -o pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
success() { echo -e "${GREEN}✅ $1${NC}"; }
warn()    { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()    { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="${1:-}"
NOTES="${2:-}"
[[ -n "$VERSION" ]] || fail "Version fehlt. Beispiel: ./scripts/release.sh 1.1"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail "Version muss dem Muster X.Y oder X.Y.Z folgen"

PRODUCT_NAME="${U4C_PRODUCT_NAME:-Max Monitor}"
BUNDLE_ID="${U4C_BUNDLE_ID:-xyz.fi5h.Usage4Claude}"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
APPCAST_URL="https://raw.githubusercontent.com/$REPO/main/appcast.xml"
TAG="v$VERSION"
# GitHub ersetzt Leerzeichen in Asset-Namen durch Punkte. Der Name im Appcast
# muss exakt zum Asset passen, sonst lädt Sparkle ins Leere — deshalb von
# vornherein ein Name ohne Leerzeichen.
PRODUCT_SLUG="$(echo "$PRODUCT_NAME" | tr ' ' '-')"
DMG_NAME="$PRODUCT_SLUG-$VERSION.dmg"
BUILD_DIR="$PROJECT_ROOT/build/no-xcode"
DMG_PATH="$PROJECT_ROOT/build/$DMG_NAME"
SIGN_UPDATE="$PROJECT_ROOT/build/vendor/sparkle-tools/sign_update"

command -v gh >/dev/null || fail "gh nicht gefunden"
[[ -x "$SIGN_UPDATE" ]] || fail "sign_update nicht gefunden unter $SIGN_UPDATE"

# Ein sauberer Arbeitsbaum verhindert, dass ungetestete Änderungen mitgehen —
# und zwar hart: veröffentlicht wird der Stand des Arbeitsbaums, nicht der von
# HEAD. Eine liegengebliebene Änderung fährt also ungeprüft in ein Release, das
# alle installierten Kopien automatisch ziehen.
if [[ -n "$(git status --porcelain)" ]]; then
    if [[ "${ALLOW_DIRTY:-}" == "1" ]]; then
        warn "Arbeitsbaum ist nicht sauber — ALLOW_DIRTY=1, es wird der aktuelle Stand veröffentlicht"
    else
        git status --short
        fail "Arbeitsbaum ist nicht sauber. Änderungen committen oder verwerfen — oder bewusst mit ALLOW_DIRTY=1 ./scripts/release.sh $VERSION \"…\" erneut starten"
    fi
fi

info "Repo:    $REPO"
info "Version: $VERSION"
info "Produkt: $PRODUCT_NAME"

# ------------------------------------------------------------------ bauen
info "Baue App…"
rm -rf "$BUILD_DIR"
U4C_PRODUCT_NAME="$PRODUCT_NAME" \
U4C_BUNDLE_ID="$BUNDLE_ID" \
U4C_APPCAST_URL="$APPCAST_URL" \
U4C_VERSION="$VERSION" \
    bash scripts/build_without_xcode.sh >/dev/null || fail "Build fehlgeschlagen"

APP_BUNDLE="$BUILD_DIR/$PRODUCT_NAME.app"
[[ -d "$APP_BUNDLE" ]] || fail "App-Bundle nicht gefunden"
success "App gebaut"

# ------------------------------------------------------------------ DMG
# Bewusst mit hdiutil statt create-dmg: hdiutil gehört zu macOS, damit hat der
# Release-Weg keine Homebrew-Abhängigkeit. Das Ergebnis ist ein gewöhnliches
# Laufwerk mit App und Verknüpfung nach /Programme — mehr braucht es nicht.
info "Packe DMG…"
rm -f "$DMG_PATH"
STAGING="$(mktemp -d)"
cp -R "$APP_BUNDLE" "$STAGING/"
ln -s /Applications "$STAGING/Programme"
hdiutil create \
    -volname "$PRODUCT_NAME" \
    -srcfolder "$STAGING" \
    -ov -format UDZO \
    "$DMG_PATH" >/dev/null || fail "DMG konnte nicht erzeugt werden"
rm -rf "$STAGING"
[[ -f "$DMG_PATH" ]] || fail "DMG wurde nicht erzeugt"
success "DMG: $(du -h "$DMG_PATH" | awk '{print $1}')"

# ------------------------------------------------------------------ signieren
info "Signiere für Sparkle…"
SIGN_OUTPUT="$("$SIGN_UPDATE" "$DMG_PATH")" || fail "Signieren fehlgeschlagen (privater Schlüssel im Schlüsselbund?)"
ED_SIGNATURE="$(echo "$SIGN_OUTPUT" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')"
FILE_LENGTH="$(echo "$SIGN_OUTPUT" | sed -n 's/.*length="\([^"]*\)".*/\1/p')"
[[ -n "$ED_SIGNATURE" && -n "$FILE_LENGTH" ]] || fail "Signatur konnte nicht gelesen werden"
success "Signatur erzeugt"

# ------------------------------------------------------------------ appcast
info "Schreibe appcast.xml fort…"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$DMG_NAME"
PUB_DATE="$(LC_ALL=en_US.UTF-8 date -u '+%a, %d %b %Y %H:%M:%S +0000')"
DESCRIPTION="${NOTES:-Version $VERSION}"

python3 - "$VERSION" "$DOWNLOAD_URL" "$ED_SIGNATURE" "$FILE_LENGTH" "$PUB_DATE" "$DESCRIPTION" "$PRODUCT_NAME" "$APPCAST_URL" <<'PYEOF'
import sys, xml.sax.saxutils as esc
from pathlib import Path

version, url, signature, length, pub_date, description, product, appcast_url = sys.argv[1:9]
path = Path("appcast.xml")

# Ein wörtliches "]]>" in den Release-Notes würde den CDATA-Abschnitt unten
# vorzeitig beenden und damit den Feed für alle installierten Kopien zerlegen.
# Üblicher Kniff: die Sequenz auf zwei CDATA-Abschnitte aufteilen — der
# angezeigte Text bleibt unverändert.
description = description.replace("]]>", "]]]]><![CDATA[>")

item = f"""        <item>
            <title>{esc.escape(version)}</title>
            <pubDate>{pub_date}</pubDate>
            <sparkle:version>{version}</sparkle:version>
            <sparkle:shortVersionString>{version}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <description><![CDATA[{description}]]></description>
            <enclosure
                url="{url}"
                sparkle:edSignature="{signature}"
                length="{length}"
                type="application/octet-stream"/>
        </item>
"""

if path.exists() and "<channel>" in path.read_text():
    text = path.read_text()
    # Neuester Eintrag zuerst — Sparkle nimmt den höchsten, die Reihenfolge ist
    # aber für Menschen relevant, die die Datei lesen.
    marker = text.index("</title>", text.index("<channel>")) + len("</title>")
    end_of_line = text.index("\n", marker) + 1
    text = text[:end_of_line] + item + text[end_of_line:]
else:
    text = f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
    <channel>
        <title>{esc.escape(product)}</title>
        <link>{appcast_url}</link>
        <description>Updates</description>
        <language>de</language>
{item}    </channel>
</rss>
"""

path.write_text(text)
print("appcast.xml aktualisiert")
PYEOF

# ------------------------------------------------------------------ veröffentlichen
info "Committe appcast.xml…"
# Nur die Datei, die dieses Skript tatsächlich schreibt. Config/Info.plist stand
# hier früher mit drin, obwohl das Skript sie nie anfasst — ein versehentlich
# geänderter SUPublicEDKey wäre so unbemerkt ins Release-Commit gerutscht und
# hätte jedes künftige Update abgeschnitten.
git add appcast.xml
git commit -q -m "Release $VERSION" || warn "Nichts zu committen"
git push -q origin main

info "Erstelle GitHub-Release…"
gh release create "$TAG" "$DMG_PATH" \
    --title "$PRODUCT_NAME $VERSION" \
    --notes "${NOTES:-Version $VERSION}

**Installation:** DMG öffnen, App nach /Programme ziehen. Beim ersten Start Rechtsklick auf die App → „Öffnen\" (die App ist nicht bei Apple notarisiert).

Bereits installierte Kopien melden sich innerhalb einer Stunde von selbst." \
    || fail "Release konnte nicht erstellt werden"

success "Release $TAG veröffentlicht"
echo ""
echo "  DMG:     $DMG_PATH"
echo "  Release: https://github.com/$REPO/releases/tag/$TAG"
echo ""
info "Installierte Kopien prüfen stündlich und bieten das Update an."
