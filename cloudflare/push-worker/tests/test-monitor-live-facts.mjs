import assert from 'node:assert/strict';
import { buildSportsMonitorLiveFacts, enrichSportsMonitorLiveFacts, SPORTS_MONITOR_FACTS_VERSION } from '../src/monitor-live-facts.js';
import { LIVE_FACTS_CONSTANTS } from '../src/live-facts.js';

function match(scoreHome, scoreAway, plays = {}) {
  return {
    eventId: '401841999', state: 'in', clock: "87'", lastObservedAt: 123456789,
    home: { id: 'home-1', name: 'Flamengo', abbreviation: 'FLA', score: scoreHome },
    away: { id: 'away-1', name: 'Bragantino', abbreviation: 'RBB', score: scoreAway },
    plays
  };
}

// 0x0 é autoridade absoluta: qualquer play espúrio acima do placar é descartado.
{
  const facts = buildSportsMonitorLiveFacts(match(0, 0, {
    bogus: { key: 'bogus', status: 'confirmed', teamId: 'home-1', side: 'home', athleteName: 'Guillermo Varela', homeScoreAfter: 1, awayScoreAfter: 0 }
  }));
  assert.equal(facts.contractVersion, LIVE_FACTS_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION);
  assert.equal(facts.monitorFactsVersion, SPORTS_MONITOR_FACTS_VERSION);
  assert.equal(SPORTS_MONITOR_FACTS_VERSION, 2);
  assert.equal(facts.goals.length, 0);
  assert.equal(facts.integrity.expectedGoals, 0);
  assert.equal(facts.integrity.complete, true);
}

// 2x1 com apenas o primeiro marcador conhecido: o contrato deve representar
// os três gols, preservando o marcador confirmado e criando placeholders por time.
{
  const facts = buildSportsMonitorLiveFacts(match(2, 1, {
    g1: { key: 'g1', status: 'confirmed', teamId: 'home-1', side: 'home', athleteId: 'v', athleteName: 'Guillermo Varela', athleteStructured: true, minute: "13'", homeScoreAfter: 1, awayScoreAfter: 0 },
    g2: { key: 'g2', status: 'pending', teamId: 'home-1', side: 'home', scoreFallback: true, homeScoreAfter: 2, awayScoreAfter: 0 },
    g3: { key: 'g3', status: 'pending', teamId: 'away-1', side: 'away', scoreFallback: true, homeScoreAfter: 2, awayScoreAfter: 1 }
  }));
  assert.equal(facts.goals.length, 3);
  assert.equal(facts.integrity.scoreComplete, true);
  assert.equal(facts.integrity.identityComplete, false);
  assert.equal(facts.integrity.missingScorers, 2);
  assert.deepEqual(facts.goals.map(g => g.side), ['home','home','away']);
  assert.equal(facts.goals[0].scorer, 'Guillermo Varela');
  assert.equal(facts.goals[1].identityPending, true);
  assert.equal(facts.goals[2].identityPending, true);
}

// teamId estruturado é superior ao side textual. Serna/Fluminense jamais pode
// ser movido para o mandante por um side incorreto.
{
  const m = {
    eventId: 'cor-flu', state: 'in', clock: "17'", lastObservedAt: 1,
    home: { id: 'cor', name: 'Corinthians', score: 0 },
    away: { id: 'flu', name: 'Fluminense', score: 1 },
    plays: {
      g1: { key: 'g1', status: 'confirmed', teamId: 'flu', side: 'home', athleteName: 'Kevin Serna', minute: "17'", homeScoreAfter: 0, awayScoreAfter: 1 }
    }
  };
  const facts = buildSportsMonitorLiveFacts(m);
  assert.equal(facts.goals.length, 1);
  assert.equal(facts.goals[0].side, 'away');
  assert.equal(facts.goals[0].teamId, 'flu');
  assert.equal(facts.goals[0].team, 'Fluminense');
  assert.equal(facts.goals[0].scorer, 'Kevin Serna');
}

// Se o monitor conhece o gol e o summary conhece a assistência para a MESMA
// transição e o MESMO marcador, apenas o detalhe complementar é incorporado.
{
  const base = buildSportsMonitorLiveFacts(match(1, 0, {
    g1: { key: 'g1', status: 'confirmed', teamId: 'home-1', side: 'home', athleteName: 'Hulk', homeScoreAfter: 1, awayScoreAfter: 0 }
  }));
  const supplemental = {
    integrity: { expectedHome: 1, expectedAway: 0, mathematicallyValid: true },
    goals: [{ teamId: 'home-1', side: 'home', scorer: 'Hulk', assists: ['John Kennedy'], scoreAfter: { home: 1, away: 0 } }],
    appearances: [{ name: 'John Kennedy', team: 'Flamengo', teamId: 'home-1' }]
  };
  const enriched = enrichSportsMonitorLiveFacts(base, supplemental);
  assert.deepEqual(enriched.goals[0].assists, ['John Kennedy']);
  assert.equal(enriched.meta.supplementalDetailsApplied, true);
}

