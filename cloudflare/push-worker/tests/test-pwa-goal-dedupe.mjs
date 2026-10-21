import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Exercise the actual Service Worker without a browser. All tests are offline.
const source = readFileSync(fileURLToPath(new URL('../../../sw.js', import.meta.url)), 'utf8');
const events = new Map();
const context = vm.createContext({
  self: { addEventListener: (type, handler) => events.set(type, handler) },
  indexedDB: undefined,
  Date, Number, String, Object, Boolean, Math, Promise
});
vm.runInContext(source, context, { filename: 'sw.js' });
const key = vm.runInContext('goalNoticeKey', context);
const a = { data: { type: 'goal', eventId: '401913957', eventKey: 'goal:401913957:score:1-2:home',
  sourcePlayKey: 'core:p66', scoreAfter: { home: 1, away: 2 } } };
const b = { data: { ...a.data, eventKey: 'goal:401913957:score:1-2:1234',
  sourcePlayKey: 'score-fallback:1-2' } };
assert.equal(key(a), key(b), 'ESPN CDN/CORE/fallback must share one notification');
assert.equal(key({ data: { ...a.data, scoreAfter: { home: 2, away: 2 } } }) !== key(a), true,
  'a new goal with a new score must alert');
assert.notEqual(key({ data: { ...a.data, type: 'goal_overturned' } }), key(a),
  'VAR overturn must have a separate notification');
assert.equal(key({ data: { ...a.data, type: 'red_card' } }), '', 'red-card events are independent');
assert.ok(events.has('push'), 'Service Worker must register a push handler');
assert.match(source, /claimGoalNotice\(key\)/, 'push path must reserve the goal notification');
assert.match(source, /displayUniqueNotification\(payload, title, options\)/,
  'push handler must use idempotent rendering');
console.log('pwa-goal-dedupe: PASS');
