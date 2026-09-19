//
//  DashboardWindowManager.swift
//  Usage4Claude
//
//  独立的多账户总览窗口。popover 会在应用失焦时自动关闭，想把总览一直摆在
//  桌面一角时用这个窗口：内容与 popover 完全一致，只是常驻、可移动。
//  Copyright © 2025 f-is-h. All rights reserved.
//

import AppKit
import SwiftUI

final class DashboardWindowManager {
    static let shared = DashboardWindowManager()

    /// 位置与大小记忆在系统 defaults 里的名字
    private static let frameAutosaveName = "Usage4Claude.DashboardWindow"
    /// Mindestgröße: genau eine Kartenspalte breit (schmaler wird die Karte
    /// beschnitten), hoch genug für Kopf + eine Karte. Das Gitter bricht bei
    /// dieser Breite von selbst auf eine Spalte um.
    private static var minimumSize: NSSize {
        NSSize(width: DashboardMetrics.width(columns: 1), height: 320)
    }

    private var window: NSWindow?
    private var closeObserver: NSObjectProtocol?

    private init() {}

    var isVisible: Bool {
        window?.isVisible == true
    }

    /// 显示总览窗口（已打开则前置）
    /// - Parameter onMenuAction: 窗口内菜单项的回调，与 popover 共用同一套动作
    func show(onMenuAction: @escaping (MenuAction) -> Void) {
        if let window, window.isVisible {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }

        // 菜单栏应用平时是 accessory（不进 Dock），要让普通窗口能获得焦点需要临时切成 regular
        NSApp.setActivationPolicy(.regular)

        let view = DashboardView(
            manager: DashboardRefreshManager.shared,
            onMenuAction: onMenuAction,
            isStandaloneWindow: true
        )

        let hostingController = NSHostingController(rootView: view)
        hostingController.sizingOptions = [.preferredContentSize]

        let window = NSWindow(contentViewController: hostingController)
        window.title = L.Dashboard.windowTitle
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.isReleasedWhenClosed = false

        // 内容的理想尺寸定下初始大小；之后关掉自动尺寸跟随，
        // 否则每次数据变化 hostingController 都会把窗口拉回理想尺寸，
        // 用户自己调过的大小就白调了。
        // 关掉之后没人再纠正尺寸了，所以先把理想尺寸落实到窗口上。
        // 注意用 preferredContentSize（= SwiftUI 的理想尺寸）而不是 fittingSize：
        // 独立窗口的根视图 maxWidth/maxHeight 是 .infinity，fittingSize 给的是
        // 最小尺寸，会把窗口开成一条缝。
        hostingController.view.layoutSubtreeIfNeeded()
        let idealSize = hostingController.preferredContentSize
        hostingController.sizingOptions = []
        if idealSize.width > 0, idealSize.height > 0 {
            window.setContentSize(NSSize(width: startWidth(idealSize.width), height: idealSize.height))
        }

        // Das Gitter im Fenster richtet sich nach der vorhandenen Breite: schmal
        // gezogen stapeln sich die Karten in einer Spalte, breit gezogen stehen
        // sie nebeneinander. Deshalb bleibt die Mindestbreite fest bei einer
        // Spalte — sie darf nicht mehr der Spaltenwahl folgen, sonst ließe sich
        // das Fenster nicht schmal ziehen. Und weil das Fenster nie mehr von
        // allein breiter wird, bleibt eine einmal gewählte Größe erhalten.
        window.minSize = Self.minimumSize

        // 先恢复上次的位置和大小，再挂上 autosave 名字——反过来会先把当前
        // 帧写回去，把记住的尺寸覆盖掉。
        if !window.setFrameUsingName(Self.frameAutosaveName) {
            window.center()
        }
        window.setFrameAutosaveName(Self.frameAutosaveName)
        self.window = window

        if let observer = closeObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { _ in
            Task { @MainActor in
                DashboardWindowManager.shared.window = nil
                // 回到 accessory：仅当没有别的可见窗口（例如设置窗口）还开着
                let hasOtherWindows = NSApp.windows.contains {
                    $0.isVisible && $0.canBecomeMain && $0 !== window
                }
                if !hasOtherWindows {
                    NSApp.setActivationPolicy(.accessory)
                }
            }
        }

        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Breite beim ersten Öffnen (ohne gemerkte Fenstergröße): Die Spaltenwahl
    /// aus den Einstellungen gibt die Startbreite vor.
    ///
    /// Die Idealbreite des Inhalts allein reicht nicht: wird das Fenster vor dem
    /// ersten Abruf geöffnet, gibt es noch keine Karten und sie wäre eine Spalte
    /// breit. Deshalb die Kontenzahl direkt aus den Einstellungen nehmen.
    private func startWidth(_ idealWidth: CGFloat) -> CGFloat {
        let wanted = contentWidth(forColumnSetting: UserSettings.shared.dashboardColumns)
        let screenWidth = NSScreen.main?.visibleFrame.width ?? wanted
        return max(Self.minimumSize.width, min(max(idealWidth, wanted), screenWidth))
    }

    /// Fensterbreite auf eine Spaltenzahl ziehen.
    ///
    /// Das Gitter im Fenster folgt der Fensterbreite, die Spaltenwahl im Menü ist
    /// hier also eine Breitenwahl. Ohne das wäre der Menüeintrag im Fenster ohne
    /// Wirkung — das Häkchen würde wandern, die Ansicht bliebe stehen.
    /// Die Höhe bleibt unangetastet, senkrecht scrollt das Gitter selbst.
    func resize(toColumns columns: Int) {
        guard let window, window.isVisible else { return }

        var frame = window.frame
        frame.size.width = contentWidth(forColumnSetting: columns)

        // Beim Verbreitern nicht über den Bildschirmrand hinauslaufen, sonst
        // steht die zusätzliche Spalte außerhalb des sichtbaren Bereichs.
        if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
            frame.origin.x = max(visible.minX, min(frame.origin.x, visible.maxX - frame.size.width))
        }
        window.setFrame(frame, display: true)
    }

