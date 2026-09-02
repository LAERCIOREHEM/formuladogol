import {
  applyObservation,
  extractScoringPlays,
  initialMatchState,
  matchNeedsFastPolling,
  needsSummary,
  normalizeScoreboardEvent,
  summarizeMatch
} from './sports-engine.js';
import { enqueueSportsEvent } from './push-dispatch.js';
import { fetchEspnScoreboard, fetchEspnSummary } from './espn-source.js';

const AGENDA_URL = 'https://formuladogol.com.br/dados-br/agenda-clubes-br.json';
const ALLOWED_LEAGUES = new Set(['bra.1', 'bra.copa_do_brazil', 'conmebol.libertadores', 'conmebol.sudamericana']);
const PRE_WINDOW_MS = 6 * 60 * 60_000;
const POST_WINDOW_MS = 5 * 60 * 60_000;
const PRESERVE_WATCH_MS = 6 * 60 * 60_000;
const FINAL_RETENTION_MS = 10 * 60_000;
const FAST_POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const MIN_POLL_GAP_MS = 20_000;
const MAX_RECENT_EVENTS = 50;
const SCHEDULE_WINDOW_MS = 14 * 24 * 60 * 60_000;
const REMINDER_MIN_MS = 13 * 60_000;
const REMINDER_MAX_MS = 16 * 60_000;
const SCHEDULE_CHANGE_MIN_MS = 2 * 60_000;

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
  if (!eventId || !ALLOWED_LEAGUES.has(league)) return null;
  const statusText = text(item?.status).toLowerCase();
  const postponed = item?.adiado === true || /adiad|postpon/.test(statusText);
  const cancelled = /cancelad|cancelled|canceled/.test(statusText);
  return {
    eventId,
    league,
    kickoff,
    competitionKey: text(item?.competicao_chave || 'brasileirao'),
    competitionName: text(item?.competicao_nome_curto || item?.competicao_nome || ''),
    phase: text(item?.fase),
    leg: item?.perna == null ? null : num(item.perna, 0),
    postponed,
    cancelled,
    dateTbd: item?.data_definir === true,
    statusText: text(item?.status),
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
    if (!Number.isFinite(kickoff)) continue;
    if (kickoff < now - POST_WINDOW_MS || kickoff > now + PRE_WINDOW_MS) continue;
    out.push(game);
  }
  return out;
}


export function selectScheduleSnapshot(payload, nowMs = Date.now(), previousSnapshot = {}) {
  const now = num(nowMs, Date.now());
  const rows = Array.isArray(payload?.jogos) ? payload.jogos : Array.isArray(payload) ? payload : [];
  const previous = previousSnapshot && typeof previousSnapshot === 'object' ? previousSnapshot : {};
  const out = {};
  for (const row of rows) {
    const game = normalizeAgendaGame(row);
    if (!game) continue;
    const kickoff = Date.parse(game.kickoff);
    const tracked = Object.prototype.hasOwnProperty.call(previous, game.eventId);
    const inWindow = Number.isFinite(kickoff) && kickoff >= now - POST_WINDOW_MS && kickoff <= now + SCHEDULE_WINDOW_MS;
    if (!tracked && !inWindow) continue;
    out[game.eventId] = game;
  }
  return out;
}

function brKickoffLabel(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return 'data a confirmar';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date).replace(',', '');
}

function scheduleEvent(type, game, now, previous = null) {
  const kickoffMs = Date.parse(game?.kickoff || '');
  const previousMs = Date.parse(previous?.kickoff || '');
  const base = {
    type,
    sourcePlayKey: '',
    eventId: text(game?.eventId),
    league: text(game?.league),
    competitionKey: text(game?.competitionKey),
    competitionName: text(game?.competitionName),
    kickoff: text(game?.kickoff),
    home: { ...(game?.home || {}), score: 0 },
    away: { ...(game?.away || {}), score: 0 },
    scoringTeam: {}, athlete: {}, minute: '', ownGoal: false, penalty: false, shootout: false,
    scoreAfter: { home: 0, away: 0 },
    detectedAt: new Date(now).toISOString(),
    confirmedAt: new Date(now).toISOString(),
    previousKickoff: text(previous?.kickoff),
    notificationDraft: { title: '', body: '' }
  };
  const matchup = `${text(game?.home?.name || 'Mandante')} × ${text(game?.away?.name || 'Visitante')}`;
  if (type === 'prematch_15') {
    base.eventKey = `prematch_15:${base.eventId}:${Number.isFinite(kickoffMs) ? kickoffMs : text(game?.kickoff)}`;
    base.notificationDraft = {
      title: '⏰ Jogo começa em 15 minutos',
      body: `${matchup} · ${brKickoffLabel(game?.kickoff)}${game?.competitionName ? ` · ${game.competitionName}` : ''}`
    };
  } else if (type === 'match_postponed') {
    base.eventKey = `match_postponed:${base.eventId}:${Number.isFinite(previousMs) ? previousMs : text(previous?.kickoff)}:${Number.isFinite(kickoffMs) ? kickoffMs : text(game?.kickoff)}`;
    base.notificationDraft = {
      title: game?.cancelled ? '🚨 Jogo cancelado' : '🚨 Jogo adiado',
      body: `${matchup}. ${Number.isFinite(kickoffMs) && !game?.dateTbd ? `Nova referência: ${brKickoffLabel(game.kickoff)}.` : 'Nova data a confirmar.'}`
    };
  } else {
    base.eventKey = `schedule_changed:${base.eventId}:${Number.isFinite(previousMs) ? previousMs : text(previous?.kickoff)}:${Number.isFinite(kickoffMs) ? kickoffMs : text(game?.kickoff)}`;
    const restored = previous?.postponed && !game?.postponed;
    base.notificationDraft = {
      title: restored ? '🕒 Nova data confirmada' : '🕒 Horário do jogo alterado',
      body: `${matchup}: ${brKickoffLabel(game?.kickoff)}${game?.competitionName ? ` · ${game.competitionName}` : ''}`
    };
  }
  return base;
}

