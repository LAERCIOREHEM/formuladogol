import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY,
  actionKey,
  brDateKey,
  brasileiraoSourceGate,
  continentalAgendaSignature,
  continentalBaselineReady,
  continentalDecision,
  continentalEligibility,
  continentalNextCheck,
  cupEditorialDecision,
  latestEligibleRound,
  liveCheckpointDue,
  guardianCheckpointDue,
  guardianResolution,
  mmRetryInterval,
  normalizeAgenda,
  pendingHighlights,
  pendingContinentalHighlights,
  pendingPublicsFromAudit,
  publicRetryInterval,
  publicPendingFingerprint,
  relevantSportsGames,
  roundState,
  sha256Hex,
  timeReached,
  tvCoverage,
  tvIntervalHours,
} from '../src/logic.js';
import { dispatchSpec } from '../src/github.js';

const d = (s) => new Date(s);

test('timezone BRT and daily gate are deterministic', () => {
  assert.equal(brDateKey(d('2026-09-03T14:30:00Z')), '2026-09-03');
  assert.equal(timeReached(d('2026-09-03T08:09:00Z'), '05:10'), false); // 05:09 BRT
  assert.equal(timeReached(d('2026-09-03T08:10:00Z'), '05:10'), true);
});


test('Brasileirão source gate recognizes structured and legacy preserved outages', () => {
  const structured = brasileiraoSourceGate({
    status: 'preservado', fonte_estado: 'unavailable', fonte_codigo: 'ESPN_SCOREBOARD_UNAVAILABLE',
    fingerprint: 'fp-1', snapshot_preservado: true,
  });
  assert.equal(structured.open, true);
  assert.equal(structured.reason, 'ESPN_SCOREBOARD_UNAVAILABLE');
  assert.equal(structured.legacy, false);

  const legacy = brasileiraoSourceGate({
    status: 'preservado', fingerprint: 'fp-old',
    mensagem_admin: 'fonte temporariamente indisponível: scoreboard HTTP Error 400 / HTTP Error 403 Forbidden',
  });
  assert.equal(legacy.open, true);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.reason, 'ESPN_SCOREBOARD_UNAVAILABLE_LEGACY');

  assert.equal(brasileiraoSourceGate({ status: 'ok', fonte_estado: 'available' }).open, false);
});

test('agenda normalization and sports probe window', () => {
  const games = normalizeAgenda({ jogos: [{
    event_id: '401', espn_league: 'bra.1', competicao_chave: 'brasileirao',
    data_iso: '2026-09-03T19:00:00-03:00', rodada: 22,
    mandante: { nome: 'A' }, visitante: { nome: 'B' },
  }] });
  assert.equal(games.length, 1);
  assert.equal(relevantSportsGames(games, d('2026-09-03T21:20:00Z')).length, 1); // T-40
  assert.equal(relevantSportsGames(games, d('2026-09-03T20:00:00Z')).length, 0); // T-120
  assert.equal(relevantSportsGames(games, d('2026-09-04T02:01:00Z')).length, 0); // T+241
});

test('player search is need-driven with only T-90/T-15/T+10 opportunities', () => {
  const game = { kickoff: d('2026-09-03T22:00:00Z') };
  assert.deepEqual(POLICY.transmissoes.liveCheckpointsMinutes, [-90, -15, 10]);
  assert.equal(liveCheckpointDue(game, d('2026-09-03T20:29:00Z'), null), null);
  assert.equal(liveCheckpointDue(game, d('2026-09-03T20:30:00Z'), null), -90);
  assert.equal(liveCheckpointDue(game, d('2026-09-03T21:46:00Z'), -90), -15);
  assert.equal(liveCheckpointDue(game, d('2026-09-03T22:11:00Z'), -15), 10);
  assert.equal(liveCheckpointDue(game, d('2026-09-03T22:31:00Z'), 10), null);
});

test('transmission Guardian is exception-only at T-90/T-15/T+10', () => {
  const game = { kickoff: d('2026-09-08T22:00:00Z') };
  assert.deepEqual(POLICY.transmissoes.guardianCheckpointsMinutes, [-90, -15, 10]);
  assert.equal(guardianCheckpointDue(game, d('2026-09-08T20:29:00Z'), null), null);
  assert.equal(guardianCheckpointDue(game, d('2026-09-08T20:30:00Z'), null), -90);
  assert.equal(guardianCheckpointDue(game, d('2026-09-08T21:46:00Z'), -90), -15);
  assert.equal(guardianCheckpointDue(game, d('2026-09-08T22:11:00Z'), -15), 10);
});

