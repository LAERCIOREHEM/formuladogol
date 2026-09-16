import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorState } from '../src/orchestrator-state.js';

function fakeState() {
  const map = new Map();
  return {
    storage: {
      async get(key) { return map.get(key); },
      async put(key, value) { map.set(key, value); },
    },
    map,
  };
}

function preservedStatus() {
  return {
    status: 'preservado',
    fonte_estado: 'unavailable',
    fonte_codigo: 'ESPN_SCOREBOARD_UNAVAILABLE',
    snapshot_preservado: true,
    fingerprint: 'same-outage',
    mensagem_admin: 'scoreboard indisponível',
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('ESPN circuit breaker is OPEN -> HALF_OPEN once -> OPEN -> HALF_OPEN on a new healthy transition', async (t) => {
  const originalFetch = globalThis.fetch;
  const state = fakeState();
  const orchestrator = new OrchestratorState(state, {});
  let healthy = false;
  globalThis.fetch = async () => healthy
    ? jsonResponse({ content: { events: [] } })
    : new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const t0 = new Date('2026-09-16T20:00:00Z');
  const open = await orchestrator.brasileiraoSourceRuntime(preservedStatus(), t0);
  assert.equal(open.state, 'open');
  assert.equal(open.blocked, true);
  assert.equal(open.recoveryEligible, false);

  healthy = true;
  const halfOpen = await orchestrator.brasileiraoSourceRuntime(preservedStatus(), new Date('2026-09-16T20:05:01Z'));
  assert.equal(halfOpen.state, 'half_open');
  assert.equal(halfOpen.blocked, false);
  assert.equal(halfOpen.recoveryEligible, true);

  await state.storage.put('br:sourceBreaker', { ...halfOpen, halfOpenDispatched: true });
  const singleShot = await orchestrator.brasileiraoSourceRuntime(preservedStatus(), new Date('2026-09-16T20:06:00Z'));
  assert.equal(singleShot.state, 'half_open');
  assert.equal(singleShot.blocked, true);
  assert.equal(singleShot.recoveryEligible, false);

  healthy = false;
  const reopened = await orchestrator.brasileiraoSourceRuntime(preservedStatus(), new Date('2026-09-16T20:11:02Z'));
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.halfOpenDispatched, false);

  healthy = true;
  const secondTransition = await orchestrator.brasileiraoSourceRuntime(preservedStatus(), new Date('2026-09-16T20:16:03Z'));
  assert.equal(secondTransition.state, 'half_open');
  assert.equal(secondTransition.recoveryEligible, true);
});

test('successful structured status closes breaker immediately without source probe', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('probe should not run'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const state = fakeState();
  await state.storage.put('br:sourceBreaker', { state: 'open', fingerprint: 'old' });
  const orchestrator = new OrchestratorState(state, {});
  const runtime = await orchestrator.brasileiraoSourceRuntime({
    status: 'ok', fonte_estado: 'available', fonte_codigo: 'ESPN_SCOREBOARD_OK', fingerprint: 'new',
  }, new Date('2026-09-16T20:20:00Z'));
  assert.equal(runtime.state, 'closed');
  assert.equal(runtime.blocked, false);
});
