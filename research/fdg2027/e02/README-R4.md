# FDG 2027 — E02-R4: Timeline Integrity, Statistical Coverage & Historical Data Certification

Status: prepared on isolated research branch; not merged, dispatched or certified. The R3 collection already launched by the owner (run 45726372657) is independent.

## Contract

- Explicit successful, completed main E02-R3 run ID; no implicit selection or restart. Validate artifact metadata, ZIP SHA-256, exact archive layout, GPG integrity, checkpoint schema and catalogue identity. Read the original checkpoint without writing to it; hash before/after. Separate encrypted audit artifact cannot be mistaken for an R3 checkpoint.
- No sporting API credentials, calls or Cloudflare operations. GitHub downloads/uploads are the only intended network operations; runner compute/artifact quotas still apply.
- R3 metrics recalculated on the exact same snapshot; R4 counts retained, gained and lost candidates. A lower count can be correct. No target-driven threshold relaxation.
- R4 clock is a regulation-minute proxy: preserve elapsed/extra ordering, no invented whistle times; exact box-minute agreement required. Goals at final regulation boundary flagged; added-time lineup changes, conflicting/unknown events, duplicates, ambiguous VAR, goal/lineup same-minute conflicts and missing active minutes quarantined. No claim of actual elapsed exposure, or exhaustive correction of supplier semantics. Goal events split segments; therefore R3 and R4 segment counts have different definitions.
- A: strict regulation-clock candidate + valid individual core; B: detailed match + valid core but timeline inconclusive; C: some validated player data, core/detail incomplete; D: player data missing or invalid under R3 checks. These are technical readiness classes, not statistical or licensing certification.
- Coverage denominators by season and position, present vs basic valid shape vs explicit numeric zero. Nulls remain null; pass accuracy semantics, changes across years, xG absence and cross-provider identity require further review. Club coverage and fixture IDs/segments remain encrypted. Provider ID name variations are not certified cross-provider matches.
- Aggregate report includes input hash, code commit, source run, R3/R4 counts and readiness flags. No trained RAPM, no production certification. E03 canonical dataset and semantic source validation remain separate.

## Commands — only after owner approves merging and the workflow exists on main

Run synthetic tests first:

    gh workflow run fdg2027-e02-r4-audit.yml --repo LAERCIOREHEM/formuladogol --ref main -f mode=self-test

After successful tests and R3 completion, explicitly select the certified source run (replace ID if a newer authorized R3 run is selected):

    gh workflow run fdg2027-e02-r4-audit.yml --repo LAERCIOREHEM/formuladogol --ref main -f mode=audit -f source_run_id=45726372657 -f authorize_private_audit=true

Inspect summary and aggregate artifact; do not decrypt outside approved environment. Original R3 artifact retention still applies; maintain an external encrypted backup.

## Handoff / execution record

- Base main SHA at preparation: 9e62d8ede2961ea8dd3018066ad7495f05096b14.
- 2026-11-25 BRT: owner dispatched R3 45726372657; status initially in_progress. R4 code prepared in research/fdg2027-e02-r4; no R4 dispatch, no main merge, no production deploy.
- R4 commits: b7ffd1bc75711259c3703e5d91cbf13ab18d2f79 (audit engine), 74cd4a09c71a825976e32dfe0e8683f41a5192be (manual workflow), 2282ad373f274f3dfdefa537c112f278f028973c (stricter identity and goal validation).
- Synthetic self-tests included; not executed at preparation. Before audit: execute compilation, all four self-tests, verify source run and archive; examine aggregate results and limitations before E03.
- Remaining: independent semantic validation of source fields and actual stoppage-time exposure, runtime verification of artifact download path, full historical audit, review of candidate selection bias, licensing, E01/E03.
