// EDITORIAL-CLOSURE R2 — Final-Driven Publishing & Verified Delivery.
// No AI or paid calls. Decisions use canonical FINAL history, not only the
// forward-looking agenda (which intentionally removes completed rounds).
const BR_LEAGUE='bra.1';
const VERIFIED_GAMES=10;

function asDate(value) {
  if(!value)return null;
  if(value instanceof Date)return Number.isNaN(value.getTime())?null:value;
  let text=String(value).trim();
  // Historical Brazilian ESPN files have local date_iso without UTC offset.
  if(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(text))text+='-03:00';
  const d=new Date(text);
  return Number.isNaN(d.getTime())?null:d;
}

function slugName(value) {
  return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
    .replace(/^vasco da gama$/,'vasco')
    .replace(/^(?:rb |red bull )?bragantino$/,'bragantino')
    .replace(/^athletico pr$/,'athletico')
    .replace(/^atletico mg$/,'atletico mineiro');
}

function teamName(value) {
  return value&&typeof value==='object'?String(value.nome||value.name||''):String(value||'');
}

function physicalKey(game) {
  return [game.round,slugName(game.home),slugName(game.away)].join('|');
}

function articleForRound(analyses,round) {
  return (analyses?.artigos||[]).find(a=>a?.tipo==='brasileirao_rodada'&&Number(a?.rodada||0)===Number(round))||null;
}

/** Preserve next-match kickoffs and overlay historical canonical FINALs.
 * ESPN IDs and CBF placeholder IDs may differ; identity uses round + teams.
 * Only finalized events with scores and nonfuture final timestamp count.
 */
export function mergeHistoricalFinals(agendaGames=[], results={}, now=new Date()) {
  const byMatch=new Map();
  for(const game of agendaGames||[]) {
    if(String(game?.league||'')!==BR_LEAGUE)continue;
    if(!Number.isInteger(Number(game.round))||Number(game.round)<1||Number(game.round)>38)continue;
    if(!game?.kickoff||!game?.home||!game?.away)continue;
    byMatch.set(physicalKey(game),{...game});
  }
  const clock=asDate(now)?.getTime()||Date.now();
  for(const row of results?.resultados||[]) {
    const eventId=String(row?.event_id||'').trim();
    const round=Number(row?.rodada);
    const state=String(row?.estado||'').toLowerCase();
    const home=teamName(row?.mandante),away=teamName(row?.visitante);
    const kickoff=asDate(row?.data_iso);
    const finished=asDate(row?.finalizado_em);
    const scoreHome=Number(row?.placar_mandante),scoreAway=Number(row?.placar_visitante);
    if(!eventId||!Number.isInteger(round)||round<1||round>38||!home||!away||
       !kickoff||!finished||finished.getTime()>clock+60_000||
       state!=='post'||row?.placar_mandante==null||row?.placar_visitante==null||
       !Number.isInteger(scoreHome)||!Number.isInteger(scoreAway)||scoreHome<0||scoreAway<0)continue;
    const game={eventId,league:BR_LEAGUE,round,kickoff,finalizedAt:finished,
      concluded:true,home,away,homeScore:scoreHome,awayScore:scoreAway};
    const key=physicalKey(game);
    const existing=byMatch.get(key);
    if(!existing||existing.concluded!==true||!existing.finalizedAt||
       finished.getTime()>asDate(existing.finalizedAt).getTime())byMatch.set(key,game);
  }
  return [...byMatch.values()];
}

export function eligibleRoundFromAgenda(games,now,config={}) {
  const current=asDate(now)||new Date();
  const minimum=Number(config.minimo_jogos_para_fechamento_editorial||8);
  const waitHours=Number(config.espera_apos_ultimo_jogo_horas||8);
  const postponedHours=Number(config.distancia_jogo_adiado_horas||72);
  const byRound=new Map();
  for(const game of games||[]) {
    if(String(game?.league||'')!==BR_LEAGUE)continue;
    const round=Number(game?.round||0);
    if(!Number.isInteger(round)||round<1||round>38)continue;
    if(!byRound.has(round))byRound.set(round,[]);
    byRound.get(round).push(game);
  }
  const eligible=[];
  for(const [round,rows] of byRound.entries()) {
    // Fail closed: a round must prove exactly ten DISTINCT physical fixtures.
    if(rows.length!==VERIFIED_GAMES||new Set(rows.map(physicalKey)).size!==VERIFIED_GAMES)continue;
    const completed=rows.filter(g=>g.concluded===true);
    const pending=rows.filter(g=>g.concluded!==true);
    if(completed.length===VERIFIED_GAMES) {
      eligible.push({round,completed:10,pending:0,reason:'dez FINALs oficiais confirmados',
        lastFinalAt:new Date(Math.max(...completed.map(g=>asDate(g.finalizedAt||g.kickoff)?.getTime()||0))).toISOString()});
      continue;
    }
    if(completed.length<minimum||!pending.length)continue;
    const completedDates=completed.map(g=>asDate(g.finalizedAt||g.kickoff)).filter(Boolean);
    const pendingDates=pending.map(g=>asDate(g.kickoff)).filter(Boolean);
    if(!completedDates.length)continue;
    const lastCompleted=new Date(Math.max(...completedDates.map(d=>d.getTime())));
    const pendingFar=!!pendingDates.length&&Math.min(...pendingDates.map(d=>d.getTime()))>=lastCompleted.getTime()+postponedHours*3_600_000;
    const waited=current.getTime()>=lastCompleted.getTime()+waitHours*3_600_000;
    if(pendingFar&&waited){
      eligible.push({round,completed:completed.length,pending:pending.length,
        reason:'fechamento excepcional com jogo adiado',
        lastFinalAt:lastCompleted.toISOString()});
    }
  }
  return eligible.sort((a,b)=>b.round-a.round)[0]||null;
}

