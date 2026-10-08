# Team relay

The little server behind the Team view of [Max Monitor](../README.md). Every app in a
team posts its own usage percentages here; everyone in the team gets one card per person and
can see who still has headroom. That is the whole job.

`server.js` is a single file with **zero dependencies** — only Node builtins (`http`, `fs`,
`path`, `crypto`). Node 20 or newer, no build step. It runs on Railway, on any VPS, in a
container, or on your laptop.

You do not have to use the relay the app ships with. Host your own and point the app at it;
nothing else changes.

## What it stores

Everything lives as plain files under `DATA_DIR`, one directory per team:

```
$DATA_DIR/<TEAMID>/members.json               name, role, macWorker, member token, creation date
$DATA_DIR/<TEAMID>/reports/<who>.json         the latest report of one person
$DATA_DIR/<TEAMID>/history/<who>.ndjson       one line per accepted report
```

`<who>` is the member ID. Any identity with `macWorker: true` can report Macs and usage, independently of its access role.
One file per member: a new report replaces the previous one.

A report is percentages and timestamps:

```json
{
  "schema": 1,
  "teamId": "4P074HZ1",
  "person": "Til",
  "reportedAt": "2026-08-31T09:12:04Z",
  "receivedAt": "2026-08-31T09:12:05.318Z",
  "memberId": "til-9f2c",
  "limits": [
    { "label": "5 Stunden", "kind": "session", "percent": 41, "resetsAt": "2026-08-31T13:00:00Z" },
    { "label": "7 Tage",    "kind": "weekly",  "percent": 62, "resetsAt": "2026-09-03T00:00:00Z" }
  ]
}
```

History lines are the same numbers without the reset times, trimmed on every write to 30 days
and 3000 lines per person. Deleting a member permanently removes all their native and Hub Macs, usage reports,
usage history and machine events. Their token is revoked. Minimal device/worker ID deny
lists in `fleet.json` prevent stale queue syncs and automatic enrollment from restoring
the deleted Mac, including after a restart. Shared queue tasks and their task history remain.

**What never arrives here:** session keys, OAuth tokens, cookies, prompts, chat content,
project or file names. The app does not send them, and there is no endpoint that would take
them.

**What is personal, even so** — worth knowing before you host this for other people:

- `person` is a display name. The server replaces it with the stored member name.
  Admin, guest and owner access does not participate as a reporting Mac.
- `limit.label` can carry an account name. Someone reporting several Claude accounts gets one
  line per account, prefixed with that account's name — and for an OAuth account without a
  self-chosen alias, that name **is the login email address**. Setting an alias per account in
  the app replaces it.

## Deploy on Railway

1. **New service → Deploy from GitHub repo**, pointing at your fork of this repository.
2. **Settings → Root Directory: `team-server`.** Railway then sees `package.json`, builds a
   Node service and starts it with `npm start` (that is `node server.js`).
3. **Add a volume, mount path `/data`.** Without it the reports are gone on every redeploy.
4. **Variables:** set `TEAM_TOKENS` (see below). `DATA_DIR` already defaults to `/data`;
   `PORT` is injected by Railway, do not set it yourself.
5. **Networking → Generate Domain.** You get an `https://….up.railway.app` address — that is
   the server URL your team enters in the app.
