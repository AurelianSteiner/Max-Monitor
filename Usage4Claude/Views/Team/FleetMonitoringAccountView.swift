import SwiftUI

struct FleetMonitoringAccountView: View {
    @ObservedObject private var manager = FleetMonitoringManager.shared
    @State private var confirmsDisconnect = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(L.Fleet.monitoringIntro).font(.callout).foregroundColor(.secondary)
            if let worker = FleetSettings.workerId {
                Label(worker, systemImage: "desktopcomputer").font(.headline)
            }
            if let account = manager.account {
                VStack(alignment: .leading, spacing: 8) {
                    Text(account.name).font(.headline).textSelection(.enabled)
                    if !account.email.isEmpty && account.email != account.name {
                        Text(account.email).font(.callout).foregroundColor(.secondary)
                    }
                    if let usage = manager.usageData {
                        usageRow(L.Fleet.monitoringSession, value: usage.fiveHour?.percentage)
                        usageRow(L.Fleet.monitoringWeekly, value: usage.sevenDay?.percentage)
                    }
                    if let error = manager.errorMessage {
                        Text(error).font(.callout).foregroundColor(.orange)
                    } else if let date = manager.updatedAt {
                        Text(date, style: .relative).font(.caption).foregroundColor(.secondary)
                    }
                }
                HStack(spacing: 12) {
                    Button(L.Fleet.retry) { manager.refresh(force: true) }.disabled(manager.isRefreshing)
                    Button(L.Fleet.monitoringReconnect) { WebLoginWindowManager.shared.showMonitoringLoginWindow() }
                    Button(L.Fleet.monitoringDisconnect, role: .destructive) { confirmsDisconnect = true }
                    if manager.isRefreshing { ProgressView().controlSize(.small) }
                }
            } else {
                Label(L.Fleet.monitoringMissing, systemImage: "person.crop.circle.badge.plus")
                    .font(.headline)
                Button(L.Fleet.monitoringConnect) { WebLoginWindowManager.shared.showMonitoringLoginWindow() }
                    .keyboardShortcut(.defaultAction)
                if let error = manager.errorMessage { Text(error).foregroundColor(.orange) }
            }
            Spacer(minLength: 0)
        }
        .confirmationDialog(L.Fleet.monitoringDisconnectConfirm, isPresented: $confirmsDisconnect) {
            Button(L.Fleet.monitoringDisconnect, role: .destructive) { manager.disconnect() }
        }
        .onAppear { manager.refresh() }
    }

    private func usageRow(_ label: String, value: Double?) -> some View {
        HStack {
            Text(label).foregroundColor(.secondary)
            Spacer()
            Text(value.flatMap { $0.isFinite ? "\(Int(min(100, max(0, $0)).rounded())) %" : nil } ?? "—").monospacedDigit()
        }
        .font(.callout)
    }
}