test('transmission Guardian only runs for a real unresolved transmission gap', () => {
  const premiere = guardianResolution({
    eventId: '401',
    tv: { jogos: { 401: { canais: ['Premiere'], estavel: true, confianca: 'confirmado' } } },
    liveAuto: { jogos: {} }, liveManual: { jogos: {} }, guardian: { jogos: {} },
  });
  assert.equal(premiere.resolved, true);
  assert.deepEqual(premiere.missing, []);
  assert.equal(premiere.playerRequired, false);

  const geTv = guardianResolution({
    eventId: '402',
    tv: { jogos: { 402: { canais: ['GE TV'], estavel: true, confianca: 'alta' } } },
    liveAuto: { jogos: {} }, liveManual: { jogos: {} },
    guardian: { jogos: { 402: { status: 'confirmado', confianca: 0.98, canais: ['GE TV'], youtube: [{ url: 'https://youtube.com/watch?v=ok', valid_for_match: true }] } } },
  });
  assert.equal(geTv.resolved, true);
  assert.equal(geTv.playerRequired, true);
  assert.equal(geTv.playerResolved, true);

  const missingTv = guardianResolution({ eventId: '403', tv: { jogos: {} }, liveAuto: { jogos: {} }, liveManual: { jogos: {} }, guardian: { jogos: {} } });
  assert.equal(missingTv.resolved, false);
  assert.ok(missingTv.missing.includes('tv_ausente'));

  const conflict = guardianResolution({
    eventId: '404',
    tv: { jogos: { 404: { canais: ['Premiere'], estavel: true, confianca: 'confirmado' } } },
    liveAuto: { jogos: {} }, liveManual: { jogos: {} },
    guardian: { jogos: { 404: { status: 'confirmado', confianca: 0.99, canais: ['Globo'] } } },
  });
  assert.equal(conflict.resolved, false);
  assert.ok(conflict.missing.includes('conflito_fontes'));
});

test('TV coverage ignores games beyond 72h and only treats near gaps as operational', () => {
  const now = d('2026-09-03T12:00:00Z');
  const mk = (id, hours) => ({ eventId: id, kickoff: new Date(now.getTime() + hours * 3600000) });
  const games = [mk('a', 48), mk('b', 80), mk('c', 24), mk('d', 5)];
  let coverage = tvCoverage(games, { jogos: {} }, now);
  assert.equal(coverage.missing72h, 3);
  assert.equal(coverage.critical24h, 2);
  assert.equal(coverage.critical6h, 1);
  assert.equal(tvIntervalHours(coverage), 1);
  coverage = tvCoverage(games, { jogos: { d: { canais: ['Premiere'], estavel: true, confianca: 'confirmado' } } }, now);
  assert.equal(coverage.missing72h, 2);
  assert.equal(tvIntervalHours(coverage), 6);
  coverage = tvCoverage(games, { jogos: { d: { canais: ['Premiere'], estavel: true, confianca: 'confirmado' }, c: { canais: ['Globo'], estavel: true, confianca: 'confirmado' } } }, now);
  assert.equal(coverage.missing72h, 1);
  assert.equal(tvIntervalHours(coverage), 24);
  coverage = tvCoverage(games, { jogos: { d: { canais: ['Premiere'], estavel: true, confianca: 'confirmado' }, c: { canais: ['Globo'], estavel: true, confianca: 'confirmado' }, a: { canais: ['ESPN'], estavel: true, confianca: 'confirmado' } } }, now);
  assert.equal(coverage.missing72h, 0);
  assert.equal(tvIntervalHours(coverage), 168);
});

test('highlight Fastlane opens at +5min and automatic GitHub consolidation is bounded', () => {
  assert.equal(POLICY.melhoresMomentos.firstAfterFinalMinutes, 5);
  assert.equal(POLICY.melhoresMomentos.automaticWindowMinutes, 24 * 60);
  assert.equal(POLICY.melhoresMomentos.maxGithubDispatchesPerEvent, 2);
  assert.equal(POLICY.melhoresMomentos.githubRetryMinutes, 30);
  const results = { resultados: [{ event_id: 'x', rodada: 22, data_iso: '2026-09-03T10:00:00Z', finalizado_em: '2026-09-03T12:00:00Z' }] };
  assert.equal(pendingHighlights({ results, auto: { jogos: {} }, manual: { jogos: {} }, now: d('2026-09-03T12:04:59Z') }).length, 0);
  assert.equal(pendingHighlights({ results, auto: { jogos: {} }, manual: { jogos: {} }, now: d('2026-09-03T12:05:00Z') }).length, 1);
});

