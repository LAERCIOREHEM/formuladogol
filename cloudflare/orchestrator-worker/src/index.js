import { OrchestratorState } from './orchestrator-state.js';

export { OrchestratorState };

function stateStub(env) {
  const id = env.ORCH_STATE.idFromName('global');
  return env.ORCH_STATE.get(id);
}

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function forwardState(env, path, init = {}) {
  return stateStub(env).fetch(new Request(`https://fdg-orchestrator.internal${path}`, init));
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const response = await forwardState(env, '/tick', { method: 'POST' });
      if (!response.ok) {
        const body = await response.text();
        console.error(`orchestrator tick HTTP ${response.status}: ${body.slice(0, 1000)}`);
        return;
      }
      const result = await response.json();
      console.log(JSON.stringify({
        kind: 'scheduled_tick',
        at: new Date().toISOString(),
        mode: env.ORCHESTRATOR_MODE || 'shadow',
        result: result.result,
        candidate: result.candidate || null,
        errors: result.errors || [],
      }));
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'formula-do-gol-orchestrator',
        version: String(env.ORCHESTRATOR_VERSION || '1.0.0'),
        mode: String(env.ORCHESTRATOR_MODE || 'shadow'),
        cron: '* * * * *',
        liveBrowserUntouched: true,
        liveBrowserRefreshSeconds: 30,
        githubHeartbeatRemoved: true,
      });
    }
    if (url.pathname === '/status' || url.pathname === '/v1/status') {
      return forwardState(env, '/status');
    }
    if (url.pathname === '/history' || url.pathname === '/v1/history') {
      return forwardState(env, '/history');
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};
