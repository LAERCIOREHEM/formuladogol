import {
  applyObservation,
  extractScoringPlays,
  initialMatchState,
  matchNeedsFastPolling,
  needsSummary,
  normalizeScoreboardEvent,
  summarizeMatch
} from './sports-engine.js';

const AGENDA_URL = 'https://formuladogol.com.br/dados-br/agenda-clubes-br.json';
const ESPN_ROOT = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ALLOWED_LEAGUES = new Set(['bra.1', 'bra.copa_do_brazil', 'conmebol.libertadores', 'conmebol.sudamericana']);
const PRE_WINDOW_MS = 6 * 60 * 60_000;
const POST_WINDOW_MS = 5 * 60 * 60_000;
const PRESERVE_WATCH_MS = 6 * 60 * 60_000;
const FINAL_RETENTION_MS = 10 * 60_000;
const FAST_POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const MIN_POLL_GAP_MS = 20_000;
const MAX_RECENT_EVENTS = 30;

function text(value) { return String(value == null ? '' : value).trim(); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }

function teamFromAgenda(value) {
  const item = value || {};
  return { id: text(item.espn_id || item.id), name: text(item.nome || item.name), abbreviation: text(item.sigla || item.abbreviation) };
}

function normalizeAgendaGame(item) {
  const league = text(item?.espn_league || 'bra.1');
  const eventId = text(item?.event_id || item?.id);
  const kickoff = text(item?.data_iso || item?.date);
  if (!eventId || !ALLOWED_LEAGUES.has(league) || !Number.isFinite(Date.parse(kickoff))) return null;
  return {
    eventId,
    league,
    kickoff,
    competitionKey: text(item?.competicao_chave || 'brasileirao'),
    competitionName: text(item?.competicao_nome_curto || item?.competicao_nome || ''),
    home: teamFromAgenda(item?.mandante || item?.home),
    away: teamFromAgenda(item?.visitante || item?.away)
  };
}

