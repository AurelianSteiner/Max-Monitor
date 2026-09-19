#!/bin/bash
#
# Usage4Claude — Build ohne Xcode
#
# Baut die App ausschließlich mit den Command Line Tools (swiftc + codesign) und
# packt sie zu einem fertigen Usage4Claude.app zusammen. Gedacht für Rechner ohne
# installiertes Xcode. Wer Xcode hat, nimmt weiterhin ./scripts/build.sh
# (das ist der offizielle, signierte/notarisierte Weg inkl. DMG).
#
# Unterschiede zum Xcode-Build:
#   - Assets.xcassets kann ohne Xcode nicht kompiliert werden (actool fehlt),
#     deshalb landen die vier Icons als lose Ressourcen im Bundle. NSImage(named:)
#     findet sie dort genauso.
#   - Signatur ist ad-hoc ("-"), nicht Developer ID. Die App läuft lokal, ist aber
#     nicht notarisiert und teilt sich den Keychain-Zugriff nicht mit einem
#     offiziell signierten Build (Accounts ggf. einmalig neu anmelden).
#
# Voraussetzungen:
#   - Command Line Tools (xcode-select --install)
#   - Sparkle.framework 2.9.x — wird bei Bedarf automatisch heruntergeladen und
#     vor dem Entpacken gegen SPARKLE_SHA256 geprüft
#
# Verwendung:
#   ./scripts/build_without_xcode.sh [--open]
#
# Name und Bundle-ID lassen sich überschreiben, um einen Build parallel zu einer
# bestehenden Installation zu betreiben:
#   U4C_PRODUCT_NAME="Usage4Claude 2.0" U4C_BUNDLE_ID=xyz.fi5h.Usage4Claude2 ./scripts/build_without_xcode.sh
#

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# SOURCE/APP_NAME: Projekt- und Quellordner, Modulname, Name der ausführbaren Datei.
# PRODUCT_NAME: sichtbarer App-Name (Dateiname des Bundles + CFBundleName).
# Eine eigene Bundle-ID sorgt für getrennte Einstellungen/Keychain — so kollidiert
# dieser Build nicht mit einer parallel installierten Originalversion.
APP_NAME="Usage4Claude"
PRODUCT_NAME="${U4C_PRODUCT_NAME:-Usage4Claude}"
BUNDLE_ID="${U4C_BUNDLE_ID:-xyz.fi5h.Usage4Claude}"
BASE_VERSION="$(grep -m1 -oE 'MARKETING_VERSION = [0-9][^;]*' "$PROJECT_ROOT/$APP_NAME.xcodeproj/project.pbxproj" | awk '{print $3}')"
# Ohne Vorgabe bekommt der Build ein Suffix, damit er in "Über …" von einem
# offiziellen Release unterscheidbar bleibt. release.sh setzt U4C_VERSION.
VERSION="${U4C_VERSION:-${BASE_VERSION}+dashboard}"
DEPLOYMENT_TARGET="13.0"
SPARKLE_VERSION="2.9.2"
# SHA-256 von Sparkle-2.9.2.tar.xz, dem Release-Asset unter
# github.com/sparkle-project/Sparkle/releases/download/2.9.2/. Das Archiv wandert
# entpackt ins signierte Bundle und damit in jedes ausgelieferte DMG — ohne
# Prüfsumme würde ein untergeschobenes Archiv unbesehen mitgehen.
# Beim Versionswechsel neu bestimmen:
#   curl -fL -o /tmp/Sparkle.tar.xz \
#     "https://github.com/sparkle-project/Sparkle/releases/download/<version>/Sparkle-<version>.tar.xz"
#   shasum -a 256 /tmp/Sparkle.tar.xz
SPARKLE_SHA256="1cb340cbbef04c6c0d162078610c25e2221031d794a3449d89f2f56f4df77c95"
# Eigener Appcast (z. B. aus dem eigenen GitHub-Fork). Gesetzt = automatische
# Update-Prüfung an; leer = aus, damit kein fremdes Release diesen Build ersetzt.
APPCAST_URL="${U4C_APPCAST_URL:-}"

