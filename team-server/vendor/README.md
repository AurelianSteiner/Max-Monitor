`../quota-pacing.js` is an unchanged source snapshot from
`ai-newsletter-creation`, commit `8525b31d542aa3d8d157ee818f8e585ec552f2a3`, file `src/quota-pacing.js`. SHA-256:
`a464e869d09f61ba3f6c359f61f2de3aecfa3121421ccd6f65d5b9af2c116e86`.

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

Verified Anthropic account plus organization pseudonyms join shared quota scopes
across Macs. Gauges are selected once, never summed; identified physical owners
contribute their remaining costs once. Unknown bindings remain conservative local
hypotheses. Credential-specific errors do not disable healthy shared credentials.
The existing telemetry snapshot remains subject to freshness and simultaneous-
start uncertainty; this does not add an atomic quota reservation system.

The passive preview collector also validates this wire format in
`scripts/quota_routing.py`. Keep its typed optional identity/owner/status fields
and the actual Python-routing-to-distribution regression aligned with this file.
