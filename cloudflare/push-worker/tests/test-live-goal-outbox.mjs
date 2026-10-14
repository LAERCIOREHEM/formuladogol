import assert from 'node:assert/strict';
import { recoverOrphanedGoalDispatches, recoverPendingDispatches } from '../src/push-dispatch.js';

const events = [{ event_key: 'goal:cam-torque:score:2-0:home' }];
const dispatch = new Map();
const sent = [];
const env = {
  PUSH_QUEUE: { send: async body => sent.push(body) },
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (/FROM sports_events e/.test(sql)) return { results: events.filter(e => !dispatch.has(e.event_key)) };
              if (/FROM push_event_dispatch/.test(sql)) return { results: [...dispatch.entries()].filter(([,v]) => v.status==='pending').map(([event_key])=>({event_key})) };
              throw new Error(`Unexpected select: ${sql}`);
            },
            async run() {
              if (/INSERT OR IGNORE INTO push_event_dispatch/.test(sql)) {
                if (!dispatch.has(args[0])) dispatch.set(args[0], { status:'pending' });
              } else if (/UPDATE push_event_dispatch/.test(sql)) {
                const row = dispatch.get(args.at(-1));
                if (row) row.status = sql.includes("status='enqueued'") ? 'enqueued' : 'pending';
              } else throw new Error(`Unexpected mutation: ${sql}`);
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  }
};
assert.equal(await recoverOrphanedGoalDispatches(env), 1, 'missing outbox row should be recovered');
assert.equal(sent.length, 1);
assert.equal(sent[0].eventKey, events[0].event_key);
assert.equal(dispatch.get(events[0].event_key).status, 'enqueued');
assert.equal(await recoverOrphanedGoalDispatches(env), 0, 'already queued goal must not duplicate');
assert.equal(await recoverPendingDispatches(env), 0);
assert.equal(sent.length, 1);
console.log('R10R17.3 outbox recovery: PASS');
