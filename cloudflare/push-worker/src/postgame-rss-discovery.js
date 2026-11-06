// Backstop de descoberta SEM IA paga. Bing mantém RSS experimental no search.
// Nunca publica dados de RSS: só fornece URLs para Match Identity Gate e parser.
const text=(v)=>String(v??'').trim();
function decodeXml(value){
  return text(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&apos;/gi,"'")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function slug(value){
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,' ').trim();
}
function publisherUrl(value){
  let u;try{u=new URL(decodeXml(value));}catch(_){return '';}
  if(u.hostname==='www.bing.com'||u.hostname==='bing.com'){
    const external=u.searchParams.get('url')||u.searchParams.get('u')||'';
    if(!external)return '';
    try{u=new URL(external);}catch(_){return '';}
  }
  if(u.protocol!=='https:'||u.username||u.password||u.port)return '';
  if(!u.hostname.includes('.')||/(?:^|\.)(?:localhost|internal|local|invalid|example\.com)$/.test(u.hostname))return '';
  if(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(u.hostname))return '';
  if(/(?:^|\.)(?:bing\.com|google\.com|news\.google\.com)$/.test(u.hostname))return '';
  u.hash='';return u.toString();
}
export function parsePublicSearchRss(xml,task={},limit=10){
  const raw=text(xml).slice(0,500000);
  if(!/<rss\b|<channel\b/i.test(raw))return [];
  const home=slug(task.home),away=slug(task.away);
  if(!home||!away)return [];
  const aliases=(name)=>[name,
    name==='bragantino'?'red bull bragantino':name,
    name==='atletico mg'?'atletico mineiro':name,
    name==='internacional'?'inter':name];
  const homeTerms=aliases(home),awayTerms=aliases(away);
  const matches=(value,arr)=>arr.some((s)=>s&&value.includes(s));
  const out=[];
  for(const item of raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
    const entry=item[1];
    const title=decodeXml(entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
    const desc=decodeXml(entry.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i)?.[1]||'');
    const link=publisherUrl(entry.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]||'');
    if(!link||out.includes(link))continue;
    const context=slug(title+' '+desc+' '+new URL(link).pathname.replace(/-/g,' '));
    if(!matches(context,homeTerms)||!matches(context,awayTerms))continue;
    // Rejeita "ingressos" pré-jogo como fonte prioritaria, mas não
    // exige público/renda no título; ficha técnica pode estar no corpo.
    if(/(?:venda de ingressos|onde assistir|provaveis escalacoes)/.test(slug(title)))continue;
    out.push(link);
    if(out.length>=Math.min(15,Math.max(1,Number(limit)||10)))break;
  }
  return out;
}
// R10R30: múltiplas consultas gratuitas; a primeira reproduz o Google do torcedor.
// Descoberta nunca autoriza valores sem Match Identity Gate + extração.
export function buildPostgameRssQueries(task) {
  const home=text(task?.home), away=text(task?.away);
  const iso=text(task?.kickoff || task?.data_iso).slice(0,10);
  if(!home||!away||!/^20\d{2}-\d{2}-\d{2}$/.test(iso))return [];
  const year=iso.slice(0,4),day=iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+year;
  const hasScore=task?.home_score!=null&&task?.away_score!=null
    &&Number.isInteger(Number(task.home_score))&&Number.isInteger(Number(task.away_score));
  const score=hasScore?home+' '+Number(task.home_score)+' x '+Number(task.away_score)+' '+away:home+' '+away;
  return [
    home+' '+away+' público renda',
    score+' público renda '+year,
    '"'+home+'" "'+away+'" ficha técnica '+day,
    'site:uol.com.br/esporte '+home+' '+away+' público renda '+day,
  ];
}

export async function discoverFreePublicNews(task,fetcher=fetch){
  const queries=buildPostgameRssQueries(task);
  if(!queries.length)return{urls:[],feedsOk:0};
  const endpoints=[
    'https://www.bing.com/search?'+new URLSearchParams({q:queries[0],format:'rss',setlang:'pt-BR'}),
    'https://www.bing.com/news/search?'+new URLSearchParams({q:queries[0],format:'rss',setmkt:'pt-BR'}),
    'https://www.bing.com/search?'+new URLSearchParams({q:queries[1],format:'rss',setlang:'pt-BR'}),
    'https://www.bing.com/search?'+new URLSearchParams({q:queries[2],format:'rss',setlang:'pt-BR'}),
    'https://www.bing.com/search?'+new URLSearchParams({q:queries[3],format:'rss',setlang:'pt-BR'}),
  ];
  const results=await Promise.all(endpoints.map(async(url)=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await fetcher(url,{signal:controller.signal,headers:{accept:'application/rss+xml,application/xml,text/xml'}});
      if(!response.ok)return{ok:false,urls:[]};
      const body=(await response.text()).slice(0,500000);
      return{ok:/<rss\b|<channel\b/i.test(body),urls:parsePublicSearchRss(body,task,8)};
    }catch(_){return{ok:false,urls:[]};}finally{clearTimeout(timer);}
  }));
  return{urls:[...new Set(results.flatMap(x=>x.urls))].slice(0,16),
    feedsOk:results.filter(x=>x.ok).length};
}
