//
//  make_provider_icons.swift — erzeugt die Anbieter-Logos
//
//  Bis 2.9 diente das App-Symbol als Claude-Logo. Seit das App-Symbol ein
//  Monitor ist, geht das nicht mehr: Auf der Claude-Bahn der Übersicht stünde
//  sonst das Symbol der App selbst. Dieses Skript zeichnet deshalb ein eigenes
//  Claude-Zeichen — den Clay-orangen Stern — in den Asset-Katalog.
//
//  Wie beim App-Symbol gilt: lieber Code als eine Binärdatei, die niemand mehr
//  ändern kann.
//
//  Aufruf:  swift scripts/make_provider_icons.swift
//

import AppKit
import Foundation

let clay = NSColor(red: 0xD9 / 255.0, green: 0x77 / 255.0, blue: 0x57 / 255.0, alpha: 1)

/// Claudes Stern: zwölf Strahlen um eine gemeinsame Mitte, abwechselnd lang und
/// kurz. Die Strahlen laufen nach außen spitz zu — eine Raute je Strahl, keine
/// Striche: So bleibt die Form auch bei 12 pt in der Kontozeile ein Stern und
/// franst nicht zu einem grauen Fleck aus.
func drawClaudeMark(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    guard let context = NSGraphicsContext.current else { fatalError("kein Grafikkontext") }
    context.imageInterpolation = .high
    context.cgContext.setShouldAntialias(true)

    let center = NSPoint(x: size / 2, y: size / 2)
    // Rundum etwas Luft lassen, damit das Zeichen in einem quadratischen
    // Bildfeld nicht an den Rand stößt.
    let long = size * 0.46
    let short = size * 0.27
    let halfWidth = size * 0.047

    let path = NSBezierPath()
    for index in 0..<12 {
        let angle = CGFloat(index) * .pi / 6
        let length = index.isMultiple(of: 2) ? long : short
        let tip = NSPoint(x: center.x + cos(angle) * length, y: center.y + sin(angle) * length)
        // Quer zur Strahlrichtung die beiden Flanken der Raute
        let side = angle + .pi / 2
        let left = NSPoint(x: center.x + cos(side) * halfWidth, y: center.y + sin(side) * halfWidth)
        let right = NSPoint(x: center.x - cos(side) * halfWidth, y: center.y - sin(side) * halfWidth)

        path.move(to: left)
        path.line(to: tip)
        path.line(to: right)
        path.close()
    }

    clay.setFill()
    path.fill()

    // Die Mitte füllt die zwölf Rauten zu einer geschlossenen Form zusammen —
    // ohne sie blieben feine helle Nähte zwischen den Strahlen stehen.
    let hub = NSBezierPath(ovalIn: NSRect(
        x: center.x - halfWidth, y: center.y - halfWidth,
        width: halfWidth * 2, height: halfWidth * 2
    ))
    hub.fill()

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
let assets = root.appendingPathComponent("Usage4Claude/Resources/Assets.xcassets")
let claudeSet = assets.appendingPathComponent("ClaudeIcon.imageset")

try! FileManager.default.createDirectory(at: claudeSet, withIntermediateDirectories: true)

let contents = """
{
  "images" : [
    {
      "idiom" : "universal",
      "scale" : "1x"
    },
    {
      "filename" : "icon.claude@2x.png",
      "idiom" : "universal",
      "scale" : "2x"
    },
    {
      "idiom" : "universal",
      "scale" : "3x"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}

"""
try! contents.write(to: claudeSet.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)

let mark = drawClaudeMark(size: 512)
writePNG(mark, to: claudeSet.appendingPathComponent("icon.claude@2x.png"), pixelSize: 512)

print("fertig")
