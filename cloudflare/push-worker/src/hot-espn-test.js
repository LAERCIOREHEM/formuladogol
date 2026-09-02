const HOT_TEST_VERSION = '6-H1';
const HOT_TEST_LEAGUE = 'ita.coppa_italia';
const HOT_TEST_EVENT_ID = '401911806';
const HOT_TEST_MATCHUP = 'Sassuolo × Frosinone';
const HOT_TEST_HOME = 'Sassuolo';
const HOT_TEST_AWAY = 'Frosinone';
const HOT_TEST_TTL_MS = 70 * 60_000;
const HOT_TEST_POLL_MS = 10_000;

function text(value) { return String(value == null ? '' : value).trim(); }
function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  const source = String(value || '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function playArray(summary) {
  if (Array.isArray(summary?.plays)) return summary.plays;
  if (Array.isArray(summary?.items)) return summary.items;
  if (Array.isArray(summary?.scoringPlays)) return summary.scoringPlays;
  return [];
}

function descriptor(item) {
  return text([
    item?.type?.text,
    item?.type?.name,
    item?.type?.description,
    item?.text,
    item?.shortText,
    item?.description
  ].filter(Boolean).join(' '));
}

function isGoal(item) {
  if (item?.scoringPlay === true) return true;
  const value = descriptor(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /(^|[^a-z])(goal|gol)([^a-z]|$)/.test(value);
}

function playClock(item) {
  return text(item?.clock?.displayValue || item?.clock?.value || item?.time || item?.period?.displayValue);
}

function playScore(item) {
  const home = num(item?.homeScore ?? item?.homeScoreAfter ?? item?.score?.home, null);
  const away = num(item?.awayScore ?? item?.awayScoreAfter ?? item?.score?.away, null);
  return { home, away };
}

function playKey(item, index = 0) {
  const raw = text(item?.id || item?.uid || item?.playId || item?.sequenceNumber || item?.sequence);
  if (raw) return raw;
  const score = playScore(item);
  return `fp-${fnv1a([
    playClock(item),
    descriptor(item),
    score.home == null ? '' : score.home,
    score.away == null ? '' : score.away,
    index
  ].join('|'))}`;
}

function normalizePlay(item, index) {
  const score = playScore(item);
  return {
    key: playKey(item, index),
    clock: playClock(item),
    description: text(item?.text || item?.shortText || item?.description || item?.type?.text || item?.type?.description || 'Nova jogada ESPN'),
    type: text(item?.type?.text || item?.type?.name),
    scoringPlay: isGoal(item),
    homeScore: score.home,
    awayScore: score.away
  };
}

export function hotEspnSnapshot(summary) {
  const plays = playArray(summary).map(normalizePlay);
  return {
    count: plays.length,
    keys: plays.map((play) => play.key).slice(-400),
    plays,
    lastPlay: plays.at(-1) || null
  };
}

export function detectHotEspnMutation(baseline, current) {
  const before = baseline || { count: 0, keys: [] };
  const after = current || { count: 0, keys: [], plays: [] };
  // O teste é deliberadamente monotônico: troca/reordenação do feed não basta.
  // Só dispara se a ESPN realmente acrescentar pelo menos uma jogada nova.
  if (Number(after.count || 0) <= Number(before.count || 0)) return null;
  const seen = new Set(Array.isArray(before.keys) ? before.keys : []);
  const newPlays = (Array.isArray(after.plays) ? after.plays : []).filter((play) => !seen.has(play.key));
  return newPlays.at(-1) || null;
}

export function buildHotEspnTestEvent(hotTest, mutation, source, now = Date.now()) {
  const item = mutation || {};
  const scoreKnown = item.homeScore != null && item.awayScore != null;
  const scoreText = scoreKnown ? ` · ${HOT_TEST_HOME} ${item.homeScore} × ${item.awayScore} ${HOT_TEST_AWAY}` : '';
  const clockText = item.clock ? `${item.clock} · ` : '';
  const goal = item.scoringPlay === true;
  const installationId = text(hotTest?.installationId);
  const eventKey = `prematch_15:fdg-hot-espn:${HOT_TEST_EVENT_ID}:${installationId}:${text(item.key || now)}`;
  return {
    eventKey,
    eventId: HOT_TEST_EVENT_ID,
    type: 'prematch_15',
    sourcePlayKey: text(item.key),
    league: HOT_TEST_LEAGUE,
    competitionKey: 'technical_hot_test',
    competitionName: 'Coppa Italia · teste quente ESPN',
    kickoff: '',
    home: { id: '', name: HOT_TEST_HOME, abbreviation: 'SAS', score: item.homeScore },
    away: { id: '', name: HOT_TEST_AWAY, abbreviation: 'FRO', score: item.awayScore },
    scoringTeam: {},
    athlete: {},
    minute: text(item.clock),
    ownGoal: false,
    penalty: false,
    shootout: false,
    scoreAfter: { home: item.homeScore, away: item.awayScore },
    detectedAt: new Date(now).toISOString(),
    confirmedAt: new Date(now).toISOString(),
    testInstallationId: installationId,
    technicalEspnTest: true,
    technicalEspnSource: text(source),
    notificationDraft: {
      title: goal ? '🧪 ESPN REAL — GOL DETECTADO' : '🧪 ESPN REAL — EVENTO DETECTADO',
      body: `${clockText}${text(item.description || item.type || 'Nova jogada ESPN')}${scoreText}`
    }
  };
}

export function publicHotEspnTest(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    version: HOT_TEST_VERSION,
    state: text(item.state || 'idle'),
    league: HOT_TEST_LEAGUE,
    eventId: HOT_TEST_EVENT_ID,
    matchup: HOT_TEST_MATCHUP,
    armedAt: Number(item.armedAt || 0),
    expiresAt: Number(item.expiresAt || 0),
    baselinePlayCount: Number(item.baselinePlayCount || 0),
    currentPlayCount: Number(item.currentPlayCount || 0),
    lastCheckAt: Number(item.lastCheckAt || 0),
    lastSource: text(item.lastSource),
    lastError: text(item.lastError),
    firedAt: Number(item.firedAt || 0),
    firedPlay: item.firedPlay && typeof item.firedPlay === 'object' ? {
      key: text(item.firedPlay.key),
      clock: text(item.firedPlay.clock),
      description: text(item.firedPlay.description),
      scoringPlay: item.firedPlay.scoringPlay === true,
      homeScore: item.firedPlay.homeScore == null ? null : Number(item.firedPlay.homeScore),
      awayScore: item.firedPlay.awayScore == null ? null : Number(item.firedPlay.awayScore)
    } : null
  };
}

export const HOT_ESPN_TEST_CONSTANTS = Object.freeze({
  VERSION: HOT_TEST_VERSION,
  LEAGUE: HOT_TEST_LEAGUE,
  EVENT_ID: HOT_TEST_EVENT_ID,
  MATCHUP: HOT_TEST_MATCHUP,
  TTL_MS: HOT_TEST_TTL_MS,
  POLL_MS: HOT_TEST_POLL_MS
});
