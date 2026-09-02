import assert from 'node:assert/strict';
import { SportsMonitor } from '../src/sports-monitor.js';
import { buildHotEspnTestEvent, detectHotEspnMutation, hotEspnSnapshot } from '../src/hot-espn-test.js';
import { buildHotMatchPrematchEvent, hotMatchPrematchDue, hotMatchTargetEvent, markHotMatchTechnicalEvent } from '../src/hot-match-test.js';

class FakeStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(key) { return this.map.get(key); }
  async put(key, value) {
    if (key && typeof key === 'object' && value === undefined) {
      for (const [k, v] of Object.entries(key)) this.map.set(k, structuredClone(v));
      return;
    }
    this.map.set(key, structuredClone(value));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = Number(value); }
}

class FakeDB {
  constructor() { this.events = new Map(); this.matchEvents = new Map(); }
  prepare(sql) {
    return {
      bind: (...args) => ({
        run: async () => {
          if (/INSERT OR IGNORE INTO sports_events/.test(sql)) {
            if (!this.events.has(args[0])) this.events.set(args[0], args);
          }
          if (/INSERT OR IGNORE INTO match_events/.test(sql)) {
            if (!this.matchEvents.has(args[0])) this.matchEvents.set(args[0], args);
          }
          return { success: true };
        }
      })
    };
  }
}

const realNow = Date.now;
const realFetch = globalThis.fetch;
let now = Date.parse('2026-09-02T00:05:00Z');
Date.now = () => now;
let phase = 'zero';
const eventId = '401909112';
const kickoff = '2026-09-01T21:00:00-03:00';

function scoreboard(score, clock) {
  return {
    events: [{
      id: eventId, date: kickoff,
      status: { type: { state: 'in', completed: false, shortDetail: clock }, displayClock: clock, period: 1 },
      competitions: [{ competitors: [
        { homeAway: 'home', score: String(score), team: { id: '7632', displayName: 'Atlético-MG' } },
        { homeAway: 'away', score: '0', team: { id: '2022', displayName: 'Cruzeiro' } }
      ] }]
    }]
  };
}

function gameSummary() {
  return {
    rosters: [{ roster: [{ athlete: { id: '9', displayName: 'João Pedro da Silva' } }] }],
    scoringPlays: [{
      id: 'goal-1', scoringPlay: true, team: { id: '7632' }, athletesInvolved: [{ id: '9' }],
      clock: { displayValue: "8'" }, homeScore: 1, awayScore: 0, text: 'Goal', type: { text: 'Goal' }
    }]
  };
}

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('agenda-clubes-br.json')) {
    return Response.json({ jogos: [{
      event_id: eventId, espn_league: 'bra.copa_do_brazil', data_iso: kickoff,
      competicao_chave: 'copa_do_brasil', competicao_nome_curto: 'Copa do Brasil',
      mandante: { espn_id: '7632', nome: 'Atlético-MG' }, visitante: { espn_id: '2022', nome: 'Cruzeiro' }
    }] });
  }
  // Regressão R5: o scoreboard pode continuar 0x0 enquanto o play-by-play já publicou o gol.
  if (href.includes('/scoreboard')) return Response.json(phase === 'zero' ? scoreboard(0, "5'") : scoreboard(0, "9'"));
  if (href.includes('/playbyplay')) return Response.json(phase === 'zero' ? { gamepackageJSON: { plays: [] } } : gameSummary());
  if (href.includes('/summary')) return Response.json(gameSummary());
  throw new Error(`URL inesperada: ${href}`);
};

