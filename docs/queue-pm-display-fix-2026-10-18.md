# Queue status and PM navigation repair · 18 October 2026

## Cause and change

The status audit repeatedly reported `stale_terminal_details` for
`sales:1791753755.856959`. The saved manual completion was valid, but
`reconcileTask` returned manual completions before clearing the previous blocker
details. The terminal projection now sets completed/100%, retains the manual
completion and its date, and clears the displayed step, blocker and error link.
The underlying source record and the audit rules remain intact.

The deployed navigation still called the PM tab “Klärung nötig”. Open questions
from older source rows used `queued` with the exact phase
`Wartet · PM-Rückfrage` and therefore appeared in Wartet. Navigation, pipeline,
badges and filters now consistently project these rows into “PM Rückfragen”.
Answered questions awaiting continuation keep their waiting status. Live language
packages retain their existing projection. CSS and execution ownership are unchanged.

## Live rollout

Only these existing runtime files were replaced, with original-hash guards and
automatic restoration on installation failure:

- `/opt/max-monitor/scripts/task-state.cjs`
- `/opt/max-monitor/team-server/public/dashboard.html`
- `/opt/max-monitor/team-server/public/dashboard.js`

The relay and dedicated queue bridge were restarted. The installed native app's
dashboard window was reopened to load the new assets. Original files are retained
in `/var/backups/max-monitor/20261018-queue-pm-display-verified`.

The primary checkout already contained unrelated edits and predates several live
features. The runtime patch was applied to fresh live copies; the equivalent
source change is isolated on `codex/queue-pm-display-fix` from `origin/main`.
Unrelated live features and primary-checkout work were preserved.

## Verification

- Status audit at **19:32:55 Europe/Berlin**: 679 tasks, `ok: true`, no findings.
- Following source cycle at **19:33:27**: source fresh, no source error.
- The Sales task remains manually completed at its original
  `2026-10-18T17:18:00.023Z`, with 100% and no displayed blocker/error link.
- Actual native app: PM tab selected beside Blockiert, **8 tasks**, no queue warning.
- Browser review of the patched runtime at 1440×900, 1024×768 and 390×844:
  navigation, PM list and detail dialog; regression coverage includes waiting
  continuations, active language packages, stale PM phases and filtered empty states.
- Server suite: 125 tests passed. Status reconciliation, bridge/Sales and related
  queue/completion/clarification tests passed; new backend regressions failed before
  the fix. The focused runtime regression suite also passed all 10 tests.

The first health probe ran before the relay had bound its socket and restored the
originals automatically. The successful rollout used bounded connection-refused
retries; both services and public asset hashes were then verified.
