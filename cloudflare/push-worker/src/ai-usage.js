function text(value) { return String(value ?? '').trim(); }

export function countWebSearchCalls(response) {
  let n = 0;
  for (const item of response?.output || []) if (item?.type === 'web_search_call') n += 1;
  return n;
}

export async function recordAiUsage(env, row = {}) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(`INSERT INTO ai_usage_ledger
      (purpose,event_id,model,phase,web_search_calls,responded,ok,http_status,duration_ms,detail)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      text(row.purpose) || 'unknown', text(row.eventId), text(row.model), text(row.phase),
      Math.max(0, Number(row.webSearchCalls || 0)), row.responded ? 1 : 0, row.ok ? 1 : 0,
      Number.isFinite(Number(row.httpStatus)) ? Number(row.httpStatus) : null,
      Math.max(0, Math.round(Number(row.durationMs || 0))), text(row.detail).slice(0, 500)
    ).run();
  } catch (error) {
    console.error(`ai usage ledger failed: ${text(error?.message || error).slice(0, 240)}`);
  }
}

export async function aiUsageSummary(env, hours = 24) {
  const h = Math.min(168, Math.max(1, Number(hours || 24)));
  const cutoff = new Date(Date.now() - h * 3600_000).toISOString();
  const totals = await env.DB.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(web_search_calls),0) web_searches,
      COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) failures
      FROM ai_usage_ledger WHERE created_at>=?`).bind(cutoff).first();
  const byPurpose = await env.DB.prepare(`SELECT purpose, COUNT(*) calls, COALESCE(SUM(web_search_calls),0) web_searches
      FROM ai_usage_ledger WHERE created_at>=? GROUP BY purpose ORDER BY calls DESC`).bind(cutoff).all();
  const byEvent = await env.DB.prepare(`SELECT event_id, COUNT(*) calls, COALESCE(SUM(web_search_calls),0) web_searches
      FROM ai_usage_ledger WHERE created_at>=? AND event_id<>'' GROUP BY event_id ORDER BY web_searches DESC LIMIT 10`).bind(cutoff).all();
  return {
    hours: h,
    calls: Number(totals?.calls || 0), webSearches: Number(totals?.web_searches || 0), failures: Number(totals?.failures || 0),
    byPurpose: byPurpose?.results || [], byEvent: byEvent?.results || []
  };
}