6. Optional: point Railway's health check at `/health`. It is the one endpoint that needs no
   token and answers `{"ok":true}`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEAM_TOKENS` | — | `TEAMID:supertoken,TEAMID2:supertoken2` — one super token per team. Team IDs are upper-cased; a new team is simply a new entry. |
| `TEAM_TOKEN` | — | Shortcut: a single super token that is valid for **every** team ID — including IDs nobody has used yet. Convenient for a private one-team relay, wrong for a relay several teams share. |
| `DATA_DIR` | `/data` | Where the files go. Use a mounted volume. |
| `PORT` | `8080` | Railway (and most hosts) set this. |

**The server refuses to start when neither `TEAM_TOKENS` nor `TEAM_TOKEN` is set** — it logs
`Weder TEAM_TOKENS noch TEAM_TOKEN gesetzt — Start verweigert.` and exits with code 1. There is
no unauthenticated mode to fall into by accident.

There is no "create team" call. A team exists as soon as its ID appears in `TEAM_TOKENS`; its
directory is created the first time something is written. Team IDs are 4–16 characters, `A–Z`
and `0–9` only:

```bash
openssl rand -hex 4 | tr '[:lower:]' '[:upper:]'   # e.g. 4P074HZ1
```

## Security

**Generate the super token with a real random source. 24 bytes, hex:**

```bash
openssl rand -hex 24
```

The super token is the team's master key: it creates and deletes members, and it can read
every member token. Treat it like a password — one per team, never in the repo, never in a
chat message that outlives the setup.

**Roles.** Four of them, and the server decides which one you are purely from the bearer
token you present:

| Role | Where the token comes from | May do |
| --- | --- | --- |
| `super` | `TEAM_TOKENS` / `TEAM_TOKEN` | everything: create and remove members, read all reports, read all member tokens |
| `admin` | a `members.json` entry with `"role": "admin"` | read the team and member list (**without** tokens), synchronize the queue, complete tasks, permanently delete ordinary members and their Macs |
| `member` | a `members.json` entry | read all team reports, fleet, queue and history, complete tasks |
| `guest` | a `members.json` entry with `"role": "guest"` | read the complete fleet, queue, reports, history and member list (**without** tokens), complete tasks |

The owner changes an existing role with `PATCH /v1/teams/:id/members/:memberId`
and `{ "role": "member" | "admin" | "guest", "macWorker": true | false }`.
Either field can be omitted. The member ID, name, creation date and token stay unchanged.
Role changes preserve the MacWorker flag. Turning MacWorker off immediately rejects
new telemetry and hides stored device reports and liveness events. Stored telemetry
is retained so the choice is reversible. Legacy members without a flag default to on;
legacy admins and guests default to off. Automatic enrollment creates enabled members.

The owner appears as `team-owner` in the member list without an invitation token.
`PATCH /v1/teams/:id/members/team-owner` accepts only `macWorker`, saved in
`$DATA_DIR/<TEAMID>/owner.json`; owner reporting defaults to off. The owner cannot
be deleted or assigned another role through this endpoint. All enabled roles report
once per minute with app version 2.14 or later, while their app is running.

**Member tokens are generated by the server**, never chosen by a human:
`crypto.randomBytes(16)` — 128 bits of randomness, hex-encoded. A freshly created token is
shown in the app right after you create the member; later it is still reachable, because the
member list comes back with the tokens for a super token (and only for a super token). To
revoke one, remove the member — the token dies with the entry.

**A public URL is fine.** Every route except `GET /health` requires
`Authorization: Bearer <token>`, and a token that does not belong to the team in the path is
rejected with 401. Token comparison uses `crypto.timingSafeEqual`, so tokens cannot be guessed
from response times. Knowing the address buys an attacker nothing.

**There is no rate limiting.** No lockout, no attempt counter, no fail2ban — that is the
trade for a dependency-free single file. It is also exactly why the super token has to be
long and random: brute force is not slowed down by anything but the size of the search space.
A 24-byte random token is far out of reach; a memorable phrase is not. If you expect to be
targeted, put the service behind a proxy that does rate limiting.

**Keep it on HTTPS.** Railway terminates TLS for you. Anywhere else, put the service behind a
reverse proxy with a certificate — the app refuses plain `http` to anything but your own
machine (see below), and the token travels in the `Authorization` header on every request.

Other limits worth knowing: request bodies are capped at 64 KB, a team holds at most 200
members, and `?days=` on the history endpoint is clamped to 1–30 (default 7).

## Run it anywhere

No build step, no `npm install` — there is nothing to install.

```bash
cd team-server
export TOKEN=$(openssl rand -hex 24)
TEAM_TOKENS="DEMO1234:$TOKEN" DATA_DIR=./data PORT=8080 node server.js
```

In a second shell, with the same `TOKEN`:

```bash
curl http://localhost:8080/health                                    # {"ok":true}
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/v1/teams/DEMO1234/me
```

## Point the app at it

In Max Monitor: **Gear → Connection & worker → Connect to server**. Unfold *Change
server*, put your relay's address in the URL field, then enter the team ID and the token.

The URL must be `https`. The only exception is a relay on your own Mac — `http://localhost`,
`http://127.0.0.1` and `http://[::1]` are accepted so you can try a self-hosted server
locally. Any other `http` address is refused before a request is made, because the bearer
token would otherwise cross the network in the clear.

As the owner (super token) you then add members by name in the same panel. The new member's
token appears right below, and the copy button in each member's row puts a ready-made
invitation — download link, server address, team ID, token — on the clipboard. Both copies are marked as
concealed, so clipboard managers do not keep them in their history.

