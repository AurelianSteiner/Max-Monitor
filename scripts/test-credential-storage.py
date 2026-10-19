#!/usr/bin/env python3
"""Exercise actual release storage without accessing real keychain/app data."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = (root / "Usage4Claude/Services/KeychainManager.swift").read_text()
start = source.index("    private static func vaultFileURL(")
end = source.index("    // MARK: - Altbestand übernehmen", start)
source = source[:start] + "    private static func vaultFileURL(service: String) -> URL? { isolatedFixtureVaultURL }\n\n" + source[end:]
production_diagnostics = 'let directory = FileManager.default.homeDirectoryForCurrentUser\n            .appendingPathComponent("Library/Application Support/Max Monitor/Worker Setup", isDirectory: true)'
assert source.count(production_diagnostics) == 1, "Diagnostic isolation must be updated before running tests"
source = source.replace(production_diagnostics, 'let directory = isolatedFixtureVaultURL!.deletingLastPathComponent().appendingPathComponent("diagnostics", isDirectory: true)')
harness = (root / "scripts/credential-storage-fixture.swift").read_text()
with tempfile.TemporaryDirectory(prefix="credential-storage-test-") as temporary:
    directory = Path(temporary)
    fixture = directory / "fixture.swift"
    fixture.write_text(source + "\n" + harness)
    binary = directory / "storage-test"
    sources = ["Usage4Claude/Services/CredentialVault.swift", "Usage4Claude/Helpers/LoggerExtension.swift",
               "Usage4Claude/Models/ProviderType.swift", "Usage4Claude/Models/Account.swift",
               "Usage4Claude/Models/FleetMonitoringAccount.swift"]
    subprocess.run(["swiftc", "-parse-as-library", "-swift-version", "5", *sources,
                    str(fixture), "-o", str(binary)], cwd=root, check=True)
    subprocess.run([str(binary)], cwd=directory, check=True)
