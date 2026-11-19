# CF-COST-SHIELD R1 — Runbook

## Objective and exact limits

Protect the **combined** Cloudflare account across Fórmula do Gol, ProbGoal,
ProbHoops and TUPAL. Usage-based spend is evaluated at US$ 2/hour,
US$ 5 per rolling 24 hours and US$ 10 per billing cycle. The account controller
also trips at 5,000,000,000 D1 rows read/day or 10,000,000 written/day if
Account Analytics Read is available. Limits are safety thresholds, not forecasts.

**This is NOT an exact USD cap on Cloudflare invoices.** The billing API is
eventually consistent; requests already running, D1 storage and other
Cloudflare products can accrue charges. Cloudflare's separate native
Workers/Durable Objects spending controls must be configured in the account
dashboard. The code cannot configure them on an account without credentials
and administrative permission.

## Topology

- Origin: `formula-do-gol-push` Worker, `CostShieldState` SQLite Durable Object.
- Read endpoint: `https://push.formuladogol.com.br/v1/cost-shield/status`.
- Durable Object class migration: `v3-cost-shield` (new class only; preserves
  prior DO state).
- Sampling cadence: every 5 minutes in the existing push Worker cron.
- Billing read: `CLOUDFLARE_BILLING_READ_TOKEN` and account identifier
  `AI_GATEWAY_ACCOUNT_ID`, already managed by the push deploy.
- Optional D1 analytics: `CLOUDFLARE_ANALYTICS_READ_TOKEN`.
- Consumers: independent Worker and DO entrypoints for all four projects.
- Clients cache the signed-origin HTTPS status per isolate for up to 15 s.
- Polling or central network failure: consumers fail closed (HTTP 503).
- Billing unavailable longer than 10 minutes (or first startup after 5
  minutes): controller latches permanently until authorized reset.
- If a limit is reached, it remains latched even at a billing-cycle rollover.

## Deployment order — MANDATORY

1. Merge the Fórmula do Gol controller PR and verify its Worker deploy + DO
   migration + secret injection succeeded. Check /v1/cost-shield/status has
   `version=1`, `halted=false`, and a recent `lastSuccessAt`.
2. If /status is missing, invalid or halted, **DO NOT MERGE client PRs**:
   all four clients intentionally deny dynamic paths when coordinator is absent.
3. Merge ProbGoal, ProbHoops and TUPAL client PRs and run their production
   deploy workflows; confirm live endpoint tests and cron statuses.
4. Verify all four clients return HTTP 503 for mocked HALTED state and operate
   when controller says ALLOW. Assert cache cannot mix countries for highlights.
5. In Cloudflare Dashboard > Billing > Spend Management configure native
   Workers and Durable Objects spending limits and budget alerts separately.
   They do not cap D1. Audit D1 Metrics for rows per database.

## Manual re-arm

Only permitted when the last billing sample is fresh and cycle usage is
below US$ 10. This endpoint requires the already configured `OPS_MCP_TOKEN`
as bearer token; it never logs or returns the token:

```bash
curl -X POST -H "Authorization: Bearer ${OPS_MCP_TOKEN}" \
  https://push.formuladogol.com.br/v1/cost-shield/reset
```

Never automatically re-arm after midnight or after deployment. For an actual
limit incident, first investigate expensive SQL using `wrangler d1 insights`.

## Explicit known boundaries

- GraphQL D1 metrics are aggregated by current UTC calendar day, not rolling
  24 hours; the billed-cost controller computes the 24-hour window from
  successive verified snapshots.
- At the beginning of a new billing cycle, spending within the first 24h is
  known from the cumulative cycle value, but hourly rate is only known after
  samples establish a baseline.
- A crash/disable of the central Worker prevents updates; clients fail closed.
- GitHub actions and other independent writers must have their own checkpoint.
- Non-Cloudflare VPS or third-party service costs are not included.
- A brand-new billable product not used by these Workers may remain outside
  application-level execution gates, even though billed totals are account-wide.
