import assert from 'node:assert/strict';
import { SportsMonitor } from '../src/sports-monitor.js';

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
  if (href.includes('/scoreboard')) return Response.json(phase === 'zero' ? scoreboard(0, "5'") : scoreboard(1, "9'"));
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
  assert.equal(status.sourceLayerVersion, '6-R1');
  assert.equal(status.scoreboardSources['bra.copa_do_brazil'], 'espn_cdn_soccer');
  assert.equal(db.events.size, 0);
  assert.ok(storage.alarm > now, 'alarme de 30 s deve ser armado durante jogo');

  phase = 'goal';
  now += 30_000;
  await monitor.alarm();
  assert.equal(db.events.size, 0, 'primeira detecção fica pendente');
  status = await monitor.publicStatus();
  assert.equal(status.pendingGoals, 1);

  now += 30_000;
  await monitor.alarm();
  assert.equal(db.events.size, 0, '30 s de estabilidade ainda não bastam');

  now += 31_000;
  await monitor.alarm();
  assert.equal(db.events.size, 1, 'gol confirmado deve ser persistido uma vez');
  const row = [...db.events.values()][0];
  assert.equal(row[1], eventId);
  assert.equal(row[2], 'goal');
  assert.equal(row[12], 'Atlético-MG');
  assert.equal(row[14], 'João Pedro');

  now += 30_000;
  await monitor.alarm();
  assert.equal(db.events.size, 1, 'poll posterior não duplica o evento');

  console.log('sports-monitor: PASS');
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}
