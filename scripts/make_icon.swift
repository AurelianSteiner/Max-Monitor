//
//  make_icon.swift — erzeugt die App-Symbol-PNGs
//
//  Zeichnet das Symbol in allen Größen, die der Asset-Katalog braucht, und
//  schreibt sie direkt dorthin. Damit ist das Symbol Code und keine Binärdatei,
//  die niemand mehr ändern kann.
//
//  Das Motiv (seit 2.9): ein Monitor. Die App heißt Max **Monitor**, und der
//  frühere Wasserkreis war von Claudes eigenem Zeichen kaum zu unterscheiden —
//  im Dock standen zwei orange Kreise nebeneinander. Der Pegel steckt jetzt im
//  Bildschirm: Das Motiv sagt „Monitor" und der Inhalt weiter „Auslastung".
//
//  Aufruf:  swift scripts/make_icon.swift
//

import AppKit
import Foundation

// Farben aus der Auslastungsskala der App
let cream = NSColor(red: 0xF5 / 255.0, green: 0xF1 / 255.0, blue: 0xEC / 255.0, alpha: 1)
let creamDeep = NSColor(red: 0xE9 / 255.0, green: 0xE3 / 255.0, blue: 0xDB / 255.0, alpha: 1)
let well = NSColor(red: 0xE8 / 255.0, green: 0xE2 / 255.0, blue: 0xDA / 255.0, alpha: 1)
let water = NSColor(red: 0xD9 / 255.0, green: 0x77 / 255.0, blue: 0x57 / 255.0, alpha: 1)
let outline = NSColor(red: 0x2B / 255.0, green: 0x2A / 255.0, blue: 0x28 / 255.0, alpha: 1)

/// Anteil, bis zu dem der Bildschirm gefüllt ist. Bewusst nicht halb — ein
/// leicht asymmetrischer Pegel liest sich als Messwert, genau in der Mitte als Dekor.
let fillLevel: CGFloat = 0.62

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
    // Ein Hauch Verlauf nach unten: Ohne ihn wirkt die große 1024er Kachel flach,
    // im Dock sieht man ihn kaum — genau so ist er gemeint.
    NSGradient(starting: cream, ending: creamDeep)?.draw(in: tile, angle: -90)
    NSGraphicsContext.restoreGraphicsState()

    // Maße des Monitors, alle an der Kachelkante gemessen. Gehäuse + Hals + Fuß
    // ergeben zusammen 0,67 t und sitzen damit mittig mit gleich viel Luft
    // oben wie unten.
    let bodyWidth = t * 0.74
    let bodyHeight = t * 0.54
    let neckWidth = t * 0.13
    let neckHeight = t * 0.075
    let footWidth = t * 0.34
    let footHeight = t * 0.052
    let bottom = tile.minY + (t - (bodyHeight + neckHeight + footHeight)) / 2

    // Fuß
    let foot = NSRect(
        x: tile.midX - footWidth / 2, y: bottom,
        width: footWidth, height: footHeight
    )
    outline.setFill()
    NSBezierPath(roundedRect: foot, xRadius: footHeight / 2, yRadius: footHeight / 2).fill()

    // Hals — überlappt Fuß und Gehäuse um einen Hauch, damit an den Übergängen
    // keine hellen Nähte stehen bleiben.
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
    let bodyCorner = t * 0.075
    NSBezierPath(roundedRect: body, xRadius: bodyCorner, yRadius: bodyCorner).fill()

    // Bildschirm
    let bezel = t * 0.055
    let screen = body.insetBy(dx: bezel, dy: bezel)
    let screenCorner = bodyCorner - bezel * 0.55
    let screenPath = NSBezierPath(roundedRect: screen, xRadius: screenCorner, yRadius: screenCorner)
    well.setFill()
    screenPath.fill()

    // Wasser mit ruhiger Welle an der Oberkante, auf den Bildschirm beschnitten
    NSGraphicsContext.saveGraphicsState()
    screenPath.addClip()

    let surfaceY = screen.minY + screen.height * fillLevel
    let waveHeight = screen.height * 0.05
    let overhang = screen.width * 0.5
    let wave = NSBezierPath()
    wave.move(to: NSPoint(x: screen.minX - overhang, y: surfaceY))
    wave.curve(
        to: NSPoint(x: screen.midX, y: surfaceY),
        controlPoint1: NSPoint(x: screen.minX - overhang * 0.4, y: surfaceY + waveHeight),
        controlPoint2: NSPoint(x: screen.minX + overhang * 0.4, y: surfaceY + waveHeight)
    )
    wave.curve(
        to: NSPoint(x: screen.maxX + overhang, y: surfaceY),
        controlPoint1: NSPoint(x: screen.midX + overhang * 0.6, y: surfaceY - waveHeight),
        controlPoint2: NSPoint(x: screen.maxX + overhang * 0.4, y: surfaceY - waveHeight)
    )
    wave.line(to: NSPoint(x: screen.maxX + overhang, y: screen.minY - overhang))
    wave.line(to: NSPoint(x: screen.minX - overhang, y: screen.minY - overhang))
    wave.close()
    water.setFill()
    wave.fill()

    NSGraphicsContext.restoreGraphicsState()

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
