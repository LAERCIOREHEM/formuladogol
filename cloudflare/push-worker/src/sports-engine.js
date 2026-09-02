const GOAL_CONFIRM_MS = 20_000;
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

function cleanParsedAthleteName(value) {
  let candidate = text(value)
    .replace(/^[-–:,\s]+/, '')
    .replace(/[-–:,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\d{1,3}(?:\+\d+)?['’]?$/u, '')
    .replace(/\s+\((?:contra|p[êe]nalti|penalty)\)$/iu, '')
    .trim();
  if (!candidate) return '';
  const blocked = new Set([
    'goal', 'gol', 'goal scored', 'goal by', 'scored by', 'marcado por', 'marca por', 'marcou', 'goal scored by',
    'penalty', 'penalty goal', 'own goal', 'gol contra', 'var', 'kickoff', 'halftime', 'full time', 'fim de jogo'
  ]);
  if (blocked.has(normalized(candidate))) return '';
  const words = candidate.split(' ').filter(Boolean);
  if (!words.length || words.length > 5) return '';
  let alphaWords = 0;
  for (const word of words) {
    const bare = word.replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/g, '');
    if (!bare) return '';
    const lower = normalized(bare);
    if (!lower || ['goal', 'gol', 'scores', 'score', 'scored', 'marca', 'marcou', 'penalty', 'own', 'contra', 'var'].includes(lower)) return '';
    if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(bare)) alphaWords += 1;
  }
  if (!alphaWords) return '';
  return compactPlayerName(candidate);
}

function parseAthleteNameFromText(...values) {
  const person = `([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,4})`;
  const patterns = [
    new RegExp(`(?:goal scored by|scored by|goal by|gol de|gol do|gol da|marcado por|marca(?:do)? por)\\s+${person}`, 'iu'),
    new RegExp(`(?:^|[.!?]\\s+)${person}\\s*\\([^)]{1,80}\\)\\s*(?:goal|scores?|scored|right footed|left footed|header|converts|shot|finaliza|cabeceia)?`, 'iu'),
    new RegExp(`^${person}\\s*(?:\\(|-|scores?\\b|scored\\b|marca\\b|marcou\\b|goal\\b|gol\\b)`, 'iu'),
    new RegExp(`^${person}\\s*,\\s*\\d{1,3}(?:\\+\\d+)?['’]?$`, 'u')
  ];
  for (const raw of values) {
    const source = text(raw)
      .replace(/^\d{1,3}(?:\+\d+)?['’]?\s*[-–:]?\s*/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!source) continue;
    for (const pattern of patterns) {
      const match = source.match(pattern);
      const candidate = cleanParsedAthleteName(match?.[1] || '');
      if (candidate) return candidate;
    }
    const exact = cleanParsedAthleteName(source);
    if (exact) return exact;
  }
  return '';
}

function athleteOf(item, roster) {
  const involved = Array.isArray(item?.athletesInvolved) ? item.athletesInvolved : [];
  const participants = Array.isArray(item?.participants) ? item.participants : [];
  const participant = participants.find((entry) => entry?.athlete || entry?.player) || participants[0] || null;
  const athlete = involved[0] || item?.athlete || item?.player || participant?.athlete || participant?.player || participant || null;
  const id = text(athlete?.id);
  const structuredName = compactPlayerName((id && roster[id]) || athlete?.shortName || athlete?.displayName || athlete?.fullName || athlete?.name);
  const inferredName = parseAthleteNameFromText(
    item?.text,
    item?.description,
    item?.shortText,
    item?.headline,
    item?.title,
    item?.note,
    item?.type?.text,
    item?.type?.description
  );
  return { id, name: structuredName || inferredName };
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

function credibleRegulationPlay(play) {
  if (!play || play.shootout) return false;
  const home = play.homeScoreAfter == null ? null : num(play.homeScoreAfter, 0);
  const away = play.awayScoreAfter == null ? null : num(play.awayScoreAfter, 0);
  if (home == null || away == null || home + away <= 0) return false;
  const side = text(play.side);
  return side === 'home' || side === 'away' || Boolean(text(play.teamId));
}

function activeRegulationPlays(match) {
  return Object.values(match?.plays || {}).filter((play) => play && credibleRegulationPlay(play) && !['rejected', 'overturned'].includes(play.status));
}

function goalCountFromScore(observation) {
  return num(observation?.home?.score, 0) + num(observation?.away?.score, 0);
}

function scoreStillContainsPlay(play, observation) {
  const requiredHome = play?.homeScoreAfter == null ? null : num(play.homeScoreAfter, 0);
  const requiredAway = play?.awayScoreAfter == null ? null : num(play.awayScoreAfter, 0);
  if (requiredHome == null || requiredAway == null) return true;
  const currentHome = num(observation?.home?.score, 0);
  const currentAway = num(observation?.away?.score, 0);
  return currentHome >= requiredHome && currentAway >= requiredAway;
}

function sameSemanticGoal(existing, incoming) {
  if (!existing || !incoming || existing.shootout || incoming.shootout) return false;
  const existingHome = existing.homeScoreAfter == null ? null : num(existing.homeScoreAfter, 0);
  const existingAway = existing.awayScoreAfter == null ? null : num(existing.awayScoreAfter, 0);
  const incomingHome = incoming.homeScoreAfter == null ? null : num(incoming.homeScoreAfter, 0);
  const incomingAway = incoming.awayScoreAfter == null ? null : num(incoming.awayScoreAfter, 0);
  if (existingHome == null || existingAway == null || incomingHome == null || incomingAway == null) return false;
  if (existingHome !== incomingHome || existingAway !== incomingAway) return false;
  const existingTeam = text(existing.teamId);
  const incomingTeam = text(incoming.teamId);
  if (existingTeam && incomingTeam && existingTeam !== incomingTeam) return false;
  const existingSide = text(existing.side);
  const incomingSide = text(incoming.side);
  if (existingSide && incomingSide && existingSide !== incomingSide) return false;
  return true;
}

function representedScoreFromPlays(match) {
  let home = 0;
  let away = 0;
  const active = activeRegulationPlays(match).sort((a, b) => num(a?.order, 0) - num(b?.order, 0));
  for (const play of active) {
    if (play?.homeScoreAfter != null && play?.awayScoreAfter != null) {
      home = Math.max(home, num(play.homeScoreAfter, home));
      away = Math.max(away, num(play.awayScoreAfter, away));
      continue;
    }
    if (play?.side === 'home') home += 1;
    else if (play?.side === 'away') away += 1;
  }
  return { home, away };
}

function summaryExactlyMatchesScore(regulation, observation) {
  const targetHome = num(observation?.home?.score, 0);
  const targetAway = num(observation?.away?.score, 0);
  const credible = (Array.isArray(regulation) ? regulation : []).filter(credibleRegulationPlay);
  if (credible.length !== targetHome + targetAway) return false;
  let home = 0;
  let away = 0;
  for (const play of credible.sort((a, b) => num(a?.order, 0) - num(b?.order, 0))) {
    home = num(play.homeScoreAfter, home);
    away = num(play.awayScoreAfter, away);
  }
  return home === targetHome && away === targetAway;
}

function semanticGoalEventKey(type, play, match) {
  const home = play?.homeScoreAfter == null ? 'x' : num(play.homeScoreAfter, 0);
  const away = play?.awayScoreAfter == null ? 'x' : num(play.awayScoreAfter, 0);
  const side = text(play?.side || play?.teamId || 'unknown');
  return `${type}:${text(match?.eventId)}:score:${home}-${away}:${side}`;
}

function ensureScoreboardFallbackGoals(match, observation, now) {
  if (!match?.initialized || !match?.baselineComplete) return [];
  const targetHome = num(observation?.home?.score, 0);
  const targetAway = num(observation?.away?.score, 0);
  const represented = representedScoreFromPlays(match);
  const missingHome = Math.max(0, targetHome - represented.home);
  const missingAway = Math.max(0, targetAway - represented.away);
  if (missingHome === 0 && missingAway === 0) return [];
  // Se as duas equipes avançaram desde a última evidência detalhada, a ordem dos gols
  // é ambígua. Nesse caso esperamos o play-by-play em vez de inventar sequência.
  if (missingHome > 0 && missingAway > 0) return [];

  const created = [];
  let home = represented.home;
  let away = represented.away;
  const side = missingHome > 0 ? 'home' : 'away';
  const count = side === 'home' ? missingHome : missingAway;
  for (let i = 0; i < count; i += 1) {
    if (side === 'home') home += 1;
    else away += 1;
    const team = side === 'home' ? match.home || {} : match.away || {};
    const candidate = {
      key: `${match.eventId}:score-fallback:${home}-${away}`,
      sourceId: '',
      teamId: text(team.id),
      side,
      athleteId: '',
      athleteName: '',
      minute: '',
      period: num(observation?.period, 0),
      description: 'Scoreboard score increase',
      ownGoal: false,
      penalty: false,
      shootout: false,
      homeScoreAfter: home,
      awayScoreAfter: away,
      order: num(observation?.period, 0) * 100000 + (home + away),
      scoreFallback: true
    };
    const semantic = Object.entries(match.plays || {}).find(([, existing]) => sameSemanticGoal(existing, candidate));
    if (semantic) continue;
    const firstSeenAt = num(match.lastScoreChangeAt, 0) || now;
    match.plays[candidate.key] = {
      ...candidate,
      status: 'pending',
      firstSeenAt,
      stableCount: 1,
      missingCount: 0,
      lastStableObservationAt: now
    };
    created.push(match.plays[candidate.key]);
  }
  return created;
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
  const athlete = play.athleteName ? `${play.athleteName}${play.ownGoal ? ' (contra)' : play.penalty ? ' (pênalti)' : ''}` : '';
  const minute = play.minute ? `${play.minute}` : '';
  const detail = [athlete, minute].filter(Boolean).join(', ');
  const teamName = text(scoringTeam.name);
  return {
    title: teamName ? `⚽ GOL DO ${teamName.toUpperCase()}!` : '⚽ GOL!',
    body: detail ? `${detail} · ${scoreText}` : scoreText
  };
}

function emittedEvent(type, play, match, observation, now) {
  const scoringTeam = scoringTeamFor(play, match);
  const draft = notificationDraft(type, play, match, observation);
  return {
    eventKey: semanticGoalEventKey(type, play, match),
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
  const rawRegulation = hasSummary ? scoringPlays.filter((play) => !play.shootout) : null;
  // R7: uma descrição textual de "goal" sem equipe/placar não é suficiente para
  // criar identidade de gol. Ela pode chegar antes do scoreboard e foi a origem do
  // falso "GOL DO TIME · 0×0" no teste Udinese × Venezia.
  const regulation = hasSummary ? rawRegulation.filter(credibleRegulationPlay) : null;

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

  const observedKeys = new Set();
  const summaryConsistent = hasSummary && summaryExactlyMatchesScore(regulation, observation);

  // R7: limpa pendências legadas sem identidade de placar. Nunca gera correção/push;
  // apenas impede que um "goal" incompleto antigo concorra com o fallback correto.
  for (const play of Object.values(match.plays || {})) {
    if (!play?.shootout && play?.status === 'pending' && !credibleRegulationPlay(play)) {
      play.status = 'rejected';
      play.rejectedAt = now;
      play.rejectedReason = 'r7_invalid_goal_identity';
    }
  }

  for (const play of (regulation || [])) {
    let storageKey = play.key;
    let existing = match.plays[storageKey];
    if (!existing) {
      const semanticMatch = Object.entries(match.plays).find(([, candidate]) => sameSemanticGoal(candidate, play));
      if (semanticMatch) {
        [storageKey, existing] = semanticMatch;
      }
    }
    observedKeys.add(storageKey);
    if (!existing) {
      match.plays[storageKey] = { ...play, status: 'pending', firstSeenAt: num(match.lastScoreChangeAt, 0) || now, stableCount: 1, missingCount: 0 };
      continue;
    }
    const canonicalKey = existing.key || storageKey;
    const preservedStatus = existing.status;
    const firstSeenAt = existing.firstSeenAt;
    const confirmedAt = existing.confirmedAt;
    const wasScoreFallback = existing.scoreFallback === true;
    Object.assign(existing, play, { key: canonicalKey });
    existing.firstSeenAt = firstSeenAt;
    existing.confirmedAt = confirmedAt;
    existing.status = preservedStatus;
    if (wasScoreFallback && play.scoreFallback !== true) {
      existing.scoreFallback = false;
      existing.enrichedFromDetailedAt = now;
    }
    existing.missingCount = 0;
    if (existing.status === 'pending' && num(existing.lastStableObservationAt, 0) !== now) {
      existing.stableCount = num(existing.stableCount, 1) + 1;
      existing.lastStableObservationAt = now;
    }
    if (existing.status === 'overturned' && scoreStillContainsPlay(existing, observation)) {
      existing.status = 'confirmed';
      existing.overturnedAt = 0;
      existing.recoveredFromFalseOverturnAt = now;
    }
  }

  for (const [key, play] of Object.entries(match.plays)) {
    if (play.shootout || observedKeys.has(key)) continue;
    if (play.status === 'pending') {
      if (!scoreStillContainsPlay(play, observation) || summaryConsistent) {
        play.status = 'rejected';
        play.rejectedAt = now;
      }
      continue;
    }
    if (play.status === 'confirmed') {
      const rollbackConfirmedByScore = !scoreStillContainsPlay(play, observation);
      if (!rollbackConfirmedByScore) {
        play.missingCount = 0;
        continue;
      }
      play.missingCount = num(play.missingCount, 0) + 1;
      if (play.missingCount >= OVERTURN_CONFIRM_OBSERVATIONS) {
        play.status = 'overturned';
        play.overturnedAt = now;
        emitted.push(emittedEvent('goal_overturned', play, match, observation, now));
      }
    }
  }

  // R6: só criamos o fallback depois de tentar reconciliar o play-by-play.
  // Assim, quando a ESPN entrega a jogada completa preservamos o ID/autoria reais;
  // o placar assume apenas quando o resumo está ausente ou incompleto.
  if (!summaryConsistent) ensureScoreboardFallbackGoals(match, observation, now);

  // Scoreboard fallback: cada nova observação estável incrementa a confiança,
  // mesmo quando a ESPN ainda não entregou uma jogada utilizável no play-by-play.
  for (const play of Object.values(match.plays)) {
    if (play?.status !== 'pending' || !play?.scoreFallback) continue;
    if (!scoreStillContainsPlay(play, observation)) {
      play.status = 'rejected';
      play.rejectedAt = now;
      continue;
    }
    if (num(play.lastStableObservationAt, 0) !== now) {
      play.stableCount = num(play.stableCount, 1) + 1;
      play.lastStableObservationAt = now;
    }
  }

  for (const play of Object.values(match.plays)) {
    if (play.status !== 'pending') continue;
    if (!credibleRegulationPlay(play)) {
      play.status = 'rejected';
      play.rejectedAt = now;
      play.rejectedReason = 'r7_invalid_goal_identity';
      continue;
    }
    const age = now - num(play.firstSeenAt, now);
    const canConfirmFromSummary = summaryConsistent;
    const canConfirmFromStableScore = play.scoreFallback === true && scoreStillContainsPlay(play, observation);
    if ((canConfirmFromSummary || canConfirmFromStableScore)
        && num(play.stableCount, 1) >= GOAL_CONFIRM_OBSERVATIONS
        && age >= GOAL_CONFIRM_MS) {
      play.status = 'confirmed';
      play.confirmedAt = now;
      emitted.push(emittedEvent('goal', play, match, observation, now));
    }
  }

  const fallbackPending = Object.values(match.plays).some((play) => play?.status === 'pending' && play?.scoreFallback === true);
  return {
    match,
    emitted,
    diagnostic: summaryConsistent ? 'summary_consistent' : fallbackPending || emitted.some((event) => event.type === 'goal') ? 'scoreboard_fallback' : hasSummary ? 'summary_inconsistent' : 'scoreboard_only'
  };
}

export function matchNeedsFastPolling(match, nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  if (!match) return false;
  if (match.state === 'in') return true;
  if (Object.values(match.plays || {}).some((play) => play?.status === 'pending')) return true;
  const kickoff = Date.parse(match.kickoff || '');
  // Acelera somente perto da partida: 20 min antes e até 45 min após o horário
  // previsto enquanto a fonte ainda não marcou o jogo como ao vivo.
  if (Number.isFinite(kickoff) && kickoff >= now - 45 * 60_000 && kickoff <= now + 20 * 60_000) return true;
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
  OVERTURN_CONFIRM_OBSERVATIONS,
  OVERTURN_POLICY_VERSION: '6-R4',
  GOAL_DETECTION_POLICY_VERSION: '6-R8',
  GOAL_RECONCILIATION_POLICY_VERSION: '6-R8',
  GOAL_SCORER_ENRICHMENT_POLICY_VERSION: '6-R8'
});
