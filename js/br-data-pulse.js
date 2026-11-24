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
    return {date:d.toLocaleDateString('pt-BR',opts),time:d.toLocaleTimeString('pt-BR',{...opts,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})};
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
  function render(input={}){
    const m=model(input);
    const metric=(label,value,detail='',tone='')=>'<div class="fdg-pulse-metric"><span>'+esc(label)+'</span><strong class="'+tone+'">'+esc(value)+'</strong><small>'+esc(detail)+'</small></div>';
    const tone=m.status==='synced'?'fdg-pulse-positive':'';
    const cards=[
      metric(input.timeLabel||'Última atualização',m.stamp?.time||'—',m.stamp?m.stamp.date+' · BRT':'Horário não confirmado',tone),
      metric(input.coverageLabel||'Jogos processados',fmt(m.processed)+'/'+fmt(m.expected),m.coverage===null?'Cobertura não confirmada':m.coverage.toLocaleString('pt-BR',{maximumFractionDigits:1})+'% da base',tone)
    ];
    if(m.season!==null&&m.completed!==null)cards.push(metric('Brasileirão '+String(input.year||2026),fmt(m.completed)+'/'+fmt(m.season),m.remaining===null?'':fmt(m.remaining)+' jogos restantes','fdg-pulse-season'));
    for(const item of (Array.isArray(input.metrics)?input.metrics:[]).slice(0,4))if(item&&typeof item==='object')cards.push(metric(item.label,item.value,item.detail));
    const bar=m.coverage===null?'':'<div class="fdg-pulse-track" role="progressbar" aria-label="Cobertura dos dados" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+m.coverage.toFixed(2)+'"><span style="width:'+m.coverage+'%"></span></div>';
    return '<section class="fdg-pulse fdg-pulse--'+m.status+'" aria-label="FDG Data Pulse"><header class="fdg-pulse-header"><span class="fdg-pulse-brand">FDG DATA PULSE</span><strong class="fdg-pulse-status"><span aria-hidden="true">'+symbols[m.status]+'</span> '+labels[m.status]+'</strong></header><div class="fdg-pulse-grid">'+cards.join('')+'</div>'+bar+'<footer class="fdg-pulse-footer">'+esc(input.note||(m.complete?'Base certificada':'Última base disponível'))+'</footer></section>';
  }
  function mount(target,input){
    if(!target||typeof target.innerHTML!=='string')return false;
    const html=render(input);
    if(target.innerHTML!==html)target.innerHTML=html;
    return true;
  }
  root.FDGDataPulse=Object.freeze({model,render,mount});
})(typeof window!=='undefined'?window:globalThis);
