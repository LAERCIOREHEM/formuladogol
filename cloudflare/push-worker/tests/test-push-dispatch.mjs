import assert from 'node:assert/strict';
import { buildSportsPushPayload, chunkArray, preferenceColumnForEvent, teamSlug, PUSH_DISPATCH_CONSTANTS } from '../src/push-dispatch.js';

assert.equal(teamSlug('Atlético-MG'), 'atletico-mg');
assert.equal(teamSlug('Grêmio'), 'gremio');
assert.equal(teamSlug('Red Bull Bragantino'), 'red-bull-bragantino');

const event = {
  eventKey: 'goal:401909112:g2',
  type: 'goal',
  sourcePlayKey: '401909112:g2',
  eventId: '401909112',
  home: { name: 'Atlético-MG', score: 0 },
  away: { name: 'Cruzeiro', score: 1 },
  scoringTeam: { name: 'Cruzeiro' },
  athlete: { name: 'Kaio Jorge' },
  minute: "34'",
  confirmedAt: '2026-09-02T00:35:00.000Z',
  notificationDraft: {
    title: '⚽ GOL DO CRUZEIRO!',
    body: "Kaio Jorge, 34' · Atlético-MG 0 × 1 Cruzeiro"
  }
};
const payload = buildSportsPushPayload(event);
assert.equal(payload.title, '⚽ GOL DO CRUZEIRO!');
assert.match(payload.body, /Kaio Jorge/);
assert.equal(payload.data.url, '/aovivo.html?event=401909112');
assert.equal(payload.badgeIncrement, 1);
assert.match(payload.tag, /^fdg-goal-/);

assert.throws(() => buildSportsPushPayload({ ...event, type: 'goal_overturned' }), /unsupported_public_alert_type/, 'gol anulado é correção interna e não pode virar push público');

const red = buildSportsPushPayload({ ...event, eventKey: 'red_card:401909112:r1', type: 'red_card', notificationDraft: { title: '🟥 EXPULSÃO DO CRUZEIRO!', body: "Jogador, 63' · Atlético-MG 0 × 1 Cruzeiro" } });
assert.match(red.tag, /^fdg-red_card-/);
assert.equal(red.data.url, '/aovivo.html?event=401909112');
const lineup = buildSportsPushPayload({ ...event, eventKey: 'lineup_confirmed:401909112:l1', type: 'lineup_confirmed', notificationDraft: { title: '👥 ESCALAÇÕES CONFIRMADAS', body: 'Atlético-MG × Cruzeiro · Os times estão definidos.' } });
assert.match(lineup.tag, /^fdg-lineup_confirmed-/);
const startAlert = buildSportsPushPayload({ ...event, eventKey: 'match_start:401909112', type: 'match_start', notificationDraft: { title: '▶️ Bola rolando!', body: 'Atlético-MG × Cruzeiro' } });
assert.match(startAlert.tag, /^fdg-match_start-/);
const final = buildSportsPushPayload({ ...event, eventKey: 'final_whistle:401909112', type: 'final_whistle', sourcePlayKey: '', notificationDraft: { title: '🏁 Fim de jogo', body: 'Atlético-MG 1 × 2 Cruzeiro' } });
assert.equal(final.data.url, '/aovivo.html?event=401909112');
assert.match(final.tag, /^fdg-final_whistle-/);
assert.equal(preferenceColumnForEvent('goal'), 'p.goals');
assert.equal(preferenceColumnForEvent('red_card'), 'p.red_cards');
assert.equal(preferenceColumnForEvent('lineup_confirmed'), 'p.lineups');
assert.equal(preferenceColumnForEvent('match_start'), 'p.match_start');
assert.equal(preferenceColumnForEvent('final_whistle'), 'p.final_whistle');
for (const legacy of ['goal_overturned','prematch_15','schedule_changed','match_postponed','shootout_start','qualification']) assert.equal(preferenceColumnForEvent(legacy), '', `${legacy} deve estar fora do contrato público`);
assert.equal(preferenceColumnForEvent('unknown'), '');

assert.deepEqual(chunkArray(['a','b','c','d','e'], 2), [['a','b'],['c','d'],['e']]);
assert.equal(PUSH_DISPATCH_CONSTANTS.DELIVERY_BATCH_SIZE, 5);
assert.equal(PUSH_DISPATCH_CONSTANTS.TARGET_PAGE_SIZE, 400);

const segmented = buildSportsPushPayload({
  eventKey: 'match_start:fdg-segmented-test:device:1',
  type: 'match_start', eventId: 'fdg-segmented-test-1', confirmedAt: event.confirmedAt,
  testInstallationId: 'fdg-device-1',
  home: { name: 'Chapecoense', abbreviation: 'CHA' },
  away: { name: 'Teste Fórmula do Gol', abbreviation: 'FDG' },
  notificationDraft: { title: '🧪 TESTE CHAPECOENSE', body: 'Evento técnico previsto para 10:45:00' }
});
assert.equal(segmented.title, '🧪 TESTE CHAPECOENSE');
assert.equal(segmented.data.type, 'match_start');
assert.equal(segmented.data.url, '/aovivo.html?event=fdg-segmented-test-1');


const hotEspn = buildSportsPushPayload({
  eventKey: 'technical_espn_test:401911806:device:p3',
  type: 'match_start', eventId: '401911806', confirmedAt: event.confirmedAt,
  testInstallationId: 'fdg-device-1', technicalEspnTest: true,
  notificationDraft: { title: '🧪 ESPN REAL — EVENTO DETECTADO', body: "46' · Second Half begins" }
});
assert.equal(hotEspn.data.type, 'match_start');
assert.equal(hotEspn.data.url, '/pwa-teste.html');
assert.equal(hotEspn.title, '🧪 ESPN REAL — EVENTO DETECTADO');

console.log('push-dispatch: PASS');
