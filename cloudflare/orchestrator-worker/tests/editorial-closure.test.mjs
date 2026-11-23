import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  editorialClosureDecision, eligibleRoundFromAgenda, mergeHistoricalFinals,
  upcomingEditorialRounds, verifyEditorialDelivery
} from '../src/editorial-closure.js';
import { orchestratorCostDecision } from '../src/cost-governance.js';
import { dispatchSpec } from '../src/github.js';

function game(round,id,kickoff='2026-11-21T21:30:00-03:00',concluded=false) {
  const k=Number(String(id).split('-').at(-1))||0;
  return {eventId:String(id),league:'bra.1',round,kickoff:new Date(kickoff),
    concluded,home:'Casa '+round+' '+k,away:'Visitante '+round+' '+k};
}
function fixtures(round,closed=0) {
  return Array.from({length:10},(_,i)=>game(round,round+'-'+i,'2026-11-21T21:30:00-03:00',i<closed));
}
function finalRow(round,i,stamp='2026-11-21T23:24:00-03:00'){
  return {event_id:String(401900000+round*10+i),rodada:round,estado:'post',
    data_iso:'2026-11-21T21:30',
    finalizado_em:stamp,mandante:{nome:'Casa '+round+' '+i},
    visitante:{nome:'Visitante '+round+' '+i},placar_mandante:2,placar_visitante:1};
}
const now=new Date('2026-11-22T00:00:00-03:00');

test('legacy 10/10 based on full schedule remains compatible',()=>{
  const list=fixtures(29,10);
  const result=editorialClosureDecision(list,{artigos:[]},now);
  assert.equal(result.state,'pending');
  assert.equal(result.completed,10);
  const resolved=editorialClosureDecision(list,{
    artigos:[{tipo:'brasileirao_rodada',rodada:29,jogos_concluidos:10,id_editorial:'brasileirao-2026-rodada-29'}]
  },now);
  assert.equal(resolved.state,'resolved');
});

test('R35 lost from forward agenda is found from 10 canonical historical finals',async()=>{
  const results=JSON.parse(await readFile(new URL('../../../resultados.json',import.meta.url),'utf8'));
  const manifest=JSON.parse(await readFile(new URL('../../../dados-br/analises.json',import.meta.url),'utf8'));
  const merged=mergeHistoricalFinals(fixtures(36,0),results,new Date('2026-11-20T04:45:00-03:00'));
  const r35=merged.filter(g=>g.round===35);
  assert.equal(r35.length,10);
  assert.ok(r35.every(g=>g.concluded));
  assert.equal(r35.filter(g=>g.eventId==='401841309').length,1);
  const closure=editorialClosureDecision(merged,manifest,new Date('2026-11-20T04:45:00-03:00'));
  assert.equal(closure.round,35);
  assert.equal(closure.state,'resolved','GitHub has the article, but not proof of public delivery');
  assert.equal(closure.completed,10);
  assert.equal(closure.lastFinalAt,'2026-11-20T02:23:00.000Z');
});

test('R36, R37, R38 arm at 9/10 and fire immediately at the tenth verified FINAL',()=>{
  for(const round of [36,37,38]){
    const agenda=fixtures(round);
    const nine={resultados:Array.from({length:9},(_,i)=>finalRow(round,i))};
    const nineGames=mergeHistoricalFinals(agenda,nine,now);
    assert.equal(nineGames.filter(g=>g.round===round).length,10,'no duplicated physical matches');
    assert.equal(nineGames.filter(g=>g.concluded).length,9);
    assert.equal(eligibleRoundFromAgenda(nineGames,now),null);
    assert.equal(upcomingEditorialRounds(nineGames,now)[0].state,'armed');
    const ten={resultados:[...nine.resultados,finalRow(round,9)]};
    const complete=mergeHistoricalFinals(agenda,ten,now);
    const decision=editorialClosureDecision(complete,{artigos:[]},now);
    assert.equal(decision.round,round);
    assert.equal(decision.completed,10);
    assert.equal(decision.pending,0);
    assert.equal(decision.state,'pending');
    assert.match(decision.reason,/dez FINALs/);
    assert.equal(upcomingEditorialRounds(complete,now)[0].state,'final_confirmed');
  }
});

