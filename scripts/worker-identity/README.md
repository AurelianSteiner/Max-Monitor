# Worker colors

`team-server/worker-identities.json` is the shared source for the eight dedicated
workers. Names are display aliases; `worker_id`, device UUID, member ID, account
binding, task ownership, SSH names/keys/ports and production launch agents stay
unchanged. Till's daily Mac (`macbook-von-till-main-2`, original macOS name
`MacBook Air von Till`) is a personal alias only. Neither Till Mac receives the
companion, wallpaper or an OS rename.

The companion is a static AppKit menu item. It applies a generated solid PNG at
login and on Space/display changes, with no timers, network access or access to
accounts or the worker process. It lives in the worker user's Applications
folder and starts via `de.ruegamer-steiner.worker-identity`. The original name
and desktop images are recorded in `~/Library/Application Support/RS Worker Identity`.

Build with a matching SDK, for example:

```sh
xcrun swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk -O -target arm64-apple-macos13.0 scripts/worker-identity/WorkerIdentity.swift -o RSWorkerIdentity
```

`install.py` accepts a JSON payload with the compiled binary, generated wallpaper,
identity and a read-only preflight snapshot. Deploy only through the existing
Max Monitor authenticated remote path, checking the exact worker first. The
installer verifies the explicit worker ID and hashes of production config and
launch agent. It verifies that the worker PID remains unchanged. Changing the
cosmetic macOS ComputerName may require local admin authentication; do not expand
sudo permissions or alter network hostnames to work around it.
For a pending ComputerName, the color menu offers “macOS-Namen auf … setzen”.
It opens a local Terminal command only after a human clicks the menu item. The
human supplies macOS administrator authentication there; no password is collected
or stored by the companion.

To remove, unload only the identity launch agent, restore saved desktop images
and ComputerName, then remove the companion app/launch agent. Do not touch the
production worker or Max Monitor launch agents.
