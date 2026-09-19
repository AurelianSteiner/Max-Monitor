//
//  make_icon.swift — erzeugt die App-Symbol-PNGs
//
//  Zeichnet das Symbol in allen Größen, die der Asset-Katalog braucht, und
//  schreibt sie direkt dorthin. Damit ist das Symbol Code und keine Binärdatei,
//  die niemand mehr ändern kann.
//
//  Das Motiv: ein Monitor, in dessen Schirm ein Prompt steht. Die App heißt
//  Max **Monitor**, und sie beobachtet Entwicklerwerkzeuge — beides steckt im
//  Bild. Der frühere Wasserkreis (bis 2.8) und der Pegel im Schirm (2.9) sind
//  weg: Sie trugen Claudes Clay-Orange, und ein Symbol, das die Hausfarbe eines
//  der beiden überwachten Anbieter trägt, behauptet eine Zugehörigkeit, die es
//  nicht gibt — die App zeigt Claude *und* Codex. Graphit und Limette gehören
//  keinem von beiden.
//
//  Aufruf:  swift scripts/make_icon.swift
//

import AppKit
import Foundation

func rgb(_ hex: Int) -> NSColor {
    NSColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255.0,
        green: CGFloat((hex >> 8) & 0xFF) / 255.0,
        blue: CGFloat(hex & 0xFF) / 255.0,
        alpha: 1
    )
}

/// Kachel: dunkles Schiefergrau mit einem Hauch Verlauf nach unten.
let slate = rgb(0x2E2D36)
let slateDeep = rgb(0x22212A)
/// Gehäuse des Monitors — dasselbe Creme wie die Flächen in der App.
let cream = rgb(0xF5F1EC)
/// Der Schirm ist dunkler als die Kachel, sonst verschwimmt er mit ihr.
let screenInk = rgb(0x121116)
/// Der Prompt. Limette, weil sie weder Claudes Clay noch Codex' Blau ist und
/// auf dem dunklen Schirm ohne Verlauf trägt.
let lime = rgb(0xC3F53C)

func drawIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    guard let context = NSGraphicsContext.current else { fatalError("kein Grafikkontext") }
    context.imageInterpolation = .high
    context.cgContext.setShouldAntialias(true)

    // macOS-Symbole bringen ihre Form selbst mit und lassen aussen Luft:
    // die Kachel nimmt rund 80 % der Kantenlänge ein.
    let inset = size * 0.0977
    let tile = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
    let corner = tile.width * 0.2245
    let t = tile.width

    let tilePath = NSBezierPath(roundedRect: tile, xRadius: corner, yRadius: corner)
    NSGraphicsContext.saveGraphicsState()
    tilePath.addClip()
    NSGradient(starting: slate, ending: slateDeep)?.draw(in: tile, angle: -90)
    NSGraphicsContext.restoreGraphicsState()

    // Maße des Monitors, alle an der Kachelkante gemessen. Gehäuse + Hals + Fuß
    // stehen zusammen mittig, mit gleich viel Luft oben wie unten.
    let bodyWidth = t * 0.80
    let bodyHeight = t * 0.56
    let neckWidth = t * 0.13
    let neckHeight = t * 0.07
    let footWidth = t * 0.34
    let footHeight = t * 0.05
    let bottom = tile.minY + (t - (bodyHeight + neckHeight + footHeight)) / 2

    cream.setFill()

    // Fuß
    let foot = NSRect(x: tile.midX - footWidth / 2, y: bottom, width: footWidth, height: footHeight)
    NSBezierPath(roundedRect: foot, xRadius: footHeight / 2, yRadius: footHeight / 2).fill()

    // Hals — überlappt Fuß und Gehäuse um einen Hauch, damit an den Übergängen
    // keine dunklen Nähte stehen bleiben.
    let neck = NSRect(
        x: tile.midX - neckWidth / 2, y: bottom + footHeight - t * 0.004,
        width: neckWidth, height: neckHeight + t * 0.008
    )
    NSBezierPath(rect: neck).fill()

    // Gehäuse: gefüllte Fläche statt Kontur — bei 16 px trägt ein Rahmen aus
    // Fläche, eine dünne Linie verschwindet.
    let body = NSRect(
        x: tile.midX - bodyWidth / 2, y: bottom + footHeight + neckHeight,
        width: bodyWidth, height: bodyHeight
    )
    NSBezierPath(roundedRect: body, xRadius: t * 0.075, yRadius: t * 0.075).fill()

    // Schirm
    let screen = body.insetBy(dx: t * 0.042, dy: t * 0.042)
    screenInk.setFill()
    NSBezierPath(roundedRect: screen, xRadius: t * 0.045, yRadius: t * 0.045).fill()

    /// Punkt in Schirm-Koordinaten (0…1)
    func sp(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: screen.minX + screen.width * x, y: screen.minY + screen.height * y)
    }

    // Das Eingabezeichen „>"
    let chevron = NSBezierPath()
    chevron.move(to: sp(0.20, 0.74))
    chevron.line(to: sp(0.42, 0.50))
    chevron.line(to: sp(0.20, 0.26))
    chevron.lineWidth = t * 0.058
    chevron.lineJoinStyle = .round
    chevron.lineCapStyle = .round
    lime.setStroke()
    chevron.stroke()

    // Der Cursor daneben
    let cursor = NSRect(
        x: screen.minX + screen.width * 0.52, y: screen.minY + screen.height * 0.22,
        width: screen.width * 0.28, height: screen.height * 0.11
    )
    lime.setFill()
    NSBezierPath(roundedRect: cursor, xRadius: cursor.height / 2, yRadius: cursor.height / 2).fill()

    image.unlockFocus()
    return image
}

func writePNG(_ image: NSImage, to url: URL, pixelSize: Int) {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixelSize, pixelsHigh: pixelSize,
        bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ) else { fatalError("Bitmap konnte nicht angelegt werden") }

    rep.size = NSSize(width: pixelSize, height: pixelSize)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(x: 0, y: 0, width: pixelSize, height: pixelSize))
    NSGraphicsContext.restoreGraphicsState()

    guard let data = rep.representation(using: .png, properties: [:]) else {
        fatalError("PNG konnte nicht erzeugt werden")
    }
    try! data.write(to: url)
    print("geschrieben: \(url.lastPathComponent) (\(pixelSize)px)")
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let iconset = root.appendingPathComponent("Usage4Claude/Resources/Assets.xcassets/AppIcon.appiconset")

for size in [16, 32, 64, 128, 256, 512, 1024] {
    let image = drawIcon(size: CGFloat(size))
    writePNG(image, to: iconset.appendingPathComponent("\(size).png"), pixelSize: size)
}

print("fertig")
