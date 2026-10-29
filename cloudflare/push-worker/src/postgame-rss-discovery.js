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
export async function discoverFreePublicNews(task,fetcher=fetch){
  const year=text(task.kickoff).slice(0,4);
  const home=text(task.home),away=text(task.away);
  if(!home||!away||!/^20\d{2}$/.test(year))return{urls:[],feedsOk:0};
  const query='"'+home+'" "'+away+'" publico renda '+year;
  const endpoints=[
    'https://www.bing.com/search?'+new URLSearchParams({q:query,format:'rss',setlang:'pt-BR'}),
    'https://www.bing.com/news/search?'+new URLSearchParams({q:query,format:'rss',setmkt:'pt-BR'})
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
  return{urls:[...new Set(results.flatMap(x=>x.urls))].slice(0,12),
    feedsOk:results.filter(x=>x.ok).length};
}