    /// Nach dem Einschalten der Anbieter-Trennung: Das Fenster muss mindestens
    /// so breit sein, dass jede Bahn eine Karte trägt — sonst stünden die
    /// Bahnen übereinander geschoben da. Schmaler wird nie gezogen; wer das
    /// Fenster breiter hatte, behält seine Breite.
    func widen(toAtLeastColumns columns: Int) {
        guard let window, window.isVisible else { return }

        let screenWidth = (window.screen ?? NSScreen.main)?.visibleFrame.width
        let wanted = min(DashboardMetrics.width(columns: columns), screenWidth ?? .greatestFiniteMagnitude)
        guard window.frame.width < wanted else { return }

        var frame = window.frame
        frame.size.width = wanted
        if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
            frame.origin.x = max(visible.minX, min(frame.origin.x, visible.maxX - frame.size.width))
        }
        window.setFrame(frame, display: true)
    }

    /// Inhaltsbreite für eine Spaltenwahl: nie mehr Spalten als Konten, nie
    /// schmaler als eine Spalte, nie breiter als der sichtbare Bildschirm.
    private func contentWidth(forColumnSetting setting: Int) -> CGFloat {
        let settings = UserSettings.shared
        let accountCount = settings.accounts.count + settings.codexAccounts.count
        let wanted = DashboardMetrics.width(
            columns: DashboardMetrics.columnCount(for: accountCount, setting: setting)
        )
        let screenWidth = (window?.screen ?? NSScreen.main)?.visibleFrame.width ?? wanted
        return max(Self.minimumSize.width, min(wanted, screenWidth))
    }

    func close() {
        window?.close()
        window = nil
    }
}
