import assert from 'node:assert/strict';
import { normalizeLiveFacts, chooseBestKnownLiveFacts, LIVE_FACTS_CONSTANTS } from '../src/live-facts.js';

function summary(eventId,home,away,homeScore,awayScore,goals=[]){return{header:{id:eventId,competitions:[{competitors:[{homeAway:'home',score:String(homeScore),team:home},{homeAway:'away',score:String(awayScore),team:away}]}]},scoringPlays:Array.isArray(goals)?goals:[goals]};}
const flu={id:'3445',displayName:'Fluminense'},cor={id:'874',displayName:'Corinthians'};
const vit={id:'3456',displayName:'Vitória'},cru={id:'2022',displayName:'Cruzeiro'};

// Autor + assistência reconciliados com o placar exato.
{
  const data=summary('hulk',flu,cor,1,0,[{id:'g1',scoringPlay:true,teamId:'3445',homeScore:1,awayScore:0,clock:{displayValue:"23'"},athletesInvolved:[{id:'hulk',displayName:'Hulk'},{id:'jk',displayName:'John Kennedy',type:{text:'assist'}}],text:'Goal! Hulk. Assisted by John Kennedy.'}]);
  const h=normalizeLiveFacts(data,{eventId:'hulk',expectedHome:1,expectedAway:0,expectedGoals:1,variants:[{source:'test',data}]});
  assert.equal(h.contractVersion,LIVE_FACTS_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION);
  assert.equal(h.integrity.complete,true);
  assert.equal(h.integrity.expectedHome,1);
  assert.equal(h.integrity.expectedAway,0);
  assert.equal(h.goals[0].team,'Fluminense');
  assert.equal(h.goals[0].scorer,'Hulk');
  assert.deepEqual(h.goals[0].assists,['John Kennedy']);
}

{
  const data=summary('rene',vit,cru,1,0,[{id:'v1',scoringPlay:true,teamId:'3456',homeScore:1,awayScore:0,clock:{displayValue:"7'"},athletesInvolved:[{id:'rene',displayName:'Renê'}],text:'Gol! Renê.'}]);
  const r=normalizeLiveFacts(data,{eventId:'rene',expectedHome:1,expectedAway:0,variants:[{source:'test',data}]});
  assert.equal(r.integrity.complete,true);
  assert.equal(r.goals[0].team,'Vitória');
  assert.equal(r.goals[0].scorer,'Renê');
}

// Regressão real 20/09: 0x0 nunca pode publicar Plata/Varela (ou qualquer outro gol).
{
  const fla={id:'819',displayName:'Flamengo'},rbr={id:'6079',displayName:'Bragantino'};
  const rogue=summary('fla-rbr',fla,rbr,0,0,[
    {id:'p1',scoringPlay:true,teamId:'819',homeScore:1,awayScore:0,clock:{displayValue:"10'"},athletesInvolved:[{displayName:'Gonzalo Plata'}],text:'Goal! Gonzalo Plata.'},
    {id:'p2',scoringPlay:true,teamId:'819',homeScore:2,awayScore:0,clock:{displayValue:"13'"},athletesInvolved:[{displayName:'Guillermo Varela'}],text:'Goal! Guillermo Varela.'}
  ]);
  const facts=normalizeLiveFacts(rogue,{eventId:'fla-rbr',expectedHome:0,expectedAway:0,variants:[{source:'rogue-feed',data:rogue}]});
  assert.equal(facts.goals.length,0,'placar 0x0 deve zerar fatos de gol, mesmo se o feed bruto trouxer scoringPlay');
  assert.equal(facts.integrity.expectedGoals,0);
  assert.equal(facts.integrity.observedGoalCount,0);
  assert.equal(facts.integrity.complete,true);
  assert.equal(facts.integrity.rawGoalVariants,2);
  assert.equal(facts.integrity.discardedGoalVariants,2);
  assert.equal(facts.integrity.reconciliationState,'scoreboard_zero_discards_raw');
}

// Se o feed atribui Serna ao Fluminense mas o estado de placar diz gol do mandante,
// há contradição. O sistema preserva o gol matemático, mas NÃO atribui Serna ao Corinthians.
{
  const contradictory=summary('serna-conflict',cor,flu,1,0,[{id:'s1',scoringPlay:true,teamId:'3445',homeScore:1,awayScore:0,clock:{displayValue:"17'"},athletesInvolved:[{displayName:'Kevin Serna'}],text:'Goal! Kevin Serna.'}]);
  const facts=normalizeLiveFacts(contradictory,{eventId:'serna-conflict',expectedHome:1,expectedAway:0,variants:[{source:'conflict',data:contradictory}]});
  assert.equal(facts.goals.length,1);
  assert.equal(facts.goals[0].team,'Corinthians','a transição 0x0->1x0 define o lado matemático');
  assert.equal(facts.goals[0].scorer,'','jogador contraditório não pode ser atribuído ao adversário');
  assert.equal(facts.integrity.status,'identity-pending');
  assert.equal(facts.integrity.complete,false);
}

// Feed sem autoria pode confirmar o gol, mas não a identidade.
{
  const data=summary('incomplete',flu,cor,1,0,[{id:'x',scoringPlay:true,teamId:'3445',homeScore:1,awayScore:0,clock:{displayValue:"9'"},text:'Goal'}]);
  const incomplete=normalizeLiveFacts(data,{eventId:'incomplete',expectedHome:1,expectedAway:0,variants:[{source:'test',data}]});
  assert.equal(incomplete.integrity.scoreComplete,true);
  assert.equal(incomplete.integrity.identityComplete,false);
  assert.equal(incomplete.integrity.status,'identity-pending');
}

// Best-known só pode sobreviver para o MESMO placar exato e se for matematicamente válido.
{
  const richData=summary('best',flu,cor,1,0,[{id:'g',scoringPlay:true,teamId:'3445',homeScore:1,awayScore:0,clock:{displayValue:"23'"},athletesInvolved:[{displayName:'Hulk'}],text:'Goal! Hulk.'}]);
  const rich=normalizeLiveFacts(richData,{eventId:'best',expectedHome:1,expectedAway:0,variants:[{source:'rich',data:richData}]});
  const poorData=summary('best',flu,cor,1,0,[{id:'g',scoringPlay:true,teamId:'3445',homeScore:1,awayScore:0,clock:{displayValue:"23'"},text:'Goal'}]);
  const poor=normalizeLiveFacts(poorData,{eventId:'best',expectedHome:1,expectedAway:0,variants:[{source:'poor',data:poorData}]});
  const chosen=chooseBestKnownLiveFacts(poor,rich);
  assert.equal(chosen.applied,true);
  assert.equal(chosen.facts.goals[0].scorer,'Hulk');

  const zero=normalizeLiveFacts(summary('best',flu,cor,0,0,[]),{eventId:'best',expectedHome:0,expectedAway:0});
  const afterVar=chooseBestKnownLiveFacts(zero,rich);
  assert.equal(afterVar.applied,false,'best-known de 1x0 não pode sobreviver depois de regressão canônica para 0x0');
  assert.equal(afterVar.facts.goals.length,0);
}

console.log('PASS live-facts v3 / Live Facts v7');
