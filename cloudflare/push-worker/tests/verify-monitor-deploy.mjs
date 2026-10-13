import assert from 'node:assert/strict';
import fs from 'node:fs';

// R10R17-HF6: Cloudflare publica Worker e Durable Object de forma
// eventualmente consistente. Versão anterior R10R5 em partida AO VIVO
// não é falha do deploy novo, desde que os demais contratos e o polling
// estejam íntegros. O estado compatível é WARNING, nunca PASS estrito.
export function verifyMonitor(m, scorer, red, now = Date.now()) {
  const expected = {
    engineVersion: 5,
    overturnPolicyVersion: '6-R10R4',
    livePolicyVersion: '6-R10',
    goalReconciliationPolicyVersion: '6-R9-R1',
    goalScorerEnrichmentPolicyVersion: scorer,
    goalRecoveryPolicyVersion: '6-R10R4',
    essentialAlertPolicyVersion: '6-R10R4',
    readinessVersion: '6-R10.1',
    readinessLifecyclePolicyVersion: '6-R10.2',
    redCardEventPolicyVersion: red,
    redCardAggregateStatsIgnored: true,
    redCardEventContextRequired: true,
    fastPollMs: 10000,
  };
  const problems = [];
  for (const [key, value] of Object.entries(expected)) {
    if (m?.[key] !== value) problems.push(`${key}=${m?.[key]} esperado=${value}`);
  }
  if (m?.ok !== true) problems.push(`ok=${m?.ok}`);
  if (Number(m?.watchCount || 0) === 0 && Number(m?.activeGames || 0) === 0 && Number(m?.readinessRed || 0) !== 0) {
    problems.push(`readinessRed=${m.readinessRed} com monitor inativo`);
  }
  if (!problems.length) return { mode: 'strict', problems: [] };
  const oldScorerOnly = problems.length === 1 && problems[0].startsWith('goalScorerEnrichmentPolicyVersion=')
    && scorer === '6-R10R6' && m.goalScorerEnrichmentPolicyVersion === '6-R10R5';
  const recentPoll = Number(m.lastPollSuccessAt || 0) > 0 && now - Number(m.lastPollSuccessAt) >= 0
    && now - Number(m.lastPollSuccessAt) <= 180000;
  const operational = m.ok === true && Number(m.activeGames || 0) > 0 && recentPoll
    && Number(m.scorerMissingAtDispatch || 0) === 0 && Number(m.readinessRed || 0) === 0
    && !String(m.lastPollError || '').trim() && !String(m.lastScorerEnrichmentWarning || '').trim();
  if (oldScorerOnly && operational) return { mode: 'compatible_active', problems };
  return { mode: 'fail', problems };
}

function selfTest() {
  const now = Date.now();
  const baseline = {
    ok:true, engineVersion:5, overturnPolicyVersion:'6-R10R4', livePolicyVersion:'6-R10',
    goalReconciliationPolicyVersion:'6-R9-R1', goalScorerEnrichmentPolicyVersion:'6-R10R5',
    goalRecoveryPolicyVersion:'6-R10R4', essentialAlertPolicyVersion:'6-R10R4',
    readinessVersion:'6-R10.1', readinessLifecyclePolicyVersion:'6-R10.2',
    redCardEventPolicyVersion:'6-R10R6', redCardAggregateStatsIgnored:true,
    redCardEventContextRequired:true, fastPollMs:10000, watchCount:2, activeGames:1,
    lastPollSuccessAt:now-10000, scorerMissingAtDispatch:0, readinessRed:0, lastPollError:'',
    lastScorerEnrichmentWarning:'',
  };
  assert.equal(verifyMonitor(baseline,'6-R10R6','6-R10R6',now).mode,'compatible_active');
  assert.equal(verifyMonitor({...baseline,goalScorerEnrichmentPolicyVersion:'6-R10R6'},'6-R10R6','6-R10R6',now).mode,'strict');
  assert.equal(verifyMonitor({...baseline,activeGames:0},'6-R10R6','6-R10R6',now).mode,'fail');
  assert.equal(verifyMonitor({...baseline,lastPollSuccessAt:now-240000},'6-R10R6','6-R10R6',now).mode,'fail');
  assert.equal(verifyMonitor({...baseline,redCardEventPolicyVersion:'old'},'6-R10R6','6-R10R6',now).mode,'fail');
  assert.equal(verifyMonitor({...baseline,scorerMissingAtDispatch:1},'6-R10R6','6-R10R6',now).mode,'fail');
  console.log('SportsMonitor deploy strict / active DO skew / invalid regressions: PASS');
}

if (process.argv[1]?.endsWith('verify-monitor-deploy.mjs')) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    const file = process.argv[2];
    if (!file) throw new Error('Usage: node verify-monitor-deploy.mjs status.json');
    const m = JSON.parse(fs.readFileSync(file,'utf8'));
    const r = verifyMonitor(m,process.env.EXPECTED_SCORER_POLICY,process.env.EXPECTED_RED_CARD_POLICY);
    if (r.mode === 'strict') console.log('SportsMonitor DO: contratos e versão convergidos (PASS).');
    else console.error(`SportsMonitor DO ${r.mode}: ${r.problems.join(' | ')}`);
    process.exitCode = r.mode === 'strict' ? 0 : r.mode === 'compatible_active' ? 2 : 1;
  }
}
