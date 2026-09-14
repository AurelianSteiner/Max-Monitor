//
//  AuthSettingsView.swift
//  Usage4Claude
//
//  Created by Claude Code on 2025-12-02.
//  Copyright © 2025 f-is-h. All rights reserved.
//
//  Kontoliste mit Alias-Feld und Löschen; der Ablauf „Konto manuell hinzufügen"
//  liegt in AuthSettingsView+AddAccount.swift, damit diese Datei kurz bleibt.
//  Die dafür geteilten @State dürfen deshalb nicht private sein (Extensions in
//  anderen Dateien kämen sonst nicht heran).

import SwiftUI

/// 认证设置页面
/// Eine Karte: alle Konten mit ihrem Alias, dazu die Knöpfe zum Hinzufügen.
struct AuthSettingsView: View {
    @ObservedObject var settings = UserSettings.shared
    @State var isAddingAccount = false
    @State var newSessionKey = ""
    @State var newAlias = ""
    @State var isValidating = false
    @State var validationError: String?
    @State var showDeleteConfirmation = false
    @State var accountToDelete: Account?
    @State var successMessage: String?
    @State var showDeleteCodexConfirmation = false
    @State var codexAccountToDelete: Account?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if isAddingAccount {
                    // 添加账户视图
                    addAccountView
                } else {
                    // 多组织添加成功提示
                    if let message = successMessage {
                        HStack(spacing: 8) {
                            Image(systemName: "info.circle.fill")
                                .foregroundColor(.blue)
                            Text(message)
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Spacer()
                            Button(action: { successMessage = nil }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(12)
                        .background(Color.blue.opacity(0.08))
                        .cornerRadius(8)
                    }

                    // 账户列表视图
                    accountListView

                    // Team-Übersicht: eigene Karte unter der Kontoliste. Sie
                    // gehört hierher, weil sie dieselbe Frage betrifft — wessen
                    // Auslastung diese App anzeigt —, nur eben für die Kollegen.
                    TeamSettingsCard()
                }
            }
            .padding()
        }
        .alert(L.Account.deleteConfirmTitle, isPresented: $showDeleteConfirmation) {
            Button(L.Account.cancel, role: .cancel) {}
            Button(L.Account.delete, role: .destructive) {
                if let account = accountToDelete {
                    settings.removeAccount(account)
                }
            }
        } message: {
            Text(L.Account.deleteConfirmMessage)
        }
        .alert(L.Account.deleteConfirmTitle, isPresented: $showDeleteCodexConfirmation) {
            Button(L.Account.cancel, role: .cancel) {}
            Button(L.Account.delete, role: .destructive) {
                if let account = codexAccountToDelete {
                    settings.removeCodexAccount(account)
                }
            }
        } message: {
            Text(L.Account.deleteConfirmMessage)
        }
    }

    // MARK: - Account List View

    var accountListView: some View {
        let hasCodex = !settings.codexAccounts.isEmpty
        let hasBothProviders = !settings.accounts.isEmpty && hasCodex

        return SettingCard(
            icon: "person.2.fill",
            iconColor: .blue,
            title: L.Account.listTitle,
            hint: settings.accounts.isEmpty && !hasCodex
                ? ""
                : "\(L.Account.aliasHint) \(L.Account.kindHint) \(L.Account.cancellationHint)"
        ) {
            VStack(alignment: .leading, spacing: 12) {
                if settings.accounts.isEmpty && !hasCodex {
                    // 无账户时的提示
                    VStack(spacing: 12) {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .font(.system(size: 40))
                            .foregroundColor(.secondary)
                        Text(L.Account.noAccounts)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                } else {
                    // Claude 账户组
                    if !settings.accounts.isEmpty {
                        if hasBothProviders {
                            providerSectionHeader(provider: .claude, label: L.Account.claudeAccounts)
                        }
                        ForEach(settings.accounts) { account in
                            accountRow(account: account, provider: .claude)
                        }
                    }

                    // Codex 账户组
                    if hasCodex {
                        if hasBothProviders {
                            providerSectionHeader(provider: .codex, label: L.Account.codexAccounts)
                                .padding(.top, 4)
                        }
                        ForEach(settings.codexAccounts) { account in
                            accountRow(account: account, provider: .codex)
                        }
                    }
                }

                // 添加账户入口
                addAccountActionsView
            }
        }
    }

    var addAccountActionsView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L.Account.addAccount)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)

            // Der Normalweg: ein Browser-Login je Anbieter. Cookie- und
            // Handeingabe sind Notnägel für den Fall, dass OAuth klemmt —
            // als drei gleichrangige Knöpfe haben sie mehr verwirrt als
            // geholfen, deshalb stehen sie eingeklappt darunter.
            HStack(spacing: 10) {
                addAccountActionButton(
                    provider: .claude,
                    title: L.WebLogin.browserLogin,
                    help: "\(ProviderType.claude.displayName) \(L.WebLogin.browserLogin)"
                ) {
                    WebLoginWindowManager.shared.showLoginWindow()
                }

                addAccountActionButton(
                    provider: .codex,
                    title: L.WebLogin.browserLogin,
                    help: "\(ProviderType.codex.displayName) \(L.WebLogin.browserLogin)"
                ) {
                    WebLoginWindowManager.shared.showCodexLoginWindow()
                }
            }

            DisclosureGroup(L.SettingsAuth.moreLoginPaths) {
                HStack(spacing: 10) {
                    addAccountActionButton(
                        provider: .claude,
                        title: L.WebLogin.cookieLogin,
                        help: L.WebLogin.cookieLoginHelp
                    ) {
                        WebLoginWindowManager.shared.showCookieLoginWindow()
                    }

                    addAccountActionButton(
                        provider: .claude,
                        title: L.WebLogin.manualInput,
                        help: L.SettingsAuth.manualInputClaudeOnlyHelp
                    ) {
                        withAnimation {
                            isAddingAccount = true
                            newSessionKey = ""
                            newAlias = ""
                            validationError = nil
                        }
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, 6)
            }
            .font(.caption)
            .foregroundColor(.secondary)
        }
        .padding(.top, 8)
    }

    func addAccountActionButton(
        provider: ProviderType,
        title: String,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                providerIcon(provider: provider, size: 16)

                Text(title)
                    .font(.subheadline)
            }
        }
        .buttonStyle(.bordered)
        .help(help)
        .accessibilityLabel(help)
    }

    @ViewBuilder
    func providerIcon(provider: ProviderType, size: CGFloat) -> some View {
        switch provider {
        case .claude:
            if let icon = ImageHelper.createAppIcon(size: size) {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: size, height: size)
            } else {
                Image(systemName: "sparkles")
                    .frame(width: size, height: size)
            }
        case .codex:
            if let icon = ImageHelper.createCodexIcon(size: size) {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: size, height: size)
            } else {
                Image(systemName: "sparkles")
                    .frame(width: size, height: size)
            }
        }
    }

    func providerSectionHeader(provider: ProviderType, label: String) -> some View {
        HStack(spacing: 4) {
            if provider == .codex, let icon = ImageHelper.createCodexIcon(size: 12) {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 12, height: 12)
            } else if provider == .claude, let icon = ImageHelper.createAppIcon(size: 12) {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 12, height: 12)
            }
            Text(label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
            Divider()
                .frame(height: 10)
        }
    }

    // MARK: - Account Row

    /// Eine Zeile je Konto: Alias direkt bearbeitbar, darunter der echte
    /// Organisationsname, rechts das Löschen. Die frühere Auswahl „aktuelles
    /// Konto" ist entfallen — die Übersicht zeigt ohnehin alle Konten.
    func accountRow(account: Account, provider: ProviderType) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "tag")
                    .font(.caption)
                    .foregroundColor(.orange)

                TextField(account.organizationName, text: aliasBinding(for: account, provider: provider))
                    .textFieldStyle(.roundedBorder)
                    .help(L.Account.aliasHint)
                    .accessibilityLabel(L.Account.alias)

                if let alias = account.alias, !alias.isEmpty {
                    Button(action: { updateAlias(nil, for: account, provider: provider) }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help(L.Account.clearAlias)
                }

                if provider == .claude {
                    kindPicker(for: account)
                }

                Button(action: {
                    if provider == .codex {
                        codexAccountToDelete = account
                        showDeleteCodexConfirmation = true
                    } else {
                        accountToDelete = account
                        showDeleteConfirmation = true
                    }
                }) {
                    Image(systemName: "trash")
                        .foregroundColor(.red)
                }
                .buttonStyle(.plain)
                .help(L.Account.deleteAccount)
            }

            HStack(spacing: 8) {
                Text(account.organizationName)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 8)

                cancellationControls(for: account, provider: provider)
            }
            .padding(.leading, 22)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Gekündigt bis

    /// Häkchen „Gekündigt" und daneben der Tag, bis zu dem das Abo noch läuft.
    /// Reine Handeingabe — keine Schnittstelle liefert das Datum. Die Karte in
    /// der Übersicht zeigt es als Plakette („endet 9. Okt."). Das Häkchen setzt
    /// beim Anhaken einen Vorschlag (in 30 Tagen), der sich sofort ändern lässt;
    /// abhaken löscht das Datum wieder.
    private func cancellationControls(for account: Account, provider: ProviderType) -> some View {
        HStack(spacing: 6) {
            Toggle(isOn: cancelledBinding(for: account, provider: provider)) {
                Text(L.Account.cancellationLabel)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .toggleStyle(.checkbox)
            .controlSize(.small)
            .help(L.Account.cancellationHint)

            if let end = account.subscriptionEndsAt {
                DatePicker(
                    L.Account.cancellationLabel,
                    selection: endDateBinding(for: account, provider: provider, current: end),
                    displayedComponents: .date
                )
                .labelsHidden()
                .datePickerStyle(.field)
                .controlSize(.small)
                .frame(width: 92)
                .help(L.Account.cancellationHint)

                Button(action: { updateCancellation(nil, for: account, provider: provider) }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help(L.Account.cancellationClear)
            }
        }
        .fixedSize()
    }

    private func cancelledBinding(for account: Account, provider: ProviderType) -> Binding<Bool> {
        Binding(
            get: { account.subscriptionEndsAt != nil },
            set: { isOn in
                let proposal = Calendar.current.startOfDay(
                    for: Calendar.current.date(byAdding: .day, value: 30, to: Date()) ?? Date()
                )
                updateCancellation(isOn ? (account.subscriptionEndsAt ?? proposal) : nil, for: account, provider: provider)
            }
        )
    }

    private func endDateBinding(for account: Account, provider: ProviderType, current: Date) -> Binding<Date> {
        Binding(
            get: { current },
            set: { updateCancellation(Calendar.current.startOfDay(for: $0), for: account, provider: provider) }
        )
    }

    private func updateCancellation(_ date: Date?, for account: Account, provider: ProviderType) {
        if provider == .codex {
            settings.updateCodexAccount(account, subscriptionEndsAt: date)
        } else {
            settings.updateAccount(account, subscriptionEndsAt: date)
        }
    }

    // MARK: - Art (Firma / Privat)

    /// Firma oder privat, direkt in der Zeile. Der Login rät die Art beim
    /// Anmelden; hier steht dann sein Ergebnis und lässt sich überschreiben.
    /// Dieselben Symbole wie auf der Karte, damit die Zuordnung sichtbar ist.
    /// Nur für Claude-Konten: Codex kennt die Unterscheidung bisher nicht.
    private func kindPicker(for account: Account) -> some View {
        Picker(L.Account.kindLabel, selection: kindBinding(for: account)) {
            ForEach(AccountKind.allCases, id: \.self) { kind in
                kindOption(kind).tag(kind)
            }
        }
        .pickerStyle(.menu)
        .fixedSize()
        .help(L.Account.kindHint)
    }

    @ViewBuilder
    private func kindOption(_ kind: AccountKind) -> some View {
        if let symbol = kind.symbolName {
            Label(kind.localizedName, systemImage: symbol)
        } else {
            Text(kind.localizedName)
        }
    }

    private func kindBinding(for account: Account) -> Binding<AccountKind> {
        Binding(
            get: { account.kind },
            set: { settings.updateAccount(account, kind: $0) }
        )
    }

    // MARK: - Alias

    private func aliasBinding(for account: Account, provider: ProviderType) -> Binding<String> {
        Binding(
            get: { account.alias ?? "" },
            set: { newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespaces)
                updateAlias(trimmed.isEmpty ? nil : newValue, for: account, provider: provider)
            }
        )
    }

    private func updateAlias(_ alias: String?, for account: Account, provider: ProviderType) {
        if provider == .codex {
            settings.updateCodexAccount(account, alias: alias)
        } else {
            settings.updateAccount(account, alias: alias)
        }
    }
}
