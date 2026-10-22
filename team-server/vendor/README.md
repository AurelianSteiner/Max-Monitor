`../quota-pacing.js` is an unchanged source snapshot from
`ai-newsletter-creation`, commit `pending` (filled in by the integrator after
the worker change is merged), file `src/quota-pacing.js`. SHA-256:
`d98242f50e66c3f1fd6df66428cce99acdfa81e2819248b265ea55c18f311d8f`.

The dashboard runs this exact module (`fleetMacs`, `analyseFleet`, `macKey`,
`slotRefusal`), the same one each worker uses to order Macs and gate its own
Claude accounts. It replaces the former `quota-scores.js` snapshot of
`src/quota-distribution.js`. Update this snapshot, its digest here and the
digest test in `test/distribution.test.js` together whenever the worker pacing
contract changes. Do not create a second scoring formula in the UI. With
`AI_NEWSLETTER_CREATION_DIR` (default `~/Documents/AI Newsletter Creation`)
pointing at a checkout that contains `src/quota-pacing.js`, the test also
asserts that both files are byte-identical; without one it is skipped.

The read-only preview covers Pre-Gen, correction, translation and upload. Sales
has a separate admission policy and is not represented by this preview. It uses
the same bounded Hub heartbeats (including each worker's optional
`quota_slots`), Max Monitor's per-worker quota row as fallback and the active
reservation register as worker intake, but does not simulate access for a
particular task, the worker's preference wait or how long a task has been
waiting (`waitedMs` is 0). A highlighted preference is not an assignment or a
promise of capacity.