test('R36 real CBF calendar: 23/11 nine FINALs cannot publish; 25/11 Atlético-MG x Corinthians closes',async()=>{
  const calendar=JSON.parse(await readFile(new URL('../../../dados-br/calendario-completo.json',import.meta.url),'utf8'));
  const r36=(calendar.jogos||[]).filter(g=>Number(g.rodada)===36);
  assert.equal(r36.length,10,'CBF R36 must have exactly ten matches');
  const last=r36.find(g=>String(g.event_id)==='401841319');
  assert.equal(last?.data_iso,'2026-11-25T20:00');
  assert.equal(last?.mandante,'Atlético-MG');
  assert.equal(last?.visitante,'Corinthians');
  assert.equal(Math.max(...r36.map(g=>Date.parse(g.data_iso+'-03:00'))),Date.parse(last.data_iso+'-03:00'));
  const agenda=r36.map(g=>({
    eventId:String(g.event_id),league:'bra.1',round:36,
    kickoff:new Date(g.data_iso+'-03:00'),concluded:false,
    home:String(g.mandante),away:String(g.visitante)
  }));
  const result=g=>({
    event_id:String(g.event_id),rodada:36,estado:'post',
    data_iso:g.data_iso,finalizado_em:new Date(Date.parse(g.data_iso+'-03:00')+2*3600_000).toISOString(),
    mandante:{nome:String(g.mandante)},visitante:{nome:String(g.visitante)},
    placar_mandante:1,placar_visitante:0
  });
  const nineRows=r36.filter(g=>String(g.event_id)!=='401841319').map(result);
  const prior=new Date('2026-11-24T12:00:00-03:00');
  const nine=mergeHistoricalFinals(agenda,{resultados:nineRows},prior);
  assert.equal(upcomingEditorialRounds(nine,prior)[0].concluded,9);
  assert.equal(upcomingEditorialRounds(nine,prior)[0].pending,1);
  assert.equal(eligibleRoundFromAgenda(nine,prior),null,
    'R36 must NOT publish on Monday night or Tuesday while Atlético-MG x Corinthians is pending');
  const completeAt=new Date('2026-11-25T22:30:00-03:00');
  const ten=mergeHistoricalFinals(agenda,{resultados:[...nineRows,result(last)]},completeAt);
  const decision=editorialClosureDecision(ten,{artigos:[]},completeAt);
  assert.equal(decision.round,36);
  assert.equal(decision.completed,10);
  assert.equal(decision.pending,0);
  assert.equal(decision.state,'pending','R36 must be dispatched immediately after tenth certified FINAL');

  const updater=await readFile(new URL('../../../.github/workflows/atualizar-brasileirao.yml',import.meta.url),'utf8');
  const slash=String.fromCharCode(92);
  assert.ok(updater.includes("output.write(f'editorial_round={alvo}"+slash+"n')"),
    'fallback must write a real GitHub Actions output line, with one backslash-n');
  assert.ok(!updater.includes("output.write(f'editorial_round={alvo}"+slash+slash+"n')"),
    'literal backslash-n would corrupt GITHUB_OUTPUT and block fallback dispatch');
});

test('CBF placeholder event ID is replaced by ESPN FINAL for the same match',()=>{
  const future=fixtures(38);
  future[4].eventId='cbf-2026-384';
  const games=mergeHistoricalFinals(future,{resultados:[finalRow(38,4)]},now);
  assert.equal(games.length,10);
  assert.equal(games.find(g=>g.home==='Casa 38 4').eventId,String(401900000+38*10+4));
});

test('pre game, no finalizado_em, future-final and partial schedule fail closed',()=>{
  assert.equal(eligibleRoundFromAgenda(fixtures(37,9),now),null);
  assert.equal(eligibleRoundFromAgenda(fixtures(37,9).slice(0,9),now),null);
  const cases=[
    {...finalRow(37,0),estado:'in'},
    {...finalRow(37,1),finalizado_em:''},
    {...finalRow(37,2),finalizado_em:'2026-12-03T12:00:00-03:00'},
    {...finalRow(37,3),placar_mandante:null}
  ];
  const merged=mergeHistoricalFinals(fixtures(37),{resultados:cases},now);
  assert.equal(merged.filter(g=>g.concluded).length,0);
});

test('verified postponement window supports R36-38 without imaginary results',()=>{
  const rows=[
    ...fixtures(36,8),
    game(36,'36-8','2026-11-26T19:00:00-03:00',false),
    game(36,'36-9','2026-11-26T20:00:00-03:00',false)
  ];
  assert.equal(rows.length,12);
  const ten=rows.slice(0,8).concat(rows.slice(-2));
  assert.equal(eligibleRoundFromAgenda(ten,new Date('2026-11-22T04:00:00-03:00')),null);
  const after=eligibleRoundFromAgenda(ten,new Date('2026-11-22T07:00:00-03:00'),{
    minimo_jogos_para_fechamento_editorial:8,
    espera_apos_ultimo_jogo_horas:8,
    distancia_jogo_adiado_horas:72
  });
  assert.equal(after?.round,36);
  assert.equal(after?.completed,8);
  assert.equal(after?.pending,2);
});