test('public/renda Fastlane opens at +15min and automatic GitHub consolidation is bounded', () => {
  assert.equal(POLICY.publicos.firstAfterFinalMinutes, 15);
  assert.equal(POLICY.publicos.automaticWindowMinutes, 24 * 60);
  assert.equal(POLICY.publicos.maxGithubDispatchesPerEvent, 2);
  assert.equal(POLICY.publicos.githubRetryMinutes, 30);
});

test('round editorial closes at 10 or after postponed-game rule', () => {
  const calendar = { jogos: Array.from({ length: 10 }, (_, i) => ({ event_id: String(i + 1), rodada: 22, data_iso: `2026-09-${String(i < 8 ? 1 : 10).padStart(2, '0')}T20:00:00Z` })) };
  const eight = { resultados: Array.from({ length: 8 }, (_, i) => ({ event_id: String(i + 1), rodada: 22, data_iso: '2026-09-01T20:00:00Z' })) };
  assert.equal(roundState(22, calendar, eight, d('2026-09-02T03:59:00Z')).eligible, false);
  assert.equal(roundState(22, calendar, eight, d('2026-09-02T04:01:00Z')).eligible, true);
  const ten = { resultados: Array.from({ length: 10 }, (_, i) => ({ event_id: String(i + 1), rodada: 22, data_iso: '2026-09-01T20:00:00Z' })) };
  assert.equal(roundState(22, calendar, ten, d('2026-09-01T20:01:00Z')).eligible, true);
  assert.equal(latestEligibleRound(calendar, ten, { artigos: [] }, d('2026-09-02T00:00:00Z')).round, 22);
});

test('round editorial never resurrects an older unpublished round', () => {
  const calendar = { jogos: [] };
  const results = { resultados: [] };
  for (const round of [19, 20, 21, 22]) {
    for (let i = 1; i <= 10; i += 1) {
      calendar.jogos.push({ event_id: `${round}-${i}`, rodada: round, data_iso: '2026-08-01T20:00:00Z' });
      results.resultados.push({ event_id: `${round}-${i}`, rodada: round, data_iso: '2026-08-01T20:00:00Z' });
    }
  }
  const analyses = { artigos: [{ tipo: 'brasileirao_rodada', rodada: 22, jogos_concluidos: 10 }] };
  assert.equal(latestEligibleRound(calendar, results, analyses, d('2026-09-03T12:00:00Z')), null);
});

test('Cup editorial waits for phase encerrada and hash change', async () => {
  const cup = { fase_atual: { ordem: 700, status: 'em_andamento' } };
  assert.equal(await cupEditorialDecision(cup, { artigos: [] }, { jogos: {} }), null);
  cup.fase_atual.status = 'encerrada';
  const first = await cupEditorialDecision(cup, { artigos: [] }, { jogos: {} });
  assert.equal(first.rank, 700);
  assert.equal(await cupEditorialDecision(cup, { artigos: [{ id_editorial: 'copa-do-brasil-2026-classificados-semifinal' }] }, { jogos: {} }), null);
});

test('continental baseline only after all first legs and before all second legs', () => {
  const br = (nome) => ({ nome, serie_a_2026: true });
  const x = (nome) => ({ nome, serie_a_2026: false });
  const snap = { eventos: [
    { fase_ordem: 700, perna: 1, concluido: true, mandante: br('A'), visitante: x('X') },
    { fase_ordem: 700, perna: 2, concluido: false, mandante: x('X'), visitante: br('A') },
  ] };
  assert.equal(continentalBaselineReady({ libertadores: snap, sul_americana: { eventos: [] } }, 700), true);
  assert.equal(continentalDecision({ libertadores: snap, sul_americana: { eventos: [] } }, { artigos: [] }, { marcos: [] }).kind, 'baseline');
});




