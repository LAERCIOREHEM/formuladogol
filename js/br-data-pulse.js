/* FDG Data Pulse R36-R5 A — pure presentation; no requests or timers. */
(function(root){
  'use strict';
  const labels={synced:'ATUALIZADO',pending:'EM ATUALIZAÇÃO',live:'AO VIVO',late:'ATUALIZAÇÃO ATRASADA',unknown:'SEM CERTIFICAÇÃO'};
  const symbols={synced:'✓',pending:'↻',live:'●',late:'!',unknown:'—'};
  const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
  const fmt=v=>v===null?'—':v.toLocaleString('pt-BR');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function timestamp(v){
    if(typeof v!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(v))return null;
    const d=new Date(v);
    if(!Number.isFinite(d.getTime()))return null;
    const opts={timeZone:'America/Sao_Paulo'};
    return {date:d.toLocaleDateString('pt-BR',opts),shortDate:d.toLocaleDateString('pt-BR',{...opts,day:'2-digit',month:'2-digit'}),time:d.toLocaleTimeString('pt-BR',{...opts,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})};
  }
  function model(input={}){
    const processed=count(input.processed),expected=count(input.expected),season=count(input.seasonTotal);
    const completed=count(input.seasonCompleted),stamp=timestamp(input.updatedAt);
    const coverage=processed!==null&&expected!==null&&expected>0&&processed<=expected?100*processed/expected:null;
    // Coverage is not proof by itself: caller must explicitly certify the
    // reference dataset and its revision. Equal stale denominators never suffice.
    const complete=coverage===100&&input.certified===true&&stamp!==null&&input.pending!==true;
    let status='unknown';
    if(input.late===true)status='late';
    else if(input.pending===true||(coverage!==null&&coverage<100))status='pending';
    else if(input.live===true)status='live';
    else if(complete)status='synced';
    return {status,stamp,processed,expected,coverage,season,completed,complete,
      remaining:season!==null&&completed!==null&&completed<=season?season-completed:null};
  }
  // Date-first display; complete timestamp remains available to assistive technology.
  function timeMetric(label,stamp,raw,tone=''){
    const full=stamp?stamp.date+' · '+stamp.time+' BRT':'Horário não confirmado';
    return '<div class="fdg-pulse-metric fdg-pulse-temporal"><span>'+esc(label)+'</span>'+
      (stamp?'<time datetime="'+esc(raw)+'" title="'+esc(full)+'" aria-label="'+esc(full)+'"><strong class="'+tone+'">'+esc(stamp.shortDate)+'</strong><small>'+esc(stamp.time)+' BRT</small></time>':'<strong>—</strong><small>Horário não confirmado</small>')+'</div>';
  }
  function freshness(raw,options={}){
    const stamp=timestamp(raw),status=options.live?'live':options.pending?'pending':'unknown';
    const label=options.label||'Última atualização';
    const title=stamp?stamp.date+' · '+stamp.time+' BRT':'Horário não confirmado';
    const state=options.live?'AO VIVO':options.pending?'AGENDA EM ATUALIZAÇÃO':stamp?'AGENDA PUBLICADA':'SEM HORÁRIO CONFIRMADO';
    return '<div class="fdg-freshness fdg-freshness--'+status+'" aria-label="'+esc(label)+'"><span class="fdg-freshness-label">'+esc(label)+'</span>'+
      (stamp?'<time datetime="'+esc(raw)+'" title="'+esc(title)+'" aria-label="'+esc(title)+'"><strong>'+esc(stamp.shortDate)+'</strong><span>'+esc(stamp.time.slice(0,5))+' BRT</span></time>':'<strong>—</strong>')+
      '<span class="fdg-freshness-state">'+esc(state)+'</span></div>';
  }
  // Retain interaction state across data-driven DOM replacements, not by row index.
  function capture(target){
    if(!target?.querySelectorAll)return null;
    const key=e=>e.id||e.getAttribute('data-game-id')||e.getAttribute('data-event-id')||e.getAttribute('data-fdg-key');
    const details=new Set([...target.querySelectorAll('details[open]')].map(key).filter(Boolean));
    const scroll=new Map();
    for(const e of target.querySelectorAll('.probability-table-shell,.probability-history-scroll,.probability-points-scroll,.tabela-scroll,.accuracy-table-scroll')){
      const parent=e.closest('[id]'),k=(parent?.id||'')+'|'+e.className;
      if(e.scrollLeft)scroll.set(k,e.scrollLeft);
    }
    return {details,scroll};
  }
  function restore(target,snapshot){
    if(!snapshot||!target?.querySelectorAll)return;
    const key=e=>e.id||e.getAttribute('data-game-id')||e.getAttribute('data-event-id')||e.getAttribute('data-fdg-key');
    for(const e of target.querySelectorAll('details'))if(snapshot.details.has(key(e)))e.open=true;
    for(const e of target.querySelectorAll('.probability-table-shell,.probability-history-scroll,.probability-points-scroll,.tabela-scroll,.accuracy-table-scroll')){
      const k=(e.closest('[id]')?.id||'')+'|'+e.className;
      if(snapshot.scroll.has(k))e.scrollLeft=snapshot.scroll.get(k);
    }
  }
  function replaceView(target,html){
    const snapshot=capture(target);
    target.innerHTML=html;
    restore(target,snapshot);
  }
  const mounted=new WeakMap();
  function render(input={}){
    const m=model(input);
    const metric=(label,value,detail='',tone='')=>'<div class="fdg-pulse-metric"><span>'+esc(label)+'</span><strong class="'+tone+'">'+esc(value)+'</strong><small>'+esc(detail)+'</small></div>';
    const tone=m.status==='synced'?'fdg-pulse-positive':'';
    const cards=[
      timeMetric(input.timeLabel||'Última atualização',m.stamp,input.updatedAt,tone),
      metric(input.coverageLabel||'Jogos processados',m.expected===null?fmt(m.processed):fmt(m.processed)+'/'+fmt(m.expected),m.coverage===null?'Cobertura não confirmada':m.coverage.toLocaleString('pt-BR',{maximumFractionDigits:1})+'% da base',tone)
    ];
    if(m.season!==null&&m.completed!==null)cards.push(metric('Brasileirão '+String(input.year||2026),fmt(m.completed)+'/'+fmt(m.season),m.remaining===null?'':fmt(m.remaining)+' jogos restantes','fdg-pulse-season'));
    for(const item of (Array.isArray(input.metrics)?input.metrics:[]).slice(0,4))if(item&&typeof item==='object')cards.push(metric(item.label,item.value,item.detail));
    const bar=m.coverage===null?'':'<div class="fdg-pulse-track" role="progressbar" aria-label="Cobertura dos dados" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+m.coverage.toFixed(2)+'"><span style="width:'+m.coverage+'%"></span></div>';
    return '<section class="fdg-pulse fdg-pulse--'+m.status+'" aria-label="FDG Data Pulse"><header class="fdg-pulse-header"><span class="fdg-pulse-brand">FDG DATA PULSE</span><strong class="fdg-pulse-status"><span aria-hidden="true">'+symbols[m.status]+'</span> '+labels[m.status]+'</strong></header><div class="fdg-pulse-grid" data-count="'+cards.length+'">'+cards.join('')+'</div>'+bar+'<footer class="fdg-pulse-footer">'+esc(input.note||(m.complete?'Base certificada':'Última base disponível'))+'</footer></section>';
  }
  function mount(target,input){
    if(!target||typeof target.innerHTML!=='string')return false;
    const html=render(input);
    if(mounted.get(target)!==html||!target.innerHTML){target.innerHTML=html;mounted.set(target,html);}
    return true;
  }

  // R36-R5 D: independent score ledger, fail closed on duplicates or inconsistent standings.
  const name=v=>String(typeof v==='object'&&v?v.nome:v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const id=g=>String(g?.event_id??g?.id??'').trim();
  const score=g=>[name(g?.mandante),name(g?.visitante),count(g?.placar_mandante),count(g?.placar_visitante)];
  function ledger(rows){
    const matches=new Map(),clubs=new Map(),pairs=new Set();let valid=Array.isArray(rows)&&rows.length>0&&rows.length<=380;
    for(const g of Array.isArray(rows)?rows:[]){
      const key=id(g),[h,a,x,y]=score(g),pair=h+'/'+a;
      if(!key||!h||!a||h===a||x===null||y===null||matches.has(key)||pairs.has(pair)){valid=false;continue;}
      pairs.add(pair);matches.set(key,JSON.stringify([h,a,x,y]));
      for(const [club,gf,ga] of [[h,x,y],[a,y,x]]){
        const c=clubs.get(club)||{jogos:0,gp:0,gc:0,pontos:0,vitorias:0,empates:0,derrotas:0};
        c.jogos++;c.gp+=gf;c.gc+=ga;c.pontos+=gf>ga?3:gf===ga?1:0;c.vitorias+=+(gf>ga);c.empates+=+(gf===ga);c.derrotas+=+(gf<ga);clubs.set(club,c);
      }
    }
    return {matches,clubs,valid};
  }
  function reconcile(rows,table){
    const l=ledger(rows),seen=new Set();
    const finals=Array.isArray(rows)&&rows.every(g=>g?.estado==='post'&&timestamp(g.finalizado_em)!==null);
    const tableValid=Array.isArray(table)&&table.length===20&&table.every(t=>{
      const k=name(t.time),c=l.clubs.get(k);if(!c||seen.has(k))return false;seen.add(k);
      return Object.keys(c).every(field=>count(t[field])===c[field]);
    });
    return {...l,expected:l.valid?l.matches.size:null,certified:l.valid&&finals&&tableValid&&l.clubs.size===20};
  }
  function compareGames(reference,rows,predicate=()=>true){
    const other=ledger(rows);let matched=0;
    const seen=new Set();
    for(const g of Array.isArray(rows)?rows:[]){const k=id(g);if(!seen.has(k)&&reference.matches.get(k)===JSON.stringify(score(g))&&predicate(g)){matched++;seen.add(k);}}
    return {matched,certified:reference.certified&&other.valid&&other.matches.size===reference.expected&&matched===reference.expected};
  }
  function after(candidate,reference){
    const a=Date.parse(candidate),b=Date.parse(reference);
    return Number.isFinite(a)&&Number.isFinite(b)&&a>=b;
  }

  // E3 audits every official final; E4 contains only historically eligible forecasts.
  function accuracyProof(reference,e3,e4){
    const rows=e3?.jogos,eligible=new Map(),seen=new Set();
    const scope=e4?.escopo||{}, summary=e3?.resumo||{};
    let valid=reference.certified&&e3?.status==='ok'&&e4?.status==='ok'&&Array.isArray(rows)&&Array.isArray(e4?.jogos);
    let audited=0,excluded=0;
    for(const g of Array.isArray(rows)?rows:[]){
      const keys=Array.isArray(g.event_ids)?g.event_ids.map(String):[];
      const value=JSON.stringify(score({...g,placar_mandante:g.placar_final_auditado?.mandante,placar_visitante:g.placar_final_auditado?.visitante}));
      const matching=keys.filter(k=>reference.matches.get(k)===value);
      if(matching.length!==1||seen.has(matching[0])){valid=false;continue;}
      const k=matching[0];seen.add(k);audited++;
      if(g.situacao==='comprovado'){
        const commit=g.prova?.commit,pre=Date.parse(g.prova?.gerado_em),start=Date.parse(g.inicio_factual);
        if(!/^[a-f0-9]{40}$/.test(commit||'')||!Number.isFinite(pre)||!Number.isFinite(start)||pre>=start){valid=false;continue;}
        eligible.set(k,{value,commit});
      }else if(g.situacao==='sem_snapshot_prejogo_comprovavel')excluded++;
      else valid=false;
    }
    const matches=new Set();
    for(const g of Array.isArray(e4?.jogos)?e4.jogos:[]){
      const k=id(g),proof=eligible.get(k);
      const value=JSON.stringify(score({...g,placar_mandante:g.placar_final?.mandante,placar_visitante:g.placar_final?.visitante}));
      if(!proof||matches.has(k)||proof.value!==value||proof.commit!==g.commit_prova){valid=false;continue;}
      matches.add(k);
    }
    valid=valid&&audited===reference.expected&&summary.resultados_auditados===audited&&summary.previsoes_certificadas===eligible.size&&summary.sem_snapshot_certificado===excluded&&summary.quarentena_por_conflito===0&&scope.em_quarentena===0&&scope.resultados_finais_auditados===audited&&scope.sem_prova_historica===excluded&&scope.jogos_com_previsao_certificada===eligible.size&&matches.size===eligible.size&&e4.jogos.length===matches.size;
    return {certified:valid,processed:matches.size,expected:reference.certified&&audited===reference.expected?eligible.size:null,audited,excluded};
  }
  root.FDGDataPulse=Object.freeze({model,render,mount,reconcile,compareGames,after,accuracyProof,freshness,capture,restore,replaceView});
})(typeof window!=='undefined'?window:globalThis);