export function deriveScheduleEvents(previousSnapshot, nextSnapshot, nowMs = Date.now(), hadBaseline = true) {
  const now = num(nowMs, Date.now());
  const previous = previousSnapshot && typeof previousSnapshot === 'object' ? previousSnapshot : {};
  const next = nextSnapshot && typeof nextSnapshot === 'object' ? nextSnapshot : {};
  const events = [];
  for (const game of Object.values(next)) {
    const kickoff = Date.parse(game?.kickoff || '');
    const remaining = kickoff - now;
    if (!game?.postponed && !game?.cancelled && Number.isFinite(kickoff) && remaining >= REMINDER_MIN_MS && remaining <= REMINDER_MAX_MS) {
      events.push(scheduleEvent('prematch_15', game, now));
    }
    if (!hadBaseline) continue;
    const old = previous[game.eventId];
    if (!old) continue;
    if ((!old.postponed && game.postponed) || (!old.cancelled && game.cancelled)) {
      events.push(scheduleEvent('match_postponed', game, now, old));
      continue;
    }
    const oldKickoff = Date.parse(old.kickoff || '');
    if (old.postponed && !game.postponed) {
      events.push(scheduleEvent('schedule_changed', game, now, old));
      continue;
    }
    if (Number.isFinite(oldKickoff) && Number.isFinite(kickoff) && Math.abs(kickoff - oldKickoff) >= SCHEDULE_CHANGE_MIN_MS) {
      events.push(scheduleEvent('schedule_changed', game, now, old));
    }
  }
  return events;
}

