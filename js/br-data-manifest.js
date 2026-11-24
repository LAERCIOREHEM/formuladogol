/* R36-R5 E: selective Pages reads; AF Core Snapshot retains authority. */
(function(root){
  'use strict';
  const manifestPath='/dados-br/fdg-data-pulse.json';
  const sha=/^[a-f0-9]{64}$/;
  const paths=new Set(['tabela.json','resultados.json','jogos.json','espn_eventos.json',
    ...['agenda-clubes-br','lideres-jogadores','estatisticas-competicao','jogos-detalhes','ranking-desempenho','historico-ranking-desempenho','auditoria-estatisticas','status-atualizacao','probabilidades-brasileirao','auditoria-probabilidades','historico-probabilidades','marcos-af-previsao','auditoria-modelos-af-previsao','avaliacao-af-previsao','probabilidades-por-pontuacao','auditoria-competicoes-af-previsao','probabilidades-jogos','vagas-libertadores-2027','acuracia-af-previsao','acuracia-placares-af-2026','resultados-af-placares-2026'].map(x=>'dados-br/'+x+'.json')]);
  const core=new Set(['tabela.json','resultados.json','jogos.json','espn_eventos.json',...['agenda-clubes-br','probabilidades-brasileirao','probabilidades-por-pontuacao','probabilidades-jogos','auditoria-probabilidades','auditoria-competicoes-af-previsao','vagas-libertadores-2027'].map(x=>'dados-br/'+x+'.json')]);
  const cache=new Map(), inflight=new Map();
  let manifest=null, flight=null, checked=0, healthy=false;
  function valid(m){return m?.schema_version===1&&sha.test(m.revision||'')&&m.files&&Object.keys(m.files).length===paths.size&&[...paths].every(k=>sha.test(m.files[k]?.sha256||'')&&Number.isSafeInteger(m.files[k]?.bytes)&&m.files[k].bytes>0);}
  async function refresh(force=false){
    if(flight)return flight;
    if(!force&&Date.now()-checked<30000)return healthy?manifest:null;
    flight=(async()=>{try{
      const r=await root.fetch(manifestPath,{cache:'no-cache',signal:AbortSignal.timeout(5000)});
      if(!r.ok)throw Error('manifest HTTP '+r.status);
      const m=await r.json();if(!valid(m))throw Error('invalid manifest');
      manifest=m;healthy=true;return m;
    }catch(e){healthy=false;return null;}finally{checked=Date.now();flight=null;}})();
    return flight;
  }
  function keyOf(path){try{const u=new URL(path,root.location.href);return u.origin===root.location.origin?u.pathname.slice(1):'';}catch{return '';}}
  async function get(path, fallback){
    const key=keyOf(path);
    if(!paths.has(key)||core.has(key))return fallback();
    const m=await refresh(), previous=cache.get(key);
    if(!m||!root.crypto?.subtle)return previous?previous.data:fallback();
    const entry=m.files[key];
    if(previous?.hash===entry.sha256)return previous.data;
    const token=key+':'+entry.sha256;
    if(inflight.has(token))return inflight.get(token);
    const task=(async()=>{try{
      const r=await root.fetch('/'+key+'?sha='+entry.sha256,{cache:'no-cache',signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw Error('HTTP '+r.status);
      const bytes=await r.arrayBuffer();
      const hash=Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
      if(bytes.byteLength!==entry.bytes||hash!==entry.sha256)throw Error('revision mismatch');
      const data=JSON.parse(new TextDecoder().decode(bytes));
      if(!data||typeof data!=='object')throw Error('invalid JSON');
      if(manifest?.files[key]?.sha256!==hash)throw Error('superseded revision');
      cache.set(key,{hash,data});
      return data;
    }catch(e){if(previous)return previous.data;throw e;}finally{inflight.delete(token);}})();
    inflight.set(token,task);return task;
  }
  function changed(path,m=manifest){const key=keyOf(path);return !!root.crypto?.subtle&&!!m&&paths.has(key)&&!core.has(key)&&cache.get(key)?.hash!==m.files[key]?.sha256;}
  root.FDGDataManifest=Object.freeze({refresh,get,changed,valid,isCore:path=>core.has(keyOf(path))});
})(window);
