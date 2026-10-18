`../quota-scores.js` is an unchanged source snapshot from
`ai-newsletter-creation`, commit `2da287c17aba86ee0619a80870e89c166394d39b`,
`src/quota-distribution.js` (introduced in `5d99e87c`). SHA-256:
`9dadd5456f4491e39d7cb57fbbea96ff06956914be95f69a2b6219140a1c7509`.

The dashboard uses this exact function, also serialized into the Sales Hub by the
workers. Update this snapshot and its digest test whenever the worker scoring
contract changes. Do not create a second scoring formula in the UI.

The read-only preview covers Pre-Gen, correction, translation and upload. Sales
has a separate admission policy and is not represented by this preview. It uses
the same bounded Hub heartbeat and active reservation register as worker intake,
but does not simulate access for a particular task or a worker's preference-wait
timer. A highlighted preference is not an assignment or a promise of capacity.
