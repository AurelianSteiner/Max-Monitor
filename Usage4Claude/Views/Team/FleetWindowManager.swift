import AppKit
import SwiftUI
import WebKit

/// The fleet lives on the shared relay; the menu-bar window is only a viewer.
@MainActor
final class FleetWindowManager: NSObject, NSWindowDelegate {
    static let shared = FleetWindowManager()
    private var window: NSWindow?
    private var onMenuAction: ((MenuAction) -> Void)?

    func show(onMenuAction: ((MenuAction) -> Void)? = nil) {
        if let onMenuAction { self.onMenuAction = onMenuAction }
        FleetReporter.shared.report()
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
            return
        }
        NSApp.setActivationPolicy(.regular)
        let controller = NSHostingController(rootView: FleetDashboardView(onMenuAction: { [weak self] action in
            self?.onMenuAction?(action)
        }))
        let window = NSWindow(contentViewController: controller)
        window.title = "Max Monitor"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        // The overview is designed light only; keep its native chrome matching the web content.
        window.appearance = NSAppearance(named: .aqua)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 520)
        let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        window.setContentSize(NSSize(width: min(1120, screen.width - 48), height: min(760, screen.height - 72)))
        if !window.setFrameUsingName("MaxMonitor.OverviewWindow") { window.center() }
        window.setFrameAutosaveName("MaxMonitor.OverviewWindow")
        window.delegate = self
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() { window?.close() }

    func windowWillClose(_ notification: Notification) {
        guard let closing = window else { return }
        window = nil
        if !NSApp.windows.contains(where: { $0 !== closing && $0.isVisible && $0.canBecomeMain }) {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

private struct FleetDashboardView: View {
    let onMenuAction: (MenuAction) -> Void
    @ObservedObject private var connection = TeamServerConnection.shared
    @ObservedObject private var sleepGuard = SleepGuard.shared
    @ObservedObject private var localization = LocalizationManager.shared
    @State private var generation = UUID()
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var selectedTab: MonitorTab = .queue
    private enum MonitorTab { case queue, accounts, members }
    private var showsAccountLimits: Bool { selectedTab == .accounts }
    @State private var activeSheet: MonitorSheet?

    private enum MonitorSheet: String, Identifiable {
        case connection, accounts, monitoring
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            ZStack {
                fleetContent
                    .opacity(selectedTab == .queue ? 1 : 0)
                    .allowsHitTesting(selectedTab == .queue)
                    .accessibilityHidden(selectedTab != .queue)
                if selectedTab == .members {
                    ScrollView {
                        TeamMemberManagement()
                            .id(generation)
                            .padding(32)
                            .frame(maxWidth: 760, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .background(Color(NSColor.windowBackgroundColor))
                } else if showsAccountLimits {
                    DashboardView(
                        manager: DashboardRefreshManager.shared,
                        onMenuAction: handleAccountAction,
                        isStandaloneWindow: true
                    )
                    .background(Color(NSColor.windowBackgroundColor))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(item: $activeSheet) { sheet in
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(sheet == .accounts ? L.Fleet.manageAccounts : sheet == .monitoring ? L.Fleet.monitoringAccount : L.Fleet.settings)
                        .font(.title3.weight(.semibold))
                    Spacer()
                    Button(L.Fleet.done) { activeSheet = nil }
                        .keyboardShortcut(.cancelAction)
                }
                if sheet == .accounts {
                    AuthSettingsView()
                } else if sheet == .monitoring {
                    FleetMonitoringAccountView()
                } else {
                    Text(L.Fleet.intro).font(.callout).foregroundColor(.secondary)
                    ScrollView { TeamServerSection() }
                }
            }
            .padding(24)
            .frame(width: 580, height: sheet == .monitoring ? 400 : 520)
        }
        .onReceive(NotificationCenter.default.publisher(for: .teamServerChanged)) { _ in reload() }
        .onAppear { sleepGuard.adoptSystemStateIfNeeded() }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Picker(L.Fleet.navigation, selection: $selectedTab) {
                Text(L.Fleet.queueAndMacs).tag(MonitorTab.queue)
                Text(L.Fleet.accountLimits).tag(MonitorTab.accounts)
                if connection.role?.canViewMembers == true {
                    Text(L.Team.membersTitle).tag(MonitorTab.members)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: connection.role?.canViewMembers == true ? 400 : 300)
            Spacer(minLength: 8)
            if showsAccountLimits {
                Button(L.Fleet.manageAccounts) { activeSheet = .accounts }
            } else if selectedTab == .queue && connection.role?.reportsDevice == true {
                Button(L.Fleet.monitoringAccount) { activeSheet = .monitoring }
            }
            Button(action: { sleepGuard.toggleAwake() }) {
                Label(L.Dashboard.sleepLabel, systemImage: sleepGuard.isAwake ? "bolt.fill" : "bolt")
                    .foregroundColor(sleepGuard.isAwake ? .accentColor : .secondary)
            }
            .help(L.Dashboard.sleepHelp)
            .accessibilityValue(sleepGuard.isAwake ? L.Fleet.enabled : L.Fleet.disabled)
            if showsAccountLimits {
                Button(action: refresh) { Image(systemName: "arrow.clockwise") }
                    .help(L.Fleet.retry)
                    .accessibilityLabel(L.Fleet.retry)
            }
            Menu {
                if connection.role?.reportsDevice == true {
                    Button(L.Fleet.monitoringAccount) { activeSheet = .monitoring }
                }
                Button(L.Fleet.settings) { activeSheet = .connection }
                Button(L.Fleet.manageAccounts) {
                    selectedTab = .accounts
                    activeSheet = .accounts
                }
                Divider()
                Button(L.Menu.generalSettings) { onMenuAction(.generalSettings) }
                Button(L.Menu.checkUpdates) { onMenuAction(.checkForUpdates) }
                Divider()
                Button(L.Menu.quit) { onMenuAction(.quit) }
            } label: { Image(systemName: "gearshape") }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel(L.Menu.generalSettings)
        }
        .controlSize(.small)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder private var fleetContent: some View {
        if let client = connection.client, connection.role != nil {
            ZStack {
                FleetWebView(client: client, isLoading: $isLoading, loadError: $loadError)
                    .id(generation)
                if let loadError {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(L.Fleet.loadError).font(.headline)
                        Text(loadError).font(.callout).foregroundColor(.secondary)
                        HStack {
                            Button(L.Fleet.retry, action: reload)
                            Button(L.Fleet.settings) { activeSheet = .connection }
                        }
                    }
                    .padding(24)
                    .frame(maxWidth: 460, alignment: .leading)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        } else {
            connectionForm
        }
    }

    private var connectionForm: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(L.Fleet.queueAndMacs).font(.system(size: 24, weight: .semibold))
                Text(L.Fleet.intro).font(.callout).foregroundColor(.secondary)
                TeamServerSection()
            }
            .padding(32)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func handleAccountAction(_ action: MenuAction) {
        if action == .authSettings { activeSheet = .accounts }
        else { onMenuAction(action) }
    }

    private func refresh() {
        if showsAccountLimits { DashboardRefreshManager.shared.refresh(force: true) }
        else { reload() }
    }

    private func reload() {
        if selectedTab == .members && connection.role?.canViewMembers != true {
            selectedTab = .queue
        }
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