// Um scorer conflitante do summary não pode substituir a memória stateful.
{
  const base = buildSportsMonitorLiveFacts(match(1, 0, {
    g1: { key: 'g1', status: 'confirmed', teamId: 'home-1', side: 'home', athleteName: 'Hulk', homeScoreAfter: 1, awayScoreAfter: 0 }
  }));
  const supplemental = {
    integrity: { expectedHome: 1, expectedAway: 0, mathematicallyValid: true },
    goals: [{ teamId: 'home-1', side: 'home', scorer: 'Outro Jogador', assists: ['X'], scoreAfter: { home: 1, away: 0 } }]
  };
  const enriched = enrichSportsMonitorLiveFacts(base, supplemental);
  assert.equal(enriched.goals[0].scorer, 'Hulk');
  assert.deepEqual(enriched.goals[0].assists, []);
}

// R10R5 — caso Bernard/CAM x RBB: o monitor já conhece a transição 1x0,
// mas perdeu o nome. O summary canônico do MESMO placar/equipe pode reidratar
// a autoria e a integridade precisa ser recalculada no mesmo response.
{
  const base = buildSportsMonitorLiveFacts(match(1, 0, {
    g1: { key: 'g1', status: 'confirmed', teamId: 'home-1', side: 'home', athleteName: '', minute: "18'", homeScoreAfter: 1, awayScoreAfter: 0 }
  }));
  assert.equal(base.integrity.status, 'identity-pending');
  assert.equal(base.integrity.missingScorers, 1);
  const supplemental = {
    integrity: { expectedHome: 1, expectedAway: 0, mathematicallyValid: true },
    goals: [{ teamId: 'home-1', side: 'home', scorerId: 'bernard-1', scorer: 'Bernard', minute: "18'", assists: [], scoreAfter: { home: 1, away: 0 }, sources: ['espn_core_plays'] }]
  };
  const enriched = enrichSportsMonitorLiveFacts(base, supplemental);
  assert.equal(enriched.monitorFactsVersion, 2);
  assert.equal(enriched.goals[0].scorer, 'Bernard');
  assert.equal(enriched.goals[0].scorerId, 'bernard-1');
  assert.equal(enriched.goals[0].identityPending, false);
  assert.ok(enriched.goals[0].sources.includes('espn-summary-details'));
  assert.equal(enriched.integrity.scorerResolvedCount, 1);
  assert.equal(enriched.integrity.missingScorers, 0);
  assert.equal(enriched.integrity.identityComplete, true);
  assert.equal(enriched.integrity.complete, true);
  assert.equal(enriched.integrity.status, 'complete');
  assert.equal(enriched.meta.supplementalScorerApplied, true);
  assert.equal(enriched.meta.supplementalScorersApplied, 1);
  assert.equal(enriched.meta.supplementalDetailsApplied, true);
}

// Segurança: scorer de outra equipe/lado para a mesma transição não pode ser
// usado para preencher um placeholder do monitor.
{
  const base = buildSportsMonitorLiveFacts(match(1, 0, {
    g1: { key: 'g1', status: 'confirmed', teamId: 'home-1', side: 'home', athleteName: '', homeScoreAfter: 1, awayScoreAfter: 0 }
  }));
  const enriched = enrichSportsMonitorLiveFacts(base, {
    integrity: { expectedHome: 1, expectedAway: 0, mathematicallyValid: true },
    goals: [{ teamId: 'away-1', side: 'away', scorer: 'Jogador Visitante', scoreAfter: { home: 1, away: 0 } }]
  });
  assert.equal(enriched.goals[0].scorer, '');
  assert.equal(enriched.integrity.missingScorers, 1);
}

// Segurança: se duas identidades diferentes disputarem a mesma transição, o
// sistema conserva o estado pendente em vez de escolher um nome por acaso.
{
  const base = buildSportsMonitorLiveFacts(match(1, 0, {
    g1: { key: 'g1', status: 'confirmed', teamId: 'home-1', side: 'home', athleteName: '', homeScoreAfter: 1, awayScoreAfter: 0 }
  }));
  const enriched = enrichSportsMonitorLiveFacts(base, {
    integrity: { expectedHome: 1, expectedAway: 0, mathematicallyValid: true },
    goals: [
      { teamId: 'home-1', side: 'home', scorer: 'Bernard', scoreAfter: { home: 1, away: 0 } },
      { teamId: 'home-1', side: 'home', scorer: 'Hulk', scoreAfter: { home: 1, away: 0 } }
    ]
  });
  assert.equal(enriched.goals[0].scorer, '');
  assert.equal(enriched.integrity.status, 'identity-pending');
  assert.equal(enriched.meta.supplementalScorerApplied, false);
}

console.log('monitor-live-facts: PASS');
