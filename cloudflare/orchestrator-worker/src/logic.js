const BRT = 'America/Sao_Paulo';

export const POLICY = Object.freeze({
  sports: {
    beforeMinutes: 45,
    afterMinutes: 240,
    fallbackFinalMinutes: 115,
    finalRetryMinutes: 15,
    dailyAfter: '05:10',
    dailyRetryMinutes: 360,
    sourceProbeMinutes: 5,
  },
  slowEvalMinutes: 5,
  publicos: {
    firstAfterFinalMinutes: 120,
    retryBands: [
      [4, 120], [6, 120], [9, 180], [12, 180], [18, 360],
      [24, 360], [36, 720], [48, 720], [99999, 1440],
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
    guardianCheckpointsMinutes: [-1440, -360, -90, -15, 10],
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
    continentalSettleMinutes: 180,
    continentalFallbackMinutes: 1440,
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

export function brasileiraoSourceGate(status = {}) {
  const explicitState = String(status?.fonte_estado || '').trim().toLowerCase();
  const explicitReason = String(status?.fonte_codigo || '').trim();
  const operationalStatus = String(status?.status || '').trim().toLowerCase();
  const message = String(status?.mensagem_admin || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const legacyUnavailable = operationalStatus === 'preservado'
    && /(scoreboard|fonte)/.test(message)
    && /(indispon|http(?: error)? 400|http(?: error)? 403|forbidden)/.test(message);
  const structuredUnavailable = explicitState === 'unavailable';
  const open = structuredUnavailable || legacyUnavailable;
  const fingerprint = String(status?.fingerprint || [operationalStatus, explicitState, explicitReason, status?.snapshot_hash || '', message].join('|'));
  return {
    open,
    state: open ? 'open' : 'closed',
    reason: explicitReason || (legacyUnavailable ? 'ESPN_SCOREBOARD_UNAVAILABLE_LEGACY' : ''),
    fingerprint,
    legacy: !structuredUnavailable && legacyUnavailable,
    snapshotPreserved: status?.snapshot_preservado === true || operationalStatus === 'preservado',
  };
}

export function teamName(value) {
  if (value && typeof value === 'object') return String(value.nome || value.name || value.displayName || '').trim();
  return String(value || '').trim();
}

export function continentalPhaseRank(value) {
  const label = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!label) return 0;
  // A ordem é importante: "quarterfinals" e "semifinal" também contêm "final".
  if (/oitav|round of 16/.test(label)) return 600;
  if (/quart|quarterfinal/.test(label)) return 700;
  if (/semi/.test(label)) return 800;
  if (/final/.test(label)) return 900;
  return 0;
}

export function normalizeAgenda(payload) {
  const rows = Array.isArray(payload?.jogos) ? payload.jogos : [];
  return rows.map((row) => ({
    eventId: String(row?.event_id || row?.id || '').trim(),
    competition: String(row?.competicao_chave || '').trim(),
    league: String(row?.espn_league || '').trim(),
    kickoff: parseDate(row?.data_iso),
    round: Number(row?.rodada || 0),
    phase: String(row?.fase || '').trim(),
    phaseRank: Number(row?.fase_ordem || 0) || continentalPhaseRank(row?.fase),
    leg: Number(row?.perna || 0),
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

export function exhaustedPublicIds() {
  // Compatibilidade de API com testes/consumidores antigos. A política v2 não
  // abandona definitivamente público/renda; backoff substitui `esgotado`.
  return new Set();
}

function pendingPublicFields(aiState, eventId) {
  const row = aiState?.jogos?.[eventId];
  if (!row || typeof row !== 'object') return [];
  const fields = [];
  if (row.campos && typeof row.campos === 'object') {
    for (const field of ['publico', 'renda']) {
      if (row.campos?.[field]?.status === 'pending') fields.push(field);
    }
    return fields;
  }
  // Estado legado `esgotado=true` é reaberto automaticamente. Como o schema
  // antigo não distinguia campos, deixa o workflow confirmar as lacunas reais.
  if (row.esgotado === true || Number(row.tentativas || 0) > 0) return ['publico', 'renda'];
  return [];
}

export function pendingPublicsFromAudit({ results, audit, aiState, now, minAgeMinutes = POLICY.publicos.firstAfterFinalMinutes }) {
  const auditAt = parseDate(audit?.gerado_em || audit?.atualizado_em);
  const publicIds = new Set((audit?.sem_publico || []).map((row) => String(row?.event_id || row?.id || '')).filter(Boolean));
  const rentIds = new Set((audit?.sem_renda || []).map((row) => String(row?.event_id || row?.id || '')).filter(Boolean));
  const pending = [];
  for (const raw of results?.resultados || []) {
    const eventId = String(raw?.event_id || raw?.id || '').trim();
    if (!eventId) continue;
    const ended = resultFinalTime(raw);
    if (!ended || minutesBetween(ended, now) < minAgeMinutes) continue;

    const stateFields = pendingPublicFields(aiState, eventId);
    const fields = [];
    if (publicIds.has(eventId)) fields.push('publico');
    if (rentIds.has(eventId)) fields.push('renda');
    for (const field of stateFields) if (!fields.includes(field)) fields.push(field);

    const auditedAfterFinal = Boolean(auditAt && auditAt.getTime() >= ended.getTime());
    // Auditoria posterior ao FINAL pode provar que não há lacuna. Porém estados
    // legados/pending ainda forçam UMA passagem de reconciliação para migrar o
    // schema antigo; o workflow lê detalhes e descarta o que já estiver resolvido.
    if (auditedAfterFinal && fields.length === 0) continue;
    if (!auditedAfterFinal && fields.length === 0) fields.push('publico', 'renda');
    pending.push({
      row: raw, eventId, ended, ageMinutes: minutesBetween(ended, now),
      firstCheck: !auditedAfterFinal, missingFields: fields,
    });
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

export function guardianCheckpointDue(game, now, lastCheckpoint = null, checkpoints = POLICY.transmissoes.guardianCheckpointsMinutes) {
  return liveCheckpointDue(game, now, lastCheckpoint, checkpoints);
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
function markIds(rank) {
  const slug = CONT_PHASES[Number(rank)]?.[1] || '';
  return [`continentais-2026-${slug}-antes-fechamento`, `continentais-2026-${slug}-depois-fechamento`];
}

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

export function rankHasCompleteTwoLegTies(snaps, rank) {
  if (Number(rank) === 900) return true;
  let found = false;
  for (const snap of Object.values(snaps || {})) {
    const events = phaseEvents(snap, rank);
    if (!events.length) continue;
    found = true;
    const ties = buildTies(snap, rank);
    if (!ties.length) return false;
    const eventIds = new Set(events.map((e) => String(e?.event_id || '')));
    const tieIds = new Set(ties.flatMap((t) => t.legs).map((e) => String(e?.event_id || '')));
    if (eventIds.size !== tieIds.size || [...eventIds].some((id) => !tieIds.has(id))) return false;
    for (const tie of ties) {
      const legs = tie.legs || [];
      const legNumbers = new Set(legs.map((e) => Number(e?.perna || 0)));
      if (legs.length !== 2 || legNumbers.size !== 2 || !legNumbers.has(1) || !legNumbers.has(2)) return false;
      if (!legs.every((e) => Boolean(e?.concluido))) return false;
    }
  }
  return found;
}

export function openEditorialRank(history) {
  const marks = new Set((history?.marcos || []).map((m) => String(m?.id || '')));
  const open = [];
  for (const rank of Object.keys(CONT_PHASES).map(Number)) {
    const [beforeId, afterId] = markIds(rank);
    if (marks.has(beforeId) && !marks.has(afterId)) open.push(rank);
  }
  return open.length ? Math.max(...open) : null;
}

function lowerPhasePending(snaps, rank) {
  for (const lower of Object.keys(CONT_PHASES).map(Number).filter((value) => value < Number(rank))) {
    const events = Object.values(snaps || {}).flatMap((snap) => phaseEvents(snap, lower));
    if (events.some((e) => !e?.concluido)) return true;
  }
  return false;
}

function editorialActiveRank(snaps) {
  const ranks = ranksWithBrazilians(snaps);
  if (!ranks.length) return 0;
  const pending = ranks.filter((rank) => Object.values(snaps || {}).flatMap((snap) => phaseEvents(snap, rank)).some((e) => !e?.concluido));
  return pending.length ? pending[0] : ranks.at(-1);
}

export function latestPublishableContinental(snaps) {
  const ranks = ranksWithBrazilians(snaps);
  if (!ranks.length) return null;
  const rank = ranks.at(-1);
  const events = Object.values(snaps || {}).flatMap((snap) => phaseEvents(snap, rank));
  if (!events.length || !events.every((e) => Boolean(e?.concluido))) return null;
  if (lowerPhasePending(snaps, rank)) return null;
  if (rank === 900 && events.some((e) => Number(e?.perna || 0) > 1)) return null;
  if (rank !== 900 && !rankHasCompleteTwoLegTies(snaps, rank)) return null;
  return phaseMaterializedForSurvivors(snaps, rank) ? rank : null;
}

export function continentalBaselineReady(snaps, rank) {
  if (Number(rank) === 900 || !phaseMaterializedForSurvivors(snaps, rank)) return false;
  const events = Object.values(snaps || {}).flatMap((snap) => phaseEvents(snap, rank));
  if (!events.length || events.every((e) => Boolean(e?.concluido))) return false;
  const first = events.filter((e) => Number(e?.perna || 0) === 1);
  const second = events.filter((e) => Number(e?.perna || 0) === 2);
  return Boolean(first.length && second.length && first.every((e) => Boolean(e?.concluido)));
}

export function continentalEligibility(snaps, history) {
  const anchored = openEditorialRank(history);
  if (anchored) {
    const events = Object.values(snaps || {}).flatMap((snap) => phaseEvents(snap, anchored));
    const pending = events.filter((e) => !e?.concluido).map((e) => String(e?.event_id || '')).filter(Boolean).sort();
    if (pending.length) return {
      action: 'none', rank: anchored, phase: CONT_PHASES[anchored][0], pending,
      reason: 'fase continental ainda em andamento; aguardar todas as partidas dos brasileiros',
    };
    if (!rankHasCompleteTwoLegTies(snaps, anchored)) return {
      action: 'none', rank: anchored, phase: CONT_PHASES[anchored][0], pending: [],
      reason: 'fase encerrada sem estrutura completa de ida e volta; aguardar reconciliação factual',
    };
    if (!phaseMaterializedForSurvivors(snaps, anchored)) return {
      action: 'none', rank: anchored, phase: CONT_PHASES[anchored][0], pending: [],
      reason: 'fase encerrada, mas os sobreviventes ainda não estão materializados de forma consistente',
    };
    return {
      action: 'publish', rank: anchored, phase: CONT_PHASES[anchored][0], pending: [],
      reason: 'fase continental ancorada encerrada para todos os brasileiros',
    };
  }

  const active = editorialActiveRank(snaps);
  if (active && continentalBaselineReady(snaps, active)) {
    const [beforeId] = markIds(active);
    const exists = (history?.marcos || []).some((m) => String(m?.id || '') === beforeId);
    if (!exists) return {
      action: 'baseline', rank: active, phase: CONT_PHASES[active][0], pending: [],
      reason: 'todas as partidas de ida terminaram; preservar marco anterior às voltas',
    };
  }

  const publishable = latestPublishableContinental(snaps);
  if (publishable) return {
    action: 'publish', rank: publishable, phase: CONT_PHASES[publishable][0], pending: [],
    reason: 'fase continental encerrada e estruturalmente consistente',
  };
  return {
    action: 'none', rank: active, phase: CONT_PHASES[active]?.[0] || '', pending: [],
    reason: 'nenhuma fase continental brasileira pronta para editorial',
  };
}

function stateRowsForRank(snaps, rank) {
  if (!rank) return [];
  return Object.entries(snaps || {}).flatMap(([comp, snap]) => phaseEvents(snap, rank).map((e) => ({
    comp,
    id: String(e?.event_id || ''),
    leg: Number(e?.perna || 0),
    done: Boolean(e?.concluido),
    when: String(e?.data_iso || ''),
  }))).sort((a, b) => `${a.comp}:${a.id}`.localeCompare(`${b.comp}:${b.id}`));
}

export function continentalStateSignature(eligibility, snaps) {
  const rows = stateRowsForRank(snaps, Number(eligibility?.rank || 0));
  return [
    String(eligibility?.action || 'none'),
    String(eligibility?.rank || 0),
    ...rows.map((row) => `${row.comp}:${row.id}:${row.leg}:${row.done ? 1 : 0}:${row.when}`),
  ].join('|');
}

function isContinentalAgendaGame(game) {
  return ['libertadores', 'sul_americana'].includes(String(game?.competition || '').toLowerCase())
    || /conmebol\.(libertadores|sudamericana)/i.test(String(game?.league || ''));
}

export function continentalAgendaSignature(games) {
  return (games || []).filter(isContinentalAgendaGame).map((g) => [
    g.eventId, g.phaseRank || 0, g.leg || 0, g.kickoff?.toISOString?.() || '', g.concluded ? 1 : 0,
  ].join(':')).sort().join('|');
}

export function continentalNextCheck(eligibility, games, now, {
  settleMinutes = POLICY.editorial.continentalSettleMinutes,
  fallbackMinutes = POLICY.editorial.continentalFallbackMinutes,
} = {}) {
  const current = parseDate(now) || new Date();
  const fallback = (reason, degraded = true) => ({
    nextCheckAt: new Date(current.getTime() + fallbackMinutes * 60000),
    degraded,
    reason,
  });
  if (['baseline', 'publish'].includes(String(eligibility?.action || ''))) {
    return { nextCheckAt: current, degraded: false, reason: 'estado factual já elegível' };
  }

  const continentalGames = (games || []).filter(isContinentalAgendaGame);
  const pending = new Set((eligibility?.pending || []).map(String).filter(Boolean));
  if (pending.size) {
    const matched = continentalGames.filter((g) => pending.has(String(g.eventId)));
    if (matched.length !== pending.size || matched.some((g) => !g.kickoff)) {
      return fallback('agenda incompleta para os jogos pendentes; usar verificação diária');
    }
    const latestKickoff = new Date(Math.max(...matched.map((g) => g.kickoff.getTime())));
    const planned = new Date(latestKickoff.getTime() + settleMinutes * 60000);
    if (planned.getTime() > current.getTime()) {
      return { nextCheckAt: planned, degraded: false, reason: 'aguardar o fim previsto da última partida brasileira da fase' };
    }
    return fallback('janela prevista já passou, mas o snapshot ainda não fechou a fase; usar verificação diária');
  }

  const future = continentalGames.filter((g) => !g.concluded && g.kickoff && g.kickoff.getTime() > current.getTime() && CONT_PHASES[g.phaseRank]);
  if (!future.length) return fallback('nenhuma próxima janela continental confiável na agenda; usar verificação diária');
  future.sort((a, b) => a.kickoff - b.kickoff);
  const first = future[0];
  const targetRank = first.phaseRank;
  const targetLeg = targetRank === 900 ? 0 : (first.leg || 0);
  // Se o snapshot ainda está preso na mesma fase e a agenda já aponta apenas
  // para as voltas, não podemos dormir até elas: falta preservar o baseline
  // pós-idas. Nesse desalinhamento, fazemos no máximo a checagem diária.
  if (targetRank !== 900 && targetLeg === 2 && Number(eligibility?.rank || 0) === targetRank) {
    return fallback('agenda já avançou para as voltas, mas o baseline factual ainda não foi confirmado; usar verificação diária');
  }
  const sameWindow = future.filter((g) => g.phaseRank === targetRank && (targetRank === 900 || !targetLeg || g.leg === targetLeg));
  if (!sameWindow.length) return fallback('agenda continental sem janela coerente; usar verificação diária');
  const latestKickoff = new Date(Math.max(...sameWindow.map((g) => g.kickoff.getTime())));
  return {
    nextCheckAt: new Date(latestKickoff.getTime() + settleMinutes * 60000),
    degraded: false,
    reason: targetRank === 900
      ? 'aguardar a final continental prevista na agenda'
      : `aguardar o encerramento previsto da perna ${targetLeg || '?'} da fase ${targetRank}`,
  };
}

export function continentalDecision(snaps, analyses, history) {
  const eligibility = continentalEligibility(snaps, history);
  const rank = Number(eligibility.rank || 0);
  if (!rank || eligibility.action === 'none') return null;
  if (eligibility.action === 'baseline') return {
    kind: 'baseline', rank, reason: eligibility.reason,
    signature: continentalStateSignature(eligibility, snaps),
  };
  const slug = CONT_PHASES[rank][1];
  const id = `continentais-2026-${slug}-brasileiros`;
  const exists = (analyses?.artigos || []).some((a) => a?.id_editorial === id);
  if (exists) return null;
  return {
    kind: 'publish', rank, reason: eligibility.reason,
    signature: continentalStateSignature(eligibility, snaps),
  };
}

export function actionKey(decision) {
  const bits = [decision?.action || 'none'];
  if (decision?.eventId) bits.push(decision.eventId);
  if (decision?.round) bits.push(String(decision.round));
  if (decision?.checkpoint != null) bits.push(String(decision.checkpoint));
  if (decision?.signature) bits.push(String(decision.signature));
  return bits.join(':');
}
