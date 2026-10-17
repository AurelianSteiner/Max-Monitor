import AppKit

// Static visual identity companion. No network, polling, account access or worker control.
struct Identity: Codable {
    let workerId: String
    let name: String
    let color: String
    let textColor: String
}
func color(_ hex: String) -> NSColor {
    let value = UInt32(hex.dropFirst(), radix: 16)!
    return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
                   green: CGFloat((value >> 8) & 255) / 255,
                   blue: CGFloat(value & 255) / 255, alpha: 1)
}
func renderWallpaper(_ identity: Identity, at url: URL) throws {
    let size = NSSize(width: 2880, height: 1800)
    let image = NSImage(size: size)
    image.lockFocus()
    color(identity.color).setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
    let text = identity.name as NSString
    text.draw(at: NSPoint(x: 100, y: 1510), withAttributes: [
        .font: NSFont.systemFont(ofSize: 112, weight: .semibold),
        .foregroundColor: color(identity.textColor)
    ])
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: url, options: .atomic)
}

final class IdentityApp: NSObject, NSApplicationDelegate {
    let identity: Identity
    let directory: URL
    var statusItem: NSStatusItem!
    var observer: NSObjectProtocol?
    init(identity: Identity, directory: URL) { self.identity = identity; self.directory = directory }
    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = " " + identity.name
            button.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
            let image = NSImage(size: NSSize(width: 13, height: 13), flipped: false) { rect in
                color(self.identity.color).setFill()
                let dot = NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3)
                dot.fill()
                NSColor.secondaryLabelColor.setStroke()
                dot.lineWidth = 0.75
                dot.stroke()
                return true
            }
            image.isTemplate = false
            button.image = image
            button.imagePosition = .imageLeading
            button.toolTip = identity.name + " · R&S Mac-Worker"
            button.setAccessibilityLabel(identity.name + " · Mac-Worker")
        }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: identity.name + " · Mac-Worker", action: nil, keyEquivalent: ""))
        statusItem.menu = menu
        let original = directory.appendingPathComponent("original-wallpapers.json")
        if !FileManager.default.fileExists(atPath: original.path) {
            let screens = NSScreen.screens.map { screen in
                ["display": screen.localizedName, "wallpaper": NSWorkspace.shared.desktopImageURL(for: screen)?.path ?? ""]
            }
            try? JSONSerialization.data(withJSONObject: screens).write(to: original, options: .atomic)
        }
        applyWallpaper()
        // New Spaces/displays receive the same wallpaper when activated, without a timer.
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.applyWallpaper() }
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }
    @objc func screensChanged() { applyWallpaper() }
    func applyWallpaper() {
        let wallpaper = directory.appendingPathComponent("wallpaper.png")
        do {
            for screen in NSScreen.screens {
                try NSWorkspace.shared.setDesktopImageURL(wallpaper, for: screen,
                    options: [.imageScaling: NSImageScaling.scaleProportionallyUpOrDown.rawValue,
                              .allowClipping: true, .fillColor: color(identity.color)])
            }
            // WallpaperAgent commits asynchronously, so read back after the request settles.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.writeReceipt() }
        } catch {
            try? String(describing: error).write(to: directory.appendingPathComponent("error.txt"), atomically: true, encoding: .utf8)
        }
    }
    func writeReceipt() {
        do {
            let screens = NSScreen.screens.map { screen in
                ["display": screen.localizedName,
                 "wallpaper": NSWorkspace.shared.desktopImageURL(for: screen)?.path ?? ""]
            }
            let receipt: [String: Any] = ["workerId": identity.workerId, "name": identity.name,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "menuItemVisible": statusItem.isVisible,
                "appliedAt": ISO8601DateFormatter().string(from: Date()), "screens": screens]
            try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
                .write(to: directory.appendingPathComponent("applied.json"), options: .atomic)
        } catch {
            try? String(describing: error).write(to: directory.appendingPathComponent("error.txt"), atomically: true, encoding: .utf8)
        }
    }
}

let args = CommandLine.arguments
if args.count == 2 && args[1] == "--inspect" {
    let screens = NSScreen.screens.map { ["display": $0.localizedName, "wallpaper": NSWorkspace.shared.desktopImageURL(for: $0)?.path ?? ""] }
    print(String(data: try JSONSerialization.data(withJSONObject: screens), encoding: .utf8)!)
} else if args.count == 6 && args[1] == "--render" {
    try renderWallpaper(Identity(workerId: "preview", name: args[3], color: args[4], textColor: args[5]), at: URL(fileURLWithPath: args[2]))
} else {
    let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/RS Worker Identity")
    let identity = try JSONDecoder().decode(Identity.self, from: Data(contentsOf: directory.appendingPathComponent("identity.json")))
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let delegate = IdentityApp(identity: identity, directory: directory)
    application.delegate = delegate
    application.run()
}
