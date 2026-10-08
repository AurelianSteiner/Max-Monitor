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
        case .guest:      return L.Team.roleGuest
        }
    }

    /// Farbe des Abzeichens — ruhig, aber unterscheidbar
    var badgeColor: Color {
        switch self {
        case .superAdmin: return .orange
        case .admin:      return .blue
        case .member:     return .teal
        case .guest:      return .secondary
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
                if connection.reportsDevice {
                    fleetSettings
                } else if connection.role == .guest {
                    Text(L.Team.guestHint).font(.callout).foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

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
    @State private var selectedRole: TeamServerRole?
    @State private var updatingMemberId: String?
    @State private var newName = ""
    @State private var newRole: TeamServerRole = .guest
    @State private var newMacWorker = false
    @State private var isAdding = false
    @State private var freshMember: TeamServerMember?
    @State private var memberToDelete: TeamServerMember?
    @State private var showDeleteConfirmation = false
    @State private var showCopied = false
    @State private var copyToken = 0

    private var canManage: Bool { connection.role?.canManageMembers == true }
    private var filteredMembers: [TeamServerMember] {
        members.filter { selectedRole == nil || $0.role == selectedRole }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Text(L.Team.membersTitle).font(.headline)
                Text("\(members.count)").font(.callout).foregroundColor(.secondary)
                if isLoading { ProgressView().controlSize(.small) }
                if showCopied { Text(L.Team.copied).font(.caption).foregroundColor(.secondary) }
                Spacer()
                Button(action: reload) { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L.Fleet.retry)
                    .help(L.Fleet.retry)
                    .disabled(isLoading)
            }

            Text(L.Team.membersRolesHint)
                .font(.callout).foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Picker(L.Team.membersRoleFilter, selection: $selectedRole) {
                Text(L.Team.membersAll).tag(TeamServerRole?.none)
                Text(TeamServerRole.member.displayName).tag(TeamServerRole?.some(.member))
                Text(TeamServerRole.admin.displayName).tag(TeamServerRole?.some(.admin))
                Text(TeamServerRole.guest.displayName).tag(TeamServerRole?.some(.guest))
                Text(TeamServerRole.superAdmin.displayName).tag(TeamServerRole?.some(.superAdmin))
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            VStack(spacing: 4) {
                ForEach(filteredMembers) { member in memberRow(member) }
                if !isLoading && filteredMembers.isEmpty {
                    Text(L.Team.membersEmpty)
                        .font(.callout).foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                }
            }

            if canManage {
                Divider()
                if let fresh = freshMember, let token = fresh.token {
                    freshTokenPill(fresh, token: token)
                }
                addRow
                if newRole == .guest {
                    Text(L.Team.guestHint).font(.caption).foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let errorText {
                Text(errorText).font(.callout).foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear(perform: reload)
        .alert(L.Team.membersDeleteConfirmTitle,
               isPresented: $showDeleteConfirmation, presenting: memberToDelete) { member in
            Button(L.Account.cancel, role: .cancel) {}
            Button(L.Team.membersRemove, role: .destructive) { delete(member) }
        } message: { member in Text(L.Team.membersDeleteConfirmMessage(member.name)) }
    }

    private func memberRow(_ member: TeamServerMember) -> some View {
        HStack(spacing: 12) {
            Text(member.name)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1).truncationMode(.middle)
                .help(member.name)
                .frame(maxWidth: .infinity, alignment: .leading)

            if canManage && member.role != .superAdmin {
                Picker(L.Team.membersRole, selection: Binding(
                    get: { member.role },
                    set: { updateRole(member, to: $0) }
                )) {
                    Text(TeamServerRole.member.displayName).tag(TeamServerRole.member)
                    Text(TeamServerRole.admin.displayName).tag(TeamServerRole.admin)
                    Text(TeamServerRole.guest.displayName).tag(TeamServerRole.guest)
                }
                .labelsHidden()
                .frame(width: 100)
                .disabled(updatingMemberId != nil)
                .accessibilityLabel("\(L.Team.membersRole): \(member.name)")
            } else {
                TeamRoleBadge(role: member.role).frame(width: 100, alignment: .leading)
            }

            Toggle(L.Team.macWorker, isOn: Binding(
                get: { member.macWorker },
                set: { updateMacWorker(member, enabled: $0) }
            ))
            .toggleStyle(.checkbox)
            .font(.callout)
            .disabled(!canManage || updatingMemberId != nil)
            .accessibilityLabel("\(L.Team.macWorker): \(member.name)")
            .help(L.Team.macWorkerHint)

            if updatingMemberId == member.id { ProgressView().controlSize(.mini) }
            Text(member.createdAt.map {
                DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .none)
            } ?? "")
                .font(.caption).foregroundColor(.secondary)
                .frame(width: 68, alignment: .trailing)

            if canManage && member.role == .superAdmin {
                Color.clear.frame(width: 40, height: 16).accessibilityHidden(true)
            }
            if canManage && member.role != .superAdmin {
                Button(action: { copyInvitation(token: member.token) }) {
                    Image(systemName: "doc.on.clipboard")
                }
                .buttonStyle(.plain).disabled(member.token == nil)
                .help(L.Team.membersCopyInvite)
                .accessibilityLabel("\(L.Team.membersCopyInvite): \(member.name)")
            }
            if member.role != .superAdmin && (canManage || (connection.role?.canDeleteMacs == true && member.role == .member)) {
                Button(action: {
                    memberToDelete = member
                    showDeleteConfirmation = true
                }) { Image(systemName: "trash").foregroundColor(.red) }
                .buttonStyle(.plain)
                .help(L.Team.membersRemove)
                .accessibilityLabel("\(L.Team.membersRemove): \(member.name)")
            }
        }
        .frame(minHeight: 36)
    }

    private var addRow: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L.Team.membersNamePlaceholder).font(.caption).foregroundColor(.secondary)
                TextField(L.Team.membersNamePlaceholder, text: $newName)
                    .textFieldStyle(.roundedBorder).onSubmit(add)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(L.Team.membersRole).font(.caption).foregroundColor(.secondary)
                Picker(L.Team.membersRole, selection: $newRole) {
                    Text(TeamServerRole.member.displayName).tag(TeamServerRole.member)
                    Text(TeamServerRole.admin.displayName).tag(TeamServerRole.admin)
                    Text(TeamServerRole.guest.displayName).tag(TeamServerRole.guest)
                }.labelsHidden().frame(width: 100)
            }
            Toggle(L.Team.macWorker, isOn: $newMacWorker)
                .toggleStyle(.checkbox)
                .help(L.Team.macWorkerHint)
                .disabled(isAdding)
            Button(L.Team.membersAdd, action: add)
                .disabled(trimmedNewName.isEmpty || isAdding)
            if isAdding { ProgressView().controlSize(.small) }
        }
    }

    private func freshTokenPill(_ member: TeamServerMember, token: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L.Team.membersTokenHint(member.name))
                .font(.caption).foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text(token).font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                Button(action: {
                    TeamClipboard.copyConcealed(token)
                    flashCopied()
                }) { Image(systemName: "doc.on.doc") }
                    .buttonStyle(.plain).help(L.Team.membersCopyToken)
                    .accessibilityLabel(L.Team.membersCopyToken)
                Button(L.Team.membersCopyInvite) { copyInvitation(token: token) }
                    .controlSize(.small)
                Spacer(minLength: 4)
                Button(action: { freshMember = nil }) { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).accessibilityLabel(L.Fleet.done)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }

    private var trimmedNewName: String {
        newName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func reload() {
        guard !isLoading else { return }
        isLoading = true
        connection.fetchMembers { result in
            isLoading = false
            switch result {
            case .success(let list): members = list; errorText = nil
            case .failure(let error): errorText = error.errorDescription
            }
        }
    }

    private func updateRole(_ member: TeamServerMember, to role: TeamServerRole) {
        guard canManage, updatingMemberId == nil, member.role != role else { return }
        updatingMemberId = member.id
        connection.updateMember(id: member.id, role: role) { result in
            updatingMemberId = nil
            switch result {
            case .success:
                errorText = nil
                reload()
            case .failure(let error): errorText = error.errorDescription
            }
        }
    }

    private func updateMacWorker(_ member: TeamServerMember, enabled: Bool) {
        guard canManage, updatingMemberId == nil, member.macWorker != enabled else { return }
        updatingMemberId = member.id
        connection.updateMember(id: member.id, macWorker: enabled) { result in
            updatingMemberId = nil
            switch result {
            case .success(let updated):
                if let index = members.firstIndex(where: { $0.id == updated.id }) { members[index] = updated }
                errorText = nil
                connection.verifyIdentity()
            case .failure(let error): errorText = error.errorDescription
            }
        }
    }

    private func add() {
        let name = trimmedNewName
        guard canManage, !name.isEmpty, !isAdding else { return }
        isAdding = true
        connection.addMember(name: name, role: newRole, macWorker: newMacWorker) { result in
            isAdding = false
            switch result {
            case .success(let member):
                newName = ""
                freshMember = member
                errorText = nil
                selectedRole = nil
                reload()
            case .failure(let error): errorText = error.errorDescription
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
            case .failure(let error): errorText = error.errorDescription
            }
        }
    }

    private func copyInvitation(token: String?) {
        guard let token, let teamId = connection.teamId else { return }
        TeamClipboard.copyConcealed(L.Team.invitation(serverURL: connection.serverURL, teamId: teamId, token: token))
        flashCopied()
    }

    private func flashCopied() {
        copyToken += 1
        let token = copyToken
        showCopied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            if copyToken == token { showCopied = false }
        }
    }
}
