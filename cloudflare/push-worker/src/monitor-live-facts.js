import { LIVE_FACTS_CONSTANTS } from './live-facts.js';

function text(value) { return String(value == null ? '' : value).trim(); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }

export const SPORTS_MONITOR_FACTS_VERSION = 1;
function normPlayer(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function finiteScore(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function monitorGoalSide(play, match) {
  const teamId = text(play?.teamId);
  const homeId = text(match?.home?.id);
  const awayId = text(match?.away?.id);
  if (teamId) {
    if (homeId && teamId === homeId) return 'home';
    if (awayId && teamId === awayId) return 'away';
    // Um teamId explícito desconhecido é conflito; nunca deixamos o side textual
    // sobrescrever uma identidade estruturada incompatível.
    return '';
  }
  const side = text(play?.side);
  return side === 'home' || side === 'away' ? side : '';
}
function monitorPlayQuality(play) {
  if (!play || play?.shootout || ['rejected', 'overturned'].includes(text(play?.status))) return -1;
  let score = 0;
  if (text(play?.status) === 'confirmed') score += 300;
  else if (text(play?.status) === 'baseline') score += 220;
  else if (text(play?.status) === 'pending') score += 120;
  if (play?.scoreFallback !== true) score += 80;
  if (play?.scorerConflict !== true && text(play?.athleteName)) score += 120;
  if (play?.athleteStructured === true) score += 30;
  if (text(play?.athleteId)) score += 10;
  if (text(play?.minute)) score += 5;
  return score;
}
function monitorCandidates(match) {
  const targetHome = Math.max(0, num(match?.home?.score, 0));
  const targetAway = Math.max(0, num(match?.away?.score, 0));
  const byState = new Map();
  for (const play of Object.values(match?.plays || {})) {
    if (!play || play?.shootout || ['rejected', 'overturned'].includes(text(play?.status))) continue;
    const home = finiteScore(play?.homeScoreAfter);
    const away = finiteScore(play?.awayScoreAfter);
    if (home == null || away == null || home + away <= 0 || home > targetHome || away > targetAway) continue;
    const side = monitorGoalSide(play, match);
    if (!side) continue;
    const key = `${home}-${away}`;
    const candidate = { ...play, __monitorSide: side, __quality: monitorPlayQuality(play) };
    const current = byState.get(key);
    if (!current || candidate.__quality > current.__quality) byState.set(key, candidate);
  }
  return byState;
}
function buildMonitorScorePath(match) {
  const targetHome = Math.max(0, num(match?.home?.score, 0));
  const targetAway = Math.max(0, num(match?.away?.score, 0));
  const targetTotal = targetHome + targetAway;
  if (targetTotal === 0) return [];
  const candidates = monitorCandidates(match);
  let paths = new Map([['0-0', { home: 0, away: 0, quality: 0, goals: [] }]]);
  for (let total = 1; total <= targetTotal; total += 1) {
    const next = new Map();
    for (let home = 0; home <= Math.min(targetHome, total); home += 1) {
      const away = total - home;
      if (away < 0 || away > targetAway) continue;
      const key = `${home}-${away}`;
      const candidate = candidates.get(key) || null;
      const transitions = [];
      if (home > 0) transitions.push({ parent: `${home - 1}-${away}`, side: 'home' });
      if (away > 0) transitions.push({ parent: `${home}-${away - 1}`, side: 'away' });
      for (const step of transitions) {
        const parent = paths.get(step.parent);
        if (!parent) continue;
        const candidateCompatible = candidate && candidate.__monitorSide === step.side;
        const evidence = candidateCompatible ? candidate : null;
        const quality = parent.quality + (evidence ? Math.max(1, evidence.__quality) : 0);
        const current = next.get(key);
        if (current && current.quality > quality) continue;
        const team = step.side === 'home' ? match?.home || {} : match?.away || {};
        const scorerConflict = evidence?.scorerConflict === true;
        const scorer = scorerConflict ? '' : text(evidence?.athleteName);
        const goal = {
          key: text(evidence?.key) || `${text(match?.eventId)}:monitor-placeholder:${key}`,
          minute: text(evidence?.minute),
          teamId: text(team?.id),
          team: text(team?.name),
          side: step.side,
          scorerId: scorer ? text(evidence?.athleteId) : '',
          scorer,
          assists: [],
          ownGoal: evidence?.ownGoal === true,
          penalty: evidence?.penalty === true,
          scorerConflict,
          identityPending: !(evidence?.ownGoal === true || scorer),
          status: text(evidence?.status || 'pending'),
          scoreFallback: evidence ? evidence?.scoreFallback === true : true,
          description: text(evidence?.description),
          scoreAfter: { home, away },
          sources: [...new Set([...(Array.isArray(evidence?.sources) ? evidence.sources : []), text(evidence?.sourceName), 'sports-monitor-state'].filter(Boolean))]
        };
        next.set(key, { home, away, quality, goals: [...parent.goals, goal] });
      }
    }
    paths = next;
    if (!paths.size) break;
  }
  return paths.get(`${targetHome}-${targetAway}`)?.goals || [];
}
function factsAppearances(goals, supplementalFacts) {
  const rows = [];
  for (const goal of goals || []) if (goal?.scorer && goal?.team) rows.push({ name: goal.scorer, team: goal.team, teamId: goal.teamId });
  for (const row of (Array.isArray(supplementalFacts?.appearances) ? supplementalFacts.appearances : [])) {
    const name = text(row?.name), team = text(row?.team), teamId = text(row?.teamId);
    if (name && (team || teamId)) rows.push({ name, team, teamId });
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${text(row.teamId)}|${normPlayer(row.team)}|${normPlayer(row.name)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function sameGoalState(a, b) {
  return finiteScore(a?.scoreAfter?.home) === finiteScore(b?.scoreAfter?.home)
    && finiteScore(a?.scoreAfter?.away) === finiteScore(b?.scoreAfter?.away);
}
function enrichMonitorGoals(goals, supplementalFacts) {
  if (!supplementalFacts || supplementalFacts?.integrity?.mathematicallyValid === false) return goals;
  const supplemental = Array.isArray(supplementalFacts?.goals) ? supplementalFacts.goals : [];
  return goals.map((goal) => {
    const match = supplemental.find((item) => {
      if (!sameGoalState(goal, item)) return false;
      const itemTeamId = text(item?.teamId);
      if (itemTeamId && text(goal?.teamId) && itemTeamId !== text(goal.teamId)) return false;
      const itemSide = text(item?.side);
      if (itemSide && itemSide !== text(goal?.side)) return false;
      if (!goal?.scorer || !item?.scorer) return false;
      return normPlayer(goal.scorer) === normPlayer(item.scorer);
    });
    if (!match) return goal;
    return {
      ...goal,
      minute: text(goal.minute || match.minute),
      assists: Array.isArray(match.assists) ? match.assists.map(text).filter(Boolean) : [],
      sources: [...new Set([...(goal.sources || []), ...(Array.isArray(match.sources) ? match.sources : []), 'espn-summary-details'])]
    };
  });
}

export function buildSportsMonitorLiveFacts(match, supplementalFacts = null) {
  if (!match || !text(match?.eventId)) return null;
  const expectedHome = Math.max(0, num(match?.home?.score, 0));
  const expectedAway = Math.max(0, num(match?.away?.score, 0));
  const expectedGoals = expectedHome + expectedAway;
  const rawGoals = buildMonitorScorePath(match);
  const goals = enrichMonitorGoals(rawGoals, supplementalFacts);
  const scorerResolvedCount = goals.filter((goal) => goal.ownGoal || text(goal.scorer)).length;
  const teamResolvedCount = goals.filter((goal) => text(goal.teamId) && text(goal.team)).length;
  const observedGoalCount = goals.length;
  const scoreComplete = observedGoalCount === expectedGoals;
  const identityComplete = scoreComplete && teamResolvedCount === expectedGoals && scorerResolvedCount === expectedGoals;
  const integrity = {
    expectedHome, expectedAway, expectedGoals,
    observedGoalCount,
    teamResolvedCount,
    scorerResolvedCount,
    usableGoalCount: scorerResolvedCount,
    rawGoalVariants: Object.values(match?.plays || {}).filter((play) => play && !play.shootout).length,
    discardedGoalVariants: Math.max(0, Object.values(match?.plays || {}).filter((play) => play && !play.shootout).length - observedGoalCount),
    reconciliationState: 'sports_monitor_persistent_score_path',
    scoreComplete,
    identityComplete,
    complete: scoreComplete && identityComplete,
    mathematicallyValid: scoreComplete && goals.every((goal, index) => {
      const h = finiteScore(goal?.scoreAfter?.home), a = finiteScore(goal?.scoreAfter?.away);
      return h != null && a != null && h + a === index + 1 && h <= expectedHome && a <= expectedAway;
    }),
    missingGoals: Math.max(0, expectedGoals - observedGoalCount),
    missingTeams: Math.max(0, expectedGoals - teamResolvedCount),
    missingScorers: Math.max(0, expectedGoals - scorerResolvedCount),
    status: scoreComplete ? (identityComplete ? 'complete' : 'identity-pending') : 'summary-pending'
  };
  return {
    contractVersion: LIVE_FACTS_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION,
    monitorFactsVersion: SPORTS_MONITOR_FACTS_VERSION,
    authority: 'sports-monitor-state',
    eventId: text(match.eventId),
    state: text(match.state),
    clock: text(match.clock),
    lastObservedAt: num(match.lastObservedAt, 0),
    home: { id: text(match?.home?.id), name: text(match?.home?.name), abbreviation: text(match?.home?.abbreviation), score: expectedHome },
    away: { id: text(match?.away?.id), name: text(match?.away?.name), abbreviation: text(match?.away?.abbreviation), score: expectedAway },
    goals,
    appearances: factsAppearances(goals, supplementalFacts),
    integrity,
    meta: {
      stateful: true,
      source: 'sports-monitor-state',
      lastObservedAt: num(match.lastObservedAt, 0),
      supplementalDetailsApplied: goals.some((goal) => Array.isArray(goal.assists) && goal.assists.length > 0)
    }
  };
}

export function enrichSportsMonitorLiveFacts(monitorFacts, supplementalFacts) {
  if (!monitorFacts || typeof monitorFacts !== 'object') return monitorFacts || null;
  if (!supplementalFacts || typeof supplementalFacts !== 'object') return monitorFacts;
  const mi = monitorFacts.integrity || {}, si = supplementalFacts.integrity || {};
  if (Number(mi.expectedHome) !== Number(si.expectedHome) || Number(mi.expectedAway) !== Number(si.expectedAway)) return monitorFacts;
  const goals = enrichMonitorGoals(Array.isArray(monitorFacts.goals) ? monitorFacts.goals : [], supplementalFacts);
  return {
    ...monitorFacts,
    goals,
    appearances: factsAppearances(goals, supplementalFacts),
    meta: { ...(monitorFacts.meta || {}), supplementalDetailsApplied: goals.some((goal) => Array.isArray(goal.assists) && goal.assists.length > 0) }
  };
}

