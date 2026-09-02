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

const overturned = buildSportsPushPayload({
  ...event,
  eventKey: 'goal_overturned:401909112:g2',
  type: 'goal_overturned',
  notificationDraft: { title: '🚫 GOL ANULADO', body: 'O placar voltou para Atlético-MG 0 × 0 Cruzeiro' }
});
assert.equal(overturned.tag, payload.tag, 'gol e anulação compartilham a mesma tag para atualização da notificação');
assert.equal(overturned.title, '🚫 GOL ANULADO');

const reminder = buildSportsPushPayload({
  eventKey: 'prematch_15:401909112:1788307200000', type: 'prematch_15', eventId: '401909112', confirmedAt: event.confirmedAt,
  notificationDraft: { title: '⏰ Jogo começa em 15 minutos', body: 'Atlético-MG × Cruzeiro · 21:00' }
});
assert.equal(reminder.data.url, '/agenda.html');
assert.match(reminder.tag, /^fdg-prematch_15-/);
const final = buildSportsPushPayload({ ...event, eventKey: 'final_whistle:401909112', type: 'final_whistle', sourcePlayKey: '', notificationDraft: { title: '🏁 Fim de jogo', body: 'Atlético-MG 1 × 2 Cruzeiro' } });
assert.equal(final.data.url, '/aovivo.html?event=401909112');
assert.match(final.tag, /^fdg-final_whistle-/);
assert.equal(preferenceColumnForEvent('goal'), 'p.goals');
assert.equal(preferenceColumnForEvent('goal_overturned'), 'p.overturned_goals');
assert.equal(preferenceColumnForEvent('prematch_15'), 'p.prematch_15');
assert.equal(preferenceColumnForEvent('final_whistle'), 'p.final_whistle');
assert.equal(preferenceColumnForEvent('schedule_changed'), 'p.schedule_changes');
assert.equal(preferenceColumnForEvent('match_postponed'), 'p.schedule_changes');
assert.equal(preferenceColumnForEvent('shootout_start'), 'p.shootout_alerts');
assert.equal(preferenceColumnForEvent('qualification'), 'p.qualification_alerts');
assert.equal(preferenceColumnForEvent('unknown'), '');

assert.deepEqual(chunkArray(['a','b','c','d','e'], 2), [['a','b'],['c','d'],['e']]);
assert.equal(PUSH_DISPATCH_CONSTANTS.DELIVERY_BATCH_SIZE, 5);
assert.equal(PUSH_DISPATCH_CONSTANTS.TARGET_PAGE_SIZE, 400);

const segmented = buildSportsPushPayload({
  eventKey: 'prematch_15:fdg-segmented-test:device:1',
  type: 'prematch_15', eventId: 'fdg-segmented-test-1', confirmedAt: event.confirmedAt,
  testInstallationId: 'fdg-device-1',
  home: { name: 'Chapecoense', abbreviation: 'CHA' },
  away: { name: 'Teste Fórmula do Gol', abbreviation: 'FDG' },
  notificationDraft: { title: '🧪 TESTE CHAPECOENSE', body: 'Evento técnico previsto para 10:45:00' }
});
assert.equal(segmented.title, '🧪 TESTE CHAPECOENSE');
assert.equal(segmented.data.type, 'prematch_15');
assert.equal(segmented.data.url, '/agenda.html');

console.log('push-dispatch: PASS');
