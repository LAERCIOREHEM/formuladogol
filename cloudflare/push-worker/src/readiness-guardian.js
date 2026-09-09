const MINUTE = 60_000;
export const READINESS_VERSION = '6-R10';
export const PRECHECK_FROM_MS = 35 * MINUTE;
export const PRECHECK_POLL_MS = 60_000;
export const RED_CONFIRM_MS = 60_000;
export const RED_CONFIRM_OBSERVATIONS = 2;
export const LINEUP_CONFIRM_MS = 20_000;
export const LINEUP_CONFIRM_OBSERVATIONS = 2;
export const CHECKPOINTS = Object.freeze([
  { key: 't30', offsetMs: -30 * MINUTE, label: 'T-30' },
  { key: 't10', offsetMs: -10 * MINUTE, label: 'T-10' },
  { key: 'tplus3', offsetMs: 3 * MINUTE, label: 'T+3' }
]);

function text(value) { return String(value == null ? '' : value).trim(); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function norm(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function compactName(value) {
  const raw = text(value).replace(/\s+/g, ' ');
  if (!raw) return '';
  const parts = raw.split(' ').filter(Boolean);
  if (parts.length <= 2) return raw;
  return `${parts[0]} ${parts.at(-1)}`;
}
function stableKey(value) {
  let hash = 0x811c9dc5;
  for (const c of String(value || '')) { hash ^= c.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
function teamDescriptor(team) {
  return {
    id: text(team?.id || team?.team?.id),
    name: text(team?.name || team?.displayName || team?.shortDisplayName || team?.team?.displayName || team?.team?.name),
    abbreviation: text(team?.abbreviation || team?.team?.abbreviation).toUpperCase()
  };
}
function competitorTeam(competitor) { return teamDescriptor(competitor?.team ? { ...competitor.team, id: competitor.team.id || competitor.id } : competitor); }
function eventCompetition(event) { return event?.competitions?.[0] || event?.competition || event?.header?.competitions?.[0] || {}; }
function eventTeams(event) {
  const competition = eventCompetition(event);
  const rows = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const home = rows.find((r) => r?.homeAway === 'home') || rows[0] || {};
  const away = rows.find((r) => r?.homeAway === 'away') || rows[1] || {};
  return { home: competitorTeam(home), away: competitorTeam(away) };
}
function teamMatches(expected, actual) {
  const a = teamDescriptor(expected), b = teamDescriptor(actual);
  if (a.id && b.id && a.id === b.id) return true;
  if (a.abbreviation && b.abbreviation && a.abbreviation === b.abbreviation) return true;
  return Boolean(norm(a.name) && norm(a.name) === norm(b.name));
}

export function resolveScoreboardEvent(events, game) {
  const list = Array.isArray(events) ? events : events instanceof Map ? [...events.values()] : [];
  const exactId = text(game?.sourceEventId || game?.eventId);
  let raw = list.find((event) => text(event?.id || eventCompetition(event)?.id) === exactId);
  if (raw) return { raw, sourceEventId: text(raw?.id || eventCompetition(raw)?.id), strategy: 'event_id' };
  raw = list.find((event) => text(event?.id || eventCompetition(event)?.id) === text(game?.eventId));
  if (raw) return { raw, sourceEventId: text(raw?.id || eventCompetition(raw)?.id), strategy: 'agenda_event_id' };

  const candidates = [];
  for (const event of list) {
    const teams = eventTeams(event);
    const direct = teamMatches(game?.home, teams.home) && teamMatches(game?.away, teams.away);
    const reversed = teamMatches(game?.home, teams.away) && teamMatches(game?.away, teams.home);
    if (!direct && !reversed) continue;
    const kickoff = Date.parse(event?.date || eventCompetition(event)?.date || '');
    const expectedKickoff = Date.parse(game?.kickoff || '');
    const timeDelta = Number.isFinite(kickoff) && Number.isFinite(expectedKickoff) ? Math.abs(kickoff - expectedKickoff) : Number.MAX_SAFE_INTEGER;
    candidates.push({ event, direct, timeDelta });
  }
  candidates.sort((a, b) => Number(b.direct) - Number(a.direct) || a.timeDelta - b.timeDelta);
  const best = candidates[0];
  if (!best || (!best.direct && best.timeDelta > 6 * 60 * MINUTE)) return null;
  return {
    raw: best.event,
    sourceEventId: text(best.event?.id || eventCompetition(best.event)?.id),
    strategy: best.direct ? 'matchup' : 'reversed_matchup'
  };
}

function walkObjects(value, out, depth = 0) {
  if (depth > 7 || value == null) return;
  if (Array.isArray(value)) { for (const item of value) walkObjects(item, out, depth + 1); return; }
  if (typeof value !== 'object') return;
  out.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (['athlete','team','clock','type'].includes(key)) continue;
    if (child && typeof child === 'object') walkObjects(child, out, depth + 1);
  }
}
function eventDescriptor(item) {
  return norm([
    item?.type?.text, item?.type?.name, item?.type?.description, item?.type?.displayName,
    item?.text, item?.description, item?.shortText, item?.displayText
  ].filter(Boolean).join(' '));
}
function athleteFrom(item) {
  const raw = item?.athlete || item?.athletesInvolved?.[0] || item?.participants?.[0]?.athlete || item?.player || {};
  const id = text(raw?.id || item?.athleteId || item?.playerId);
  let name = text(raw?.shortName || raw?.displayName || raw?.fullName || raw?.name || item?.athleteName || item?.playerName);
  if (!name) {
    const narrative = text(item?.text || item?.description || '');
    const match = narrative.match(/(?:red card|cart[aã]o vermelho|expuls(?:o|ão|ao))\s+(?:to|para)?\s*([^.(,;]+)/iu);
    if (match) name = match[1].trim();
  }
  return { id, name: compactName(name) };
}
function teamFrom(item) {
  const raw = item?.team || item?.competitor?.team || {};
  return teamDescriptor({ ...raw, id: raw?.id || item?.teamId || item?.competitorId });
}

export function extractRedCards(payload, observation = {}, sourceName = '') {
  const objects = [];
  walkObjects(payload, objects);
  const out = new Map();
  for (const item of objects) {
    const descriptor = eventDescriptor(item);
    const red = item?.redCard === true || item?.isRedCard === true || /red card|cartao vermelho|expuls|second yellow|segundo amarelo|segunda amarela/.test(descriptor);
    if (!red) continue;
    const athlete = athleteFrom(item);
    const team = teamFrom(item);
    const minute = text(item?.clock?.displayValue || item?.displayClock || item?.clock || '');
    const sourceId = text(item?.id || item?.uid || item?.sequenceNumber || item?.sequence);
    const identity = sourceId || stableKey([text(observation?.eventId), team.id || team.name, athlete.id || athlete.name, minute, descriptor].join('|'));
    if (!identity) continue;
    const key = `${text(observation?.eventId)}:red:${identity}`;
    out.set(key, { key, sourceId, athlete, team, minute, sourceName: text(sourceName), descriptor });
  }
  return [...out.values()];
}

export function mergeRedCards(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const card of Array.isArray(list) ? list : []) {
      if (!card?.key) continue;
      const previous = map.get(card.key) || {};
      map.set(card.key, {
        ...previous, ...card,
        athlete: { ...(previous.athlete || {}), ...(card.athlete || {}) },
        team: { ...(previous.team || {}), ...(card.team || {}) }
      });
    }
  }
  return [...map.values()];
}

function teamSide(card, match) {
  const id = text(card?.team?.id);
  if (id && id === text(match?.home?.id)) return 'home';
  if (id && id === text(match?.away?.id)) return 'away';
  const name = norm(card?.team?.name);
  if (name && name === norm(match?.home?.name)) return 'home';
  if (name && name === norm(match?.away?.name)) return 'away';
  return '';
}
function redEvent(card, match, observation, now) {
  const side = teamSide(card, match);
  const team = side === 'home' ? match.home : side === 'away' ? match.away : card.team || {};
  const athlete = card?.athlete || {};
  const minute = text(card?.minute);
  const who = text(athlete?.name);
  const teamName = text(team?.name);
  const matchup = `${text(match?.home?.name || 'Mandante')} ${num(observation?.home?.score, 0)} × ${num(observation?.away?.score, 0)} ${text(match?.away?.name || 'Visitante')}`;
  const detail = [who || (teamName ? `Jogador do ${teamName}` : 'Jogador expulso'), minute].filter(Boolean).join(', ');
  return {
    eventKey: `red_card:${text(match?.eventId)}:${text(card?.key)}`,
    type: 'red_card', sourcePlayKey: text(card?.key), eventId: text(match?.eventId), league: text(match?.league),
    competitionKey: text(match?.competitionKey), competitionName: text(match?.competitionName), kickoff: text(match?.kickoff),
    home: { ...(match?.home || {}), score: num(observation?.home?.score, 0) },
    away: { ...(match?.away || {}), score: num(observation?.away?.score, 0) },
    scoringTeam: {}, athlete: { id: text(athlete?.id), name: who }, minute, ownGoal: false, penalty: false, shootout: false,
    scoreAfter: { home: num(observation?.home?.score, 0), away: num(observation?.away?.score, 0) },
    detectedAt: new Date(now - RED_CONFIRM_MS).toISOString(), confirmedAt: new Date(now).toISOString(),
    notificationDraft: {
      title: teamName ? `🟥 EXPULSÃO DO ${teamName.toUpperCase()}!` : '🟥 CARTÃO VERMELHO!',
      body: `${detail} · ${matchup}`
    }
  };
}

export function applyRedCardObservations(matchInput, cards, observation, nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  const match = structuredClone(matchInput || {});
  const current = match.redCards && typeof match.redCards === 'object' ? match.redCards : {};
  const seen = new Set();
  const emitted = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card?.key) continue;
    seen.add(card.key);
    const old = current[card.key];
    if (!old) {
      current[card.key] = { ...card, status: 'pending', firstSeenAt: now, lastSeenAt: now, stableCount: 1, missingCount: 0 };
      continue;
    }
    const next = { ...old, ...card, athlete: { ...(old.athlete || {}), ...(card.athlete || {}) }, team: { ...(old.team || {}), ...(card.team || {}) }, lastSeenAt: now, stableCount: num(old.stableCount, 0) + 1, missingCount: 0 };
    if (old.status === 'pending' && next.stableCount >= RED_CONFIRM_OBSERVATIONS && now - num(old.firstSeenAt, now) >= RED_CONFIRM_MS) {
      next.status = 'confirmed'; next.confirmedAt = now; emitted.push(redEvent(next, match, observation, now));
    }
    current[card.key] = next;
  }
  for (const [key, card] of Object.entries(current)) {
    if (seen.has(key) || card?.status !== 'pending') continue;
    const missingCount = num(card?.missingCount, 0) + 1;
    current[key] = { ...card, missingCount, status: missingCount >= 2 ? 'rejected' : 'pending' };
  }
  match.redCards = current;
  return { match, emitted };
}