try {
  const storage = new FakeStorage();
  const db = new FakeDB();
  const monitor = new SportsMonitor({ storage }, { DB: db });

  let status = await monitor.bootstrap();
  assert.equal(status.watchCount, 1);
  assert.equal(status.activeGames, 1);
  assert.equal(status.lastPollError, '');
  assert.ok(status.lastPollSuccessAt > 0);
  assert.equal(status.sourceLayerVersion, '6-R3');
  assert.equal(status.scoreboardSources['bra.copa_do_brazil'], 'espn_freshest_merge');
  assert.equal(db.events.size, 0);
  assert.equal(storage.alarm, now + 10_000, 'alarme de 10 s deve ser armado durante jogo');

  phase = 'goal';
  now += 10_000;
  await monitor.alarm();
  assert.equal(db.events.size, 0, 'primeira detecção fica pendente');
  status = await monitor.publicStatus();
  assert.equal(status.pendingGoals, 1);
  assert.equal(status.matches[0].score, '1-0', 'play-by-play deve promover placar mesmo com scoreboard atrasado');
  assert.equal(status.livePolicyVersion, '6-R5');
  assert.equal(status.fastPollMs, 10_000);
  assert.equal(status.minPollGapMs, 8_000);

  now += 10_000;
  await monitor.alarm();
  assert.equal(db.events.size, 0, '10 s de estabilidade ainda não bastam');

  now += 11_000;
  await monitor.alarm();
  assert.equal(db.events.size, 1, 'gol confirmado deve ser persistido após 20 s');
  const row = [...db.events.values()][0];
  assert.equal(row[1], eventId);
  assert.equal(row[2], 'goal');
  assert.equal(row[12], 'Atlético-MG');
  assert.equal(row[14], 'João Pedro');

  now += 10_000;
  await monitor.alarm();
  assert.equal(db.events.size, 1, 'poll posterior não duplica o evento');

  

// 6-H1: baseline não dispara; uma nova jogada real adicionada pela ESPN dispara uma única mutação.
{
  const baseline = hotEspnSnapshot({ plays: [
    { id: 'p1', text: 'Shot saved', clock: { displayValue: "45'+1'" } },
    { id: 'p2', text: 'End of first half', clock: { displayValue: "45'+3'" } }
  ] });
  const same = hotEspnSnapshot({ plays: [
    { id: 'p1', text: 'Shot saved', clock: { displayValue: "45'+1'" } },
    { id: 'p2', text: 'End of first half', clock: { displayValue: "45'+3'" } }
  ] });
  assert.equal(detectHotEspnMutation(baseline, same), null, 'baseline idêntico não pode disparar');

  const changed = hotEspnSnapshot({ plays: [
    { id: 'p1', text: 'Shot saved', clock: { displayValue: "45'+1'" } },
    { id: 'p2', text: 'End of first half', clock: { displayValue: "45'+3'" } },
    { id: 'p3', text: 'Second Half begins', clock: { displayValue: "46'" } }
  ] });
  const mutation = detectHotEspnMutation(baseline, changed);
  assert.equal(mutation.key, 'p3');
  assert.equal(mutation.clock, "46'");
  const event = buildHotEspnTestEvent({ installationId: 'install-test' }, mutation, 'espn_core_plays', now);
  assert.equal(event.type, 'prematch_15');
  assert.equal(event.testInstallationId, 'install-test');
  assert.match(event.notificationDraft.title, /ESPN REAL/);
}

console.log('sports-monitor: PASS');
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}


