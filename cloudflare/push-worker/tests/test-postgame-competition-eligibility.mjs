import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { attendanceEligibility, POSTGAME_ELIGIBILITY_VERSION } from '../src/postgame-competition-eligibility.js';
import { recordPostgameFinal, claimDue, ensurePolicyVersion, postgameStatus, publicSlaAlertAllowed } from '../src/postgame-fastlane.js';

// Teste de INTEGRAÇÃO em SQLite real (sem Cloudflare, sem Web, sem IA e sem D1 remoto).
// O adaptador apenas reproduz a interface D1 prepare/bind/first/all/run.
const sqlite = new DatabaseSync(':memory:');
for (const name of ['0009_postgame_fastlane.sql', '0010_postgame_public_ai.sql', '0013_postgame_hunter_v6.sql']) {
  sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
}
const env = { DB: {
  prepare(sql) {
    let params = [];
    const statement = sqlite.prepare(sql);
    return {
      bind(...values) { params = values; return this; },
      async first() { return statement.get(...params) ?? null; },
      async all() { return { results: statement.all(...params) }; },
      async run() { const result = statement.run(...params); return { meta: { changes: Number(result.changes || 0) } }; },
    };
  },
}};
const end = Date.parse('2026-10-14T02:00:00.000Z');
const kickoff = '2026-10-13T21:30:00.000Z';
async function add(id, league) {
  await recordPostgameFinal(env, {eventId:id, league, home:{name:'Mandante'}, away:{name:'Visitante'}, kickoff}, null, end);
  return sqlite.prepare('SELECT * FROM postgame_fastlane WHERE event_id=?').get(id);
}
for (const league of ['bra.1', 'conmebol.sudamericana', 'conmebol.libertadores', 'bra.copa_do_brazil', 'BRA.1', '', null]) {
  const eligibility = attendanceEligibility(league);
  assert.equal(eligibility.required, league === 'bra.1' || league === 'BRA.1');
  assert.equal(eligibility.publicStatus, eligibility.required ? null : (!league ? 'eligibility_pending' : 'not_applicable'));
}
assert.equal(POSTGAME_ELIGIBILITY_VERSION, 1);

const conmebol = 'fdg-conmebol-sul-americana-202610132130-boca-juniors-vasco-da-gama';
let sud = await add(conmebol, 'conmebol.sudamericana');
let copa = await add('copa-br-test', 'bra.copa_do_brazil');
let lib = await add('lib-test', 'conmebol.libertadores');
let unknown = await add('unknown-test');
let br = await add('401841248', 'bra.1');
await add('legacy-uppercase-test', 'bra.1');
sqlite.prepare("UPDATE postgame_fastlane SET league='BRA.1',public_status='overdue',public_next_at='2026-10-14T02:10:00.000Z' WHERE event_id='legacy-uppercase-test'").run();
assert.equal(sud.public_status, 'not_applicable');
assert.equal(sud.highlight_status, 'not_applicable');
assert.equal(sud.highlight_next_at, null);
assert.equal(copa.public_status, 'not_applicable');
assert.equal(copa.highlight_status, 'not_applicable');
assert.equal(copa.highlight_next_at, null);
assert.equal(lib.public_status, 'not_applicable');
assert.equal(lib.highlight_status, 'not_applicable');
assert.equal(unknown.public_status, 'eligibility_pending');
assert.equal(unknown.highlight_status, 'eligibility_pending');
assert.equal(br.public_status, 'pending');
assert.equal(br.highlight_status, 'pending');
for (const row of [sud, copa, lib, unknown]) {
  assert.equal(row.public_next_at, null, `sem agendamento de IA para ${row.event_id}`);
  assert.equal(publicSlaAlertAllowed(row, end + 180 * 60000), false, `sem alertas para ${row.event_id}`);
}
assert.equal(publicSlaAlertAllowed(br, end + 180 * 60000), true);
assert.equal((await claimDue(env, 'public', Date.now() + 120000)).event_id, '401841248', 'só o Brasileirão entra na fila');
assert.equal(await claimDue(env, 'public', Date.now() + 120000), null, 'zero buscas para Copa/internacionais/desconhecidos');
const dueHighlight = await claimDue(env, 'highlight', Date.now() + 120000);
assert.ok(dueHighlight && dueHighlight.league === 'bra.1', 'somente Série A entra na fila de vídeos');
assert.equal(await claimDue(env, 'highlight', Date.now() + 120000), null, 'zero buscas Copa/CONMEBOL/indefinidos, segunda partida ainda sem liga normalizada');

