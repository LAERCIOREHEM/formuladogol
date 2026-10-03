function text(value) { return String(value ?? '').trim(); }
function n(value) { const x = Number(value); return Number.isFinite(x) ? x : 0; }
function roundUsd(value) { return Number(n(value).toFixed(6)); }

// Tabela de preços usada SOMENTE para estimativa conservadora do Hunter de
// público/renda. Valores de referência em 03/10/2026; podem ser sobrescritos por
// env vars sem redeploy. Para OpenAI usamos as tarifas documentadas de contexto
// longo (mais conservadoras que contexto curto). A cobrança final continua sendo a dos provedores.
const DEFAULT_PRICES = Object.freeze({
  geminiSearchPerCallUsd: 0.014, // Gemini 3.x Grounding after free allowance; conservador: não desconta franquia.
  gemini35FlashLiteInputPerMUsd: 0.30,
  gemini35FlashLiteOutputPerMUsd: 2.50,
  openaiWebSearchPerCallUsd: 0.01,
  openaiSolInputPerMUsd: 4.00,
  openaiSolOutputPerMUsd: 15.00,
  openaiTerraInputPerMUsd: 2.00,
  openaiTerraOutputPerMUsd: 9.00,
  openaiLunaInputPerMUsd: 0.20,
  openaiLunaOutputPerMUsd: 0.90,
});

function envPrice(env, key, fallback) {
  const v = Number(env?.[key]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function modelTokenRates(provider, model, env = {}) {
  const m = text(model).toLowerCase();
  if (provider === 'gemini') {
    // O Hunter usa Flash-Lite por padrão. Para modelos Gemini desconhecidos,
    // usa a mesma referência, sempre marcada como estimativa no relatório.
    return {
      input: envPrice(env, 'POSTGAME_GEMINI_INPUT_PER_M_USD', DEFAULT_PRICES.gemini35FlashLiteInputPerMUsd),
      output: envPrice(env, 'POSTGAME_GEMINI_OUTPUT_PER_M_USD', DEFAULT_PRICES.gemini35FlashLiteOutputPerMUsd),
    };
  }
  if (provider === 'openai') {
    if (m.includes('luna')) return {
      input: envPrice(env, 'POSTGAME_OPENAI_LUNA_INPUT_PER_M_USD', DEFAULT_PRICES.openaiLunaInputPerMUsd),
      output: envPrice(env, 'POSTGAME_OPENAI_LUNA_OUTPUT_PER_M_USD', DEFAULT_PRICES.openaiLunaOutputPerMUsd),
    };
    if (m.includes('terra')) return {
      input: envPrice(env, 'POSTGAME_OPENAI_TERRA_INPUT_PER_M_USD', DEFAULT_PRICES.openaiTerraInputPerMUsd),
      output: envPrice(env, 'POSTGAME_OPENAI_TERRA_OUTPUT_PER_M_USD', DEFAULT_PRICES.openaiTerraOutputPerMUsd),
    };
    return {
      input: envPrice(env, 'POSTGAME_OPENAI_SOL_INPUT_PER_M_USD', DEFAULT_PRICES.openaiSolInputPerMUsd),
      output: envPrice(env, 'POSTGAME_OPENAI_SOL_OUTPUT_PER_M_USD', DEFAULT_PRICES.openaiSolOutputPerMUsd),
    };
  }
  return { input: 0, output: 0 };
}

export function estimateProviderCost(row = {}, env = {}) {
  const provider = text(row.provider).toLowerCase();
  const searches = Math.max(0, n(row.searches ?? row.search_calls));
  const inputTokens = Math.max(0, n(row.inputTokens ?? row.input_tokens));
  const outputTokens = Math.max(0, n(row.outputTokens ?? row.output_tokens));
  const rates = modelTokenRates(provider, row.model, env);
  let searchUsd = 0;
  if (provider === 'gemini') searchUsd = searches * envPrice(env, 'POSTGAME_GEMINI_SEARCH_PER_CALL_USD', DEFAULT_PRICES.geminiSearchPerCallUsd);
  if (provider === 'openai') searchUsd = searches * envPrice(env, 'POSTGAME_OPENAI_SEARCH_PER_CALL_USD', DEFAULT_PRICES.openaiWebSearchPerCallUsd);
  const tokenUsd = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  // Workers AI é acompanhado por chamadas/tokens, mas seu preço depende do
  // modelo/neurons e entra no billing Cloudflare. Não inventamos USD aqui.
  const knownUsd = provider === 'gemini' || provider === 'openai' ? searchUsd + tokenUsd : 0;
  return { provider, searchUsd: roundUsd(searchUsd), tokenUsd: roundUsd(tokenUsd), knownUsd: roundUsd(knownUsd), costKnown: provider === 'gemini' || provider === 'openai' };
}

export function countWebSearchCalls(response) {
  let nCalls = 0;
  for (const item of response?.output || []) if (item?.type === 'web_search_call') nCalls += 1;
  return nCalls;
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
      FROM ai_usage_ledger WHERE datetime(created_at)>=datetime(?)`).bind(cutoff).first();
  const byPurpose = await env.DB.prepare(`SELECT purpose, COUNT(*) calls, COALESCE(SUM(web_search_calls),0) web_searches
      FROM ai_usage_ledger WHERE datetime(created_at)>=datetime(?) GROUP BY purpose ORDER BY calls DESC`).bind(cutoff).all();
  const byEvent = await env.DB.prepare(`SELECT event_id, COUNT(*) calls, COALESCE(SUM(web_search_calls),0) web_searches
      FROM ai_usage_ledger WHERE datetime(created_at)>=datetime(?) AND event_id<>'' GROUP BY event_id ORDER BY web_searches DESC LIMIT 10`).bind(cutoff).all();
  return {
    hours: h,
    calls: Number(totals?.calls || 0), webSearches: Number(totals?.web_searches || 0), failures: Number(totals?.failures || 0),
    byPurpose: byPurpose?.results || [], byEvent: byEvent?.results || []
  };
}

export async function recordProviderUsage(env, row = {}) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(`INSERT INTO ai_provider_ledger
      (provider,purpose,event_id,model,phase,search_calls,input_tokens,output_tokens,total_tokens,responded,ok,http_status,duration_ms,detail)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      text(row.provider) || 'unknown', text(row.purpose) || 'unknown', text(row.eventId), text(row.model), text(row.phase),
      Math.max(0, Number(row.searchCalls || 0)), Math.max(0, Number(row.inputTokens || 0)), Math.max(0, Number(row.outputTokens || 0)),
      Math.max(0, Number(row.totalTokens || 0)), row.responded ? 1 : 0, row.ok ? 1 : 0,
      Number.isFinite(Number(row.httpStatus)) ? Number(row.httpStatus) : null,
      Math.max(0, Math.round(Number(row.durationMs || 0))), text(row.detail).slice(0, 700)
    ).run();
  } catch (error) {
    console.error(`provider usage ledger failed: ${text(error?.message || error).slice(0, 240)}`);
  }
}

