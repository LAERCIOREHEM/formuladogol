# E01 — Multi-Season Foundation (shadow / offline)
Base audited: 3e4adc7229701b24f288a6011fbf1ac1720e5b4b. E02-R4 verified; E03 follows after CI and owner approval.

## Scope and protection
No change to live JS, Python collectors, JSON, D1, Supabase, Workers, notification delivery, deploy workflows or the AF 1.3 model. No sports API calls, credentials, migrations, production deploy or season switch. The 2026 legacy paths are read-only aliases in this contract; historical 2022–2025 and planned 2027 are research-only. The 2027 continental rules are explicitly unverified, never inherited from 2026. No public 2027 route is activated. This is an additive foundation for E03, not a claim of completed live migration.

## Contracts
- season-registry.json: single configuration source, explicit default 2026, both activation flags false; no empty-season fallback.
- foundation.py and foundation.mjs: strict seasons, legacy read path, external private path/key, provider-scoped identity, season-scoped fixture identity, cache/D1/DO/Supabase/notification/snapshot/workflow namespaces, competition + season envelope guards. JS is a Node shadow implementation, not yet a browser bundle.
- Club/player identifiers remain stable across seasons within a provider; provider IDs are not cross-provider canonical matches. E03 owns validated mappings and roster-season membership. Never map by name alone.
- Private files stay outside the git checkout, in an access-controlled external workspace; caller owns encryption and filesystem permissions. No raw data in git. Paths alone do not provide authorization or OS isolation; all writers must use guarded interfaces and verify envelope/permissions. No live storage adapters switched yet.
- 2026 rule state points to existing legacy handling; 2027 rule state unverified. Existing math/forecast history not recomputed.
- Shared vectors, Python filesystem and in-memory SQLite isolation tests; no live cloud tests. CI verifies legacy aliases exist and prints path-only inventory, not secrets or data.

## Initial inventory (verified at base)
| Area | Findings and migration action |
|---|---|
| js/br-config.js | temporada=2026; legacy relative data paths; retain until E10 activation |
| js/br-data-manifest.js / js/br-af-core-snapshot.js | fixed manifests, path-keyed caches; future per-season manifests and hash/cache keys |
| atualizar_espn.py | BRASILEIRAO_TEMPORADA env exists but output paths are fixed; do not run with 2027 until adapters migrated |
| scripts/gerar_probabilidades_jogos.py and continental scripts | model and year-sensitive assets; review via inventory before E07; preserve 2026 results |
| cloudflare/push-worker/src/readiness-guardian.js | event keys based on event ID/signature; do not alter live deduplication; use explicit season keys for new consumers |
| cloudflare/push-worker/migrations/0002_sports_monitor.sql | sports_events keyed by event_key; no season field in this migration; future additive, separately authorized migration |
| cloudflare/orchestrator-worker/src/orchestrator-state.js | shared state keys and ledgers; future season partition or separate DO; no live changes |
| supabase/brasileirao_apostas*.sql | inventory and RLS review before multi-season private features; do not modify existing data |
| .github/workflows/atualizar-brasileirao.yml | legacy output and calendar contract; no 2027 dispatch |
| .github/workflows/deploy*.yml | changes to live paths can trigger automatic deploy; research/e01 excluded from explicit publish allowlist |
| sw.js | no fetch interception; existing push state untouched |
 
inventory.py scans tracked implementation text with lexical markers and emits paths/counts. It is a review queue, not proof every match is a hardcode or all dynamic dependencies are found.

## Run
From repo root: python research/fdg2027/e01/test_foundation.py; node research/fdg2027/e01/test-foundation.mjs; python research/fdg2027/e01/inventory.py.
CI runs on scoped pushes and PRs. No secrets or external sporting sources. Rollback: revert this additive commit; live paths were never modified.

## Gates
E03 may use the private keys and identity/envelope contract after green CI, explicit owner authorization, verified encrypted source checkpoint, rights review and external encrypted storage. E10/E12 must separately migrate adapters and certify real URLs, manifests, storage and production isolation before activation. Existing live 2026 full regression/production smoke is not asserted by E01 tests. RAPM remains optional.
