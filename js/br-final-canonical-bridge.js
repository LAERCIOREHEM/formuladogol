/* Post-FINAL bridge: reads the latest canonical public GitHub snapshot when
 * GitHub Pages is behind. Does NOT mark ESPN in-play as FINAL or invent scores.
 * Network requests occur ONLY for recent real finals absent from published JSON.
 */
(function (global) {
  'use strict';
  const RAW_BASE = 'https://raw.githubusercontent.com/LAERCIOREHEM/formuladogol/main/';
  const MIN_INTERVAL_MS = 30000;
  let lastCheck = 0;
  let running = null;

  function team(row) {
    return String(row && typeof row === 'object' ? row.nome : row || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function identity(row) {
    return [team(row?.mandante), team(row?.visitante)].join('|');
  }
  function number(x) {
    return Number.isInteger(x) && x >= 0 ? x : null;
  }
  function confirmedRows(raw) {
    if (!raw || raw.fonte !== 'ESPN' || !Array.isArray(raw.resultados)) return null;
    const byId = new Map();
    for (const row of raw.resultados) {
      const id = String(row?.event_id || '');
      if (!id || row.estado !== 'post' || number(row.placar_mandante) === null ||
          number(row.placar_visitante) === null || !identity(row) || byId.has(id)) return null;
      byId.set(id, row);
    }
    if (Number(raw.total_resultados) !== byId.size) return null;
    return byId;
  }
  function missingFinals(liveMap, publishedRows, isFinal) {
    const published = new Set((publishedRows || []).map(r => String(r?.event_id || '')));
    const missing = [];
    for (const live of Object.values(liveMap || {})) {
      if (!isFinal(live) || !live) continue;
      const id = String(live.eventId || '');
      if (!id || published.has(id)) continue;
      const home = team(live.mandante), away = team(live.visitante);
      const hs = Number(live.placarMandante), as = Number(live.placarVisitante);
      if (!home || !away || !Number.isInteger(hs) || !Number.isInteger(as) ||
          hs < 0 || as < 0) continue;
      missing.push({ id, home, away, hs, as });
    }
    return missing;
  }
  function reconcile({ results, probabilities, table, waiting, currentCount }) {
    const rows = confirmedRows(results);
    if (!rows || !waiting.length || rows.size < currentCount ||
        !probabilities || probabilities.status !== 'ok' ||
        !Array.isArray(probabilities.clubes) || probabilities.clubes.length !== 20 ||
        Number(probabilities.base_corrente?.partidas_concluidas) !== rows.size ||
        Number(probabilities.base_corrente?.partidas_totais) !== 380 ||
        !table || table.fonte !== 'ESPN' || !Array.isArray(table.tabela) ||
        table.tabela.length !== 20) return null;
    // Match exact ESPN event identity + both team names + both score values.
    for (const w of waiting) {
      const row = rows.get(w.id);
      if (!row || team(row.mandante) !== w.home || team(row.visitante) !== w.away ||
          row.placar_mandante !== w.hs || row.placar_visitante !== w.as) return null;
    }
    const played = table.tabela.reduce((sum, club) => sum + Number(club.jogos || 0), 0);
    if (played !== rows.size * 2) return null;
    return { results, probabilities, table };
  }
  async function fetchRaw(name, fetcher, stamp) {
    const url = RAW_BASE + name + '?fdg_final=' + stamp;
    const response = await fetcher(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('Canonical GitHub ' + name + ' HTTP ' + response.status);
    return response.json();
  }
  async function check({ liveMap, publishedRows, currentCount, isFinal, fetcher, now }) {
    const waiting = missingFinals(liveMap, publishedRows, isFinal);
    if (!waiting.length) return null;
    const ms = Number(now || Date.now());
    if (running) return running;
    if (ms - lastCheck < MIN_INTERVAL_MS) return null;
    lastCheck = ms;
    running = (async () => {
      try {
        const stamp = String(Math.floor(ms / MIN_INTERVAL_MS));
        const [results, probabilities, table] = await Promise.all([
          fetchRaw('resultados.json', fetcher, stamp),
          fetchRaw('dados-br/probabilidades-brasileirao.json', fetcher, stamp),
          fetchRaw('tabela.json', fetcher, stamp),
        ]);
        return reconcile({ results, probabilities, table, waiting, currentCount });
      } catch (_) {
        return null; // CDN/GitHub unavailable: never damage published stable state.
      } finally {
        running = null;
      }
    })();
    return running;
  }
  global.BRFinalCanonicalBridge = { check, reconcile, missingFinals, confirmedRows };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.BRFinalCanonicalBridge;
  }
})(typeof window !== 'undefined' ? window : globalThis);
