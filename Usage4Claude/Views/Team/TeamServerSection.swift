//
//  TeamServerSection.swift
//  Usage4Claude
//
//  Team-Übersicht — Server-Anbindung Teil 3: die Oberfläche in den
//  Einstellungen. Zwei Zustände:
//
//    • Nicht verbunden: Team-ID und Token eintragen, „Verbinden". Die
//      Server-URL ist mit dem produktiven Relay vorbelegt und versteckt
//      sich hinter „Server ändern" — kaum jemand braucht sie je.
//    • Verbunden: Rollen-Abzeichen (Inhaber/Admin/Mitglied), Name,
//      Team-ID, „Trennen". Der Inhaber sieht darunter die Mitglieder-
//      verwaltung: anlegen (das frische Token erscheint genau einmal),
//      Einladung kopieren, entfernen.
//
//  Der Zustand selbst wohnt in `TeamServerConnection` — hier wird nur
//  eingegeben und angezeigt.
//  Copyright © 2025 f-is-h. All rights reserved.
//

import SwiftUI

// MARK: - Rolle anzeigen

extension TeamServerRole {
    /// Deutscher Anzeigename des Rollen-Abzeichens
    var displayName: String {
        switch self {
        case .superAdmin: return L.Team.roleSuper
        case .admin:      return L.Team.roleAdmin
        case .member:     return L.Team.roleMember
        }
    }

    /// Farbe des Abzeichens — ruhig, aber unterscheidbar
    var badgeColor: Color {
        switch self {
        case .superAdmin: return .orange
        case .admin:      return .blue
        case .member:     return .teal
        }
    }
}

/// Kleines Kapsel-Abzeichen für eine Rolle — Einstellungen und Mitgliederliste
/// nutzen dasselbe.
struct TeamRoleBadge: View {
    let role: TeamServerRole

    var body: some View {
        Text(role.displayName)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(role.badgeColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(role.badgeColor.opacity(0.15)))
    }
}

// MARK: - Server-Abschnitt

struct TeamServerSection: View {

    @ObservedObject private var connection = TeamServerConnection.shared

    @AppStorage(FleetSettings.workerIdKey) private var workerIdInput = ""

