import assert from 'node:assert/strict';

await import('../../../js/br-resultados-freshness.js');
const F = globalThis.BRResultadosFreshness;
assert.ok(F, 'BRResultadosFreshness não carregou');

assert.equal(F.latestTimestamp([
  '2026-10-03T23:41:00.000Z',
  '2026-10-03T23:42:38.000Z',
  '2026-10-04T07:08:44.801Z'
]), '2026-10-04T07:08:44.801Z');

// Sequência real esperada: resultado -> melhores momentos -> público/renda.
const state = {
  resultadosMeta: { atualizado_em: '2026-10-03T23:41:00.000Z', atualizado_em_br: '03/10/2026 20:41 BRT' },
  melhoresMomentosMeta: { atualizado_em: '2026-10-03T23:42:38.000Z' },
  jogosDetalhesMeta: { gerado_em: '2026-10-03T23:40:00.000Z' },
  postgameFastlane: {
    '401841168': {
      event_id: '401841168',
      public_status: 'resolved', publico: 22159, renda: 1002775.79,
      public_last_at: '2026-10-04T07:08:44.801Z',
      highlight_status: 'resolved', highlight_last_at: '2026-10-03T23:43:10.000Z',
      highlight: { published_at: '2026-10-03T23:42:38.000Z' }
    }
  }
};
const final = F.effectiveUpdate(state);
assert.equal(final.iso, '2026-10-04T07:08:44.801Z');
assert.equal(final.br, '04/10/2026 04:08 BRT');
assert.equal(final.source, 'publico-renda:401841168');

// Tentativa pendente NÃO pode mexer na hora exibida.
state.postgameFastlane['401841168'] = {
  event_id: '401841168', public_status: 'pending', publico: null, renda: null,
  public_last_at: '2026-10-04T10:00:00.000Z',
  highlight_status: 'resolved', highlight_last_at: '2026-10-03T23:43:10.000Z',
  highlight: { published_at: '2026-10-03T23:42:38.000Z' }
};
const pending = F.effectiveUpdate(state);
assert.equal(pending.iso, '2026-10-03T23:43:10.000Z');
assert.equal(pending.br, '03/10/2026 20:43 BRT');

// Conteúdo manual antigo não pode congelar o timestamp de MM novo.
assert.equal(F.latestTimestamp(['2026-08-01T12:00:00Z','2026-10-03T23:42:38Z']), '2026-10-03T23:42:38.000Z');

console.log('resultados freshness R10R9 tests: PASS');
