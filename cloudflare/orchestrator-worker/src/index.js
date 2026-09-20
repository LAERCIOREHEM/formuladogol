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
        version: String(env.ORCHESTRATOR_VERSION || '1.7.0'),
        mode: String(env.ORCHESTRATOR_MODE || 'shadow'),
        cron: '*/5 * * * *',
        liveBrowserUntouched: true,
        liveBrowserRefreshSeconds: 30,
        githubHeartbeatRemoved: true,
        transmissionGuardian: true,
        transmissionGuardianCheckpointsMinutes: [-90, -15, 10],
        transmissionGuardianNeedGate: true,
        transmissionGuardianBatching: true,
        transmissionNeedDrivenV2: true,
        adaptiveSlowPath: true,
        adaptiveSlowPathMaxSleepMinutes: 60,
        transmissionTvOperationalWindowHours: 72,
        transmissionTvCheckpointsMinutes: [-4320, -1440, -360],
        transmissionPlayerCheckpointsMinutes: [-90, -15, 10],
        transmissionYoutubeOnlyWhenRequired: true,
        publicFirstAttemptAfterFinalMinutes: 360,
        postgameFastlanePrimary: true,
        postgameFastlaneCronMinutes: 1,
        githubPostgameFallbackHours: 6,
        targetedPublicResearch: true,
        continentalPhaseFingerprints: true,
        continentalAgendaAware: true,
        continentalStateIdempotency: true,
        continentalDailyFallbackMinutes: 1440,
        continentalJointBrazilianClosure: true,
        continentalPairPhaseReconciliation: true,
        continentalAiAuditWorkflow: true,
        brasileiraoSourceCircuitBreaker: true,
        brasileiraoSourceProbeMinutes: 5,
        espnScoreboardGateway: true,
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