    @State private var teamIdInput = ""
    @State private var tokenInput = ""
    @State private var serverURLInput = TeamServerConnection.defaultServerURL.absoluteString
    @State private var isServerFieldExpanded = false
    /// Die beanstandete Adresse wird genau einmal ins Feld gelegt — sonst
    /// überschriebe ein zweites `onAppear` die halb fertige Korrektur.
    @State private var didPrefillRejectedURL = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L.Team.serverSection)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)

            // Eine gespeicherte http-Adresse wird nicht benutzt (siehe
            // `TeamServerConnection.isServerURLInsecure`). Dann zählt die
            // Verbindung hier als nicht hergestellt: Das Formular ist der Ort,
            // an dem die Adresse zu reparieren ist.
            if connection.isConnected && !connection.isServerURLInsecure {
                connectedRow
                VStack(alignment: .leading, spacing: 4) {
                    Text(L.Team.serverURLLabel).font(.caption).foregroundColor(.secondary)
                    Text(connection.serverURL.absoluteString)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                    Text(L.Team.serverTokenLabel).font(.caption).foregroundColor(.secondary)
                    Text(L.Fleet.tokenStored).font(.caption)
                }
                DisclosureGroup(L.Fleet.editConnection) { connectForm.padding(.top, 8) }
                fleetSettings

                if connection.role?.canManageMembers == true {
                    TeamMemberManagement()
                }
            } else {
                connectForm
            }

            if let error = connection.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(DashboardPalette.ink(100))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear {
            if connection.isConnected && !connection.isServerURLInsecure {
                serverURLInput = connection.serverURL.absoluteString
                teamIdInput = connection.teamId ?? ""
            }
            prefillRejectedURL()
        }
    }

    /// Reparaturzustand: Die gespeicherte Adresse liegt aufgeklappt im Feld,
    /// die Team-ID daneben — zu korrigieren ist meist nur das „http". Das
    /// Token wird bewusst nicht mitgefüllt: Es aus dem Schlüsselbund ins Feld
    /// zu holen, hieße ein Geheimnis ohne Not auf den Bildschirm zu legen.
    private func prefillRejectedURL() {
        guard connection.isServerURLInsecure, connection.isConnected,
              !didPrefillRejectedURL else { return }
        didPrefillRejectedURL = true
        serverURLInput = connection.serverURL.absoluteString
        teamIdInput = connection.teamId ?? ""
        isServerFieldExpanded = true
    }

    // MARK: - Nicht verbunden

    private var connectForm: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField(L.Team.idLabel, text: $teamIdInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(maxWidth: 110)

                SecureField(L.Team.serverTokenLabel, text: $tokenInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .onSubmit(connect)

                Button(L.Team.serverConnect, action: connect)
                    .disabled(!canConnect)

                if connection.isConnecting {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            // Die URL braucht fast niemand — deshalb eingeklappt statt als
            // drittes Feld in der Zeile.
            DisclosureGroup(isExpanded: $isServerFieldExpanded) {
                TextField(L.Team.serverURLLabel, text: $serverURLInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))
                    .padding(.top, 4)
            } label: {
                Text(L.Team.serverChange)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            // Nur im Reparaturzustand: Die gespeicherte Verbindung besteht
            // noch, wird aber nicht benutzt. Wer sie gar nicht mehr will,
            // kommt hier heraus, statt eine Adresse eintippen zu müssen.
            if connection.isConnected {
                Button(L.Team.serverDisconnect) {
                    connection.disconnect()
                    serverURLInput = TeamServerConnection.defaultServerURL.absoluteString
                    teamIdInput = ""
                    isServerFieldExpanded = false
                }
                .controlSize(.small)
            }
        }
    }

    /// Eine wohlgeformte https-URL — sonst bleibt „Verbinden" aus, statt
    /// hinterher einen Netzfehler zu melden. Klartext-http lässt
    /// `isSecureServerURL` nur zum eigenen Rechner durch; die Verbindung
    /// prüft dasselbe noch einmal selbst.
    private var normalizedURL: URL? {
        let trimmed = serverURLInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              TeamServerConnection.isSecureServerURL(url) else { return nil }
        return url
    }

    private var canConnect: Bool {
        TeamServerConnection.normalizeTeamId(teamIdInput) != nil
            && !tokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && normalizedURL != nil
            && !connection.isConnecting
    }

    private func connect() {
        guard canConnect, let url = normalizedURL else { return }
        connection.connect(serverURL: url, teamId: teamIdInput, token: tokenInput) { result in
            if case .success = result {
                teamIdInput = ""
                tokenInput = ""
                isServerFieldExpanded = false
                serverURLInput = connection.serverURL.absoluteString
            }
        }
    }

    // MARK: - Verbunden

    private var fleetSettings: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField(L.Fleet.workerId, text: $workerIdInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .onSubmit { FleetReporter.shared.report() }
                    .help(L.Fleet.workerIdHelp)
            }
            Text(L.Fleet.workerIdHelp)
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L.Fleet.heartbeatHelp)
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 6)
    }
    private var connectedRow: some View {
        HStack(spacing: 8) {
            if let role = connection.role {
                TeamRoleBadge(role: role)
            }

            if let name = connection.memberName, !name.isEmpty {
                Text(name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            if let teamId = connection.teamId {
                Text(teamId)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 8)

            Button(L.Team.serverDisconnect) {
                connection.disconnect()
            }
            .controlSize(.small)
        }
    }
}

// MARK: - Mitgliederverwaltung (nur Inhaber)

struct TeamMemberManagement: View {

    @ObservedObject private var connection = TeamServerConnection.shared

    @State private var members: [TeamServerMember] = []
    @State private var isLoading = false
    @State private var errorText: String?

    @State private var newName = ""
    @State private var newRole: TeamServerRole = .member
    @State private var isAdding = false

    /// Das gerade angelegte Mitglied — sein Token wird genau einmal gezeigt
    @State private var freshMember: TeamServerMember?

    @State private var memberToDelete: TeamServerMember?
    @State private var showDeleteConfirmation = false

    /// „Kopiert"-Hinweis, verschwindet nach zwei Sekunden von selbst
    @State private var showCopied = false
    @State private var copyToken = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(L.Team.membersTitle)
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(.secondary)

                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                }

                if showCopied {
                    Text(L.Team.copied)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .transition(.opacity)
                }

                Spacer(minLength: 0)
            }
            .animation(.easeInOut(duration: 0.2), value: showCopied)

            ForEach(members) { member in
                memberRow(member)
            }

            if let fresh = freshMember, let token = fresh.token {
                freshTokenPill(fresh, token: token)
            }

            addRow

            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundColor(DashboardPalette.ink(100))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 2)
        .onAppear(perform: reload)
        .alert(L.Team.membersDeleteConfirmTitle,
               isPresented: $showDeleteConfirmation,
               presenting: memberToDelete) { member in
            Button(L.Account.cancel, role: .cancel) {}
            Button(L.Team.membersRemove, role: .destructive) {
                delete(member)
            }
        } message: { member in
            Text(L.Team.membersDeleteConfirmMessage(member.name))
        }
    }

    // MARK: - Zeilen

    private func memberRow(_ member: TeamServerMember) -> some View {
        HStack(spacing: 8) {
            Text(member.name)
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.middle)

            TeamRoleBadge(role: member.role)

            if let created = member.createdAt {
                Text(DateFormatter.localizedString(from: created, dateStyle: .short, timeStyle: .none))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer(minLength: 8)

            // Einladung: Download-Link, Fundort des Feldes, Team-ID und das
            // Token dieser Person — fertig zum Verschicken.
            Button(action: { copyInvitation(token: member.token) }) {
                Image(systemName: "doc.on.clipboard")
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .disabled(member.token == nil)
            .help(L.Team.membersCopyInvite)

            Button(action: {
                memberToDelete = member
                showDeleteConfirmation = true
            }) {
                Image(systemName: "trash")
                    .foregroundColor(.red)
            }
            .buttonStyle(.plain)
            .help(L.Team.membersRemove)
        }
    }

    /// Das frische Token — Schreibmaschinenschrift zum Abgleichen, ein Knopf
    /// zum Kopieren, einer für die fertige Einladung, ein X zum Wegräumen.
    private func freshTokenPill(_ member: TeamServerMember, token: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L.Team.membersTokenHint(member.name))
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Text(token)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))

                Button(action: {
                    TeamClipboard.copyConcealed(token)
                    flashCopied()
                }) {
                    Image(systemName: "doc.on.doc")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help(L.Team.membersCopyToken)

                Button(L.Team.membersCopyInvite) {
                    copyInvitation(token: token)
                }
                .controlSize(.small)

                Spacer(minLength: 4)

                Button(action: { freshMember = nil }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }

    private var addRow: some View {
        HStack(spacing: 8) {
            TextField(L.Team.membersNamePlaceholder, text: $newName)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 140)
                .onSubmit(add)

            Picker("", selection: $newRole) {
                Text(TeamServerRole.member.displayName).tag(TeamServerRole.member)
                Text(TeamServerRole.admin.displayName).tag(TeamServerRole.admin)
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()

            Button(L.Team.membersAdd, action: add)
                .disabled(trimmedNewName.isEmpty || isAdding)

            if isAdding {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    // MARK: - Aktionen

    private var trimmedNewName: String {
        newName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func reload() {
        guard !isLoading else { return }
        isLoading = true
        connection.fetchMembers { result in
            isLoading = false
            switch result {
            case .success(let list):
                members = list
                errorText = nil
            case .failure(let error):
                errorText = error.errorDescription
            }
        }
    }

    private func add() {
        let name = trimmedNewName
        guard !name.isEmpty, !isAdding else { return }
        isAdding = true
        connection.addMember(name: name, role: newRole) { result in
            isAdding = false
            switch result {
            case .success(let member):
                newName = ""
                newRole = .member
                freshMember = member
                errorText = nil
                reload()
            case .failure(let error):
                errorText = error.errorDescription
            }
        }
    }

    private func delete(_ member: TeamServerMember) {
        connection.deleteMember(id: member.id) { result in
            switch result {
            case .success:
                if freshMember?.id == member.id { freshMember = nil }
                errorText = nil
                reload()
            case .failure(let error):
                errorText = error.errorDescription
            }
        }
    }

    /// Die Einladung trägt das Token mitten im Text — sie ist genauso geheim
    /// wie das Token allein und geht deshalb denselben Weg.
    private func copyInvitation(token: String?) {
        guard let token, let teamId = connection.teamId else { return }
        TeamClipboard.copyConcealed(L.Team.invitation(teamId: teamId, token: token))
        flashCopied()
    }

    /// Zeigt „Kopiert" und blendet es nach zwei Sekunden wieder aus. Der Token
    /// sorgt dafür, dass ein zweiter Klick den Hinweis verlängert.
    private func flashCopied() {
        copyToken += 1
        let token = copyToken
        showCopied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            if copyToken == token { showCopied = false }
        }
    }
}
