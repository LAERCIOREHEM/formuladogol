/*
 * R10R19 — Evita inferência redundante em fontes de pós-jogo já verificadas.
 * Somente cacheia o resultado de uma fonte que passou previamente pelo Match
 * Identity Gate. O chamador deve revalidar cada payload antes de aceitá-lo.
 * Cache negativo expira rapidamente; mudanças no texto/modelo invalidam ambos.
 */
export const EXTRACTION_CACHE_VERSION = 1;
export const EXTRACTION_CACHE_POSITIVE_MS = 6 * 60 * 60_000;
export const EXTRACTION_CACHE_NEGATIVE_MS = 20 * 60_000;
const PREFIX = 'source_extract_r10r19:';

export async function sourceExtractionDigest(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function sourceExtractionCacheDecision(record, fingerprint, model, now = Date.now()) {
  if (!record || record.version !== EXTRACTION_CACHE_VERSION ||
      record.fingerprint !== fingerprint || record.model !== model) return 'miss';
  const age = now - Number(record.at || 0);
  if (!Number.isFinite(age) || age < 0) return 'miss';
  if (record.status === 'positive' && age < EXTRACTION_CACHE_POSITIVE_MS && record.parsed && typeof record.parsed === 'object') return 'positive';
  if (record.status === 'negative' && age < EXTRACTION_CACHE_NEGATIVE_MS) return 'negative';
  return 'miss';
}

/*
 * Persistência best-effort: indisponibilidade do D1 nunca impede o fluxo
 * factual. O chamador fornece `validate` (incluindo fonte robusta, confiança e
 * integridade factual) e `extract` (a chamada real ao Workers AI).
 */
export async function extractSourceWithCache(env, task, source, { model, extract, validate, now = Date.now() }) {
  const run = async () => ({ ...(await extract()), cacheState: 'miss' });
  if (!env?.DB || !task?.event_id || !source?.url || !source?.text || !model ||
      typeof extract !== 'function' || typeof validate !== 'function') return run();

  let key, fingerprint;
  try {
    const urlDigest = await sourceExtractionDigest(source.url);
    fingerprint = await sourceExtractionDigest(model + '\n' + source.text);
    key = PREFIX + String(task.event_id) + ':' + urlDigest.slice(0, 24);
    const row = await env.DB.prepare('SELECT value FROM postgame_meta WHERE key=?').bind(key).first();
    const record = row?.value ? JSON.parse(row.value) : null;
    const decision = sourceExtractionCacheDecision(record, fingerprint, model, now);
    if (decision === 'positive' && validate(record.parsed)) {
      return { found: true, parsed: record.parsed, model, cacheState: 'hit_positive' };
    }
    if (decision === 'negative') {
      return { found: false, parsed: null, model, reason: 'workers_ai_negative_cache', cacheState: 'hit_negative' };
    }
  } catch (_) {
    // Falha do cache não inviabiliza extração nem altera a fonte factual.
  }

  const result = await run();
  const valid = Boolean(result?.parsed && validate(result.parsed));
  if (key && fingerprint && result?.reason !== 'workers_ai_unavailable') {
    const payload = JSON.stringify({
      version: EXTRACTION_CACHE_VERSION, fingerprint, model, at: now,
      status: valid ? 'positive' : 'negative', parsed: valid ? result.parsed : null
    });
    try {
      await env.DB.prepare(`INSERT INTO postgame_meta(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`)
        .bind(key, payload).run();
    } catch (_) {
      // O ledger de provedores permanece a fonte da verdade para tentativas.
    }
  }
  return result;
}
