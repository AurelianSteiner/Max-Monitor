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
$DATA_DIR/<TEAMID>/members.json               name, role, member token, creation date
$DATA_DIR/<TEAMID>/reports/<who>.json         the latest report of one person
$DATA_DIR/<TEAMID>/history/<who>.ndjson       one line per accepted report
```

`<who>` is the member ID for a member or admin token, and a slug of the reported name for the
super token. One file per person: a new report replaces the previous one.

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
and 3000 lines per person. Deleting a member deletes their report and their history with them.

**What never arrives here:** session keys, OAuth tokens, cookies, prompts, chat content,
project or file names. The app does not send them, and there is no endpoint that would take
them.

**What is personal, even so** — worth knowing before you host this for other people:

- `person` is a display name. For a member (or admin) token the server replaces whatever was
  sent with the name the team owner typed in. A **super** token has no member entry, so what
  the app sends stands: the full macOS user name (`NSFullUserName()`).
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

**Roles.** Three of them, and the server decides which one you are purely from the bearer
token you present:

| Role | Where the token comes from | May do |
| --- | --- | --- |
| `super` | `TEAM_TOKENS` / `TEAM_TOKEN` | everything: create and remove members, read all reports, read all member tokens |
| `admin` | a `members.json` entry with `"role": "admin"` | read all reports and the member list (**without** tokens) |
| `member` | a `members.json` entry | post its own report, read only its own report and history |

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

In Max Monitor: **Settings → Accounts → Team → Connect to server**. Unfold *Change
server*, put your relay's address in the URL field, then enter the team ID and the token.

The URL must be `https`. The only exception is a relay on your own Mac — `http://localhost`,
`http://127.0.0.1` and `http://[::1]` are accepted so you can try a self-hosted server
locally. Any other `http` address is refused before a request is made, because the bearer
token would otherwise cross the network in the clear.

As the owner (super token) you then add members by name in the same panel. The new member's
token appears right below, and the copy button in each member's row puts a ready-made
invitation — download link, team ID, token — on the clipboard. Both copies are marked as
concealed, so clipboard managers do not keep them in their history.

## Endpoints

All of them except `/health` need `Authorization: Bearer <token>`.

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| `GET` | `/health` | anyone | `{"ok":true}` |
| `GET` | `/v1/teams/:id/me` | any role | role, name and member ID of this token |
| `POST` | `/v1/reports` | any role | store a report (members always as themselves) |
| `GET` | `/v1/teams/:id/reports` | any role | super/admin: all reports, member: only its own |
| `GET` | `/v1/teams/:id/members` | super, admin | member list — tokens included for super only |
| `POST` | `/v1/teams/:id/members` | super | create a member `{name, role?}`, returns its token |
| `DELETE` | `/v1/teams/:id/members/:memberId` | super | remove a member, their report and their history |
| `GET` | `/v1/teams/:id/members/:mid/history?days=7` | super, admin, own member | usage history, up to 30 days |