export async function providerUsageSummary(env, hours = 24) {
  const h = Math.min(744, Math.max(1, Number(hours || 24)));
  const cutoff = new Date(Date.now() - h * 3600_000).toISOString();
  try {
    const totals = await env.DB.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(search_calls),0) searches,
      COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(total_tokens),0) total_tokens, COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) failures
      FROM ai_provider_ledger WHERE datetime(created_at)>=datetime(?)`).bind(cutoff).first();
    const byProvider = await env.DB.prepare(`SELECT provider, COUNT(*) calls, COALESCE(SUM(search_calls),0) searches,
      COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(total_tokens),0) total_tokens, COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) failures
      FROM ai_provider_ledger WHERE datetime(created_at)>=datetime(?) GROUP BY provider ORDER BY calls DESC`).bind(cutoff).all();
    const byPurpose = await env.DB.prepare(`SELECT provider,purpose,COUNT(*) calls,COALESCE(SUM(search_calls),0) searches
      FROM ai_provider_ledger WHERE datetime(created_at)>=datetime(?) GROUP BY provider,purpose ORDER BY calls DESC`).bind(cutoff).all();
    const byEvent = await env.DB.prepare(`SELECT event_id,provider,COUNT(*) calls,COALESCE(SUM(search_calls),0) searches
      FROM ai_provider_ledger WHERE datetime(created_at)>=datetime(?) AND event_id<>'' GROUP BY event_id,provider ORDER BY searches DESC,calls DESC LIMIT 20`).bind(cutoff).all();
    return {hours:h,calls:Number(totals?.calls||0),searches:Number(totals?.searches||0),inputTokens:Number(totals?.input_tokens||0),outputTokens:Number(totals?.output_tokens||0),totalTokens:Number(totals?.total_tokens||0),failures:Number(totals?.failures||0),byProvider:byProvider?.results||[],byPurpose:byPurpose?.results||[],byEvent:byEvent?.results||[]};
  } catch (_) {
    return {hours:h,calls:0,searches:0,inputTokens:0,outputTokens:0,totalTokens:0,failures:0,byProvider:[],byPurpose:[],byEvent:[]};
  }
}

function monthStartUtc(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit' }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  // Brasília não observa DST em 2026. 00:00 BRT = 03:00 UTC.
  return `${get('year')}-${get('month')}-01T03:00:00.000Z`;
}

async function usageRows(env, cutoff, eventId = '') {
  const whereEvent = eventId ? ' AND event_id=?' : '';
  const stmt = env.DB.prepare(`SELECT provider,model,COUNT(*) calls,COALESCE(SUM(search_calls),0) searches,
      COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(total_tokens),0) total_tokens,COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) failures
      FROM ai_provider_ledger WHERE datetime(created_at)>=datetime(?) AND purpose IN ('postgame_public','postgame_extract')${whereEvent}
      GROUP BY provider,model ORDER BY provider,model`);
  const result = eventId ? await stmt.bind(cutoff, text(eventId)).all() : await stmt.bind(cutoff).all();
  return result?.results || [];
}

function summarizeCostRows(rows, env = {}) {
  let estimatedUsd = 0;
  let calls = 0, searches = 0, inputTokens = 0, outputTokens = 0, totalTokens = 0, failures = 0;
  const byProvider = [];
  for (const row of rows || []) {
    const est = estimateProviderCost(row, env);
    calls += n(row.calls); searches += n(row.searches); inputTokens += n(row.input_tokens); outputTokens += n(row.output_tokens); totalTokens += n(row.total_tokens); failures += n(row.failures);
    if (est.costKnown) estimatedUsd += est.knownUsd;
    byProvider.push({
      provider:text(row.provider), model:text(row.model), calls:n(row.calls), searches:n(row.searches), inputTokens:n(row.input_tokens), outputTokens:n(row.output_tokens), totalTokens:n(row.total_tokens), failures:n(row.failures),
      estimatedUsd:est.costKnown ? est.knownUsd : null,
    });
  }
  return { calls, searches, inputTokens, outputTokens, totalTokens, failures, estimatedUsd:roundUsd(estimatedUsd), byProvider };
}


async function eventUsageRows(env, cutoff) {
  const result = await env.DB.prepare(`SELECT event_id,provider,model,COUNT(*) calls,COALESCE(SUM(search_calls),0) searches,
      COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(total_tokens),0) total_tokens,COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) failures
      FROM ai_provider_ledger WHERE datetime(created_at)>=datetime(?) AND event_id<>'' AND purpose IN ('postgame_public','postgame_extract')
      GROUP BY event_id,provider,model ORDER BY event_id,provider,model`).bind(cutoff).all();
  return result?.results || [];
}

function summarizeEventRows(rows, env = {}) {
  const map = new Map();
  for (const row of rows || []) {
    const eventId = text(row.event_id);
    if (!eventId) continue;
    if (!map.has(eventId)) map.set(eventId, { eventId, calls:0, searches:0, inputTokens:0, outputTokens:0, totalTokens:0, failures:0, estimatedUsd:0, byProvider:[] });
    const target = map.get(eventId);
    const est = estimateProviderCost(row, env);
    target.calls += n(row.calls); target.searches += n(row.searches); target.inputTokens += n(row.input_tokens); target.outputTokens += n(row.output_tokens); target.totalTokens += n(row.total_tokens); target.failures += n(row.failures);
    if (est.costKnown) target.estimatedUsd += est.knownUsd;
    target.byProvider.push({ provider:text(row.provider), model:text(row.model), calls:n(row.calls), searches:n(row.searches), estimatedUsd:est.costKnown ? est.knownUsd : null });
  }
  return [...map.values()].map((row) => ({ ...row, estimatedUsd:roundUsd(row.estimatedUsd) })).sort((a,b) => b.estimatedUsd-a.estimatedUsd || b.searches-a.searches);
}

export async function postgamePublicCostSummary(env, now = Date.now(), eventId = '') {
  if (!env?.DB) return { estimatedUsd:0, monthEstimatedUsd:0, eventEstimatedUsd:0, byProvider:[], monthByProvider:[] };
  const last24Cutoff = new Date(now - 24 * 3600_000).toISOString();
  const monthCutoff = monthStartUtc(now);
  const [dayRows, monthRows, eventRows, monthEventRows] = await Promise.all([
    usageRows(env, last24Cutoff), usageRows(env, monthCutoff), eventId ? usageRows(env, monthCutoff, eventId) : Promise.resolve([]), eventUsageRows(env, monthCutoff),
  ]);
  const day = summarizeCostRows(dayRows, env);
  const month = summarizeCostRows(monthRows, env);
  const event = summarizeCostRows(eventRows, env);
  const events = summarizeEventRows(monthEventRows, env);
  return {
    pricingBasis:'conservative_list_price_2026-10-03',
    note:'Estimativa conservadora: não desconta franquias gratuitas de Google Search; Workers AI fica fora do USD estimado e aparece no billing Cloudflare.',
    last24h:day,
    month:{...month, cutoff:monthCutoff},
    events,
    event:eventId ? {...event,eventId:text(eventId)} : null,
  };
}