// Dados antigos, inclusive com erro ou resolved, devem ser encerrados por SQL,
// preservando métricas e mantendo o histórico do Hunter auditável.
sqlite.prepare("UPDATE postgame_fastlane SET public_status='overdue', public_next_at='2026-10-14T02:10:00.000Z', public_attempts=25, publico=15056, renda=708004.50,highlight_status='pending',highlight_next_at='2026-10-14T02:10:00.000Z',highlight_attempts=21 WHERE event_id=?").run(conmebol);
sqlite.prepare(`UPDATE postgame_fastlane SET public_status='resolved', publico=12000, renda=440000, highlight_status='resolved', highlight_json='{"url":"https://youtube.com/watch?v=old","video_id":"old"}' WHERE event_id='copa-br-test'`).run();
sqlite.prepare("UPDATE postgame_fastlane SET public_status='overdue', public_next_at='2026-10-14T02:10:00.000Z' WHERE event_id='unknown-test'").run();
sqlite.prepare("INSERT INTO postgame_meta(key,value) VALUES('policy_version','13')").run();
assert.equal(await ensurePolicyVersion(env, end + 100000), true);
sud = sqlite.prepare('SELECT * FROM postgame_fastlane WHERE event_id=?').get(conmebol);
copa = sqlite.prepare("SELECT * FROM postgame_fastlane WHERE event_id='copa-br-test'").get();
unknown = sqlite.prepare("SELECT * FROM postgame_fastlane WHERE event_id='unknown-test'").get();
assert.equal(sud.public_status, 'not_applicable');
assert.equal(sud.highlight_status, 'not_applicable');
assert.equal(sud.highlight_next_at, null);
assert.equal(sud.public_next_at, null);
assert.equal(sqlite.prepare("SELECT league,public_status FROM postgame_fastlane WHERE event_id='legacy-uppercase-test'").get().league,'bra.1');
assert.equal(sud.public_attempts, 25);
assert.equal(sud.publico, 15056);
assert.equal(sud.renda, 708004.50);
assert.equal(sud.highlight_status, 'not_applicable');
assert.equal(sud.highlight_next_at, null);
assert.equal(sud.highlight_attempts, 21, 'tentativas históricas preservadas');
assert.equal(copa.public_status, 'not_applicable');
assert.equal(copa.highlight_status, 'not_applicable');
assert.equal(copa.highlight_next_at, null);
assert.equal(copa.publico, 12000);
assert.equal(copa.highlight_status, 'not_applicable');
assert.equal(copa.highlight_next_at, null);
assert.ok(copa.highlight_json?.includes('youtube.com'), 'vídeos históricos não são apagados');
assert.equal(copa.renda, 440000);
assert.equal(unknown.public_status, 'eligibility_pending');
assert.equal(unknown.highlight_status, 'eligibility_pending');
assert.equal(unknown.highlight_next_at, null);
assert.equal(unknown.public_next_at, null);
assert.equal(await ensurePolicyVersion(env, end + 100000), false, 'migração idempotente');