test('continental anchor defeats degraded false Final and waits for open quarterfinals', () => {
  const br = (nome) => ({ nome, serie_a_2026: true });
  const x = (nome) => ({ nome, serie_a_2026: false });
  const snaps = {
    libertadores: { eventos: [
      { event_id: 'L1', fase_ordem: 700, perna: 1, concluido: true, mandante: br('Palmeiras'), visitante: x('LDU') },
      { event_id: 'L2', fase_ordem: 700, perna: 2, concluido: false, mandante: x('LDU'), visitante: br('Palmeiras') },
    ] },
    sul_americana: { eventos: [
      { event_id: 'S1', fase_ordem: 700, perna: 1, concluido: true, mandante: br('Vasco'), visitante: x('Santa Fe') },
      // Reprodução da degradação real: a volta das quartas veio rotulada como 900.
      { event_id: 'S2', fase_ordem: 900, perna: 2, concluido: true, vencedor: 'Vasco', mandante: br('Vasco'), visitante: x('Santa Fe') },
    ] },
  };
  const history = { marcos: [{ id: 'continentais-2026-quartas-antes-fechamento' }] };
  const eligibility = continentalEligibility(snaps, history);
  assert.equal(eligibility.action, 'none');
  assert.equal(eligibility.rank, 700);
  assert.deepEqual(eligibility.pending, ['L2']);
  assert.equal(continentalDecision(snaps, { artigos: [] }, history), null);
  const unanchored = continentalEligibility(snaps, { marcos: [] });
  assert.equal(unanchored.action, 'baseline');
  assert.equal(unanchored.rank, 700);
});

test('continental calendar sleeps until the last pending Brazilian match plus settlement margin', () => {
  const games = normalizeAgenda({ jogos: [
    { event_id: 'A', espn_league: 'conmebol.libertadores', competicao_chave: 'libertadores', fase: 'Quartas de final', perna: 2, data_iso: '2026-09-16T19:00:00-03:00', mandante: { nome: 'A' }, visitante: { nome: 'X' } },
    { event_id: 'B', espn_league: 'conmebol.libertadores', competicao_chave: 'libertadores', fase: 'Quartas de final', perna: 2, data_iso: '2026-09-17T21:30:00-03:00', mandante: { nome: 'B' }, visitante: { nome: 'Y' } },
  ] });
  const plan = continentalNextCheck(
    { action: 'none', rank: 700, phase: 'Quartas de final', pending: ['A', 'B'] },
    games,
    d('2026-09-16T17:00:00Z'),
  );
  assert.equal(plan.degraded, false);
  assert.equal(plan.nextCheckAt.toISOString(), '2026-09-18T03:30:00.000Z'); // 00:30 BRT
});

test('continental calendar falls back to one daily verification when agenda is incomplete', () => {
  const games = normalizeAgenda({ jogos: [
    { event_id: 'A', espn_league: 'conmebol.libertadores', competicao_chave: 'libertadores', fase: 'Quartas de final', perna: 2, data_iso: '2026-09-16T19:00:00-03:00', mandante: { nome: 'A' }, visitante: { nome: 'X' } },
  ] });
  const now = d('2026-09-16T17:00:00Z');
  const plan = continentalNextCheck(
    { action: 'none', rank: 700, phase: 'Quartas de final', pending: ['A', 'MISSING'] },
    games,
    now,
  );
  assert.equal(plan.degraded, true);
  assert.equal(plan.nextCheckAt.toISOString(), '2026-09-17T17:00:00.000Z');
  assert.match(plan.reason, /verificação diária/);
});

test('continental calendar never sleeps through the baseline window before second legs', () => {
  const games = normalizeAgenda({ jogos: [{
    event_id: 'V2', espn_league: 'conmebol.libertadores', competicao_chave: 'libertadores', fase: 'Semifinal', perna: 2,
    data_iso: '2026-10-20T21:30:00-03:00', concluido: false, mandante: { nome: 'A' }, visitante: { nome: 'B' },
  }] });
  const now = d('2026-10-15T12:00:00Z');
  const plan = continentalNextCheck(
    { action: 'none', rank: 800, phase: 'Semifinal', pending: [] },
    games,
    now,
  );
  assert.equal(plan.degraded, true);
  assert.equal(plan.nextCheckAt.toISOString(), '2026-10-16T12:00:00.000Z');
  assert.match(plan.reason, /baseline factual/);
});

