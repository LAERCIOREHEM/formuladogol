import assert from 'node:assert/strict';
import { assessOperationalHealth, OPS_CONSTANTS } from '../src/ops.js';
import { recoverStuckDeliveries } from '../src/push-dispatch.js';

const now = Date.parse('2026-09-01T22:00:00Z');

let health = assessOperationalHealth({
  monitor: { watchCount: 0, activeGames: 0, lastBootstrapAt: now },
  dispatch: { stuckDispatches: 0, stuckDeliveries: 0, retry: 0, failed24h: 0 }
}, now);
assert.equal(health.ok, true);
assert.equal(health.state, 'healthy');

health = assessOperationalHealth({
  monitor: { watchCount: 1, activeGames: 1, lastBootstrapAt: now - 30_000, lastPollCompletedAt: now - OPS_CONSTANTS.STALE_ACTIVE_POLL_MS - 1 },
  dispatch: { stuckDispatches: 0, stuckDeliveries: 0, retry: 0, failed24h: 0 }
}, now);
assert.equal(health.ok, false);
assert.equal(health.state, 'degraded');
assert.ok(health.errors.includes('monitor_ao_vivo_sem_poll_recente'));

health = assessOperationalHealth({
  monitor: { watchCount: 1, activeGames: 0, lastBootstrapAt: now - 30_000, lastPollError: 'ESPN timeout' },
  dispatch: { stuckDispatches: 0, stuckDeliveries: 0, retry: 2, failed24h: 0 }
}, now);
assert.equal(health.ok, true);
assert.equal(health.state, 'warning');
assert.ok(health.warnings.some((x) => x.startsWith('espn:')));
assert.ok(health.warnings.includes('entregas_em_retry'));

class FakeDB {
  constructor(rows) { this.rows = rows; this.updates = 0; }
  prepare(sql) {
    return {
      bind: (...args) => ({
        all: async () => (/SELECT d\.event_key/.test(sql) ? { results: this.rows } : { results: [] }),
        run: async () => { if (/UPDATE push_deliveries/.test(sql)) this.updates += 1; return { meta: { changes: 1 } }; }
      }),
      run: async () => { if (/UPDATE push_deliveries/.test(sql)) this.updates += 1; return { meta: { changes: 1 } }; }
    };
  }
}

const queueMessages = [];
const fakeEnv = {
  DB: new FakeDB([
    { event_key: 'goal:a', subscription_id: 's1' },
    { event_key: 'goal:a', subscription_id: 's2' },
    { event_key: 'goal:b', subscription_id: 's3' }
  ]),
  PUSH_QUEUE: { send: async (body) => { queueMessages.push(body); } }
};
const recovered = await recoverStuckDeliveries(fakeEnv, 50);
assert.equal(recovered, 3);
assert.equal(queueMessages.length, 2);
assert.deepEqual(queueMessages[0].subscriptionIds, ['s1','s2']);
assert.deepEqual(queueMessages[1].subscriptionIds, ['s3']);
assert.ok(queueMessages.every((x) => x.kind === 'delivery_batch' && x.recovered === true));
assert.equal(fakeEnv.DB.updates, 0, 'watchdog apenas reenfileira; o lock idempotente da entrega decide quem envia');

console.log('ops-hardening: PASS');
