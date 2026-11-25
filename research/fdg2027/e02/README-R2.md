# FDG 2027 — E02-R2: historical recovery and feasibility

## Research only
No production files, notifications, Cloudflare, schedules or AF 1.3 writes.
Use existing repository secrets API_FOOTBALL_KEY and STRIKER_API_KEY and a new independent high-entropy secret FDG_RESEARCH_ARCHIVE_KEY. Never reset that key while encrypted checkpoints are needed. Only aggregate reports and AES256-encrypted checkpoints are uploaded. The public repository must never contain raw provider records or unencrypted datasets. Keep a secure offline backup of the encryption key and encrypted checkpoint before artifact expiry (90 days).

## Sequence and budget
1. Verify the API-Football account status reports Free, 100 requests/day.
2. Discover final fixture catalogues for 2022–2024. Expect 380 per season, do not invent missing fixtures.
3. Collect fixtures with detailed players, lineups and events in groups of 20 when supported; use targeted single-fixture fallback. Validate identity, score, both teams and individual player rows.
4. After all 1,140 fixtures have received a first pass, probe StrikerAPI 2026 (Chapecoense–Palmeiras), 2024 overlap, 2025 and cross-check ESPN. A completed first pass is NOT necessarily complete validated coverage.
5. Report minute reconstruction, missing values, identity candidates, timeline consistency and candidate segments. RAPM training and production adoption are later executions.

Ideal historic budget: 3 season queries + 57 batches + 1 account-status check = 61 attempts, excluding retries and fallback. Per manual run: <=65 Football, <=25 Striker credits, <=8 ESPN requests; cumulative conservative research budget <=90 Football/day, <=400 Striker/month, plus provider quota checks. Includes 18 Football and 55 Striker attempted units previously recorded on 25 Nov 2026. User must verify free balance before dispatch; do not run parallel probes. No paid subscription is needed or authorized.

## Run
`gh workflow run fdg2027-e02-r2-historical.yml --repo LAERCIOREHEM/formuladogol --ref main -f authorize_free_probe=true -f football_limit=65 -f striker_limit=25`

The workflow automatically restores the most recent completed non-skipped prior checkpoint. A missing/expired checkpoint blocks collection rather than silently restarting paid/quota-consuming work. Inspect the prior run before recovery; retain encrypted checkpoints securely. Never re-run old commits for new data; dispatch main. If insufficient credits, reduce limits or wait for actual provider reset.

## Acceptance
- Offline tests pass before authenticated calls.
- Historical completeness requires 380 validated fixtures for each season. Partial, unavailable, or invalid rows remain visible.
- Regulation-clock minutes exclude stoppage time; unresolved dismissals and inconsistent intervals remain unknown; they are not zero.
- Candidate timelines require reconciled scoring, player-count and substitution checks; historical comparison uses provider-reported minutes. This is not a fitted or validated RAPM model.
- Name/club cross-matches are provisional, not a permanent cross-provider identity key.
- No historical provider xG is used for strict as-of training; prevent future leakage.
- 2025/2026 full recovery remains a separate quota-limited E03 activity; 2027 coverage and actual predictive gains remain unverified.
- Sources: https://www.api-football.com/news/post/how-to-get-all-data-from-a-league-with-api-football ; https://www.api-football.com/terms ; https://strikerapi.com/docs/get-game ; https://strikerapi.com/docs/timing-and-rights . StrikerAPI allows internal storage and model training, not bulk redistribution; API-Football does not grant third-party publication rights. Review applicable rights before any production use.