test('continental agenda signature changes on factual schedule/conclusion change', () => {
  const pre = normalizeAgenda({ jogos: [{
    event_id: 'A', espn_league: 'conmebol.sudamericana', competicao_chave: 'sul_americana', fase: 'Semifinal', perna: 1,
    data_iso: '2026-10-13T19:00:00-03:00', concluido: false, mandante: { nome: 'A' }, visitante: { nome: 'B' },
  }] });
  const post = normalizeAgenda({ jogos: [{
    event_id: 'A', espn_league: 'conmebol.sudamericana', competicao_chave: 'sul_americana', fase: 'Semifinal', perna: 1,
    data_iso: '2026-10-13T19:00:00-03:00', concluido: true, mandante: { nome: 'A' }, visitante: { nome: 'B' },
  }] });
  assert.notEqual(continentalAgendaSignature(pre), continentalAgendaSignature(post));
});

test('state idempotency key changes only when continental factual signature changes', () => {
  const a = actionKey({ action: 'editorial_continentais', signature: 'publish:700:A0:B0' });
  const same = actionKey({ action: 'editorial_continentais', signature: 'publish:700:A0:B0' });
  const changed = actionKey({ action: 'editorial_continentais', signature: 'publish:700:A1:B0' });
  assert.equal(a, same);
  assert.notEqual(a, changed);
});

test('agenda concluded state is enough for the five-minute FINAL gate', () => {
  const games = normalizeAgenda({ jogos: [{
    event_id: '401', espn_league: 'bra.copa_do_brazil', competicao_chave: 'copa_do_brasil',
    data_iso: '2026-09-03T20:00:00-03:00', estado: 'post', concluido: true,
    mandante: { nome: 'A' }, visitante: { nome: 'B' },
  }] });
  assert.equal(games[0].concluded, true);
});

test('public trigger uses the small audit and detects a new final before the audit catches up', () => {
  const results = { resultados: [
    { event_id: 'old', data_iso: '2026-09-01T20:00:00Z', finalizado_em: '2026-09-01T22:00:00Z' },
    { event_id: 'new', data_iso: '2026-09-03T10:00:00Z', finalizado_em: '2026-09-03T12:00:00Z' },
  ] };
  const audit = { gerado_em: '2026-09-02T10:00:00Z', sem_publico: [{ event_id: 'old' }] };
  const pending = pendingPublicsFromAudit({
    results, audit, aiState: { esgotados: [] }, now: d('2026-09-03T18:20:00Z'),
  });
  assert.deepEqual(new Set(pending.map((x) => x.eventId)), new Set(['old', 'new']));
  assert.equal(pending.find((x) => x.eventId === 'new').firstCheck, true);

  const audited = pendingPublicsFromAudit({
    results, audit: { gerado_em: '2026-09-03T18:30:00Z', sem_publico: [{ event_id: 'old' }], sem_renda: [] },
    aiState: { esgotados: ['old'], jogos: { old: { tentativas: 8, esgotado: true } } }, now: d('2026-09-03T18:40:00Z'),
  });
  assert.deepEqual(audited.map((x) => x.eventId), ['old']);
  assert.ok(audited[0].missingFields.includes('publico'));
});

test('public/renda GitHub fallback opens at 15 minutes, not before', () => {
  const results = { resultados: [{ event_id: 'fresh', data_iso: '2026-09-03T10:00:00Z', finalizado_em: '2026-09-03T12:00:00Z' }] };
  const audit = { gerado_em: '2026-09-03T11:00:00Z', sem_publico: [] };
  assert.equal(pendingPublicsFromAudit({ results, audit, aiState: {}, now: d('2026-09-03T12:14:59Z') }).length, 0);
  assert.equal(pendingPublicsFromAudit({ results, audit, aiState: {}, now: d('2026-09-03T12:15:00Z') }).length, 1);
});

test('rent-only audit gap remains eligible even when attendance is already known', () => {
  const results = { resultados: [{ event_id: 'rent', data_iso: '2026-09-03T10:00:00Z', finalizado_em: '2026-09-03T12:00:00Z' }] };
  const pending = pendingPublicsFromAudit({
    results,
    audit: { gerado_em: '2026-09-03T18:30:00Z', sem_publico: [], sem_renda: [{ event_id: 'rent' }] },
    aiState: { esgotados: [] },
    now: d('2026-09-03T18:40:00Z'),
  });
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].missingFields, ['renda']);
});