async function fetchAgendaJson(url) {
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

function eventMap(payload) {
  const map = new Map();
  for (const event of payload?.events || []) {
    const id = text(event?.id || event?.competitions?.[0]?.id);
    if (id) map.set(id, event);
  }
  return map;
}

function scoreboardScoringDetails(raw) {
  const competition = raw?.competitions?.[0] || raw?.competition || {};
  const candidates = [competition?.details, raw?.details, competition?.scoringPlays, raw?.scoringPlays];
  for (const value of candidates) if (Array.isArray(value) && value.length) return value;
  return [];
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
    const [watchlist, matches, status, recentEvents, scheduleSnapshot] = await Promise.all([
      this.state.storage.get('watchlist'),
      this.state.storage.get('matches'),
      this.state.storage.get('status'),
      this.state.storage.get('recentEvents'),
      this.state.storage.get('scheduleSnapshot')
    ]);
    return {
      watchlist: watchlist && typeof watchlist === 'object' ? watchlist : {},
      matches: matches && typeof matches === 'object' ? matches : {},
      status: status && typeof status === 'object' ? status : {},
      recentEvents: Array.isArray(recentEvents) ? recentEvents : [],
      scheduleSnapshot: scheduleSnapshot && typeof scheduleSnapshot === 'object' ? scheduleSnapshot : {}
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
    let scheduleSnapshot = { ...current.scheduleSnapshot };
    let agendaError = '';
    let scheduleEvents = [];
    try {
      const agenda = await fetchAgendaJson(AGENDA_URL);
      candidates = selectAgendaCandidates(agenda, now);
      scheduleSnapshot = selectScheduleSnapshot(agenda, now, current.scheduleSnapshot);
      scheduleEvents = deriveScheduleEvents(current.scheduleSnapshot, scheduleSnapshot, now, Boolean(current.status.scheduleBaselineAt));
    } catch (error) {
      agendaError = text(error?.message || error);
    }

    for (const event of scheduleEvents) await this.recordEvent(event);
    if (!agendaError) await this.state.storage.put('scheduleSnapshot', scheduleSnapshot);

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
      scheduleBaselineAt: agendaError ? num(current.status.scheduleBaselineAt, 0) : (num(current.status.scheduleBaselineAt, 0) || now),
      scheduleEventsThisBootstrap: scheduleEvents.length,
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
    const goalEvent = row.event_type === 'goal' || row.event_type === 'goal_overturned';
    const inserted = goalEvent
      ? await this.env.DB.prepare(`
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
      ).run()
      : await this.env.DB.prepare(`
        INSERT OR IGNORE INTO match_events (event_key,event_id,event_type,confirmed_at,payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).bind(row.event_key,row.event_id,row.event_type,row.confirmed_at,row.payload_json).run();
    if (Number(inserted?.meta?.changes || 0) > 0) {
      try {
        await enqueueSportsEvent(this.env, row.event_key);
      } catch (error) {
        console.error('sports_event_queue_enqueue_failed', row.event_key, String(error?.message || error));
      }
    }
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
    const scoreboardSources = {};
    const sourceAttempts = {};
    const summarySources = {};
    const summaryGoalCounts = {};
    await Promise.all([...byLeague.entries()].map(async ([league, games]) => {
      try {
        const days = games.map((game) => brDateKey(game.kickoff)).filter(Boolean).sort();
        const start = days[0] || brDateKey(Date.now());
        const end = days.at(-1) || start;
        const dates = start === end ? start : `${start}-${end}`;
        const result = await fetchEspnScoreboard(league, dates);
        scoreboardResults.set(league, eventMap(result.data));
        scoreboardSources[league] = result.source;
        sourceAttempts[league] = result.attempts;
      } catch (error) {
        sourceAttempts[league] = Array.isArray(error?.attempts) ? error.attempts : [];
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
        const expectedGoals = num(observation.home?.score, 0) + num(observation.away?.score, 0);
        const scoreboardDetails = scoreboardScoringDetails(raw);
        if (scoreboardDetails.length) {
          const candidate = extractScoringPlays({ scoringPlays: scoreboardDetails }, observation);
          const regulationCount = candidate.filter((play) => !play.shootout).length;
          if (regulationCount >= expectedGoals && (expectedGoals === 0 || candidate.some((play) => text(play.athleteName)))) {
            plays = candidate;
            summarySources.espn_scoreboard_details = num(summarySources.espn_scoreboard_details, 0) + 1;
            summaryGoalCounts[game.eventId] = regulationCount;
          }
        }
        if (!plays) {
          try {
            const summaryResult = await fetchEspnSummary(game.league, game.eventId, globalThis.fetch, expectedGoals);
            plays = extractScoringPlays(summaryResult.data, observation);
            summariesFetched += 1;
            summarySources[summaryResult.source] = num(summarySources[summaryResult.source], 0) + 1;
            summaryGoalCounts[game.eventId] = plays.filter((play) => !play.shootout).length;
          } catch (error) {
            sourceErrors.push(`${game.league}/${game.eventId}/summary: ${text(error?.message || error)}`);
          }
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
      lastPollSuccessAt: sourceErrors.length ? num(snapshot.status.lastPollSuccessAt, 0) : Date.now(),
      lastPollDurationMs: Date.now() - startedAt,
      lastPollError: sourceErrors.join(' | ').slice(0, 2000),
      observedGames,
      activeGames: liveGames,
      summariesFetched,
      emittedThisPoll: newlyEmitted.length,
      totalRecentEvents: recentEvents.length,
      scoreboardSources,
      summarySources,
      summaryGoalCounts,
      sourceAttempts,
      sourceLayerVersion: '6-R3'
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
      lastPollSuccessAt: num(snapshot.status.lastPollSuccessAt, 0),
      lastPollDurationMs: num(snapshot.status.lastPollDurationMs, 0),
      lastPollError: text(snapshot.status.lastPollError),
      summariesFetched: num(snapshot.status.summariesFetched, 0),
      emittedThisPoll: num(snapshot.status.emittedThisPoll, 0),
      scheduleEventsThisBootstrap: num(snapshot.status.scheduleEventsThisBootstrap, 0),
      sourceLayerVersion: text(snapshot.status.sourceLayerVersion || '6-R3'),
      scoreboardSources: snapshot.status.scoreboardSources && typeof snapshot.status.scoreboardSources === 'object' ? snapshot.status.scoreboardSources : {},
      summarySources: snapshot.status.summarySources && typeof snapshot.status.summarySources === 'object' ? snapshot.status.summarySources : {},
      summaryGoalCounts: snapshot.status.summaryGoalCounts && typeof snapshot.status.summaryGoalCounts === 'object' ? snapshot.status.summaryGoalCounts : {},
      sourceAttempts: snapshot.status.sourceAttempts && typeof snapshot.status.sourceAttempts === 'object' ? snapshot.status.sourceAttempts : {},
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
      const now = Date.now();
      const staleBootstrap = !num(status.lastBootstrapAt, 0) || now - num(status.lastBootstrapAt, 0) > 3 * 60_000;
      const staleLivePoll = num(status.activeGames, 0) > 0 && now - num(status.lastPollCompletedAt, 0) > 90_000;
      return Response.json((staleBootstrap || staleLivePoll) ? await this.bootstrap() : await this.publicStatus());
    }
    if (url.pathname === '/recent' && request.method === 'GET') {
      const recentEvents = await this.state.storage.get('recentEvents') || [];
      return Response.json({ ok: true, events: recentEvents.slice(-20).reverse() });
    }
    return new Response('Not found', { status: 404 });
  }
}