// Mesmo após múltiplos seeds, não se pode reativar o Hunter internacional.
await add(conmebol, 'conmebol.sudamericana');
assert.equal(sqlite.prepare('SELECT public_status FROM postgame_fastlane WHERE event_id=?').get(conmebol).public_status, 'not_applicable');
assert.equal(sqlite.prepare('SELECT highlight_status FROM postgame_fastlane WHERE event_id=?').get(conmebol).highlight_status, 'not_applicable');
const promotedBra = await claimDue(env, 'highlight', Date.now()+120000);
assert.equal(promotedBra?.event_id, 'legacy-uppercase-test', 'liga brasileira normalizada pode buscar vídeo');
assert.equal(await claimDue(env, 'highlight', Date.now()+120000), null, 'seed posterior não reabre busca continental');
// Competições corrigidas de desconhecidas para Brasileirão reabrem somente se a classificação for explícita.
await add('unknown-test', 'bra.1');
unknown = sqlite.prepare("SELECT * FROM postgame_fastlane WHERE event_id='unknown-test'").get();
assert.equal(unknown.public_status, 'pending');
assert.ok(unknown.public_next_at);
assert.equal(unknown.highlight_status, 'pending', 'reclassificação explícita para bra.1 reabre destaque');
assert.ok(unknown.highlight_next_at);

const status = await postgameStatus(env);
assert.equal(status.version, 16);
assert.equal(status.storedPolicyVersion, 16);
assert.equal(status.highlightRequiredLeague, 'bra.1');
assert.equal(status.highlightEligibilityPolicyVersion, 1);
assert.equal(status.highlightNotApplicable, 3);
assert.equal(status.highlightEligibilityPending, 0);
assert.equal(status.attendanceRequiredLeague, 'bra.1');
assert.equal(status.publicNotApplicable, 3);
assert.equal(status.publicEligibilityPending, 0);
assert.equal(status.publicEligibleTotal, 3);
assert.equal(status.publicPending, 3);
assert.equal(status.publicOverdue, 1);
assert.equal(status.publicResolved, 0);
// A consulta contábil do Health deve coincidir com o Fastlane; não contar COPA/CONMEBOL.
const healthSource = readFileSync(new URL('../src/health-monitor.js', import.meta.url), 'utf8');
// R10R17.6-HF1: o Action Center acrescentou um bind(iso(now)) para medir
// pendências de highlights >2h. Localizar a MESMA consulta do Health e
// reproduzir o bind real; não alterar a SQL nem enfraquecer os asserts.
const healthQueryMatch = healthSource.match(
  /env\.DB\.prepare\(`(SELECT COUNT\(\*\) total,[\s\S]*?FROM postgame_fastlane)`\)(\.bind\(iso\(now\)\))?\.first\(\)/
);
assert.ok(healthQueryMatch, 'query do Health precisa ser localizada para teste de integração');
const healthQuery = healthQueryMatch[1];
const healthBindValues = healthQueryMatch[2] ? [new Date().toISOString()] : [];
assert.equal((healthQuery.match(/\?/g) || []).length, healthBindValues.length,
  'parâmetros SQL do Health devem coincidir com os binds esperados');
const healthCounts = sqlite.prepare(healthQuery).get(...healthBindValues);
assert.equal(typeof healthCounts.highlight_overdue, 'number', 'contador de highlights vencidos deve existir');
assert.equal(healthCounts.public_pending, status.publicPending);
assert.equal(healthCounts.public_not_applicable, status.publicNotApplicable);
assert.equal(healthCounts.public_eligibility_pending, status.publicEligibilityPending);
assert.equal(healthCounts.public_overdue, status.publicOverdue);
assert.equal(healthCounts.highlight_pending, status.highlightPending);
assert.equal(healthCounts.highlight_overdue, status.highlightPending, 'somente brasileiros históricos podem ficar vencidos; Copa/CONMEBOL nunca entram');
console.log('R10R17.7 SQLite integration: BR Série A, COPA/CONMEBOL dispensadas, reclassificação, D1 v13->v15, preservação histórica e Health: PASS');