test('public pending fingerprint tracks only the fields that are still missing', () => {
  assert.equal(publicPendingFingerprint({ missingFields: ['renda', 'publico', 'renda'] }), 'publico+renda');
  assert.equal(publicPendingFingerprint({ missingFields: ['renda'] }), 'renda');
  assert.equal(publicPendingFingerprint({ missingFields: [] }), 'reconciliar');
});
test('dispatch mapping is targeted and deterministic', () => {
  assert.deepEqual(dispatchSpec({ action: 'melhores_momentos', eventId: '401' }), {
    workflow: 'buscar-melhores-momentos-getv.yml', inputs: { modo: 'incremental', event_id: '401', origem_fastlane: 'false' },
  });
  assert.deepEqual(dispatchSpec({ action: 'melhores_momentos', eventIds: ['402', '401', '401'], fastlane: true }), {
    workflow: 'buscar-melhores-momentos-getv.yml', inputs: { modo: 'incremental', event_ids: '401,402', origem_fastlane: 'true' },
  });
  assert.equal(dispatchSpec({ action: 'editorial_rodada', round: 22 }).inputs.rodada, '22');
  assert.deepEqual(dispatchSpec({ action: 'publicos', eventId: '401' }), {
    workflow: 'atualizar-publicos-brasileirao.yml', inputs: { modo: 'partida', event_id: '401', origem_fastlane: 'false' },
  });
  assert.deepEqual(dispatchSpec({ action: 'publicos', eventId: '401', fastlane: true }), {
    workflow: 'atualizar-publicos-brasileirao.yml', inputs: { modo: 'partida', event_id: '401', origem_fastlane: 'true' },
  });
  assert.deepEqual(dispatchSpec({ action: 'transmissoes_guardian', eventId: '401', checkpoint: -90 }), {
    workflow: 'auditar-transmissoes-ia.yml', inputs: { event_id: '401', checkpoint: '-90' },
  });
  assert.deepEqual(dispatchSpec({ action: 'transmissoes_guardian', eventIds: ['402', '401', '401'], checkpoint: -90 }), {
    workflow: 'auditar-transmissoes-ia.yml', inputs: { event_ids: '401,402', checkpoint: '-90' },
  });
  assert.equal(actionKey({ action: 'transmissao_aovivo', eventId: '401', checkpoint: -20 }), 'transmissao_aovivo:401:-20');
  assert.equal(actionKey({ action: 'transmissoes_guardian', eventId: '401', checkpoint: -90 }), 'transmissoes_guardian:401:-90');
  assert.equal(actionKey({ action: 'transmissoes_guardian', eventIds: ['402', '401'], checkpoint: -90, fingerprint: 'gap' }), 'transmissoes_guardian:401,402:-90:gap');
});

test('continental joint gate reconciles false Final on leg 2 and ignores foreign-only pending matches', () => {
  const br = (nome) => ({ nome, serie_a_2026: true });
  const x = (nome) => ({ nome, serie_a_2026: false });
  const snaps = {
    libertadores: { eventos: [
      { event_id: 'L1', data_iso: '2026-09-10T21:30:00-03:00', fase_ordem: 700, perna: 1, concluido: true, mandante: x('IDV'), visitante: br('Flamengo'), vencedor: 'Flamengo' },
      { event_id: 'L2', data_iso: '2026-09-17T21:30:00-03:00', fase_ordem: 900, perna: 2, concluido: true, mandante: br('Flamengo'), visitante: x('IDV'), vencedor: 'Flamengo' },
      // Jogo estrangeiro da mesma fase: não bloqueia o editorial brasileiro.
      { event_id: 'LF', data_iso: '2026-09-18T21:30:00-03:00', fase_ordem: 700, perna: 2, concluido: false, mandante: x('River'), visitante: x('Racing') },
    ] },
    sul_americana: { eventos: [
      { event_id: 'S1', data_iso: '2026-09-08T19:00:00-03:00', fase_ordem: 700, perna: 1, concluido: true, mandante: x('Santa Fe'), visitante: br('Vasco') },
      { event_id: 'S2', data_iso: '2026-09-15T19:00:00-03:00', fase_ordem: 900, perna: 2, concluido: true, mandante: br('Vasco'), visitante: x('Santa Fe'), vencedor: 'Vasco' },
    ] },
  };
  const history = { marcos: [{ id: 'continentais-2026-quartas-antes-fechamento' }] };
  const eligibility = continentalEligibility(snaps, history);
  assert.equal(eligibility.action, 'publish');
  assert.equal(eligibility.rank, 700);
  assert.deepEqual(eligibility.pending, []);
  const decision = continentalDecision(snaps, { artigos: [] }, history);
  assert.equal(decision.kind, 'publish');
  assert.equal(decision.rank, 700);
});