export function selectAgendaCandidates(payload, nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  const rows = Array.isArray(payload?.jogos) ? payload.jogos : Array.isArray(payload) ? payload : [];
  const out = [];
  for (const row of rows) {
    const game = normalizeAgendaGame(row);
    if (!game) continue;
    const kickoff = Date.parse(game.kickoff);
    if (kickoff < now - POST_WINDOW_MS || kickoff > now + PRE_WINDOW_MS) continue;
    out.push(game);
  }
  return out;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}_fdg=${Date.now()}`, {
      signal: controller.signal,
      headers: { 'accept': 'application/json', 'cache-control': 'no-cache' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${new URL(url).hostname}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function brDateKey(isoOrMs) {
  const date = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function scoreboardUrl(league, games) {
  const days = games.map((game) => brDateKey(game.kickoff)).filter(Boolean).sort();
  const start = days[0] || brDateKey(Date.now());
  const end = days.at(-1) || start;
  const dates = start === end ? start : `${start}-${end}`;
  return `${ESPN_ROOT}/${encodeURIComponent(league)}/scoreboard?dates=${dates}&limit=100`;
}

function summaryUrl(league, eventId) {
  return `${ESPN_ROOT}/${encodeURIComponent(league)}/summary?event=${encodeURIComponent(eventId)}`;
}

function eventMap(payload) {
  const map = new Map();
  for (const event of payload?.events || []) {
    const id = text(event?.id || event?.competitions?.[0]?.id);
    if (id) map.set(id, event);
  }
  return map;
}

function activeWatchEntry(entry, now) {
  const kickoff = Date.parse(entry?.kickoff || '');
  if (!Number.isFinite(kickoff)) return false;
  if (entry?.lastState === 'in') return true;
  if (entry?.lastState === 'post') {
    const finalSince = num(entry?.finalSince, 0);
    return finalSince > 0 && now - finalSince <= FINAL_RETENTION_MS;
  }
  return kickoff >= now - PRESERVE_WATCH_MS && kickoff <= now + PRE_WINDOW_MS;
}

function eventRow(event) {
  const payload = event || {};
  return {
    event_key: text(payload.eventKey),
    event_id: text(payload.eventId),
    event_type: text(payload.type),
    source_play_key: text(payload.sourcePlayKey),
    league: text(payload.league),
    competition_key: text(payload.competitionKey),
    competition_name: text(payload.competitionName),
    home_team_id: text(payload.home?.id),
    home_team_name: text(payload.home?.name),
    away_team_id: text(payload.away?.id),
    away_team_name: text(payload.away?.name),
    scoring_team_id: text(payload.scoringTeam?.id),
    scoring_team_name: text(payload.scoringTeam?.name),
    athlete_id: text(payload.athlete?.id),
    athlete_name: text(payload.athlete?.name),
    minute: text(payload.minute),
    home_score: num(payload.scoreAfter?.home, payload.home?.score || 0),
    away_score: num(payload.scoreAfter?.away, payload.away?.score || 0),
    own_goal: payload.ownGoal ? 1 : 0,
    penalty_goal: payload.penalty ? 1 : 0,
    shootout: payload.shootout ? 1 : 0,
    detected_at: text(payload.detectedAt),
    confirmed_at: text(payload.confirmedAt),
    payload_json: JSON.stringify(payload)
  };
}

export class SportsMonitor {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pollPromise = null;
  }

  async readState() {
    const [watchlist, matches, status, recentEvents] = await Promise.all([
      this.state.storage.get('watchlist'),
      this.state.storage.get('matches'),
      this.state.storage.get('status'),
      this.state.storage.get('recentEvents')
    ]);
    return {
      watchlist: watchlist && typeof watchlist === 'object' ? watchlist : {},
      matches: matches && typeof matches === 'object' ? matches : {},
      status: status && typeof status === 'object' ? status : {},
      recentEvents: Array.isArray(recentEvents) ? recentEvents : []
    };
  }

  async writeStatus(patch) {
    const current = await this.state.storage.get('status') || {};
    const next = { ...current, ...patch };
    await this.state.storage.put('status', next);
    return next;
  }

  async bootstrap() {
    const now = Date.now();
    const current = await this.readState();
    let candidates = [];
    let agendaError = '';
    try {
      const agenda = await fetchJson(AGENDA_URL);
      candidates = selectAgendaCandidates(agenda, now);
    } catch (error) {
      agendaError = text(error?.message || error);
    }

    const watchlist = {};
    for (const candidate of candidates) {
      const previous = current.watchlist[candidate.eventId] || {};
      if (previous.lastState === 'post' && num(previous.finalSince, 0) > 0 && now - num(previous.finalSince, 0) > FINAL_RETENTION_MS) continue;
      watchlist[candidate.eventId] = {
        ...candidate,
        lastState: previous.lastState || 'pre',
        finalSince: num(previous.finalSince, 0)
      };
    }
    for (const [eventId, previous] of Object.entries(current.watchlist)) {
      if (!watchlist[eventId] && activeWatchEntry(previous, now)) watchlist[eventId] = previous;
    }
    await this.state.storage.put('watchlist', watchlist);
    await this.writeStatus({
      lastBootstrapAt: now,
      lastAgendaSuccessAt: agendaError ? current.status.lastAgendaSuccessAt || 0 : now,
      lastAgendaError: agendaError,
      watchCount: Object.keys(watchlist).length
    });

    const lastPollAt = num(current.status.lastPollAt, 0);
    if (Object.keys(watchlist).length && now - lastPollAt >= MIN_POLL_GAP_MS) await this.pollOnce();
    await this.ensureNextAlarm();
    return this.publicStatus();
  }

  async ensureNextAlarm() {
    const snapshot = await this.readState();
    const now = Date.now();
    const fast = Object.values(snapshot.matches).some((match) => matchNeedsFastPolling(match, now));
    if (fast) {
      const currentAlarm = await this.state.storage.getAlarm();
      const desired = now + FAST_POLL_MS;
      if (currentAlarm == null || currentAlarm > desired + 5_000) await this.state.storage.setAlarm(desired);
    }
  }

  async recordEvent(event) {
    const row = eventRow(event);
    await this.env.DB.prepare(`
      INSERT OR IGNORE INTO sports_events (
        event_key,event_id,event_type,source_play_key,league,competition_key,competition_name,
        home_team_id,home_team_name,away_team_id,away_team_name,scoring_team_id,scoring_team_name,
        athlete_id,athlete_name,minute,home_score,away_score,own_goal,penalty_goal,shootout,
        detected_at,confirmed_at,payload_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      row.event_key,row.event_id,row.event_type,row.source_play_key,row.league,row.competition_key,row.competition_name,
      row.home_team_id,row.home_team_name,row.away_team_id,row.away_team_name,row.scoring_team_id,row.scoring_team_name,
      row.athlete_id,row.athlete_name,row.minute,row.home_score,row.away_score,row.own_goal,row.penalty_goal,row.shootout,
      row.detected_at,row.confirmed_at,row.payload_json
    ).run();
  }

  async pollOnce() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this._pollOnce().finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  async _pollOnce() {
    const startedAt = Date.now();
    const snapshot = await this.readState();
    if (startedAt - num(snapshot.status.lastPollAt, 0) < MIN_POLL_GAP_MS) return this.publicStatus();
    const watchEntries = Object.values(snapshot.watchlist).filter((entry) => activeWatchEntry(entry, startedAt));
    if (!watchEntries.length) {
      await this.writeStatus({ lastPollAt: startedAt, lastPollDurationMs: 0, activeGames: 0, lastPollError: '' });
      return this.publicStatus();
    }

    const byLeague = new Map();
    for (const game of watchEntries) {
      if (!byLeague.has(game.league)) byLeague.set(game.league, []);
      byLeague.get(game.league).push(game);
    }

    const scoreboardResults = new Map();
    const sourceErrors = [];
    await Promise.all([...byLeague.entries()].map(async ([league, games]) => {
      try {
        const payload = await fetchJson(scoreboardUrl(league, games));
        scoreboardResults.set(league, eventMap(payload));
      } catch (error) {
        sourceErrors.push(`${league}: ${text(error?.message || error)}`);
      }
    }));

    const matches = { ...snapshot.matches };
    const watchlist = { ...snapshot.watchlist };
    const newlyEmitted = [];
    let summariesFetched = 0;
    let observedGames = 0;
    let liveGames = 0;

    for (const game of watchEntries) {
      const raw = scoreboardResults.get(game.league)?.get(game.eventId);
      if (!raw) continue;
      observedGames += 1;
      const observation = normalizeScoreboardEvent(raw, game.league, game);
      if (observation.state === 'in') liveGames += 1;
      const previousWatch = watchlist[game.eventId] || game;
      watchlist[game.eventId] = {
        ...game,
        lastState: observation.state,
        lastObservedAt: startedAt,
        finalSince: observation.state === 'post' ? (num(previousWatch.finalSince, 0) || startedAt) : 0
      };
      const previous = matches[game.eventId] || initialMatchState(observation);
      let plays = null;
      if (needsSummary(previous, observation)) {
        try {
          const summary = await fetchJson(summaryUrl(game.league, game.eventId));
          plays = extractScoringPlays(summary, observation);
          summariesFetched += 1;
        } catch (error) {
          sourceErrors.push(`${game.league}/${game.eventId}/summary: ${text(error?.message || error)}`);
        }
      }
      const result = applyObservation(previous, observation, plays, startedAt);
      for (const event of result.emitted) {
        await this.recordEvent(event);
        newlyEmitted.push(event);
      }
      matches[game.eventId] = result.match;
    }

    let recentEvents = [...snapshot.recentEvents, ...newlyEmitted];
    if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents = recentEvents.slice(-MAX_RECENT_EVENTS);
    const finishedCutoff = startedAt - PRESERVE_WATCH_MS;
    for (const [eventId, match] of Object.entries(matches)) {
      const kickoff = Date.parse(match?.kickoff || '');
      if (match?.state === 'post' && Number.isFinite(kickoff) && kickoff < finishedCutoff) delete matches[eventId];
    }

    await this.state.storage.put({ watchlist, matches, recentEvents });
    await this.writeStatus({
      lastPollAt: startedAt,
      lastPollCompletedAt: Date.now(),
      lastPollDurationMs: Date.now() - startedAt,
      lastPollError: sourceErrors.join(' | ').slice(0, 2000),
      observedGames,
      activeGames: liveGames,
      summariesFetched,
      emittedThisPoll: newlyEmitted.length,
      totalRecentEvents: recentEvents.length
    });
    await this.ensureNextAlarm();
    return this.publicStatus();
  }

  async publicStatus() {
    const snapshot = await this.readState();
    const matches = Object.values(snapshot.matches).map(summarizeMatch).sort((a, b) => a.eventId.localeCompare(b.eventId));
    return {
      ok: true,
      engineVersion: 4,
      watchCount: Object.keys(snapshot.watchlist).length,
      matchCount: matches.length,
      activeGames: matches.filter((m) => m.state === 'in').length,
      pendingGoals: matches.reduce((sum, m) => sum + m.pendingGoals, 0),
      lastBootstrapAt: num(snapshot.status.lastBootstrapAt, 0),
      lastAgendaSuccessAt: num(snapshot.status.lastAgendaSuccessAt, 0),
      lastAgendaError: text(snapshot.status.lastAgendaError),
      lastPollAt: num(snapshot.status.lastPollAt, 0),
      lastPollCompletedAt: num(snapshot.status.lastPollCompletedAt, 0),
      lastPollDurationMs: num(snapshot.status.lastPollDurationMs, 0),
      lastPollError: text(snapshot.status.lastPollError),
      summariesFetched: num(snapshot.status.summariesFetched, 0),
      emittedThisPoll: num(snapshot.status.emittedThisPoll, 0),
      matches
    };
  }

  async alarm() {
    await this.pollOnce();
    await this.ensureNextAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/bootstrap' && request.method === 'POST') return Response.json(await this.bootstrap());
    if (url.pathname === '/poll' && request.method === 'POST') return Response.json(await this.pollOnce());
    if (url.pathname === '/status' && request.method === 'GET') {
      const status = await this.state.storage.get('status') || {};
      return Response.json(status.lastBootstrapAt ? await this.publicStatus() : await this.bootstrap());
    }
    if (url.pathname === '/recent' && request.method === 'GET') {
      const recentEvents = await this.state.storage.get('recentEvents') || [];
      return Response.json({ ok: true, events: recentEvents.slice(-20).reverse() });
    }
    return new Response('Not found', { status: 404 });
  }
}