The main window also has a **Members** tab for owners, admins and guests, with
All / Member / Admin / Guest / Owner filters. Only the owner can create or change
identities or copy invitation tokens. Admins can permanently delete ordinary members
and their Macs from the Members tab or the Mac details in the overview, after confirmation.
Admins cannot delete guest or admin access. New manual invitations default to Guest;
automatic worker enrollment still creates Members with MacWorker enabled. The MacWorker
checkbox controls reporting independently of the role. Updated newsletter workers also check this
saved capability through the trusted Hub before reserving or starting any new newsletter/upload.
Disabling it releases unstarted reservations while already running work continues. The worker
service stays running and discovers re-enablement on its next poll (normally every minute).
Unknown/ambiguous bindings and permission-check failures block new work. Match the exact worker ID
in the app and worker configuration. Older manually connected Macs can supply their existing
random app UUID as `?deviceId=...`; a conflicting Worker ID/device binding is rejected.
Display names and queue observations are not identity bindings.
Deploy the relay and `scripts/check-worker-control.mjs` on the Hub and verify existing worker
bindings before distributing worker code. The existing native checkbox needs no app update.

## Endpoints

All of them except `/health` need `Authorization: Bearer <token>`.

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| `GET` | `/health` | anyone | `{"ok":true}` |
| `GET` | `/v1/teams/:id/me` | any role | role, name, member ID and macWorker of this token |
| `GET` | `/v1/teams/:id/workers/:workerId/control` | super | current admission `{schema:1, workerId, enabled, reason}`, without credentials; no-store |
| `POST` | `/v1/reports` | MacWorker | store a report, always as the authenticated member |
| `GET` | `/v1/teams/:id/reports` | any role | reports belonging to enabled MacWorkers |
| `GET` | `/v1/teams/:id/members` | super, admin, guest | member list — tokens included for super only |
| `POST` | `/v1/teams/:id/members` | super | create a member `{name, role?, macWorker?}`, returns its token |
| `DELETE` | `/v1/teams/:id/members/:memberId` | super, admin | permanently delete identity and Macs; admin may delete ordinary members only |
| `GET` | `/v1/teams/:id/members/:mid/history?days=7` | any role | usage history of enabled MacWorkers, up to 30 days |

## Worker fleet and workflow queue

`/fleet` serves the shared dashboard. Each authenticated team member can read the
fleet, queue and bounded event log; the existing report/history permissions above
remain unchanged. All app installations use the same URL and team ID, with one
member token per Mac. The owner/admin queue producer runs independently of those
Macs. See [fleet setup](../docs/fleet-monitoring.md).

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| `GET` | `/fleet` or `/monitor` | anyone | dashboard shell, no team data or credentials |
| `POST` | `/v1/teams/:id/heartbeat` | MacWorker | register/update this Mac's liveness, battery and per-account usage |
| `GET` | `/v1/teams/:id/fleet` | any role | complete team fleet, queue and event log |
| `GET` | `/v1/teams/:id/fleet/events` | any role | authenticated SSE change signals; clients reload the complete fleet |
| `POST` | `/v1/teams/:id/queue` | super, admin | complete queue/worker-source snapshot or source-only error |

The fleet is saved atomically in `$DATA_DIR/<TEAMID>/fleet.json`, including known
devices, queue snapshots and up to 300 recent events. Keep the existing persistent
volume when updating this service. Server receipt time determines Mac liveness:
online through 15 minutes, silent after 15, offline after 30. Usage freshness and
provider errors are tracked independently, including each individual account.
The device UUID belongs to its reporting identity; a duplicate Worker ID is rejected
to avoid merging two Macs. An enabled owner may resume an existing native device
with the same device UUID and worker ID when switching from its worker token.

Unlike legacy usage reports, this optional feature also stores device/worker names,
battery, app/worker versions, task titles, customer folder names, ClickUp/Figma URLs, tags and workflow states. It still
never receives Claude credentials, ClickUp credentials, prompts or briefings.
The read-only newsletter bridge keeps ClickUp/Slack access on the existing RS Hub.
Browser tokens stay in memory; the native app uses an ephemeral, origin-restricted
WebView. Queue snapshots have a separate 2 MB request budget (5,000 tasks maximum).
Source errors retain the last complete queue and its timestamp. Run `npm test`
for the fleet/auth/persistence integration checks.
