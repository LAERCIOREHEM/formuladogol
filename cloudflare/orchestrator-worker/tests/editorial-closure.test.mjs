import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editorialClosureDecision, eligibleRoundFromAgenda } from '../src/editorial-closure.js';

function game(round, id, kickoff, concluded = true) {
  return { eventId: String(id), league: 'bra.1', round, kickoff: new Date(kickoff), concluded };
}
function fullRound(round, date = '2026-10-08T21:30:00-03:00') {
  return Array.from({ length: 10 }, (_, i) => game(round, `${round}-${i}`, date, true));
}

test('10/10 FINAL sem artigo vira pendência prioritária', () => {
  const games = fullRound(29);
  const decision = editorialClosureDecision(games, { artigos: [] }, new Date('2026-10-09T00:00:00-03:00'));
  assert.equal(decision.state, 'pending');
  assert.equal(decision.round, 29);
  assert.equal(decision.completed, 10);
  assert.equal(decision.pending, 0);
});

test('artigo canônico com a mesma cobertura resolve o fechamento', () => {
  const games = fullRound(29);
  const analyses = { artigos: [{ tipo: 'brasileirao_rodada', rodada: 29, jogos_concluidos: 10, id_editorial: 'brasileirao-2026-rodada-29' }] };
  const decision = editorialClosureDecision(games, analyses, new Date('2026-10-09T00:00:00-03:00'));
  assert.equal(decision.state, 'resolved');
  assert.equal(decision.articlePresent, true);
});

test('fechamento excepcional 8/10 respeita espera e distância de adiado', () => {
  const games = [
    ...Array.from({ length: 8 }, (_, i) => game(30, `30-done-${i}`, '2026-10-10T20:00:00-03:00', true)),
    game(30, '30-pending-1', '2026-10-14T20:00:00-03:00', false),
    game(30, '30-pending-2', '2026-10-14T21:00:00-03:00', false),
  ];
  assert.equal(eligibleRoundFromAgenda(games, new Date('2026-10-11T03:00:00-03:00')), null);
  const state = eligibleRoundFromAgenda(games, new Date('2026-10-11T05:00:00-03:00'));
  assert.equal(state.round, 30);
  assert.equal(state.completed, 8);
  assert.equal(state.pending, 2);
});

test('agenda incompleta falha fechada', () => {
  const games = fullRound(29).slice(0, 9);
  assert.equal(eligibleRoundFromAgenda(games, new Date('2026-10-09T00:00:00-03:00')), null);
});

test('arquitetura prioriza Closure Guarantee antes do slow path e expõe contrato', async () => {
  const state = await readFile(new URL('../src/orchestrator-state.js', import.meta.url), 'utf8');
  const contract = await readFile(new URL('../src/contract.js', import.meta.url), 'utf8');
  const github = await readFile(new URL('../src/github.js', import.meta.url), 'utf8');
  const deploy = await readFile(new URL('../../../.github/workflows/deploy-orchestrator-worker.yml', import.meta.url), 'utf8');
  const config = JSON.parse(await readFile(new URL('../../../dados-br/config-orquestrador.json', import.meta.url), 'utf8'));

  const guardAt = state.indexOf('await this.editorialClosureGuard(games, now)');
  const slowAt = state.indexOf("const lastSlow = await this.storageDate('meta:lastSlowEval')");
  assert.ok(guardAt > 0 && slowAt > guardAt, 'Closure Guarantee deve preceder o slow path');
  assert.match(state, /retryMinutes: 5/);
  assert.match(state, /editorial:closure:lastResolved/);
  assert.match(state, /resolved_cached/);
  assert.match(state, /overdue = ageMinutes >= 15/);
  assert.match(github, /publicar-analise-rodada\.yml/);
  assert.match(contract, /editorialClosureGuarantee: true/);
  assert.match(contract, /editorialClosureSlaMinutes: 15/);
  assert.match(deploy, /ORCHESTRATOR_CONTRACT\.health/);
  assert.equal(config.schema_version, 8);
  assert.equal(config.editorial_closure_guarantee.ativo, true);
  assert.equal(config.editorial_closure_guarantee.sla_minutos, 15);
});
