import AppKit
import SwiftUI
import WebKit

/// The fleet lives on the shared relay; the menu-bar window is only a viewer.
@MainActor
final class FleetWindowManager: NSObject, NSWindowDelegate {
    static let shared = FleetWindowManager()
    private var window: NSWindow?

    func show() {
        FleetReporter.shared.report()
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        NSApp.setActivationPolicy(.regular)
        let controller = NSHostingController(rootView: FleetDashboardView())
        let window = NSWindow(contentViewController: controller)
        window.title = L.Fleet.title
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 520)
        let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        window.setContentSize(NSSize(width: min(1240, screen.width - 48), height: min(820, screen.height - 72)))
        if !window.setFrameUsingName("MaxMonitor.FleetWindow") { window.center() }
        window.setFrameAutosaveName("MaxMonitor.FleetWindow")
        window.delegate = self
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = window else { return }
        window = nil
        if !NSApp.windows.contains(where: { $0 !== closing && $0.isVisible && $0.canBecomeMain }) {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

private struct FleetDashboardView: View {
    @ObservedObject private var connection = TeamServerConnection.shared
    @State private var generation = UUID()
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var showsSettings = false

    var body: some View {
        VStack(spacing: 0) {
            if let client = connection.client, connection.role != nil {
                HStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                        .foregroundColor(.accentColor)
                    Text(L.Fleet.title).font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if isLoading { ProgressView().controlSize(.small) }
                    Button(action: reload) { Image(systemName: "arrow.clockwise") }
                        .help(L.Fleet.retry)
                        .accessibilityLabel(L.Fleet.retry)
                    Button(L.Fleet.settings) { showsSettings = true }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                Divider()
                ZStack {
                    FleetWebView(client: client, isLoading: $isLoading, loadError: $loadError)
                        .id(generation)
                    if let loadError {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(L.Fleet.loadError).font(.headline)
                            Text(loadError).font(.callout).foregroundColor(.secondary)
                            HStack {
                                Button(L.Fleet.retry, action: reload)
                                Button(L.Fleet.settings) { showsSettings = true }
                            }
                        }
                        .padding(24)
                        .frame(maxWidth: 460, alignment: .leading)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            } else {
                connectionForm
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showsSettings) {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(L.Fleet.settings).font(.title3.weight(.semibold))
                    Spacer()
                    Button("OK") { showsSettings = false }
                }
                Text(L.Fleet.intro).font(.callout).foregroundColor(.secondary)
                ScrollView { TeamServerSection() }
            }
            .padding(24)
            .frame(width: 580, height: 480)
        }
        .onReceive(NotificationCenter.default.publisher(for: .teamServerChanged)) { _ in reload() }
    }

    private var connectionForm: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 32))
                    .foregroundColor(.accentColor)
                Text(L.Fleet.title).font(.system(size: 24, weight: .semibold))
                Text(L.Fleet.intro).font(.callout).foregroundColor(.secondary)
                TeamServerSection()
            }
            .padding(32)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func reload() {
        loadError = nil
        isLoading = true
        generation = UUID()
    }
}

private struct FleetWebView: NSViewRepresentable {
    let client: TeamServerClient
    @Binding var isLoading: Bool
    @Binding var loadError: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if let script = try? client.fleetBootstrapScript() {
            configuration.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.load(URLRequest(url: client.fleetDashboardURL))
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        nsView.stopLoading()
        nsView.navigationDelegate = nil
        nsView.configuration.userContentController.removeAllUserScripts()
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: FleetWebView
        init(_ parent: FleetWebView) { self.parent = parent }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            let target = parent.client.fleetDashboardURL
            func effectivePort(_ value: URL) -> Int? {
                value.port ?? (value.scheme?.lowercased() == "https" ? 443 : value.scheme?.lowercased() == "http" ? 80 : nil)
            }
            let sameOrigin = url.scheme?.lowercased() == target.scheme?.lowercased()
                && url.host?.lowercased() == target.host?.lowercased() && effectivePort(url) == effectivePort(target)
            if sameOrigin && (url.path == target.path || url.path == target.path + "/") {
                decisionHandler(.allow)
                return
            }
            // Only a deliberate ClickUp link opens outside the credential-bearing
            // WebView. Redirects, arbitrary external pages and popups are blocked.
            let host = url.host?.lowercased() ?? ""
            if action.navigationType == .linkActivated, url.scheme == "https",
               host == "clickup.com" || host.hasSuffix(".clickup.com") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoading = false
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            show(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            show(error)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
                parent.isLoading = false
                parent.loadError = "HTTP \(http.statusCode)"
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        private func show(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            parent.isLoading = false
            parent.loadError = error.localizedDescription
        }
    }
}