BUILD_DIR="$PROJECT_ROOT/build/no-xcode"
APP_BUNDLE="$BUILD_DIR/$PRODUCT_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
VENDOR_DIR="$PROJECT_ROOT/build/vendor"
SPARKLE_DIR="$VENDOR_DIR/Sparkle-$SPARKLE_VERSION"

OPEN_AFTER_BUILD=false
[[ "${1:-}" == "--open" ]] && OPEN_AFTER_BUILD=true

info()    { printf '\033[0;34mℹ️  %s\033[0m\n' "$1"; }
success() { printf '\033[0;32m✅ %s\033[0m\n' "$1"; }
fail()    { printf '\033[0;31m❌ %s\033[0m\n' "$1"; exit 1; }

# ---------------------------------------------------------------- Abhängigkeiten
command -v swiftc >/dev/null || fail "swiftc nicht gefunden — bitte 'xcode-select --install' ausführen"
SDK_PATH="$(xcrun --show-sdk-path)"
[[ -d "$SDK_PATH" ]] || fail "macOS SDK nicht gefunden"
info "SDK: $SDK_PATH"
info "Produkt: $PRODUCT_NAME  ($BUNDLE_ID)"
info "Version: $VERSION"

[[ -n "$SPARKLE_SHA256" ]] || fail "SPARKLE_SHA256 ist leer — Prüfsumme für Sparkle $SPARKLE_VERSION eintragen (siehe Kommentar oben)"

# Ein bereits entpacktes Verzeichnis allein sagt nichts darüber aus, woher es
# stammt. Der Stempel hält fest, gegen welche Prüfsumme der Inhalt tatsächlich
# geprüft wurde; fehlt er oder passt er nicht, wird verworfen und neu geladen.
SPARKLE_STAMP="$SPARKLE_DIR/.verified-sha256"
CACHED_SHA256=""
if [[ -f "$SPARKLE_STAMP" ]]; then
    CACHED_SHA256="$(cat "$SPARKLE_STAMP")"
fi

if [[ ! -d "$SPARKLE_DIR/Sparkle.framework" || "$CACHED_SHA256" != "$SPARKLE_SHA256" ]]; then
    info "Sparkle $SPARKLE_VERSION wird heruntergeladen…"
    rm -rf "$SPARKLE_DIR"
    mkdir -p "$SPARKLE_DIR"
    curl -fsSL -o "$SPARKLE_DIR/Sparkle.tar.xz" \
        "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"
    ACTUAL_SHA256="$(shasum -a 256 "$SPARKLE_DIR/Sparkle.tar.xz" | awk '{print $1}')"
    if [[ "$ACTUAL_SHA256" != "$SPARKLE_SHA256" ]]; then
        rm -rf "$SPARKLE_DIR"
        fail "Sparkle-Prüfsumme stimmt nicht — erwartet $SPARKLE_SHA256, erhalten $ACTUAL_SHA256"
    fi
    info "Prüfsumme bestätigt"
    tar -xf "$SPARKLE_DIR/Sparkle.tar.xz" -C "$SPARKLE_DIR"
    rm -f "$SPARKLE_DIR/Sparkle.tar.xz"
    printf '%s\n' "$SPARKLE_SHA256" > "$SPARKLE_STAMP"
fi
[[ -d "$SPARKLE_DIR/Sparkle.framework" ]] || fail "Sparkle.framework nicht gefunden"

# ---------------------------------------------------------------- Bundle-Gerüst
rm -rf "$APP_BUNDLE"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$CONTENTS/Frameworks"

# ---------------------------------------------------------------- Kompilieren
info "Kompiliere Swift-Quellen…"
# macOS liefert bash 3.2 aus — kein mapfile, deshalb klassische while-read-Schleife
SOURCES=()
while IFS= read -r file; do
    SOURCES+=("$file")