// 6-H3: Osnabrück × Bayern, invisível ao site, reutiliza o motor R7/R6 + anti-VAR R4.
{
  const oldNow = Date.now;
  const oldFetch = globalThis.fetch;
  let h2Now = Date.parse('2026-09-02T18:29:00Z'); // 15:29 Brasília
  Date.now = () => h2Now;
  let h2Phase = 'pre';
  const h2EventId = '401875174';
  const h2Kickoff = '2026-09-02T18:45:00Z';
  const h2Scoreboard = () => ({ events: [{
    id: h2EventId, date: h2Kickoff,
    status: h2Phase === 'pre'
      ? { type: { state: 'pre', completed: false, shortDetail: 'Scheduled' }, displayClock: '', period: 0 }
      : { type: { state: 'in', completed: false, shortDetail: "5'" }, displayClock: "5'", period: 1 },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '0', team: { id: '118', displayName: 'VfL Osnabrück', abbreviation: 'OSN' } },
      { homeAway: 'away', score: h2Phase === 'pre' ? '0' : '1', team: { id: '132', displayName: 'Bayern Munich', abbreviation: 'FCB' } }
    ] }]
  }] });
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/scoreboard') && href.includes('ger.dfb_pokal')) return Response.json(h2Scoreboard());
    if (href.includes('/playbyplay') && href.includes('ger.dfb_pokal')) {
      return Response.json({ gamepackageJSON: { plays: h2Phase === 'pre' ? [] : [{
        id: 'h2-goal-1', scoringPlay: true, text: 'Goal Bayern Munich', type: { text: 'Goal' },
        team: { id: '132' }, athletesInvolved: [{ id: '77', displayName: 'Teste Atacante' }],
        clock: { displayValue: "5'" }, homeScore: 0, awayScore: 1
      }] } });
    }
    if (href.includes('/leagues/ger.dfb_pokal/') && href.includes('/plays')) {
      return Response.json({ items: h2Phase === 'pre' ? [{ id: 'warmup', text: 'Pre-match' }] : [{
        id: 'h2-goal-1', scoringPlay: true, text: 'Goal Bayern Munich', type: { text: 'Goal' },
        team: { id: '132' }, athletesInvolved: [{ id: '77', displayName: 'Teste Atacante' }],
        clock: { displayValue: "5'" }, homeScore: 0, awayScore: 1
      }] });
    }
    throw new Error(`H3 URL inesperada: ${href}`);
  };
  try {
    const target = hotMatchTargetEvent(h2Scoreboard().events);
    assert.equal(target.id, h2EventId);
    assert.equal(hotMatchPrematchDue(h2Kickoff, Date.parse('2026-09-02T18:30:00Z')), true);
    const prem = buildHotMatchPrematchEvent({ installationId: 'inst-h2', eventId: h2EventId, kickoff: h2Kickoff }, {
      eventId: h2EventId, kickoff: h2Kickoff, home: { name: 'VfL Osnabrück' }, away: { name: 'Bayern de Munique' }
    }, h2Now);
    assert.equal(prem.testInstallationId, 'inst-h2');
    assert.equal(prem.technicalEspnTest, true);
    const marked = markHotMatchTechnicalEvent({ eventKey: 'goal:x', eventId: h2EventId, type: 'goal', sourcePlayKey: 'g1', notificationDraft: { title: '⚽ GOL DO BAYERN DE MUNIQUE!', body: 'VfL Osnabrück 0 × 1 Bayern de Munique' } }, { installationId: 'inst-h2' });
    assert.equal(marked.testInstallationId, 'inst-h2');
    assert.match(marked.notificationDraft.title, /TESTE ESPN REAL/);

    const storage = new FakeStorage();
    const db = new FakeDB();
    const monitor = new SportsMonitor({ storage }, { DB: db });
    const armed = await monitor.armHotMatchTest('inst-h2');
    assert.equal(armed.state, 'armed');
    assert.equal(armed.eventId, h2EventId);
    assert.equal(armed.score, '0-0');

    h2Now = Date.parse('2026-09-02T18:30:00Z');
    await monitor.pollHotMatchTest();
    assert.equal(db.matchEvents.size, 1, 'alerta de 15 min deve ser criado pela hora ESPN do jogo');
    const premRow = [...db.matchEvents.values()][0];
    const premPayload = JSON.parse(premRow[4]);
    assert.equal(premPayload.type, 'prematch_15');
    assert.equal(premPayload.testInstallationId, 'inst-h2');

    h2Phase = 'goal';
    h2Now = Date.parse('2026-09-02T18:50:00Z');
    await monitor.pollHotMatchTest();
    let hotStatus = await monitor.publicStatus();
    assert.equal(hotStatus.hotMatchTest.pendingGoals, 1, 'primeira evidência real fica pendente');
    assert.equal(db.events.size, 0);

    h2Now += 10_000;
    await monitor.pollHotMatchTest();
    assert.equal(db.events.size, 0, '10 s ainda não confirmam gol');

    h2Now += 11_000;
    await monitor.pollHotMatchTest();
    assert.equal(db.events.size, 1, '20 s + duas observações confirmam o gol técnico pelo motor real');
    const goalRow = [...db.events.values()][0];
    const goalPayload = JSON.parse(goalRow[23]);
    assert.equal(goalPayload.type, 'goal');
    assert.equal(goalPayload.technicalEspnTest, true);
    assert.equal(goalPayload.testInstallationId, 'inst-h2');
    assert.equal(goalPayload.scoreAfter.home, 0);
    assert.equal(goalPayload.scoreAfter.away, 1);
    assert.match(goalPayload.notificationDraft.title, /TESTE ESPN REAL/);
    assert.match(goalPayload.notificationDraft.title, /BAYERN/);
  } finally {
    Date.now = oldNow;
    globalThis.fetch = oldFetch;
  }
}

console.log('hot-match H3 integration: PASS');