function rosterEntries(group) {
  return Array.isArray(group?.roster) ? group.roster : Array.isArray(group?.athletes) ? group.athletes : [];
}
function starterEntry(entry) {
  const athlete = entry?.athlete || entry || {};
  const status = norm([entry?.status?.type?.name, entry?.status?.type?.description, entry?.position?.displayName].filter(Boolean).join(' '));
  return entry?.starter === true || athlete?.starter === true || status === 'starter' || /starting|titular/.test(status);
}
function lineupPlayer(entry) {
  const athlete = entry?.athlete || entry || {};
  return { id: text(athlete?.id), name: compactName(athlete?.shortName || athlete?.displayName || athlete?.fullName || athlete?.name) };
}
function groupTeam(group) { return teamDescriptor(group?.team || group?.competitor?.team || group || {}); }
function dedupePlayers(players) {
  const map = new Map();
  for (const p of players) {
    const key = text(p?.id) || norm(p?.name);
    if (key && !map.has(key)) map.set(key, p);
  }
  return [...map.values()];
}

export function extractLineupSnapshot(summary, observation = {}) {
  if (text(observation?.league) !== 'bra.1') return null;
  const groups = Array.isArray(summary?.rosters) ? summary.rosters : [];
  if (groups.length < 2) return null;
  const assign = { home: [], away: [] };
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const gt = groupTeam(group);
    const side = teamMatches(observation?.home, gt) ? 'home' : teamMatches(observation?.away, gt) ? 'away' : i === 0 ? 'home' : i === 1 ? 'away' : '';
    if (!side) continue;
    const starters = dedupePlayers(rosterEntries(group).filter(starterEntry).map(lineupPlayer)).filter((p) => p.id || p.name);
    if (starters.length >= 11) assign[side] = starters.slice(0, 11);
  }
  if (assign.home.length !== 11 || assign.away.length !== 11) return null;
  const signature = ['home', ...assign.home.map((p) => p.id || norm(p.name)), 'away', ...assign.away.map((p) => p.id || norm(p.name))].join('|');
  return { home: assign.home, away: assign.away, signature: stableKey(signature) };
}