done < <(find "$PROJECT_ROOT/$APP_NAME" -name '*.swift' | sort)
[[ ${#SOURCES[@]} -gt 0 ]] || fail "Keine Swift-Dateien gefunden"
info "${#SOURCES[@]} Swift-Dateien"

# Universal Binary: pro Architektur einmal linken, danach mit lipo zusammenführen.
ARCHS=(arm64 x86_64)
THIN_BINARIES=()
for arch in "${ARCHS[@]}"; do
    out="$BUILD_DIR/$APP_NAME-$arch"
    swiftc \
        -sdk "$SDK_PATH" \
        -target "$arch-apple-macos$DEPLOYMENT_TARGET" \
        -swift-version 5 \
        -O \
        -module-name "$APP_NAME" \
        -F "$SPARKLE_DIR" \
        -framework Sparkle \
        -Xlinker -rpath -Xlinker "@executable_path/../Frameworks" \
        -o "$out" \
        "${SOURCES[@]}"
    THIN_BINARIES+=("$out")
done

lipo -create -output "$CONTENTS/MacOS/$APP_NAME" "${THIN_BINARIES[@]}"
rm -f "${THIN_BINARIES[@]}"
chmod +x "$CONTENTS/MacOS/$APP_NAME"
success "Binary gebaut ($(lipo -archs "$CONTENTS/MacOS/$APP_NAME"))"

# ---------------------------------------------------------------- Ressourcen
info "Kopiere Ressourcen…"
# Lokalisierungen
for lproj in "$PROJECT_ROOT/$APP_NAME/Resources"/*.lproj; do
    cp -R "$lproj" "$CONTENTS/Resources/"
done

# Icons: ohne actool kein Assets.car — die benötigten Bilder kommen als
# lose Dateien ins Bundle, NSImage(named:) findet sie dort ebenfalls.
ASSETS="$PROJECT_ROOT/$APP_NAME/Resources/Assets.xcassets"
# AppIcon.icns aus den PNGs des Asset-Katalogs erzeugen, statt eine vorgebaute
# .icns mitzuschleppen: iconutil gehört zu macOS, und damit ist der Asset-Katalog
# die einzige Quelle für das Symbol — ein Austausch dort wirkt sofort.
ICONSET="$BUILD_DIR/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for spec in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" "128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" "512:512x512" "1024:512x512@2x"; do
    src="${spec%%:*}"; name="${spec#*:}"
    cp "$ASSETS/AppIcon.appiconset/$src.png" "$ICONSET/icon_$name.png"
done
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns" || fail "AppIcon.icns konnte nicht erzeugt werden"
rm -rf "$ICONSET"
cp "$ASSETS/AppIconReverse.imageset/icon.reverse@2x.png"               "$CONTENTS/Resources/AppIconReverse@2x.png"
cp "$ASSETS/ClaudeIcon.imageset/icon.claude@2x.png"                    "$CONTENTS/Resources/ClaudeIcon@2x.png"
cp "$ASSETS/CodexIcon.imageset/icon.codex@2x.png"                      "$CONTENTS/Resources/CodexIcon@2x.png"
cp "$ASSETS/CodexIconReverse.imageset/icon.codex.reverse@2x.png"       "$CONTENTS/Resources/CodexIconReverse@2x.png"

# Sparkle
cp -R "$SPARKLE_DIR/Sparkle.framework" "$CONTENTS/Frameworks/"

# ---------------------------------------------------------------- Info.plist
info "Erzeuge Info.plist…"
python3 - "$PROJECT_ROOT/Config/Info.plist" "$CONTENTS/Info.plist" \
    "$BUNDLE_ID" "$APP_NAME" "$VERSION" "$DEPLOYMENT_TARGET" "$BASE_VERSION" "$PRODUCT_NAME" "$APPCAST_URL" <<'PY'
import plistlib, re, sys

src, dst, bundle_id, name, version, min_os, base_version, product_name, appcast_url = sys.argv[1:10]

with open(src, "rb") as handle:
    plist = plistlib.load(handle)

substitutions = {
    "$(DEVELOPMENT_LANGUAGE)": "en",
    "$(EXECUTABLE_NAME)": name,
    "$(PRODUCT_BUNDLE_IDENTIFIER)": bundle_id,
    "$(PRODUCT_NAME)": product_name,
    "$(PRODUCT_BUNDLE_PACKAGE_TYPE)": "APPL",
    "$(MARKETING_VERSION)": version,
    # CFBundleVersion muss mitwachsen: Sparkle vergleicht die <sparkle:version>
    # des Appcasts gegen CFBundleVersion, nicht gegen die sichtbare Version.
    # Stand hier die feste base_version, meldete jede gebaute App dauerhaft 1.0 —
    # und der Appcast bot dieselbe Version endlos als „Update" an.
    # Nur der numerische Anteil: Entwickler-Builds heißen „1.0+dashboard“, und
    # CFBundleVersion erlaubt ausschließlich Ziffern und Punkte.
    "$(CURRENT_PROJECT_VERSION)": re.match(r"[0-9.]*", version).group(0).strip(".") or base_version,
    "$(MACOSX_DEPLOYMENT_TARGET)": min_os,
}

def resolve(value):
    if isinstance(value, str):
        for token, replacement in substitutions.items():
            value = value.replace(token, replacement)
        return value
    if isinstance(value, dict):
        return {key: resolve(item) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item) for item in value]
    return value

plist = resolve(plist)

# Auto-Update nur mit eigenem Appcast: der Upstream-Feed würde diesen Build durch
# das offizielle Release ersetzen und die lokalen Änderungen entfernen.
if appcast_url:
    plist["SUFeedURL"] = appcast_url
    plist["SUEnableAutomaticChecks"] = True
    plist["SUScheduledCheckInterval"] = 3600  # stündlich prüfen
else:
    plist["SUEnableAutomaticChecks"] = False

with open(dst, "wb") as handle:
    plistlib.dump(plist, handle)
PY

# ---------------------------------------------------------------- Signieren
# codesign kennt keine $(...)-Build-Variablen (das macht sonst Xcode). Die
# Sparkle-mach-lookup-Ausnahmen enthalten $(PRODUCT_BUNDLE_IDENTIFIER) und würden
# sonst wörtlich im Bundle landen — hier vorher auflösen.
RESOLVED_ENTITLEMENTS="$BUILD_DIR/entitlements.resolved.plist"
python3 - "$PROJECT_ROOT/Config/Usage4Claude.entitlements" "$RESOLVED_ENTITLEMENTS" "$BUNDLE_ID" <<'ENT'
import plistlib, sys

src, dst, bundle_id = sys.argv[1:4]

with open(src, "rb") as handle:
    plist = plistlib.load(handle)

def resolve(value):
    if isinstance(value, str):
        return value.replace("$(PRODUCT_BUNDLE_IDENTIFIER)", bundle_id)
    if isinstance(value, dict):
        return {key: resolve(item) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item) for item in value]
    return value

with open(dst, "wb") as handle:
    plistlib.dump(resolve(plist), handle)
ENT

# Feste Identität statt ad-hoc, wenn vorhanden: Ad-hoc-Signaturen sind bei jedem
# Build anders, deshalb fragte der Schlüsselbund nach jedem Update neu nach den
# gespeicherten Konten. Mit demselben selbst erstellten Zertifikat („Claude Max
# Monitor Signing") bleibt die Identität über Versionen stabil und „Immer
# erlauben" gilt dauerhaft. Fehlt das Zertifikat (z. B. auf CI), ad-hoc wie bisher.
# Der Zertifikatsname trägt weiter den alten Produktnamen: Er ist in den
# Schlüsselbunden der Nutzer hinterlegt — ein neuer Name wäre eine neue
# Identität, und der Schlüsselbund fragte bei jedem Update wieder nach.
SIGN_IDENTITY="-"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Claude Max Monitor Signing"; then
    SIGN_IDENTITY="Claude Max Monitor Signing"
    info "Signiere (Claude Max Monitor Signing)…"
else
    info "Signiere (ad-hoc)…"
fi
codesign --force --sign "$SIGN_IDENTITY" --timestamp=none \
    --entitlements "$RESOLVED_ENTITLEMENTS" \
    "$APP_BUNDLE" 2>&1 | sed 's/^/    /' || fail "Signieren fehlgeschlagen"

codesign --verify --verbose=2 "$APP_BUNDLE" 2>&1 | sed 's/^/    /'

success "Fertig: $APP_BUNDLE"
echo
echo "  Installieren:  cp -R \"$APP_BUNDLE\" /Applications/"
echo

if [[ "$OPEN_AFTER_BUILD" == true ]]; then
    open "$APP_BUNDLE"
fi
