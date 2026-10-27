import assert from 'node:assert/strict';
import {
  extractArticlePublishedAt, recordPublicSourceObservation, recordPublicResolution,
  buildPublicDiscoveryDiagnostic, readPublicDiscoveryDiagnostics
} from '../src/postgame-public-observability.js';

const article='<html><head><meta property="article:published_time" content="2026-10-26T22:38:00-03:00"></head></html>';
assert.equal(extractArticlePublishedAt(article,Date.parse('2026-10-27T08:00:00Z')),'2026-10-27T01:38:00.000Z');
assert.equal(extractArticlePublishedAt('<script type="application/ld+json">{"datePublished":"2026-10-26T22:38:00-03:00"}</script>',Date.parse('2026-10-27T08:00:00Z')),'2026-10-27T01:38:00.000Z');
assert.equal(extractArticlePublishedAt('<meta property="article:published_time" content="2026-10-26">'),null,'data sem horário não pode virar hora inventada');
assert.equal(extractArticlePublishedAt('<meta property="article:published_time" content="2026-11-15T20:00:00-03:00">',Date.parse('2026-10-27T08:00:00Z')),null,'não aceitar publicação no futuro');

const statements=[];
const fake={DB:{prepare(sql){return {bind(...args){return{async run(){statements.push({sql,args});return{success:true}}}}}}}};
assert.equal(await recordPublicSourceObservation(fake,{
  eventId:'401841286',url:'https://ge.globo.com/gato-mestre/noticia/2026/10/26/partida.ghtml',
  provider:'ge-roundup-sitemap',outcome:'accepted',fields:['publico','renda'],
  publishedAt:'2026-10-26T22:38:00-03:00',at:Date.parse('2026-10-27T02:00:00Z')
}),true);
assert.equal(statements[0].args[8],0,'aceita não incrementa rejeição');
assert.equal(statements[0].args[9],1,'aceita incrementa contagem');
assert.equal(statements[0].args[12],'publico,renda');
assert.equal(statements[0].args[5],'2026-10-27T01:38:00.000Z');
assert.equal(await recordPublicSourceObservation(fake,{eventId:'401841286',url:'https://ge.globo.com/other',outcome:'rejected',reason:'identity_gate',at:Date.parse('2026-10-27T02:01:00Z')}),true);
assert.equal(statements[1].args[8],1);
assert.equal(statements[1].args[9],0);
assert.equal(await recordPublicResolution(fake,'401841286',{channel:'hunter:gemini',at:Date.parse('2026-10-27T02:02:00Z')}),true);
assert.match(statements[2].sql,/INSERT OR IGNORE/);

const event={
  event_id:'401841286',home:'Flamengo',away:'Atlético-MG',
  public_status:'resolved',publico:60624,renda:4578137.5,
  final_at:'2026-10-27T01:01:00Z',
  first_observed_resolved_at:'2026-10-27T02:02:00Z',
  channel:'hunter:gemini'
};
const src={
  event_id:'401841286',url:'https://ge.globo.com/gato-mestre/noticia/2026/10/26/partida.ghtml',
  provider:'ge-roundup-sitemap',first_discovered_at:'2026-10-27 01:39:00',
  first_checked_at:'2026-10-27T01:50:00Z',first_accepted_at:'2026-10-27T02:00:00Z',
  published_at:'2026-10-27T01:38:00Z',check_count:3,rejected_count:2,accepted_count:1,
  last_reason:'validated_deterministic',last_outcome:'accepted',accepted_fields:'publico,renda'
};
const costRows=[
  {event_id:event.event_id,provider:'gemini',model:'gemini-3.5-flash-lite',calls:2,searches:2,input_tokens:0,output_tokens:0,failures:1},
  {event_id:event.event_id,provider:'openai',model:'gpt-5.6-terra',calls:1,searches:1,input_tokens:0,output_tokens:0,failures:0},
  {event_id:event.event_id,provider:'workers-ai',model:'@cf/meta/llama',calls:1,searches:0,input_tokens:0,output_tokens:0,failures:0},
];
const computed=buildPublicDiscoveryDiagnostic(event,[src],costRows);
assert.equal(computed.timeline.finalToResolvedMinutes,61);
assert.equal(computed.timeline.publishedToValidatedMinutes,22);
assert.equal(computed.timeline.finalToFirstUrlMinutes,38);
assert.equal(computed.sourceFunnel.checks,3);
assert.equal(computed.sourceFunnel.rejected,2);
assert.equal(computed.sourceFunnel.acceptancePct,33.3);
assert.equal(computed.cost.estimatedUsd,0.038,'2 buscas Gemini + 1 OpenAI');
assert.equal(computed.cost.byProvider[2].estimatedUsd,null,'Workers AI sem preço USD inferido');
assert.equal(buildPublicDiscoveryDiagnostic({...event,first_observed_resolved_at:null},[src],[]).timeline.finalToResolvedMinutes,null,'sem inventar timestamp histórico');

const db={DB:{prepare(sql){return{bind(){return this},async all(){
  if(sql.includes('FROM postgame_fastlane p'))return{results:[event]};
  if(sql.includes('FROM postgame_source_cache c'))return{results:[src]};
  if(sql.includes('FROM ai_provider_ledger'))return{results:costRows};
  throw Error('unexpected SQL '+sql);
}}}}};
const api=await readPublicDiscoveryDiagnostics(db,['401841286']);
assert.equal(api.ok,true);
assert.equal(api.rows.length,1);
assert.equal(api.rows[0].timeline.finalToResolvedMinutes,61);
assert.equal(api.summary.estimatedUsd,0.038);
assert.equal(api.summary.meanFinalToResolutionMinutes,61);
assert.equal(api.summary.measuredResolutions,1);
console.log('Hunter source lifecycle / published-to-validated latency / cost observability: PASS');
