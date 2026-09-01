import assert from 'node:assert/strict';
import { buildSportsPushPayload, chunkArray, teamSlug, PUSH_DISPATCH_CONSTANTS } from '../src/push-dispatch.js';

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

assert.deepEqual(chunkArray(['a','b','c','d','e'], 2), [['a','b'],['c','d'],['e']]);
assert.equal(PUSH_DISPATCH_CONSTANTS.DELIVERY_BATCH_SIZE, 5);
assert.equal(PUSH_DISPATCH_CONSTANTS.TARGET_PAGE_SIZE, 400);

console.log('push-dispatch: PASS');
