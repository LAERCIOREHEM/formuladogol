const GOAL_CONFIRM_MS = 45_000;
const GOAL_CONFIRM_OBSERVATIONS = 2;
const OVERTURN_CONFIRM_OBSERVATIONS = 2;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalized(value) {
  return text(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function compactPlayerName(value) {
  const raw = text(value).replace(/\s+/g, ' ');
  if (!raw) return '';
  const parts = raw.split(' ').filter(Boolean);
  const suffixes = new Set(['junior', 'júnior', 'neto', 'filho', 'sobrinho', 'ii', 'iii', 'iv']);
  while (parts.length > 1 && suffixes.has(normalized(parts.at(-1)))) parts.pop();
  if (parts.length <= 2) return parts.join(' ');
  const particles = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  const generic = new Set(['silva', 'santos', 'souza', 'sousa', 'oliveira', 'pereira', 'costa', 'lima', 'alves', 'rocha', 'nascimento', 'ferreira', 'gomes', 'ribeiro', 'martins', 'carvalho']);
  let last = parts.length - 1;
  while (last > 1 && (particles.has(normalized(parts[last])) || generic.has(normalized(parts[last])))) last -= 1;
  while (last > 1 && particles.has(normalized(parts[last]))) last -= 1;
  return `${parts[0]} ${parts[last]}`;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  const input = String(value || '');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function getCompetition(event) {
  return event?.competitions?.[0] || event?.competition || {};
}

function teamShape(competitor) {
  const t = competitor?.team || {};
  return {
    id: text(t.id || competitor?.id),
    name: text(t.displayName || t.shortDisplayName || t.name || t.location || competitor?.displayName),
    abbreviation: text(t.abbreviation || competitor?.abbreviation),
    winner: competitor?.winner === true
  };
}

function scoreOf(competitor) {
  if (competitor == null) return 0;
  const raw = competitor.score?.value ?? competitor.score?.displayValue ?? competitor.score;
  return Math.max(0, num(raw, 0));
}

function shootoutScoreOf(competitor) {
  const raw = competitor?.shootoutScore?.value ?? competitor?.shootoutScore?.displayValue ?? competitor?.shootoutScore
    ?? competitor?.penaltyShootoutScore?.value ?? competitor?.penaltyShootoutScore?.displayValue ?? competitor?.penaltyShootoutScore;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function aggregateScoreOf(competitor) {
  const raw = competitor?.aggregateScore?.value ?? competitor?.aggregateScore?.displayValue ?? competitor?.aggregateScore;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function isCupCompetition(value) {
  const key = normalized(value);
  return /copa do brasil|copa_do_brasil|libertadores|sudamericana|sul americana/.test(key);
}

export function normalizeScoreboardEvent(event, league, agendaGame = null) {
  const competition = getCompetition(event);
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const homeRaw = competitors.find((item) => item?.homeAway === 'home') || competitors[0] || {};
  const awayRaw = competitors.find((item) => item?.homeAway === 'away') || competitors[1] || {};
  const status = event?.status || competition?.status || {};
  const statusType = status?.type || {};
  const sourceState = text(statusType.state || (statusType.completed ? 'post' : 'pre')).toLowerCase();
  const statusLabel = [statusType.name, statusType.description, statusType.detail, statusType.shortDetail, status.displayClock].filter(Boolean).join(' ');
  const statusText = normalized(statusLabel);
  const explicitFinal = statusType.completed === true || /(^| )(ft|full time|final|fim de jogo)( |$)/.test(statusText);
  const clockLooksLive = /^\d{1,3}(?:\+\d+)?/.test(text(status.displayClock || statusType.shortDetail));
  let safeState = sourceState === 'in' ? 'in' : explicitFinal ? 'post' : 'pre';
  if (sourceState === 'post' && !explicitFinal && clockLooksLive) safeState = 'in';
  const home = teamShape(homeRaw);
  const away = teamShape(awayRaw);
  const agendaHome = agendaGame?.home || {};
  const agendaAway = agendaGame?.away || {};
  if (!home.name) home.name = text(agendaHome.name);
  if (!home.id) home.id = text(agendaHome.id);
  if (!away.name) away.name = text(agendaAway.name);
  if (!away.id) away.id = text(agendaAway.id);
  const homeShootout = shootoutScoreOf(homeRaw);
  const awayShootout = shootoutScoreOf(awayRaw);
  const homeAggregate = aggregateScoreOf(homeRaw);
  const awayAggregate = aggregateScoreOf(awayRaw);
  const shootoutByStatus = /penalty shootout|shootout|penaltis|penalties|disputa de penaltis/.test(statusText);
  const shootoutActive = shootoutByStatus || num(homeShootout, 0) > 0 || num(awayShootout, 0) > 0;
  return {
    eventId: text(event?.id || competition?.id || agendaGame?.eventId),
    league: text(league || agendaGame?.league),
    competitionKey: text(agendaGame?.competitionKey),
    competitionName: text(agendaGame?.competitionName),
    phase: text(agendaGame?.phase),
    leg: agendaGame?.leg == null ? null : num(agendaGame.leg, 0),
    kickoff: text(event?.date || competition?.date || agendaGame?.kickoff),
    state: safeState,
    completed: statusType.completed === true,
    clock: text(status.displayClock || statusType.shortDetail || statusType.detail),
    statusLabel: text(statusLabel),
    period: num(status.period || competition.period, 0),
    shootoutActive,
    shootoutScore: { home: homeShootout, away: awayShootout },
    aggregateScore: { home: homeAggregate, away: awayAggregate },
    home: { ...home, score: scoreOf(homeRaw) },
    away: { ...away, score: scoreOf(awayRaw) },
    observedAt: Date.now()
  };
}

function rosterNameMap(summary) {
  const names = {};
  const add = (athlete) => {
    if (!athlete) return;
    const id = text(athlete.id);
    const name = compactPlayerName(athlete.shortName || athlete.displayName || athlete.fullName || athlete.name);
    if (id && name) names[id] = name;
  };
  for (const group of summary?.rosters || []) {
    for (const entry of group?.roster || group?.athletes || []) add(entry?.athlete || entry);
  }
  for (const team of summary?.boxscore?.players || []) {
    for (const group of team?.statistics || []) {
      for (const entry of group?.athletes || []) add(entry?.athlete || entry);
    }
  }
  return names;
}

function eventMinute(item) {
  return text(item?.clock?.displayValue || item?.displayClock || item?.clock || '');
}

function minuteOrder(minute, period, index) {
  const match = text(minute).match(/(\d{1,3})(?:\+(\d+))?/);
  const base = match ? num(match[1], 999) : 999;
  const added = match ? num(match[2], 0) : 0;
  return num(period, 0) * 100000 + base * 100 + added + index / 1000;
}

function isGoalItem(item) {
  const descriptor = normalized([
    item?.type?.text, item?.type?.name, item?.type?.description,
    item?.text, item?.description
  ].filter(Boolean).join(' '));
  return item?.scoringPlay === true || /(^| )goal( |$)|(^| )gol( |$)/.test(descriptor);
}

function isShootoutItem(item) {
  const descriptor = normalized([
    item?.type?.text, item?.type?.name, item?.type?.description,
    item?.text, item?.description
  ].filter(Boolean).join(' '));
  return Boolean(
    item?.shootout === true || item?.penaltyShootout === true || item?.isShootout === true ||
    /penalty shootout|shootout|disputa de penaltis/.test(descriptor)
  );
}

function isPenaltyGoal(item) {
  const descriptor = normalized([
    item?.type?.text, item?.type?.name, item?.type?.description,
    item?.text, item?.description
  ].filter(Boolean).join(' '));
  return !isShootoutItem(item) && /penalty|penalti/.test(descriptor);
}

function isOwnGoal(item) {
  const descriptor = normalized([
    item?.type?.text, item?.type?.name, item?.type?.description,
    item?.text, item?.description
  ].filter(Boolean).join(' '));
  return item?.ownGoal === true || /own goal|gol contra/.test(descriptor);
}

function athleteOf(item, roster) {
  const involved = Array.isArray(item?.athletesInvolved) ? item.athletesInvolved : [];
  const athlete = involved[0] || item?.athlete || item?.player || null;
  if (!athlete) return { id: '', name: '' };
  const id = text(athlete.id);
  const name = compactPlayerName((id && roster[id]) || athlete.shortName || athlete.displayName || athlete.fullName || athlete.name);
  return { id, name };
}

function rawScore(item, key) {
  const value = item?.[key] ?? item?.score?.[key] ?? item?.score?.[key === 'homeScore' ? 'home' : 'away'];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function extractScoringPlays(summary, match) {
  const primary = Array.isArray(summary?.scoringPlays) ? summary.scoringPlays : [];
  const fallback = Array.isArray(summary?.plays) ? summary.plays : [];
  const source = primary.length ? primary : fallback.filter(isGoalItem);
  const roster = rosterNameMap(summary || {});
  const homeId = text(match?.home?.id);
  const awayId = text(match?.away?.id);
  const seen = new Set();
  const rows = [];

  source.forEach((item, index) => {
    if (!isGoalItem(item)) return;
    const shootout = isShootoutItem(item);
    const teamId = text(item?.team?.id || item?.teamId || item?.competitor?.id);
    const minute = eventMinute(item);
    const athlete = athleteOf(item, roster);
    const description = text(item?.text || item?.description || item?.type?.text || item?.type?.description);
    let side = teamId && teamId === homeId ? 'home' : teamId && teamId === awayId ? 'away' : '';
    const explicitHomeScore = rawScore(item, 'homeScore');
    const explicitAwayScore = rawScore(item, 'awayScore');
    const identitySeed = [match?.eventId, teamId, minute, athlete.id, athlete.name, description, explicitHomeScore, explicitAwayScore].join('|');
    const rawId = text(item?.id || item?.playId || item?.uid);
    const key = rawId ? `${match.eventId}:${rawId}` : `${match.eventId}:fp-${fnv1a(identitySeed)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      key,
      sourceId: rawId,
      teamId,
      side,
      athleteId: athlete.id,
      athleteName: athlete.name,
      minute,
      period: num(item?.period?.number || item?.period || item?.clock?.period, 0),
      description,
      ownGoal: isOwnGoal(item),
      penalty: isPenaltyGoal(item),
      shootout,
      homeScoreAfter: explicitHomeScore,
      awayScoreAfter: explicitAwayScore,
      order: minuteOrder(minute, item?.period?.number || item?.period || item?.clock?.period, index)
    });
  });

  rows.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

  let homeCount = 0;
  let awayCount = 0;
  for (const play of rows) {
    if (play.shootout) continue;
    if (!play.side && play.homeScoreAfter != null && play.awayScoreAfter != null) {
      if (play.homeScoreAfter > homeCount && play.awayScoreAfter === awayCount) play.side = 'home';
      else if (play.awayScoreAfter > awayCount && play.homeScoreAfter === homeCount) play.side = 'away';
    }
    if (play.homeScoreAfter != null && play.awayScoreAfter != null) {
      homeCount = play.homeScoreAfter;
      awayCount = play.awayScoreAfter;
    } else if (play.side === 'home') {
      homeCount += 1;
      play.homeScoreAfter = homeCount;
      play.awayScoreAfter = awayCount;
    } else if (play.side === 'away') {
      awayCount += 1;
      play.homeScoreAfter = homeCount;
      play.awayScoreAfter = awayCount;
    }
  }
  return rows;
}

export function initialMatchState(observation) {
  return {
    eventId: text(observation?.eventId),
    league: text(observation?.league),
    competitionKey: text(observation?.competitionKey),
    competitionName: text(observation?.competitionName),
    phase: text(observation?.phase),
    leg: observation?.leg == null ? null : num(observation.leg, 0),
    kickoff: text(observation?.kickoff),
    initialized: false,
    baselineComplete: false,
    state: text(observation?.state || 'pre'),
    completed: Boolean(observation?.completed),
    clock: text(observation?.clock),
    period: num(observation?.period, 0),
    shootoutActive: Boolean(observation?.shootoutActive),
    shootoutScore: {
      home: observation?.shootoutScore?.home ?? null,
      away: observation?.shootoutScore?.away ?? null
    },
    aggregateScore: {
      home: observation?.aggregateScore?.home ?? null,
      away: observation?.aggregateScore?.away ?? null
    },
    home: { ...(observation?.home || {}), score: num(observation?.home?.score, 0) },
    away: { ...(observation?.away || {}), score: num(observation?.away?.score, 0) },
    plays: {},
    lastObservedAt: 0,
    lastSummaryAt: 0,
    lastScoreChangeAt: 0
  };
}

function activeRegulationPlays(match) {
  return Object.values(match?.plays || {}).filter((play) => play && !play.shootout && !['rejected', 'overturned'].includes(play.status));
}

function goalCountFromScore(observation) {
  return num(observation?.home?.score, 0) + num(observation?.away?.score, 0);
}

export function needsSummary(match, observation) {
  const current = match || initialMatchState(observation);
  const scoreTotal = goalCountFromScore(observation);
  if (!current.initialized) return scoreTotal > 0;
  if (!current.baselineComplete) return true;
  const activeKnown = activeRegulationPlays(current).length;
  if (activeKnown !== scoreTotal) return true;
  if (Object.values(current.plays || {}).some((play) => play?.status === 'pending')) return true;
  if (goalCountFromScore(current) !== scoreTotal) return true;
  return false;
}

function scoringTeamFor(play, match) {
  if (play.side === 'home') return match.home || {};
  if (play.side === 'away') return match.away || {};
  if (play.teamId && play.teamId === text(match.home?.id)) return match.home || {};
  if (play.teamId && play.teamId === text(match.away?.id)) return match.away || {};
  return { id: play.teamId || '', name: '' };
}

function notificationDraft(type, play, match, observation) {
  const scoreHome = play?.homeScoreAfter != null ? play.homeScoreAfter : num(observation?.home?.score, 0);
  const scoreAway = play?.awayScoreAfter != null ? play.awayScoreAfter : num(observation?.away?.score, 0);
  const scoreText = `${match.home?.name || 'Mandante'} ${scoreHome} × ${scoreAway} ${match.away?.name || 'Visitante'}`;
  if (type === 'goal_overturned') {
    return { title: '🚫 GOL ANULADO', body: `O placar voltou para ${match.home?.name || 'Mandante'} ${num(observation?.home?.score, 0)} × ${num(observation?.away?.score, 0)} ${match.away?.name || 'Visitante'}` };
  }
  const scoringTeam = scoringTeamFor(play, match);
  const athlete = play.athleteName ? `${play.athleteName}${play.ownGoal ? ' (contra)' : play.penalty ? ' (pênalti)' : ''}` : 'Autoria aguardando confirmação';
  const minute = play.minute ? `${play.minute}` : '';
  return {
    title: `⚽ GOL DO ${text(scoringTeam.name || 'TIME').toUpperCase()}!`,
    body: `${[athlete, minute].filter(Boolean).join(', ')} · ${scoreText}`
  };
}

function emittedEvent(type, play, match, observation, now) {
  const scoringTeam = scoringTeamFor(play, match);
  const draft = notificationDraft(type, play, match, observation);
  return {
    eventKey: `${type}:${play.key}`,
    type,
    sourcePlayKey: play.key,
    eventId: match.eventId,
    league: match.league,
    competitionKey: match.competitionKey,
    competitionName: match.competitionName,
    kickoff: match.kickoff,
    home: { id: text(match.home?.id), name: text(match.home?.name), abbreviation: text(match.home?.abbreviation), score: num(observation?.home?.score, 0) },
    away: { id: text(match.away?.id), name: text(match.away?.name), abbreviation: text(match.away?.abbreviation), score: num(observation?.away?.score, 0) },
    scoringTeam: { id: text(scoringTeam.id), name: text(scoringTeam.name) },
    athlete: { id: text(play.athleteId), name: text(play.athleteName) },
    minute: text(play.minute),
    ownGoal: Boolean(play.ownGoal),
    penalty: Boolean(play.penalty),
    shootout: Boolean(play.shootout),
    scoreAfter: {
      home: play.homeScoreAfter != null ? num(play.homeScoreAfter, 0) : num(observation?.home?.score, 0),
      away: play.awayScoreAfter != null ? num(play.awayScoreAfter, 0) : num(observation?.away?.score, 0)
    },
    detectedAt: new Date(play.firstSeenAt || now).toISOString(),
    confirmedAt: new Date(now).toISOString(),
    notificationDraft: draft
  };
}


function lifecycleEvent(type, match, observation, now) {
  const homeScore = num(observation?.home?.score, 0);
  const awayScore = num(observation?.away?.score, 0);
  const homeName = text(match.home?.name || 'Mandante');
  const awayName = text(match.away?.name || 'Visitante');
  const scoreText = `${homeName} ${homeScore} × ${awayScore} ${awayName}`;
  let title = 'Atualização do jogo';
  let body = scoreText;
  let winner = null;
  let loser = null;

  if (type === 'final_whistle') {
    title = '🏁 Fim de jogo';
    body = `${scoreText}${match.competitionName ? ` · ${match.competitionName}` : ''}`;
  } else if (type === 'shootout_start') {
    title = '⚡ DECISÃO NOS PÊNALTIS!';
    body = `${scoreText}${match.competitionName ? ` · ${match.competitionName}` : ''}`;
  } else if (type === 'qualification') {
    const homeWon = observation?.home?.winner === true;
    const awayWon = observation?.away?.winner === true;
    const shootHome = observation?.shootoutScore?.home;
    const shootAway = observation?.shootoutScore?.away;
    const aggHome = observation?.aggregateScore?.home;
    const aggAway = observation?.aggregateScore?.away;
    winner = homeWon && !awayWon ? match.home : awayWon && !homeWon ? match.away : null;
    if (!winner && shootHome != null && shootAway != null && num(shootHome, 0) !== num(shootAway, 0)) {
      winner = num(shootHome, 0) > num(shootAway, 0) ? match.home : match.away;
    }
    if (!winner && aggHome != null && aggAway != null && num(aggHome, 0) !== num(aggAway, 0)) {
      winner = num(aggHome, 0) > num(aggAway, 0) ? match.home : match.away;
    }
    loser = winner && winner.id === match.home?.id ? match.away : winner ? match.home : null;
    if (!winner) return null;
    title = `🏆 ${text(winner.name).toUpperCase()} CLASSIFICADO!`;
    const aggregateText = aggHome != null && aggAway != null ? ` · Agregado: ${num(aggHome, 0)} × ${num(aggAway, 0)}` : '';
    const shootoutText = shootHome != null && shootAway != null && (num(shootHome, 0) > 0 || num(shootAway, 0) > 0)
      ? ` · Pênaltis: ${num(shootHome, 0)} × ${num(shootAway, 0)}` : '';
    body = `${text(winner.name)} avança; ${text(loser?.name)} está eliminado. ${scoreText}${aggregateText}${shootoutText}`;
  }

  return {
    eventKey: `${type}:${match.eventId}${winner?.id ? `:${text(winner.id)}` : ''}`,
    type,
    sourcePlayKey: '',
    eventId: match.eventId,
    league: match.league,
    competitionKey: match.competitionKey,
    competitionName: match.competitionName,
    kickoff: match.kickoff,
    home: { id: text(match.home?.id), name: homeName, abbreviation: text(match.home?.abbreviation), score: homeScore },
    away: { id: text(match.away?.id), name: awayName, abbreviation: text(match.away?.abbreviation), score: awayScore },
    scoringTeam: {}, athlete: {}, minute: '', ownGoal: false, penalty: false,
    shootout: type === 'shootout_start' || Boolean(observation?.shootoutActive),
    scoreAfter: { home: homeScore, away: awayScore },
    winner: winner ? { id: text(winner.id), name: text(winner.name), abbreviation: text(winner.abbreviation) } : null,
    loser: loser ? { id: text(loser.id), name: text(loser.name), abbreviation: text(loser.abbreviation) } : null,
    shootoutScore: {
      home: observation?.shootoutScore?.home ?? null,
      away: observation?.shootoutScore?.away ?? null
    },
    detectedAt: new Date(now).toISOString(),
    confirmedAt: new Date(now).toISOString(),
    notificationDraft: { title, body }
  };
}

export function applyObservation(previous, observation, scoringPlays, nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  const match = structuredClone(previous || initialMatchState(observation));
  const emitted = [];
  const wasInitialized = Boolean(match.initialized);
  const previousState = text(match.state);
  const previousShootoutActive = Boolean(match.shootoutActive);
  const previousScoreTotal = goalCountFromScore(match);
  const currentScoreTotal = goalCountFromScore(observation);
  const hasSummary = Array.isArray(scoringPlays);
  const regulation = hasSummary ? scoringPlays.filter((play) => !play.shootout) : null;

  match.eventId = text(observation.eventId || match.eventId);
  match.league = text(observation.league || match.league);
  match.competitionKey = text(observation.competitionKey || match.competitionKey);
  match.competitionName = text(observation.competitionName || match.competitionName);
  match.phase = text(observation.phase || match.phase);
  if (observation.leg != null) match.leg = num(observation.leg, 0);
  match.kickoff = text(observation.kickoff || match.kickoff);
  match.state = text(observation.state || match.state);
  match.completed = Boolean(observation.completed);
  match.clock = text(observation.clock || match.clock);
  match.period = num(observation.period, match.period || 0);
  match.shootoutActive = Boolean(observation.shootoutActive);
  match.shootoutScore = {
    home: observation?.shootoutScore?.home ?? match.shootoutScore?.home ?? null,
    away: observation?.shootoutScore?.away ?? match.shootoutScore?.away ?? null
  };
  match.aggregateScore = {
    home: observation?.aggregateScore?.home ?? match.aggregateScore?.home ?? null,
    away: observation?.aggregateScore?.away ?? match.aggregateScore?.away ?? null
  };
  match.home = { ...(match.home || {}), ...(observation.home || {}), score: num(observation.home?.score, 0) };
  match.away = { ...(match.away || {}), ...(observation.away || {}), score: num(observation.away?.score, 0) };
  match.lastObservedAt = now;
  if (previousScoreTotal !== currentScoreTotal) match.lastScoreChangeAt = now;
  if (hasSummary) match.lastSummaryAt = now;

  if (!match.initialized) {
    match.initialized = true;
    if (currentScoreTotal === 0) {
      match.baselineComplete = true;
      return { match, emitted, diagnostic: 'baseline_zero' };
    }
    if (hasSummary && regulation.length >= currentScoreTotal) {
      for (const play of regulation) match.plays[play.key] = { ...play, status: 'baseline', firstSeenAt: now, stableCount: 1, missingCount: 0 };
      match.baselineComplete = true;
      return { match, emitted, diagnostic: 'baseline_existing_goals' };
    }
    match.baselineComplete = false;
    return { match, emitted, diagnostic: 'baseline_waiting_summary' };
  }

  if (wasInitialized) {
    const cup = isCupCompetition(match.competitionKey) || isCupCompetition(match.competitionName) || isCupCompetition(match.league);
    const decisiveCupMatch = cup && num(match.leg, 0) !== 1;
    if (decisiveCupMatch && observation.state === 'in' && Boolean(observation.shootoutActive) && !previousShootoutActive) {
      const event = lifecycleEvent('shootout_start', match, observation, now);
      if (event) emitted.push(event);
    }
    if (previousState !== 'post' && observation.state === 'post') {
      const finalEvent = lifecycleEvent('final_whistle', match, observation, now);
      if (finalEvent) emitted.push(finalEvent);
      if (decisiveCupMatch) {
        const qualificationEvent = lifecycleEvent('qualification', match, observation, now);
        if (qualificationEvent) emitted.push(qualificationEvent);
      }
    }
  }

  if (!match.baselineComplete) {
    if (hasSummary && regulation.length >= currentScoreTotal) {
      match.plays = {};
      for (const play of regulation) match.plays[play.key] = { ...play, status: 'baseline', firstSeenAt: now, stableCount: 1, missingCount: 0 };
      match.baselineComplete = true;
      return { match, emitted, diagnostic: 'baseline_completed' };
    }
    return { match, emitted, diagnostic: 'baseline_still_waiting' };
  }

  if (!hasSummary) return { match, emitted, diagnostic: 'scoreboard_only' };

  const summaryKeys = new Set(regulation.map((play) => play.key));
  const summaryConsistent = regulation.length === currentScoreTotal;

  for (const play of regulation) {
    const existing = match.plays[play.key];
    if (!existing) {
      match.plays[play.key] = { ...play, status: 'pending', firstSeenAt: now, stableCount: 1, missingCount: 0 };
      continue;
    }
    Object.assign(existing, play);
    existing.missingCount = 0;
    if (existing.status === 'pending') existing.stableCount = num(existing.stableCount, 1) + 1;
  }

  for (const [key, play] of Object.entries(match.plays)) {
    if (play.shootout || summaryKeys.has(key)) continue;
    if (play.status === 'pending') {
      if (currentScoreTotal < previousScoreTotal || summaryConsistent) {
        play.status = 'rejected';
        play.rejectedAt = now;
      }
      continue;
    }
    if (play.status === 'confirmed' && (currentScoreTotal < previousScoreTotal || num(play.missingCount, 0) > 0)) {
      play.missingCount = num(play.missingCount, 0) + 1;
      if (play.missingCount >= OVERTURN_CONFIRM_OBSERVATIONS) {
        play.status = 'overturned';
        play.overturnedAt = now;
        emitted.push(emittedEvent('goal_overturned', play, match, observation, now));
      }
    }
  }

  if (summaryConsistent) {
    for (const play of Object.values(match.plays)) {
      if (play.status !== 'pending') continue;
      const age = now - num(play.firstSeenAt, now);
      const scorerReady = Boolean(text(play.athleteName));
      if (scorerReady && num(play.stableCount, 1) >= GOAL_CONFIRM_OBSERVATIONS && age >= GOAL_CONFIRM_MS) {
        play.status = 'confirmed';
        play.confirmedAt = now;
        emitted.push(emittedEvent('goal', play, match, observation, now));
      }
    }
  }

  return { match, emitted, diagnostic: summaryConsistent ? 'summary_consistent' : 'summary_inconsistent' };
}

export function matchNeedsFastPolling(match, nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  if (!match) return false;
  if (match.state === 'in') return true;
  if (Object.values(match.plays || {}).some((play) => play?.status === 'pending')) return true;
  const kickoff = Date.parse(match.kickoff || '');
  if (Number.isFinite(kickoff) && kickoff >= now - 15 * 60_000 && kickoff <= now + 15 * 60_000) return true;
  return false;
}

export function summarizeMatch(match) {
  const plays = Object.values(match?.plays || {});
  return {
    eventId: match?.eventId || '',
    league: match?.league || '',
    phase: match?.phase || '',
    leg: match?.leg ?? null,
    state: match?.state || '',
    clock: match?.clock || '',
    shootoutActive: Boolean(match?.shootoutActive),
    score: `${num(match?.home?.score, 0)}-${num(match?.away?.score, 0)}`,
    home: match?.home?.name || '',
    away: match?.away?.name || '',
    baselineComplete: Boolean(match?.baselineComplete),
    pendingGoals: plays.filter((p) => p.status === 'pending').length,
    confirmedGoals: plays.filter((p) => p.status === 'confirmed').length,
    overturnedGoals: plays.filter((p) => p.status === 'overturned').length,
    lastObservedAt: match?.lastObservedAt || 0,
    lastSummaryAt: match?.lastSummaryAt || 0
  };
}

export const SPORTS_ENGINE_CONSTANTS = Object.freeze({
  GOAL_CONFIRM_MS,
  GOAL_CONFIRM_OBSERVATIONS,
  OVERTURN_CONFIRM_OBSERVATIONS
});
