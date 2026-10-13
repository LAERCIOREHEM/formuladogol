import assert from 'node:assert/strict';
import {
  applyObservation, initialMatchState, mergeScoringPlayVariants,
  reconcileScoringPlays, scorerCoverage, unresolvedScorersForTransition
} from '../src/sports-engine.js';
import { shouldRetryMissingScorers } from '../src/sports-monitor.js';
import { buildSportsMonitorLiveFacts, enrichSportsMonitorLiveFacts } from '../src/monitor-live-facts.js';
import { normalizeLiveFacts } from '../src/live-facts.js';

const obs = (homeScore=1,awayScore=0,state='in')=>({
  eventId:'regressao-bragantino-cruzeiro',league:'bra.1',state,
  home:{id:'rbb',name:'Bragantino',score:homeScore},
  away:{id:'cru',name:'Cruzeiro',score:awayScore}
});
const play = (key,name='',id='',structured=false,score=[1,0],ownGoal=false)=>({
  key,sourceName:'espn_core_plays',teamId:score[0]>0&&score[1]===0?'rbb':score[0]===3?'rbb':'cru',
  side:score[0]>0&&score[1]===0?'home':score[0]===3?'home':'away',
  athleteName:name,athleteId:id,athleteStructured:structured,
  minute:"13'",homeScoreAfter:score[0],awayScoreAfter:score[1],ownGoal,
  order:13
});

// Dois nomes apenas inferidos podem divergir; um atleta identificado pela ESPN
// no MESMO placar/time resolve o conflito sem depender da ordem dos feeds.
{
  const variants=[
    {source:'espn_cdn_league_playbyplay',plays:[play('g1','Lucas Barbosa')]},
    {source:'espn_cdn_soccer_playbyplay',plays:[play('g2','Outro Nome')]},
    {source:'espn_core_plays',plays:[play('g3','Lucas Barbosa','lucas-123',true)]}
  ];
  const merged=mergeScoringPlayVariants(variants);
  assert.equal(merged.length,1);
  assert.equal(merged[0].athleteName,'Lucas Barbosa');
  assert.equal(merged[0].scorerConflict,false,'evidência estruturada precisa limpar conflito transitório');
  assert.equal(unresolvedScorersForTransition({plays:{}},obs(),merged),0);
}

// Mesmo athleteId, nomes abreviados diferentes: nunca é conflito de pessoa.
{
  const merged=mergeScoringPlayVariants([
    {source:'a',plays:[play('a','Lucas B.','123',true)]},
    {source:'b',plays:[play('b','Lucas Barbosa','123',true)]}
  ]);
  assert.equal(merged[0].scorerConflict,false,'IDs iguais nunca criam conflito');
  assert.equal(merged[0].athleteName,'Lucas Barbosa');
}

// Dois IDs estruturados DIFERENTES continuam bloqueados, mesmo se um deles
// aparecer novamente em uma terceira superfície ESPN.
{
  const merged=mergeScoringPlayVariants([
    {source:'a',plays:[play('a','Jogador Um','1',true)]},
    {source:'b',plays:[play('b','Jogador Dois','2',true)]},
    {source:'c',plays:[play('c','Jogador Um','1',true)]}
  ]);
  assert.equal(merged[0].scorerConflict,true);
  assert.equal(merged[0].scorerConflictStrong,true);
  assert.equal(scorerCoverage(merged,obs()).missingScorers,1);
}

// Nomes iguais NÃO autorizam unir IDs estruturados distintos.
{
  const merged=mergeScoringPlayVariants([
    {source:'a',plays:[play('a','João Silva','11',true)]},
    {source:'b',plays:[play('b','João Silva','22',true)]}
  ]);
  assert.equal(merged[0].scorerConflict,true);
  assert.equal(merged[0].scorerConflictStrong,true);
}

// A busca não pode cessar quando um gol sem autor muda de pending para confirmed.
{
  const current=obs();
  let match=initialMatchState(obs(0,0));
  match=applyObservation(match,obs(0,0),null,1_000_000).match;
  const noName=play('goal-13','');
  match=applyObservation(match,current,[noName],1_010_000).match;
  match=applyObservation(match,current,[noName],1_020_000).match;
  match=applyObservation(match,current,[noName],1_031_000).match;
  assert.equal(match.plays['goal-13'].status,'confirmed');
  assert.equal(unresolvedScorersForTransition(match,current,[noName]),1);
  assert.equal(shouldRetryMissingScorers(match,current,1,1_060_000),true);
  match.lastScorerRecoveryAt=1_060_000;
  assert.equal(shouldRetryMissingScorers(match,current,1,1_075_000),false,'limitar reconsultas');
  assert.equal(shouldRetryMissingScorers(match,current,1,1_090_000),true,'tentar novamente em 30s');
  assert.equal(shouldRetryMissingScorers(match,obs(1,0,'post'),1,1_090_000),false,'não gastar buscas de jogo encerrado');
  const withName=play('goal-13','Lucas Barbosa','lucas-123',true);
  const enriched=applyObservation(match,current,[withName],1_091_000);
  assert.equal(enriched.match.plays['goal-13'].athleteName,'Lucas Barbosa');
  assert.equal(enriched.match.plays['goal-13'].scorerConflict,false);
  assert.equal(enriched.emitted.filter(e=>e.type==='goal').length,0,'recuperação não dispara gol duplicado');
  assert.equal(unresolvedScorersForTransition(enriched.match,current,[withName]),0);
}