test('GitHub content is not public delivery: require page + public manifest + hub',async()=>{
  const html='<main data-fdg-analise-rodada="35">'+
    '<article class="analysis-game-card"></article>'.repeat(10)+'</main>';
  const manifest={artigos:[{tipo:'brasileirao_rodada',rodada:35,jogos_concluidos:10,
    url:'https://formuladogol.com.br/analises/brasileirao-2026-rodada-35.html'}]};
  const okFetcher=async url=>url.includes('dados-br/analises.json')
    ?Response.json(manifest)
    :new Response(url.includes('/analises/brasileirao')?html:
      '<a href="brasileirao-2026-rodada-35.html">R35</a>',{status:200});
  assert.equal((await verifyEditorialDelivery({},35,10,now,okFetcher)).ok,true);
  const missingHub=async url=>url.includes('/analises/')&&!url.includes('.html')
    ?new Response('<div>R34 only</div>',{status:200}):okFetcher(url);
  const rejected=await verifyEditorialDelivery({},35,10,now,missingHub);
  assert.equal(rejected.ok,false);
  assert.equal(rejected.reason,'public_hub_stale');
  const down=await verifyEditorialDelivery({},35,10,now,async()=>new Response('bad',{status:503}));
  assert.equal(down.ok,false);
  assert.match(down.reason,/delivery_probe_failed/);
});

test('COST-SHIELD R2 may disable paid AI, never deterministic editorial or deploy',()=>{
  const shield={mode:'secondary_paused',optionalAllowed:false,secondaryAllowed:false};
  assert.equal(orchestratorCostDecision('editorial_rodada',shield).allowed,true);
  assert.equal(orchestratorCostDecision('deploy_editorial',shield).allowed,true);
  assert.equal(dispatchSpec({action:'editorial_rodada',round:36,useAI:false}).inputs.usar_ia,'false');
  assert.equal(dispatchSpec({action:'editorial_rodada',round:36,useAI:true}).inputs.usar_ia,'true');
  assert.equal(dispatchSpec({action:'deploy_editorial',round:36}).workflow,'deploy.yml');
});

test('architecture: FINAL history before enrichment, delivery recovery, cost-safe trigger and contract',async()=>{
  const state=await readFile(new URL('../src/orchestrator-state.js',import.meta.url),'utf8');
  const sources=await readFile(new URL('../src/sources.js',import.meta.url),'utf8');
  const contract=await readFile(new URL('../src/contract.js',import.meta.url),'utf8');
  const github=await readFile(new URL('../src/github.js',import.meta.url),'utf8');
  const deploy=await readFile(new URL('../../../.github/workflows/deploy-orchestrator-worker.yml',import.meta.url),'utf8');
  const workflow=await readFile(new URL('../../../.github/workflows/publicar-analise-rodada.yml',import.meta.url),'utf8');
  const siteDeploy=await readFile(new URL('../../../.github/workflows/deploy.yml',import.meta.url),'utf8');
  const config=JSON.parse(await readFile(new URL('../../../dados-br/config-orquestrador.json',import.meta.url),'utf8'));
  const guardAt=state.indexOf('await this.editorialClosureGuard(games, now)');
  const slowAt=state.indexOf("const lastSlow = await this.storageDate('meta:lastSlowEval')");
  assert.ok(guardAt>0&&slowAt>guardAt);
  assert.match(state,/mergeHistoricalFinals\(games,historical,now\)/);
  assert.match(state,/verifyEditorialDelivery\(/);
  assert.match(state,/delivery_manual_attention/);
  assert.match(state,/retryMinutes:5/);
  assert.match(state,/editorial:closure:lastResolved/);
  assert.match(state,/site_verified_cached/);
  assert.match(state,/ageMinutes>=15/);
  assert.match(sources,/'resultados\.json',/);
  assert.match(github,/deploy_editorial/);
  assert.match(workflow,/group: fdg-editorial-r2-/);
  assert.match(workflow,/USAR_IA/);
  assert.doesNotMatch(siteDeploy,/Gate de horário R35 concluído após a data da partida/);
  assert.doesNotMatch(siteDeploy,/Gate de artefato R35 concluído após a data da partida/);
  assert.match(contract,/editorialClosureGuaranteeVersion: 2/);
  assert.match(contract,/editorialClosureSlaMinutes: 15/);
  assert.match(deploy,/ORCHESTRATOR_CONTRACT\.health/);
  assert.equal(config.schema_version,8);
  assert.equal(config.editorial_closure_guarantee.ativo,true);
  assert.equal(config.editorial_closure_guarantee.sla_minutos,15);
});