function lineupEvent(snapshot, match, observation, now) {
  const home = text(match?.home?.name || 'Mandante'), away = text(match?.away?.name || 'Visitante');
  return {
    eventKey: `lineup_confirmed:${text(match?.eventId)}:${text(snapshot?.signature)}`,
    type: 'lineup_confirmed', sourcePlayKey: text(snapshot?.signature), eventId: text(match?.eventId), league: text(match?.league),
    competitionKey: text(match?.competitionKey), competitionName: text(match?.competitionName), kickoff: text(match?.kickoff),
    home: { ...(match?.home || {}), score: num(observation?.home?.score, 0) }, away: { ...(match?.away || {}), score: num(observation?.away?.score, 0) },
    scoringTeam: {}, athlete: {}, minute: '', ownGoal: false, penalty: false, shootout: false,
    scoreAfter: { home: num(observation?.home?.score, 0), away: num(observation?.away?.score, 0) },
    lineup: snapshot, detectedAt: new Date(now).toISOString(), confirmedAt: new Date(now).toISOString(),
    notificationDraft: { title: '👥 ESCALAÇÕES CONFIRMADAS', body: `${home} × ${away} · Os times estão definidos.` }
  };
}

export function applyLineupObservation(matchInput, snapshot, observation, nowMs = Date.now()) {
  const match = structuredClone(matchInput || {});
  const now = num(nowMs, Date.now());
  if (text(match?.league || observation?.league) !== 'bra.1' || !snapshot?.signature) return { match, emitted: [] };
  if (num(match?.lineupConfirmedAt, 0) > 0) return { match, emitted: [] };
  const old = match.lineupCandidate || {};
  const same = text(old.signature) === text(snapshot.signature);
  const next = same
    ? { ...snapshot, firstSeenAt: num(old.firstSeenAt, now), stableCount: num(old.stableCount, 0) + 1, lastSeenAt: now }
    : { ...snapshot, firstSeenAt: now, stableCount: 1, lastSeenAt: now };
  match.lineupCandidate = next;
  const confirmed = next.stableCount >= LINEUP_CONFIRM_OBSERVATIONS && now - num(next.firstSeenAt, now) >= LINEUP_CONFIRM_MS;
  if (!confirmed) return { match, emitted: [] };
  match.lineupConfirmedAt = now;
  match.lineup = snapshot;
  return { match, emitted: [lineupEvent(snapshot, match, observation, now)] };
}

