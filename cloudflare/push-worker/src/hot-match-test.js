const HOT_MATCH_VERSION = '6-H2';
const HOT_MATCH_LEAGUE = 'ita.coppa_italia';
const HOT_MATCH_DATE_KEY = '20260902';
const HOT_MATCH_HOME = 'Udinese';
const HOT_MATCH_AWAY = 'Venezia';
const HOT_MATCH_MATCHUP = `${HOT_MATCH_HOME} × ${HOT_MATCH_AWAY}`;
const HOT_MATCH_EXPECTED_KICKOFF = '2026-09-02T16:00:00.000Z'; // 13:00 Brasília / 18:00 CEST
const HOT_MATCH_POLL_MS = 10_000;
const HOT_MATCH_SLOW_POLL_MS = 60_000;
const HOT_MATCH_FAST_PRE_MS = 20 * 60_000;
const HOT_MATCH_REMINDER_MIN_MS = 13 * 60_000;
const HOT_MATCH_REMINDER_MAX_MS = 16 * 60_000;
const HOT_MATCH_POST_MS = 3 * 60 * 60_000;

function text(value) { return String(value == null ? '' : value).trim(); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function normalized(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function competitionOf(event) { return event?.competitions?.[0] || event?.competition || {}; }
function competitorsOf(event) { return Array.isArray(competitionOf(event)?.competitors) ? competitionOf(event).competitors : []; }
function teamName(competitor) {
  const team = competitor?.team || {};
  return text(team.displayName || team.shortDisplayName || team.name || team.location || competitor?.displayName);
}

export function hotMatchTargetEvent(events) {
  const homeNeedle = normalized(HOT_MATCH_HOME);
  const awayNeedle = normalized(HOT_MATCH_AWAY);
  for (const event of Array.isArray(events) ? events : []) {
    const competitors = competitorsOf(event);
    const names = competitors.map(teamName).map(normalized);
    if (names.some((name) => name.includes(homeNeedle)) && names.some((name) => name.includes(awayNeedle))) return event;
  }
  return null;
}

export function hotMatchPrematchDue(kickoff, nowMs = Date.now()) {
  const kickoffMs = Date.parse(kickoff || '');
  if (!Number.isFinite(kickoffMs)) return false;
  const remaining = kickoffMs - num(nowMs, Date.now());
  return remaining >= HOT_MATCH_REMINDER_MIN_MS && remaining <= HOT_MATCH_REMINDER_MAX_MS;
}

export function buildHotMatchPrematchEvent(test, observation, nowMs = Date.now()) {
  const installationId = text(test?.installationId);
  const eventId = text(observation?.eventId || test?.eventId);
  const kickoff = text(observation?.kickoff || test?.kickoff);
  return {
    eventKey: `prematch_15:fdg-hot-match:${eventId}:${installationId}`,
    eventId,
    type: 'prematch_15',
    sourcePlayKey: '',
    league: HOT_MATCH_LEAGUE,
    competitionKey: 'technical_hot_match_test',
    competitionName: 'Coppa Italia · teste ESPN real',
    kickoff,
    home: { ...(observation?.home || {}), score: 0 },
    away: { ...(observation?.away || {}), score: 0 },
    scoringTeam: {}, athlete: {}, minute: '', ownGoal: false, penalty: false, shootout: false,
    scoreAfter: { home: 0, away: 0 },
    detectedAt: new Date(nowMs).toISOString(),
    confirmedAt: new Date(nowMs).toISOString(),
    testInstallationId: installationId,
    technicalEspnTest: true,
    technicalEspnTestVersion: HOT_MATCH_VERSION,
    notificationDraft: {
      title: '🧪 TESTE ESPN REAL — JOGO EM 15 MIN',
      body: `${HOT_MATCH_MATCHUP} começa às 13:00 · horário vindo da ESPN`
    }
  };
}

export function markHotMatchTechnicalEvent(event, test) {
  const source = event && typeof event === 'object' ? structuredClone(event) : {};
  const installationId = text(test?.installationId);
  const eventId = text(source.eventId || test?.eventId);
  const sourceKey = text(source.sourcePlayKey || source.eventKey || source.type || Date.now());
  const title = text(source.notificationDraft?.title || 'Atualização do jogo');
  const body = text(source.notificationDraft?.body || HOT_MATCH_MATCHUP);
  return {
    ...source,
    eventKey: `${text(source.type)}:fdg-hot-match:${eventId}:${installationId}:${sourceKey}`,
    competitionKey: 'technical_hot_match_test',
    competitionName: 'Coppa Italia · teste ESPN real',
    testInstallationId: installationId,
    technicalEspnTest: true,
    technicalEspnTestVersion: HOT_MATCH_VERSION,
    notificationDraft: {
      title: `🧪 TESTE ESPN REAL — ${title.replace(/^\p{Extended_Pictographic}+\s*/u, '')}`,
      body
    }
  };
}

export function publicHotMatchTest(value) {
  const item = value && typeof value === 'object' ? value : {};
  const match = item.match && typeof item.match === 'object' ? item.match : {};
  const plays = Object.values(match.plays || {});
  return {
    version: HOT_MATCH_VERSION,
    state: text(item.state || 'idle'),
    league: HOT_MATCH_LEAGUE,
    eventId: text(item.eventId),
    matchup: HOT_MATCH_MATCHUP,
    kickoff: text(item.kickoff || HOT_MATCH_EXPECTED_KICKOFF),
    armedAt: num(item.armedAt, 0),
    expiresAt: num(item.expiresAt, 0),
    lastCheckAt: num(item.lastCheckAt, 0),
    lastSource: text(item.lastSource),
    lastError: text(item.lastError),
    prematchSentAt: num(item.prematchSentAt, 0),
    observedState: text(match.state),
    clock: text(match.clock),
    score: `${num(match?.home?.score, 0)}-${num(match?.away?.score, 0)}`,
    pendingGoals: plays.filter((p) => p?.status === 'pending').length,
    confirmedGoals: plays.filter((p) => p?.status === 'confirmed').length,
    overturnedGoals: plays.filter((p) => p?.status === 'overturned').length,
    emittedCount: num(item.emittedCount, 0)
  };
}

export function hotMatchNextPollDelay(test, nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  const kickoffMs = Date.parse(test?.kickoff || HOT_MATCH_EXPECTED_KICKOFF);
  if (!Number.isFinite(kickoffMs)) return HOT_MATCH_SLOW_POLL_MS;
  const matchState = text(test?.match?.state);
  if (matchState === 'in' || Object.values(test?.match?.plays || {}).some((p) => p?.status === 'pending')) return HOT_MATCH_POLL_MS;
  if (now >= kickoffMs - HOT_MATCH_FAST_PRE_MS && now <= kickoffMs + HOT_MATCH_POST_MS) return HOT_MATCH_POLL_MS;
  const untilFast = kickoffMs - HOT_MATCH_FAST_PRE_MS - now;
  if (untilFast > 0) return Math.max(5_000, Math.min(HOT_MATCH_SLOW_POLL_MS, untilFast));
  return HOT_MATCH_POLL_MS;
}

export const HOT_MATCH_TEST_CONSTANTS = Object.freeze({
  VERSION: HOT_MATCH_VERSION,
  LEAGUE: HOT_MATCH_LEAGUE,
  DATE_KEY: HOT_MATCH_DATE_KEY,
  HOME: HOT_MATCH_HOME,
  AWAY: HOT_MATCH_AWAY,
  MATCHUP: HOT_MATCH_MATCHUP,
  EXPECTED_KICKOFF: HOT_MATCH_EXPECTED_KICKOFF,
  POLL_MS: HOT_MATCH_POLL_MS,
  SLOW_POLL_MS: HOT_MATCH_SLOW_POLL_MS,
  FAST_PRE_MS: HOT_MATCH_FAST_PRE_MS,
  POST_MS: HOT_MATCH_POST_MS
});
