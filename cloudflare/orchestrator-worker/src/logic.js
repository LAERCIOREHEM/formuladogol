const BRT = 'America/Sao_Paulo';

export const POLICY = Object.freeze({
  sports: {
    beforeMinutes: 45,
    afterMinutes: 240,
    fallbackFinalMinutes: 115,
    finalRetryMinutes: 15,
    dailyAfter: '05:10',
    dailyRetryMinutes: 360,
  },
  slowEvalMinutes: 5,
  publicos: {
    firstAfterFinalMinutes: 15,
    retryBands: [
      [2, 30], [6, 60], [24, 120], [72, 360], [168, 720], [99999, 1440],
    ],
  },
  melhoresMomentos: {
    firstAfterFinalMinutes: 20,
    retryBands: [
      [0.75, 25], [1.5, 45], [3, 90], [6, 180], [12, 360], [24, 720], [99999, 1440],
    ],
  },
  transmissoes: {
    liveCheckpointsMinutes: [-90, -45, -20, -5, 10, 30],
    tvAfter: '06:30',
    tvCriticalHours: 6,
    tvMissing14dHours: 24,
    tvMissing30dHours: 72,
    tvHealthy30dHours: 168,
  },
  editorial: {
    roundMinimumGames: 8,
    roundWaitHours: 8,
    postponedDistanceHours: 72,
    retryMinutes: 30,
  },
});

export function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function minutesBetween(earlier, later) {
  const a = parseDate(earlier);
  const b = parseDate(later);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.max(0, (b.getTime() - a.getTime()) / 60000);
}

export function hoursBetween(earlier, later) {
  return minutesBetween(earlier, later) / 60;
}

export function brParts(date) {
  const d = parseDate(date) || new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRT,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const out = {};
  for (const item of parts) if (item.type !== 'literal') out[item.type] = item.value;
  return out;
}

