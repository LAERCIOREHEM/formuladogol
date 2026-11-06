import assert from 'node:assert/strict';
import { parsePublicSearchRss, discoverFreePublicNews, buildPostgameRssQueries } from '../src/postgame-rss-discovery.js';
import { isCandidateEditorialAttendanceSource } from '../src/postgame-search-profile.js';

const task={home:'Bragantino',away:'Chapecoense',kickoff:'2026-10-28T19:30:00-03:00',
  home_score:3,away_score:0,round:33};
const uol='https://www.uol.com.br/esporte/ultimas-noticias/agencia/2026/10/28/bragantino-vence-chapecoense.htm';
const regional='https://www.futebolinterior.com.br/red-bull-bragantino-3-x-0-chapecoense-wallace-yan-da-show-e-garante-a-vitoria/';
const bad='https://www.site.com.br/esportes/2026/05/03/chapecoense-bahia/';
const xml='<rss version="2.0"><channel><title>Bing RSS</title>'+
  '<item><title>Bragantino 3 x 0 Chapecoense: renda e público</title><link>'+regional+'</link><description>3 a 0</description></item>'+
  '<item><title>Bragantino vence Chapecoense: ficha técnica</title><link>'+uol+'</link></item>'+
  '<item><title>Chapecoense e Bahia se enfrentam</title><link>'+bad+'</link></item>'+
  '<item><title>Red Bull Bragantino bate Chapecoense</title>'+
    '<link>https://www.bing.com/news/apiclick.aspx?ref=123&amp;url='+encodeURIComponent(regional)+'</link></item>'+
  '</channel></rss>';
assert.equal(isCandidateEditorialAttendanceSource(regional,task),true,
  'matéria regional com clubes no slug não pode ser bloqueada pelo caminho raiz');
assert.deepEqual(parsePublicSearchRss(xml,task),[regional,uol],
  'busca genérica deve encontrar o resultado da fonte certa, não jogo diferente nem duplicata');
assert.deepEqual(parsePublicSearchRss('<html>not rss</html>',task),[]);
assert.deepEqual(parsePublicSearchRss(xml,{home:'Fluminense',away:'Internacional'}),[]);

const urls=[];
const fakeFetch=async (url)=>{
  urls.push(String(url));
  return new Response(xml,{status:200,headers:{'content-type':'application/rss+xml'}});
};
const found=await discoverFreePublicNews(task,fakeFetch);
assert.equal(found.feedsOk,5);
assert.deepEqual(found.urls,[regional,uol]);
assert.equal(urls.length,5);
assert.ok(urls.every((x)=>x.includes('format=rss')));

const palTask={event_id:'401841300',home:'Palmeiras',away:'Remo',
  kickoff:'2026-11-05T19:30:00-03:00',home_score:6,away_score:1,round:34};
const search=buildPostgameRssQueries(palTask);
assert.equal(search[0],'Palmeiras Remo público renda','search must mirror simple Google lookup');
assert.ok(search.some(q=>q.includes('6 x 1')));
assert.ok(search.some(q=>q.includes('05/11/2026')));
assert.ok(search.some(q=>q.includes('site:uol.com.br')));
const palUrl='https://www.uol.com.br/esporte/ultimas-noticias/agencia/2026/11/05/palmeiras-passeia-em-casa-faz-6-no-remo-e-se-mantem-na-cola-do-flamengo.htm';
const badHistorical='https://www.uol.com.br/esporte/ultimas-noticias/agencia/2021/11/05/palmeiras-vence-remo.htm';
const palXml='<rss version="2.0"><channel><item><title>Palmeiras passeia em casa, faz 6 no Remo</title>'+
  '<link>'+palUrl+'</link><description>Ficha técnica de 05/11/2026</description></item>'+
  '<item><title>Palmeiras x Corinthians</title><link>'+badHistorical+
  '</link><description>Sem a dupla do jogo</description></item></channel></rss>';
const seen=[];
const palFound=await discoverFreePublicNews(palTask,async url=>{
  seen.push(new URL(url).searchParams.get('q'));
  return new Response(palXml,{status:200,headers:{'content-type':'application/rss+xml'}});
});
assert.equal(palFound.feedsOk,5);
assert.deepEqual(palFound.urls,[palUrl],'must discover user provided UOL agency story');
assert.equal(seen.length,5);
assert.equal(seen[0],search[0]);
console.log('PASS: Palmeiras x Remo discovery with generic/date/score/UOL queries');

console.log('Hunter free generic RSS fallback, safe links, regional slug and fixture guard: PASS');