export function dueReadinessCheckpoints(game, preflightState = {}, nowMs = Date.now()) {
  const kickoff = Date.parse(game?.kickoff || '');
  if (!Number.isFinite(kickoff)) return [];
  const now = num(nowMs, Date.now());
  if (now < kickoff - PRECHECK_FROM_MS || now > kickoff + 20 * MINUTE) return [];
  return CHECKPOINTS.filter((cp) => now >= kickoff + cp.offsetMs && !preflightState?.[cp.key]?.completedAt);
}

export function readinessSnapshot(game, resolved, match, audience = {}, checkpoint = '', nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  const kickoff = Date.parse(game?.kickoff || '');
  const raw = resolved?.raw || null;
  const rawTeams = raw ? eventTeams(raw) : { home: {}, away: {} };
  const rawState = norm(raw?.status?.type?.state || eventCompetition(raw)?.status?.type?.state || '');
  const teamsOk = Boolean(raw && teamMatches(game?.home, rawTeams.home) && teamMatches(game?.away, rawTeams.away));
  const found = Boolean(raw);
  const initialized = Boolean(match?.initialized);
  const afterStartGate = checkpoint === 'tplus3';
  const startedOk = !afterStartGate || ['in', 'post'].includes(rawState);
  const ready = found && teamsOk && initialized && startedOk;
  const reasons = [];
  if (!found) reasons.push('espn_event_not_found');
  if (found && !teamsOk) reasons.push('team_identity_mismatch');
  if (!initialized) reasons.push('monitor_not_initialized');
  if (!startedOk) reasons.push('espn_still_pre_after_tplus3');
  return {
    version: READINESS_VERSION, checkpoint, readiness: ready ? 'green' : 'red', ready,
    eventId: text(game?.eventId), sourceEventId: text(resolved?.sourceEventId), strategy: text(resolved?.strategy), league: text(game?.league),
    kickoff: text(game?.kickoff), checkedAt: new Date(now).toISOString(), minutesToKickoff: Number.isFinite(kickoff) ? Math.round((kickoff - now) / MINUTE * 10) / 10 : null,
    sourceState: rawState, teamsOk, monitorInitialized: initialized, reasons,
    audience: audience && typeof audience === 'object' ? audience : {}
  };
}