/** Diagnostic: a 9/10 round is ARMED, never prematurely released. */
export function upcomingEditorialRounds(games,now) {
  const byRound=new Map();
  for(const g of games||[]){
    if(g?.league!==BR_LEAGUE||!Number.isInteger(Number(g.round)))continue;
    const round=Number(g.round);
    if(![35,36,37,38].includes(round))continue;
    if(!byRound.has(round))byRound.set(round,[]);
    byRound.get(round).push(g);
  }
  const rows=[];
  for(const [round,group] of byRound){
    const pending=group.filter(g=>!g.concluded);
    const kickoffs=pending.map(g=>asDate(g.kickoff)).filter(Boolean);
    rows.push({
      round,scheduledGames:group.length,
      concluded:group.filter(g=>g.concluded).length,pending:pending.length,
      state:group.length!==10?'incomplete_schedule':pending.length===0?'final_confirmed':'armed',
      finalScheduledKickoffAt:kickoffs.length?new Date(Math.max(...kickoffs.map(d=>d.getTime()))).toISOString():null
    });
  }
  return rows.sort((a,b)=>a.round-b.round);
}

export function editorialClosureDecision(games,analyses,now,config={}) {
  const state=eligibleRoundFromAgenda(games,now,config);
  if(!state)return {state:'idle',eligible:false,round:0,completed:0,pending:0,reason:'nenhuma rodada elegível'};
  const article=articleForRound(analyses,state.round);
  const articleGames=Number(article?.jogos_concluidos||0);
  if(article&&articleGames>=state.completed){
    return {...state,state:'resolved',eligible:true,articlePresent:true,articleGames,
      articleId:String(article?.id_editorial||''),articleUrl:String(article?.url||'')};
  }
  return {...state,state:'pending',eligible:true,articlePresent:false,articleGames,articleId:''};
}

/** A GitHub commit is not a publication. Verify all public surfaces. */
export async function verifyEditorialDelivery(env,round,completed=10,now=new Date(),fetcher=fetch) {
  const number=Number(round);
  if(!Number.isInteger(number)||number<1||number>38)
    return {ok:false,reason:'invalid_round'};
  const base=String(env?.SITE_BASE||'https://formuladogol.com.br').replace(/\/+$/,'');
  const slug='brasileirao-2026-rodada-'+number+'.html';
  const nonce=Math.floor((asDate(now)?.getTime()||Date.now())/300_000);
  async function get(path,type){
    const url=base+path+'?fdg_closure_r2='+nonce;
    const response=await fetcher(url,{headers:{'Accept':type==='json'?'application/json':'text/html',
      'Cache-Control':'no-cache','User-Agent':'FDG-Editorial-Closure-R2/1.0'},
      cf:{cacheTtl:0,cacheEverything:false},signal:AbortSignal.timeout(6500)});
    if(!response?.ok)throw Error(path+':http_'+(response?.status||'failed'));
    return type==='json'?response.json():response.text();
  }
  try {
    const [html,manifest,hub]=await Promise.all([
      get('/analises/'+slug,'html'),get('/dados-br/analises.json','json'),get('/analises/','html')
    ]);
    const marker='data-fdg-analise-rodada="'+number+'"';
    const cards=(String(html).match(/class="analysis-game-card"/g)||[]).length;
    const article=articleForRound(manifest,number);
    const url=String(article?.url||'');
    const articleOK=String(html).includes(marker)&&cards===completed;
    const manifestOK=Boolean(article&&Number(article.jogos_concluidos)===completed&&url.endsWith('/'+slug));
    const hubOK=String(hub).includes(slug);
    return {ok:articleOK&&manifestOK&&hubOK,
      reason:!articleOK?'article_incomplete_or_unavailable':!manifestOK?'public_manifest_stale':!hubOK?'public_hub_stale':'verified',
      round:number,articleOK,manifestOK,hubOK,cards,verifiedAt:(asDate(now)||new Date()).toISOString()};
  } catch(error){
    return {ok:false,reason:'delivery_probe_failed:'+String(error?.message||error).slice(0,140),
      round:number,articleOK:false,manifestOK:false,hubOK:false};
  }
}
