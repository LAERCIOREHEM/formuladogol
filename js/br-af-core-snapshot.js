/* R36-R4 public atomic core: one version, shared fetch, bounded fallback.
 * Raw GitHub serves ONLY an allowlisted bundle committed with the AF.
 * The Pages version wins when as new or newer. No Cloudflare writes.
 */
(function(root){
  'use strict';
  const nativeFetch=root.fetch.bind(root);
  const raw='https://raw.githubusercontent.com/LAERCIOREHEM/formuladogol/main/';
  const manifestPath='dados-br/af-core-manifest.json';
  const bundlePath='dados-br/af-core-snapshot.json';
  const allowed=new Set(['tabela.json','resultados.json','jogos.json','espn_eventos.json',
    'dados-br/agenda-clubes-br.json','dados-br/probabilidades-brasileirao.json',
    'dados-br/probabilidades-por-pontuacao.json','dados-br/probabilidades-jogos.json',
    'dados-br/auditoria-probabilidades.json','dados-br/auditoria-competicoes-af-previsao.json',
    'dados-br/vagas-libertadores-2027.json']);
  let lastBundle=null, selected=null, inFlight=null, checkedAt=0, pagesMeta=null;
  const validMeta=m=>m&&m.schema_version===1&&/^[a-f0-9]{64}$/.test(m.revision||'')&&
    /^[a-f0-9]{64}$/.test(m.hash_entrada||'')&&Number.isFinite(Date.parse(m.calculado_em))&&
    Number.isInteger(m.concluidos)&&Number.isInteger(m.restantes)&&m.concluidos>=0&&
    m.restantes>=0&&m.concluidos+m.restantes===380;
  function newer(a,b){
    if(!validMeta(a))return false;
    if(!validMeta(b))return true;
    // Never regress FINAL coverage, even with a later wall-clock timestamp.
    if(a.concluidos!==b.concluidos)return a.concluidos>b.concluidos;
    return Date.parse(a.calculado_em)>Date.parse(b.calculado_em);
  }
  function validBundle(b,m){
    if(!b||!validMeta(b.manifest)||b.manifest.revision!==m.revision||!b.files)return false;
    const f=b.files,p=f['dados-br/probabilidades-brasileirao.json'],r=f['resultados.json']?.resultados,
      t=f['tabela.json']?.tabela,j=f['dados-br/probabilidades-jogos.json']?.jogos;
    return [...allowed].every(k=>f[k]&&typeof f[k]==='object')&&p?.status==='ok'&&
      p.hash_entrada===m.hash_entrada&&p.calculado_em===m.calculado_em&&
      p.simulacao?.quantidade===2000000&&p.clubes?.length===20&&
      p.base_corrente?.partidas_concluidas===m.concluidos&&p.base_corrente?.partidas_restantes===m.restantes&&
      Array.isArray(r)&&r.length===m.concluidos&&Array.isArray(t)&&t.length===20&&
      Array.isArray(j)&&j.length===m.restantes&&new Set(r.map(x=>String(x.event_id))).size===r.length&&
      !j.some(x=>r.some(y=>String(x.event_id)===String(y.event_id)));
  }
  async function get(url,timeout=3500){
    const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeout);
    try{
      const res=await nativeFetch(url,{cache:'no-cache',signal:c.signal,credentials:'omit'});
      return res.ok?await res.json():null;
    }catch(_){return null}finally{clearTimeout(timer)}
  }
  async function choose(){
    const [remote,local]=await Promise.all([get(raw+manifestPath),get('/'+manifestPath)]);
    if(validMeta(local)&&(!pagesMeta||newer(local,pagesMeta)||local.revision===pagesMeta.revision))pagesMeta=local;
    let best=lastBundle&&newer(lastBundle.manifest,local)?lastBundle:null;
    if(newer(remote,local)&&(!best||newer(remote,best.manifest))){
      const candidate=await get(raw+bundlePath+'?revision='+encodeURIComponent(remote.revision),6000);
      if(validBundle(candidate,remote)){lastBundle=candidate;best=candidate}
    }
    // If local manifest is absent, do not prefer a cached bundle blindly:
    // compare the actual Pages AF timestamp before using it.
    if(!validMeta(local)&&best){
      const p=await get('/dados-br/probabilidades-brasileirao.json');
      if(p&&p.base_corrente&&
          (p.base_corrente.partidas_concluidas>best.manifest.concluidos||
           (p.base_corrente.partidas_concluidas===best.manifest.concluidos&&
            Date.parse(p.calculado_em)>=Date.parse(best.manifest.calculado_em))))return null;
    }
    return best;
  }
  async function snapshot(urgent=false){
    if(inFlight)return inFlight;
    if(Date.now()-checkedAt<(urgent?12000:45000))return selected;
    inFlight=choose().then(b=>{selected=b;checkedAt=Date.now();return b})
      .catch(()=>selected).finally(()=>{inFlight=null});
    return inFlight;
  }
  function keyOf(url){
    try{const u=new URL(typeof url==='string'?url:url.url,root.location.href);
      if(u.origin!==root.location.origin)return '';
      return u.pathname.replace(/^\//,'');
    }catch(_){return ''}
  }
  async function fetchCore(url,options){
    const key=keyOf(url);
    if(!allowed.has(key))return nativeFetch(url,options);
    const b=await snapshot();
    if(b&&b.files[key])return new Response(JSON.stringify(b.files[key]),{
      status:200,headers:{'Content-Type':'application/json','X-FDG-Core-Revision':b.manifest.revision}});
    return nativeFetch(url,options);
  }
  root.FDGCoreSnapshot={fetch:fetchCore,validMeta,validBundle,newer,
    async current(options={}){const b=await snapshot(options.urgent===true);return b?.manifest||pagesMeta||null}};
})(window);