export function aiResolverRequest(game, checkpoint) {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      candidate_event_id: { type: 'string' },
      status: { type: 'string', enum: ['found', 'not_found', 'postponed', 'unknown'] },
      reason: { type: 'string', maxLength: 700 },
      source_urls: { type: 'array', items: { type: 'string' }, maxItems: 8 }
    },
    required: ['candidate_event_id', 'status', 'reason', 'source_urls']
  };
  const dossier = {
    checkpoint, event_id_agenda: text(game?.eventId), league: text(game?.league), kickoff: text(game?.kickoff),
    home: game?.home || {}, away: game?.away || {}, competition: text(game?.competitionName || game?.competitionKey)
  };
  return {
    model: 'gpt-5.6-sol', store: false, reasoning: { effort: 'medium' },
    input: [
      { role: 'developer', content: 'Você é o auditor de prontidão do Fórmula do Gol. Pesquise na web apenas para identificar a partida exata e, se existir evidência pública, o event ID da ESPN. Não invente IDs. Se não houver certeza, candidate_event_id deve ser vazio. A saída será validada novamente contra a própria ESPN antes de qualquer uso operacional.' },
      { role: 'user', content: `Partida esperada: ${JSON.stringify(dossier)}` }
    ],
    max_output_tokens: 1800,
    text: { format: { type: 'json_schema', name: 'fdg_push_readiness', strict: true, schema } },
    tools: [{ type: 'web_search', search_context_size: 'low' }], tool_choice: 'auto', max_tool_calls: 3
  };
}

export function parseOpenAIJson(response) {
  for (const item of response?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && part?.text) {
        try { return JSON.parse(part.text); } catch (_) { return null; }
      }
    }
  }
  return null;
}