export function brDateKey(date) {
  const p = brParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function timeReached(date, hhmm) {
  const p = brParts(date);
  const [hh, mm] = String(hhmm || '00:00').split(':').map(Number);
  return Number(p.hour) * 60 + Number(p.minute) >= hh * 60 + mm;
}

export function espnDay(date) {
  const p = brParts(date);
  return `${p.year}${p.month}${p.day}`;
}

export function teamName(value) {
  if (value && typeof value === 'object') return String(value.nome || value.name || value.displayName || '').trim();
  return String(value || '').trim();
}

export function normalizeAgenda(payload) {
  const rows = Array.isArray(payload?.jogos) ? payload.jogos : [];
  return rows.map((row) => ({
    eventId: String(row?.event_id || row?.id || '').trim(),
    competition: String(row?.competicao_chave || '').trim(),
    league: String(row?.espn_league || '').trim(),
    kickoff: parseDate(row?.data_iso),
    round: Number(row?.rodada || 0),
    concluded: row?.concluido === true || String(row?.estado || '').toLowerCase() === 'post',
    home: teamName(row?.mandante),
    away: teamName(row?.visitante),
  })).filter((g) => g.eventId && g.league && g.kickoff);
}

export function relevantSportsGames(games, now, beforeMinutes = POLICY.sports.beforeMinutes, afterMinutes = POLICY.sports.afterMinutes) {
  const t = parseDate(now)?.getTime() ?? Date.now();
  return games.filter((g) => {
    const k = g.kickoff.getTime();
    return t >= k - beforeMinutes * 60000 && t <= k + afterMinutes * 60000;
  });
}

export function localFinalIds(results, cup, lib, sula) {
  const out = new Set();
  for (const row of results?.resultados || []) {
    const id = String(row?.event_id || row?.id || '').trim();
    if (id) out.add(id);
  }
  for (const snap of [cup, lib, sula]) {
    for (const row of snap?.eventos || []) {
      if (!row?.concluido) continue;
      const id = String(row?.event_id || '').trim();
      if (id) out.add(id);
    }
  }
  return out;
}

export function firstPendingFinal(games, espnStates, finalIds) {
  for (const game of games) {
    const state = espnStates.get(game.eventId);
    if (state?.state === 'post' && !finalIds.has(game.eventId)) return game;
  }
  return null;
}

export function resultFinalTime(row) {
  const exact = parseDate(row?.finalizado_em);
  if (exact) return exact;
  const kickoff = parseDate(row?.data_iso);
  return kickoff ? new Date(kickoff.getTime() + 115 * 60000) : null;
}

export function attendanceNumber(value) {
  if (value == null || typeof value === 'boolean') return null;
  let n;
  if (typeof value === 'number') n = Math.round(value);
  else {
    const digits = String(value).replace(/\D+/g, '');
    if (!digits) return null;
    n = Number(digits);
  }
  return Number.isFinite(n) && n >= 100 && n <= 250000 ? n : null;
}

export function exhaustedPublicIds(aiState) {
  const out = new Set();
  for (const id of aiState?.esgotados || []) if (String(id || '').trim()) out.add(String(id));
  if (aiState?.jogos && typeof aiState.jogos === 'object') {
    for (const [id, row] of Object.entries(aiState.jogos)) if (row?.esgotado === true) out.add(String(id));
  }
  return out;
}

export function pendingPublicsFromAudit({ results, audit, aiState, now, minAgeMinutes = POLICY.publicos.firstAfterFinalMinutes }) {
  const exhausted = exhaustedPublicIds(aiState);
  const auditAt = parseDate(audit?.gerado_em || audit?.atualizado_em);
  const pendingIds = new Set((audit?.sem_publico || []).map((row) => String(row?.event_id || row?.id || '')).filter(Boolean));
  const pending = [];
  for (const raw of results?.resultados || []) {
    const eventId = String(raw?.event_id || raw?.id || '').trim();
    if (!eventId || exhausted.has(eventId)) continue;
    const ended = resultFinalTime(raw);
    if (!ended || minutesBetween(ended, now) < minAgeMinutes) continue;

    // Se a auditoria foi gerada DEPOIS do FINAL, ela é a fonte canônica da
    // pendência: o coletor já conferiu ESPN + complementos documentais. Se a
    // auditoria ainda é anterior ao jogo, há uma nova partida que nunca foi
    // avaliada e merece a primeira tentativa. Isso evita baixar o enorme
    // jogos-detalhes.json (vários MB) no Worker apenas para decidir o gatilho.
    const auditedAfterFinal = Boolean(auditAt && auditAt.getTime() >= ended.getTime());
    if (auditedAfterFinal && !pendingIds.has(eventId)) continue;
    pending.push({ row: raw, eventId, ended, ageMinutes: minutesBetween(ended, now), firstCheck: !auditedAfterFinal });
  }
  pending.sort((a, b) => b.ended - a.ended);
  return pending;
}

export function retryInterval(ageHours, bands) {
  for (const [limit, minutes] of bands) if (ageHours <= limit) return minutes;
  return bands.at(-1)?.[1] || 1440;
}

export function publicRetryInterval(ageHours) {
  return retryInterval(ageHours, POLICY.publicos.retryBands);
}

export function mmRetryInterval(ageHours) {
  return retryInterval(ageHours, POLICY.melhoresMomentos.retryBands);
}

export function linkedMmIds(auto, manual) {
  const out = new Set();
  for (const src of [auto, manual]) {
    const games = src?.jogos && typeof src.jogos === 'object' ? src.jogos : {};
    for (const [key, row] of Object.entries(games)) {
      const id = String(row?.event_id || key || '').trim();
      if (id) out.add(id);
    }
  }
  return out;
}

export function pendingHighlights({ results, auto, manual, now, firstMinutes = POLICY.melhoresMomentos.firstAfterFinalMinutes }) {
  const linked = linkedMmIds(auto, manual);
  const out = [];
  for (const raw of results?.resultados || []) {
    const eventId = String(raw?.event_id || raw?.id || '').trim();
    const round = Number(raw?.rodada || 0);
    if (!eventId || round <= 0 || linked.has(eventId)) continue;
    const ended = resultFinalTime(raw);
    if (!ended || minutesBetween(ended, now) < firstMinutes) continue;
    out.push({ row: raw, eventId, ended, ageMinutes: minutesBetween(ended, now), round });
  }
  out.sort((a, b) => b.ended - a.ended);
  return out;
}

export function liveLinkedIds(auto, manual) {
  const out = new Set();
  for (const src of [auto, manual]) {
    const games = src?.jogos && typeof src.jogos === 'object' ? src.jogos : {};
    for (const [id, row] of Object.entries(games)) if (row) out.add(String(id));
  }
  return out;
}

export function liveSearchAllowed(eventId, tv) {
  const item = tv?.jogos?.[eventId];
  if (!item || typeof item !== 'object') return { allowed: true, reason: 'grade ainda não consolidada' };
  const channels = new Set((item.canais || []).map(String));
  if (['GE TV', 'SBT', 'CazéTV'].some((x) => channels.has(x))) return { allowed: true, reason: 'grade já indica GE TV/SBT/CazéTV' };
  if (item.exclusivo === true) return { allowed: false, reason: 'grade exclusiva confirmada sem player-alvo' };
  if (channels.has('Globo') || channels.has('Record')) return { allowed: true, reason: 'grade aberta pode ter direito digital' };
  if (item.estavel === true) return { allowed: false, reason: 'grade estável sem indício de player-alvo' };
  return { allowed: true, reason: 'grade ainda não estável' };
}

export function liveCheckpointDue(game, now, lastCheckpoint = null, checkpoints = POLICY.transmissoes.liveCheckpointsMinutes) {
  const delta = (parseDate(now).getTime() - game.kickoff.getTime()) / 60000;
  const due = checkpoints.filter((cp) => cp <= delta && (lastCheckpoint == null || cp > lastCheckpoint));
  return due.length ? Math.max(...due) : null;
}

export function tvCoverage(games, tv, now, days = 30) {
  const t = parseDate(now).getTime();
  const max = t + days * 86400000;
  const published = tv?.jogos && typeof tv.jogos === 'object' ? tv.jogos : {};
  const missing = [];
  for (const game of games) {
    const k = game.kickoff.getTime();
    if (k < t - 6 * 3600000 || k > max) continue;
    if (published[game.eventId]?.canais?.length) continue;
    const hours = (k - t) / 3600000;
    missing.push({ game, hours });
  }
  return {
    missing30d: missing.length,
    missing14d: missing.filter((x) => x.hours <= 14 * 24).length,
    critical72h: missing.filter((x) => x.hours <= 72).length,
    missing,
  };
}

export function tvIntervalHours(coverage) {
  if (coverage.critical72h > 0) return POLICY.transmissoes.tvCriticalHours;
  if (coverage.missing14d > 0) return POLICY.transmissoes.tvMissing14dHours;
  if (coverage.missing30d > 0) return POLICY.transmissoes.tvMissing30dHours;
  return POLICY.transmissoes.tvHealthy30dHours;
}

export function roundState(round, calendar, results, now, config = {}) {
  const expected = (calendar?.jogos || []).filter((g) => Number(g?.rodada || 0) === Number(round));
  const completed = (results?.resultados || []).filter((g) => Number(g?.rodada || 0) === Number(round));
  const doneIds = new Set(completed.map((g) => String(g?.event_id || g?.id || '')).filter(Boolean));
  const pending = expected.filter((g) => !doneIds.has(String(g?.event_id || g?.id || '')));
  const total = 10;
  const minimum = Number(config.minimo_jogos_para_fechamento_editorial || POLICY.editorial.roundMinimumGames);
  const waitHours = Number(config.espera_apos_ultimo_jogo_horas || POLICY.editorial.roundWaitHours);
  const postponedHours = Number(config.distancia_jogo_adiado_horas || POLICY.editorial.postponedDistanceHours);
  if (completed.length === total) return { round: Number(round), eligible: true, completed: completed.length, pending: pending.length, reason: 'todos os dez jogos foram concluídos' };
  if (completed.length < minimum || !completed.length) return { round: Number(round), eligible: false, completed: completed.length, pending: pending.length, reason: 'rodada em andamento' };
  const completedDates = completed.map((g) => parseDate(g?.data_iso)).filter(Boolean);
  const last = completedDates.length ? new Date(Math.max(...completedDates.map((d) => d.getTime()))) : null;
  const pendingDates = pending.map((g) => parseDate(g?.data_iso)).filter(Boolean);
  const pendingFar = pending.length > 0 && (!pendingDates.length || (last && Math.min(...pendingDates.map((d) => d.getTime())) >= last.getTime() + postponedHours * 3600000));
  const waited = last && parseDate(now).getTime() >= last.getTime() + waitHours * 3600000;
  return {
    round: Number(round), eligible: Boolean(pendingFar && waited), completed: completed.length,
    pending: pending.length, reason: pendingFar && waited ? 'janela encerrada com partida adiada' : 'rodada em andamento',
  };
}

export function latestEligibleRound(calendar, results, analyses, now, config = {}) {
  // O editorial sempre trabalha sobre a MAIOR rodada já elegível. Não devemos
  // ressuscitar uma rodada histórica sem artigo (ex.: rodada 19) quando a
  // temporada já possui rodada 25 fechada e publicada. Isso replica a regra do
  // gerador Python: calcula eligible[] e usa max(eligible).
  const eligible = [];
  for (let round = 1; round <= 38; round += 1) {
    const state = roundState(round, calendar, results, now, config);
    if (state.eligible) eligible.push(state);
  }
  if (!eligible.length) return null;
  const state = eligible.reduce((best, row) => (!best || row.round > best.round ? row : best), null);
  const article = (analyses?.artigos || []).find((a) => a?.tipo === 'brasileirao_rodada' && Number(a?.rodada || 0) === state.round);
  const articleGames = Number(article?.jogos_concluidos || 0);
  if (article && articleGames >= state.completed) return null;
  return { ...state, article };
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export async function sha256Hex(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const CUP_ARTICLES = Object.freeze({
  600: 'copa-do-brasil-2026-classificados-quartas',
  700: 'copa-do-brasil-2026-classificados-semifinal',
  800: 'copa-do-brasil-2026-finalistas',
  900: 'copa-do-brasil-2026-campeao',
});

export async function cupEditorialDecision(cup, analyses, _cupHighlights) {
  const rank = Number(cup?.fase_atual?.ordem || 0);
  const id = CUP_ARTICLES[rank];
  if (!id || String(cup?.fase_atual?.status || '').toLowerCase() !== 'encerrada') return null;
  const article = (analyses?.artigos || []).find((a) => a?.id_editorial === id);
  if (!article) return { rank, reason: `fase ${rank} encerrada e editorial inexistente` };
  // Não reproduzimos no JavaScript o hash canônico Python dos melhores momentos:
  // JSON.parse perde a distinção lexical 1.0 vs 1 e poderia criar um loop falso.
  // Atualizações posteriores de vídeo da Copa disparam o editorial diretamente
  // pelo workflow de melhores momentos quando o arquivo factual muda.
  return null;
}

const CONT_PHASES = Object.freeze({
  600: ['Oitavas de final', 'oitavas'],
  700: ['Quartas de final', 'quartas'],
  800: ['Semifinal', 'semifinal'],
  900: ['Final', 'final'],
});

function sideKey(side) { return String(side?.espn_id || side?.nome || ''); }
function isBr(side) { return Boolean(side?.serie_a_2026); }

export function phaseEvents(snapshot, rank) {
  return (snapshot?.eventos || []).filter((e) => Number(e?.fase_ordem || 0) === Number(rank) && (isBr(e?.mandante) || isBr(e?.visitante)));
}

export function ranksWithBrazilians(snaps) {
  const set = new Set();
  for (const snap of Object.values(snaps || {})) for (const e of snap?.eventos || []) {
    const rank = Number(e?.fase_ordem || 0);
    if (CONT_PHASES[rank] && (isBr(e?.mandante) || isBr(e?.visitante))) set.add(rank);
  }
  return [...set].sort((a, b) => a - b);
}

function buildTies(snapshot, rank) {
  const groups = new Map();
  for (const event of phaseEvents(snapshot, rank)) {
    const key = [sideKey(event?.mandante), sideKey(event?.visitante)].sort().join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const ties = [];
  for (const legsRaw of groups.values()) {
    const legs = [...legsRaw].sort((a, b) => Number(a?.perna || 0) - Number(b?.perna || 0) || String(a?.data_iso || '').localeCompare(String(b?.data_iso || '')));
    const teams = new Map();
    for (const e of legs) for (const side of [e?.mandante || {}, e?.visitante || {}]) teams.set(sideKey(side), side);
    if (teams.size !== 2) continue;
    const teamRows = [...teams.values()];
    let winner = String(legs.at(-1)?.vencedor || '').trim();
    if (!winner) for (const e of [...legs].reverse()) if (e?.vencedor) { winner = String(e.vencedor); break; }
    const brWinners = teamRows.filter(isBr).map((s) => String(s?.nome || s?.nome_espn || '')).filter((name) => name === winner);
    ties.push({ legs, brWinners });
  }
  return ties;
}

export function phaseMaterializedForSurvivors(snaps, rank) {
  const prev = Number(rank) - 100;
  if (!CONT_PHASES[prev]) return true;
  for (const snap of Object.values(snaps || {})) {
    const current = phaseEvents(snap, rank);
    const prevWinners = new Set(buildTies(snap, prev).flatMap((t) => t.brWinners));
    if (prevWinners.size && !current.length) return false;
  }
  return true;
}

export function latestPublishableContinental(snaps) {
  const ranks = ranksWithBrazilians(snaps);
  if (!ranks.length) return null;
  const rank = ranks.at(-1);
  const events = Object.values(snaps || {}).flatMap((snap) => phaseEvents(snap, rank));
  if (events.length && events.every((e) => Boolean(e?.concluido)) && phaseMaterializedForSurvivors(snaps, rank)) return rank;
  return null;
}

export function continentalBaselineReady(snaps, rank) {
  if (Number(rank) === 900 || !phaseMaterializedForSurvivors(snaps, rank)) return false;
  const events = Object.values(snaps || {}).flatMap((snap) => phaseEvents(snap, rank));
  if (!events.length || events.every((e) => Boolean(e?.concluido))) return false;
  const first = events.filter((e) => Number(e?.perna || 0) === 1);
  const second = events.filter((e) => Number(e?.perna || 0) === 2);
  return Boolean(first.length && second.length && first.every((e) => Boolean(e?.concluido)));
}

export function continentalDecision(snaps, analyses, history) {
  const rank = latestPublishableContinental(snaps);
  if (rank) {
    const slug = CONT_PHASES[rank][1];
    const id = `continentais-2026-${slug}-brasileiros`;
    const exists = (analyses?.artigos || []).some((a) => a?.id_editorial === id);
    if (!exists) return { kind: 'publish', rank, reason: `fase continental ${rank} encerrada no recorte brasileiro` };
    return null;
  }
  const ranks = ranksWithBrazilians(snaps);
  const active = ranks.at(-1);
  if (!active || !continentalBaselineReady(snaps, active)) return null;
  const slug = CONT_PHASES[active][1];
  const beforeId = `continentais-2026-${slug}-antes-fechamento`;
  const exists = (history?.marcos || []).some((m) => m?.id === beforeId);
  return exists ? null : { kind: 'baseline', rank: active, reason: `idas continentais ${active} encerradas; preservar fotografia anterior às voltas` };
}

export function actionKey(decision) {
  const bits = [decision?.action || 'none'];
  if (decision?.eventId) bits.push(decision.eventId);
  if (decision?.round) bits.push(String(decision.round));
  if (decision?.checkpoint != null) bits.push(String(decision.checkpoint));
  return bits.join(':');
}