test('continental agenda reconciles a false Final rank on a second leg', () => {
  const games = normalizeAgenda({ jogos: [
    { event_id: 'Q1', espn_league: 'conmebol.libertadores', competicao_chave: 'libertadores', fase: 'Quartas de final', fase_ordem: 700, perna: 1, data_iso: '2026-09-10T21:30:00-03:00', mandante: { nome: 'IDV' }, visitante: { nome: 'Flamengo' } },
    { event_id: 'Q2', espn_league: 'conmebol.libertadores', competicao_chave: 'libertadores', fase: 'Final', fase_ordem: 900, perna: 2, data_iso: '2026-09-17T21:30:00-03:00', mandante: { nome: 'Flamengo' }, visitante: { nome: 'IDV' } },
  ] });
  assert.equal(games[1].phaseRank, 700);
  assert.equal(games[1].phase, 'Quartas de final');
});

test('next continental phase waits until every surviving Brazilian is materialized', () => {
  const br = (nome) => ({ nome, serie_a_2026: true });
  const x = (nome) => ({ nome, serie_a_2026: false });
  const snap = { eventos: [
    { event_id: 'a1', data_iso: '2026-09-10T19:00:00-03:00', fase_ordem: 700, perna: 1, concluido: true, vencedor: 'A', mandante: br('A'), visitante: x('XA') },
    { event_id: 'a2', data_iso: '2026-09-17T19:00:00-03:00', fase_ordem: 700, perna: 2, concluido: true, vencedor: 'A', mandante: x('XA'), visitante: br('A') },
    { event_id: 'b1', data_iso: '2026-09-10T21:30:00-03:00', fase_ordem: 700, perna: 1, concluido: true, vencedor: 'B', mandante: br('B'), visitante: x('XB') },
    { event_id: 'b2', data_iso: '2026-09-17T21:30:00-03:00', fase_ordem: 700, perna: 2, concluido: true, vencedor: 'B', mandante: x('XB'), visitante: br('B') },
    // ESPN materializou apenas a semifinal de A; B ainda não aparece.
    { event_id: 'sa1', data_iso: '2026-10-13T19:00:00-03:00', fase_ordem: 800, perna: 1, concluido: true, mandante: br('A'), visitante: x('YA') },
    { event_id: 'sa2', data_iso: '2026-10-20T19:00:00-03:00', fase_ordem: 800, perna: 2, concluido: false, mandante: x('YA'), visitante: br('A') },
  ] };
  assert.equal(continentalBaselineReady({ libertadores: snap, sul_americana: { eventos: [] } }, 800), false);
});


test('continental highlights are a separate postgame action only for recent missing videos', () => {
  const snap = { eventos: [{
    event_id: 'cont-1', fase_ordem: 800, perna: 1,
    data_iso: '2026-09-20T19:00:00-03:00', concluido: true,
    mandante: { nome: 'Flamengo', serie_a_2026: true, espn_id: '819' },
    visitante: { nome: 'Rival', serie_a_2026: false, espn_id: 'x' },
  }] };
  const now = d('2026-09-21T01:30:00Z'); // 22:30 BRT, ~1h40 após fim aproximado
  const pending = pendingContinentalHighlights({ libertadores: snap, sul_americana: { eventos: [] } }, { jogos: {} }, now);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, 'cont-1');
  assert.equal(pending[0].rank, 800);
  assert.equal(pendingContinentalHighlights(
    { libertadores: snap, sul_americana: { eventos: [] } },
    { jogos: { 'cont-1': { url: 'https://youtube.com/watch?v=ok' } } },
    now,
  ).length, 0);
  assert.equal(pendingContinentalHighlights(
    { libertadores: snap, sul_americana: { eventos: [] } }, { jogos: {} }, d('2026-09-23T03:00:00Z'),
  ).length, 0);
});

test('continental highlights dispatch is targeted and independent from editorial', () => {
  assert.deepEqual(dispatchSpec({ action: 'melhores_momentos_continentais', eventId: 'cont-1', phaseRank: 800 }), {
    workflow: 'atualizar-melhores-momentos-continentais.yml',
    inputs: { event_id: 'cont-1', fase_ordem: '800' },
  });
});
