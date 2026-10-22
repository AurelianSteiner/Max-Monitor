#!/bin/bash
# Separate processes and differently signed builds, using synthetic credentials.
set -euo pipefail
monitor_root=$(cd "$(dirname "$0")/.." && pwd)
monitor_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/max-monitor-persistence.XXXXXX")
trap 'rm -rf "$monitor_test_dir"' EXIT
cat > "$monitor_test_dir/Probe.swift" <<'SWIFT'
import Foundation

@main struct Probe {
    enum Failure: Error { case unexpectedKeychain, verification }
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let phase = CommandLine.arguments[2]
        let vault = try PersistentCredentialVault(directory: directory) { name in
            guard phase == "setup" else { throw Failure.unexpectedKeychain }
            return name == "accounts" ? "synthetic-original-token" :
                name == "teamServerToken" ? "synthetic-team-token" : nil
        }
        switch phase {
        case "setup":
            guard vault.load(key: "accounts") == "synthetic-original-token" else { throw Failure.verification }
        case "restart":
            guard vault.load(key: "accounts") == "synthetic-original-token",
                  vault.load(key: "accounts_codex") == nil,
                  vault.save(key: "accounts", value: "synthetic-rotated-token"),
                  vault.delete(key: "teamServerToken"), vault.delete(key: "missing") else { throw Failure.verification }
        case "update":
            guard vault.load(key: "accounts") == "synthetic-rotated-token",
                  vault.load(key: "teamServerToken") == nil else { throw Failure.verification }
        default: throw Failure.verification
        }
        #if UPDATED_BUILD
        print("Different build: persisted and deleted credentials verified; zero Keychain reads.")
        #else
        print("\(phase): persistence verified.")
        #endif
    }
}
SWIFT
xcrun swiftc -swift-version 5 -O "$monitor_root/Usage4Claude/Services/CredentialVault.swift" \
  "$monitor_test_dir/Probe.swift" -o "$monitor_test_dir/build-one"
xcrun swiftc -swift-version 5 -O -D UPDATED_BUILD "$monitor_root/Usage4Claude/Services/CredentialVault.swift" \
  "$monitor_test_dir/Probe.swift" -o "$monitor_test_dir/build-two"
codesign --force --sign - "$monitor_test_dir/build-one" >/dev/null 2>&1
codesign --force --sign - "$monitor_test_dir/build-two" >/dev/null 2>&1
cmp -s "$monitor_test_dir/build-one" "$monitor_test_dir/build-two" && exit 1
"$monitor_test_dir/build-one" "$monitor_test_dir/credentials" setup
"$monitor_test_dir/build-one" "$monitor_test_dir/credentials" restart
"$monitor_test_dir/build-two" "$monitor_test_dir/credentials" update