// Conflito antigo no DO não é uma condenação permanente se o summary canônico
// do mesmo placar/time comprova um ÚNICO ID estruturado.
{
  const state={...obs(),eventId:'regressao-bragantino-cruzeiro',plays:{
    'goal-13':{...play('goal-13','Lucas Barbosa','',false),scorerConflict:true,status:'confirmed'}
  }};
  const base=buildSportsMonitorLiveFacts(state);
  assert.equal(base.integrity.missingScorers,1);
  const supplement={integrity:{expectedHome:1,expectedAway:0,mathematicallyValid:true},goals:[{
    scorer:'Lucas Barbosa',scorerId:'lucas-123',teamId:'rbb',side:'home',
    scoreAfter:{home:1,away:0},sources:['espn_core_plays']
  }]};
  const fixed=enrichSportsMonitorLiveFacts(base,supplement);
  assert.equal(fixed.goals[0].scorer,'Lucas Barbosa');
  assert.equal(fixed.integrity.missingScorers,0);
  assert.equal(fixed.integrity.complete,true);
  const weak=enrichSportsMonitorLiveFacts(base,{...supplement,goals:[{...supplement.goals[0],scorerId:''}]});
  assert.equal(weak.goals[0].scorer,'','conflito histórico não pode ser resolvido por palpite textual');
  const wrong=enrichSportsMonitorLiveFacts(base,{...supplement,goals:[{...supplement.goals[0],teamId:'cru',side:'away'}]});
  assert.equal(wrong.goals[0].scorer,'','equipe errada não pode preencher o autor');
}

// Gol contra é fato confirmado, mas o NOME do autor continua recuperável.
{
  const og=play('og-20','', '',false,[2,0],true);
  assert.equal(scorerCoverage([og],obs(2,0)).missingScorers,2);
  const prior={...obs(2,0),plays:{'og-20':{...og,status:'confirmed'}}};
  assert.ok(unresolvedScorersForTransition(prior,obs(2,0),[og])>0);
}

// Conflito de dois IDs estruturados não pode ser resolvido por um terceiro
// snapshot isolado que simplesmente escolheu um dos jogadores.
{
  const base=buildSportsMonitorLiveFacts({...obs(),plays:{
    a:{...play('a','Jogador Um','1',true),scorerConflict:true,scorerConflictStrong:true,status:'confirmed'}
  }});
  const enriched=enrichSportsMonitorLiveFacts(base,{
    integrity:{expectedHome:1,expectedAway:0,mathematicallyValid:true},
    goals:[{teamId:'rbb',side:'home',scorer:'Jogador Um',scorerId:'1',scoreAfter:{home:1,away:0}}]
  });
  assert.equal(enriched.goals[0].scorer,'');
  assert.equal(enriched.integrity.status,'identity-pending');
}

// Caso R30 Bragantino 3x1 Cruzeiro: quatro transições matemáticas, incluindo
// gol contra, e autor do primeiro gol recuperado por uma superfície ESPN rica.
{
  const teamHome={id:'rbb',displayName:'Bragantino'};
  const teamAway={id:'cru',displayName:'Cruzeiro'};
  const summary={header:{id:'regressao-bragantino-cruzeiro',competitions:[{competitors:[
    {homeAway:'home',score:'3',team:teamHome},{homeAway:'away',score:'1',team:teamAway}
  ]}]}};
  const rows=[
    {id:'1',scoringPlay:true,teamId:'rbb',homeScore:1,awayScore:0,clock:{displayValue:"13'"},athletesInvolved:[{id:'lucas-123',displayName:'Lucas Barbosa'}],text:'Goal'},
    {id:'2',scoringPlay:true,teamId:'rbb',homeScore:2,awayScore:0,clock:{displayValue:"20'"},ownGoal:true,text:'Own Goal'},
    {id:'3',scoringPlay:true,teamId:'rbb',homeScore:3,awayScore:0,clock:{displayValue:"30'"},athletesInvolved:[{id:'ramires-123',displayName:'Eric Ramires'}],text:'Goal'},
    {id:'4',scoringPlay:true,teamId:'cru',homeScore:3,awayScore:1,clock:{displayValue:"43'"},athletesInvolved:[{id:'zelucas-123',displayName:'Zé Lucas'}],text:'Goal'}
  ];
  const canonical=normalizeLiveFacts({...summary,scoringPlays:rows},{eventId:'regressao-bragantino-cruzeiro',expectedHome:3,expectedAway:1,variants:[{source:'espn_core_plays',data:{...summary,scoringPlays:rows}}]});
  assert.equal(canonical.integrity.scoreComplete,true);
  assert.equal(canonical.integrity.missingScorers,0);
  assert.deepEqual(canonical.goals.map(g=>g.scorer),['Lucas Barbosa','','Eric Ramires','Zé Lucas']);
  assert.equal(canonical.goals[1].ownGoal,true);
  assert.deepEqual(canonical.goals.map(g=>g.scoreAfter),[{home:1,away:0},{home:2,away:0},{home:3,away:0},{home:3,away:1}]);
}

console.log('scorer-recovery: PASS');
