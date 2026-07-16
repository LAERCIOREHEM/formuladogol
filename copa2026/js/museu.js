(function(){
  'use strict';
  const DATA_URL = 'dados/museu-copa.json?v=20260716-museu-dinamico-v1';
  const SELECOES_URL = 'dados/selecoes.json?v=20260716-museu-dinamico-v1';
  const ESTATISTICAS_URL = 'dados/estatisticas.json?v=20260716-museu-dinamico-v1';
  const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
  const ESPN_JANELAS = ['20260611-20260627','20260628-20260703','20260704-20260707','20260709-20260711','20260714-20260715','20260718-20260718','20260719-20260719'];
  const HIST = { copas:22, gols:2720, jogos:964, brasilVitorias:76, maiorMargem:9, maisGolsJogo:12, maisGolsFinal:7, maisGolsEdicao:172, artilheiroEdicao:13 };
  let TIMES = {};
  let refreshTimer = null;
  const $ = (sel, root=document) => root.querySelector(sel);
  const statsEl = $('#museu-stats');
  const salasEl = $('#museu-salas');
  const mainEl = $('#museu-conteudo');

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function num(v){ return v == null ? '—' : Number(v).toLocaleString('pt-BR'); }
  function slug(v){ return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
  function flagHtml(iso2, nome){
    const code = String(iso2 || '').trim().toLowerCase();
    if(!code) return '<span class="museu-flag-placeholder" aria-hidden="true">🏆</span>';
    return `<img class="flag museu-flag" loading="lazy" decoding="async" src="https://flagcdn.com/w40/${esc(code)}.png" alt="Bandeira de ${esc(nome || '')}">`;
  }

  async function fetchJson(url, fallback){
    try{
      const res = await fetch(url, {cache:'no-store'});
      if(!res.ok) throw new Error('HTTP '+res.status);
      return await res.json();
    }catch(err){
      console.warn('[Museu]', url, err);
      return fallback;
    }
  }

  async function buscarEventosEspn(){
    const lotes = await Promise.all(ESPN_JANELAS.map(j =>
      Promise.race([
        fetch(`${ESPN_API}?dates=${j}&limit=120`, {cache:'no-store'}),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout ESPN')),8000))
      ]).then(r => r && r.ok ? r.json() : {events:[]})
        .catch(() => ({events:[]}))
    ));
    const vistos = new Set();
    const eventos = [];
    lotes.forEach(l => (l && l.events || []).forEach(ev => {
      const id = String(ev && ev.id || '');
      if(id && !vistos.has(id)){ vistos.add(id); eventos.push(ev); }
    }));
    return eventos;
  }

  function clone(v){ return JSON.parse(JSON.stringify(v || {})); }
  function compOf(ev){ return ev && ev.competitions && ev.competitions[0] || {}; }
  function isPost(ev){ return !!(compOf(ev).status && compOf(ev).status.type && compOf(ev).status.type.state === 'post'); }
  function abbr(c){ return String(c && c.team && c.team.abbreviation || '').toUpperCase(); }
  function score(c){ const n = Number.parseInt(c && c.score, 10); return Number.isFinite(n) ? n : 0; }
  function shootout(c){
    const vals = [c && c.shootoutScore, c && c.penaltyScore, c && c.penalties];
    for(const v of vals){ const n = Number.parseInt(v,10); if(Number.isFinite(n)) return n; }
    return null;
  }
  function teamsOf(ev){ return (compOf(ev).competitors || []).map(abbr).filter(Boolean); }
  function nomeTime(id){ return TIMES[id] && TIMES[id].nome || id || 'A definir'; }
  function isoTime(id){ return TIMES[id] && TIMES[id].iso2 || ''; }
  function phaseOf(ev){
    const comp = compOf(ev);
    const raw = [ev && ev.season && ev.season.slug, ev && ev.name, ev && ev.shortName, comp.name, comp.shortName, comp.note, comp.notes]
      .filter(Boolean).join(' ').toLowerCase();
    if(/third|3rd|bronze|terceiro/.test(raw)) return 'third-place';
    if(/round[-\s_]*of[-\s_]*32|round32|\br32\b/.test(raw)) return 'round-of-32';
    if(/round[-\s_]*of[-\s_]*16|round16|\br16\b|oitava/.test(raw)) return 'round-of-16';
    if(/quarter|quartas/.test(raw)) return 'quarterfinals';
    if(/semi/.test(raw)) return 'semifinals';
    if(/final/.test(raw)) return 'final';
    if(/group/.test(raw)) return 'group-stage';
    const d = String(ev && ev.date || '').slice(0,10).replaceAll('-','');
    if(d>='20260611' && d<='20260627') return 'group-stage';
    if(d>='20260628' && d<='20260703') return 'round-of-32';
    if(d>='20260704' && d<='20260707') return 'round-of-16';
    if(d>='20260709' && d<='20260711') return 'quarterfinals';
    if(d>='20260714' && d<='20260715') return 'semifinals';
    if(d==='20260718') return 'third-place';
    if(d==='20260719') return 'final';
    return '';
  }
  function winLose(ev){
    const cs = compOf(ev).competitors || [];
    let w = cs.find(c => c && c.winner === true), l = cs.find(c => c && c.winner === false);
    if(!w && cs.length===2 && score(cs[0])!==score(cs[1])){
      w = score(cs[0])>score(cs[1]) ? cs[0] : cs[1];
      l = w===cs[0] ? cs[1] : cs[0];
    }
    return {w:abbr(w), l:abbr(l), wc:w, lc:l};
  }
  function placarEvento(ev, vencedorPrimeiro){
    const cs = compOf(ev).competitors || [];
    if(cs.length<2) return 'A definir';
    let a=cs[0], b=cs[1];
    if(vencedorPrimeiro){ const wl=winLose(ev); if(wl.w){ a=wl.wc; b=wl.lc; } }
    const sa=score(a), sb=score(b), pa=shootout(a), pb=shootout(b);
    if(pa!=null && pb!=null) return `${nomeTime(abbr(a))} ${sa} (${pa}) x (${pb}) ${sb} ${nomeTime(abbr(b))}`;
    return `${nomeTime(abbr(a))} ${sa} x ${sb} ${nomeTime(abbr(b))}`;
  }
  function confrontoEvento(ev){
    const t=teamsOf(ev); return t.length===2 ? `${nomeTime(t[0])} x ${nomeTime(t[1])}` : 'A definir';
  }
  function localEvento(ev, fallback){
    const venue=compOf(ev).venue || {};
    const addr=venue.address || {};
    return {estadio:venue.fullName || fallback.estadio || 'New York New Jersey Stadium', cidade:addr.city || fallback.cidade || 'East Rutherford'};
  }
  function setRecord(recordes, titulo, valor, detalhe){
    const r=(recordes||[]).find(x=>x.titulo===titulo); if(r){ r.valor=valor; r.detalhe=detalhe; }
  }
  function maiorPartida(eventos, criterio){
    let best=null, val=-1;
    eventos.filter(isPost).forEach(ev=>{
      const cs=compOf(ev).competitors||[]; if(cs.length<2) return;
      const s1=score(cs[0]), s2=score(cs[1]);
      const v=criterio==='margem' ? Math.abs(s1-s2) : s1+s2;
      if(v>val){ val=v; best=ev; }
    });
    return {evento:best, valor:val};
  }
  function gols2026(estatisticas, eventos){
    const concluidos=eventos.filter(isPost);
    const somaEventos=concluidos.reduce((acc,ev)=>acc+(compOf(ev).competitors||[]).reduce((s,c)=>s+score(c),0),0);
    const somaStats=(estatisticas && estatisticas.por_selecao || []).reduce((acc,x)=>acc+Number(x.gols||0),0);
    return Math.max(somaEventos, somaStats, 0);
  }
  function artilheiro2026(estatisticas){
    const lista=(estatisticas && estatisticas.artilheiros || []).slice().sort((a,b)=>
      Number(b.gols||0)-Number(a.gols||0) || Number(b.assistencias||0)-Number(a.assistencias||0) ||
      Number((a.jogos||[]).length)-Number((b.jogos||[]).length) || String(a.nome||'').localeCompare(String(b.nome||''),'pt-BR')
    );
    const a=lista[0];
    if(!a) return {nome:'A definir',pais:'—',gols:null,equipe:''};
    return {nome:a.nome,pais:nomeTime(a.equipe),gols:Number(a.gols||0),equipe:a.equipe};
  }
  function aplicar2026(base, selecoesData, estatisticas, eventos){
    const data=clone(base);
    TIMES={};
    (selecoesData && selecoesData.selecoes || []).forEach(t=>{ TIMES[t.id]={nome:t.nome,iso2:t.iso2}; });
    const ed=(data.edicoes||[]).find(x=>Number(x.ano)===2026);
    if(!ed) return data;
    const concluidos=(eventos||[]).filter(isPost);
    const jogosConcluidos=concluidos.length || Number(estatisticas && estatisticas.jogos_processados || 0);
    const totalGols=gols2026(estatisticas,eventos||[]);
    const artilheiro=artilheiro2026(estatisticas);
    const finalEv=(eventos||[]).find(e=>phaseOf(e)==='final');
    const terceiroEv=(eventos||[]).find(e=>phaseOf(e)==='third-place');
    const finalPost=finalEv && isPost(finalEv), terceiroPost=terceiroEv && isPost(terceiroEv);

    ed.gols=totalGols || null;
    ed.encerrada=!!finalPost;
    ed.artilheiroStatus=finalPost ? 'Artilheiro' : 'Líder da artilharia';
    ed.artilheiro={nome:artilheiro.nome,pais:artilheiro.pais,gols:artilheiro.gols};
    ed.brasil='Eliminado pela Noruega nas oitavas de final.';
    ed.maior_goleada='Em andamento';
    const maiorMargem=maiorPartida(eventos||[],'margem');
    if(maiorMargem.evento) ed.maior_goleada=placarEvento(maiorMargem.evento,true);

    if(finalEv){
      const loc=localEvento(finalEv,ed.final||{}); ed.final.estadio=loc.estadio; ed.final.cidade=loc.cidade;
      ed.final.placar=finalPost ? placarEvento(finalEv,true) : `${confrontoEvento(finalEv)} — a definir`;
      if(finalPost){ const wl=winLose(finalEv); ed.campeao=nomeTime(wl.w); ed.vice=nomeTime(wl.l); ed.campeaoIso2=isoTime(wl.w); }
    }
    if(terceiroPost){ const wl=winLose(terceiroEv); ed.terceiro=nomeTime(wl.w); ed.quarto=nomeTime(wl.l); }

    const finalistas=finalEv ? teamsOf(finalEv).map(nomeTime).join(' x ') : '';
    data.stats=data.stats||{};
    data.stats.copasAte2026=23;
    data.stats.golsAte2026=HIST.gols+totalGols;
    data.stats.jogos2026Concluidos=jogosConcluidos;
    data.stats.edicao2026Resumo=finalPost ? `${ed.campeao} campeã` : (finalistas ? `${finalistas} na final` : 'Edição em andamento');

    const rank=(data.campeoesRanking||[]).map((r,i)=>Object.assign({_ordem:i},r));
    if(finalPost){
      let r=rank.find(x=>x.pais===ed.campeao);
      if(r && !(r.anos||[]).includes(2026)){ r.anos=(r.anos||[]).concat(2026); r.titulos=Number(r.titulos||0)+1; }
    }
    rank.sort((a,b)=>Number(b.titulos||0)-Number(a.titulos||0) || a._ordem-b._ordem);
    rank.forEach(r=>delete r._ordem); data.campeoesRanking=rank;
    data.stats.selecoesCampeas=rank.length;

    const recordes=data.recordes||[];
    const lider=rank[0];
    if(lider) setRecord(recordes,'Maior campeã',`${lider.pais} — ${lider.titulos} títulos`,(lider.anos||[]).join(', '));
    if(totalGols>HIST.maisGolsEdicao){
      setRecord(recordes,'Edição com mais gols',`Copa 2026 — ${num(totalGols)} gols`, jogosConcluidos>=104 ? 'Recorde em 104 jogos' : `${jogosConcluidos}/104 jogos concluídos`);
    }
    if(artilheiro.gols>HIST.artilheiroEdicao){ setRecord(recordes,'Mais gols em uma edição',`${artilheiro.nome} — ${artilheiro.gols} gols`,'Copa 2026'); }
    if(maiorMargem.evento && maiorMargem.valor>HIST.maiorMargem){ setRecord(recordes,'Maior goleada',placarEvento(maiorMargem.evento,true),'Copa 2026'); }
    const maisGols=maiorPartida(eventos||[],'gols');
    if(maisGols.evento && maisGols.valor>HIST.maisGolsJogo){ setRecord(recordes,'Jogo com mais gols',placarEvento(maisGols.evento,false),'Copa 2026'); }
    if(finalPost){
      const totalFinal=(compOf(finalEv).competitors||[]).reduce((s,c)=>s+score(c),0);
      if(totalFinal>HIST.maisGolsFinal) setRecord(recordes,'Final com mais gols',placarEvento(finalEv,true),'Final de 2026');
    }
    const vitoriasBra=concluidos.filter(ev=>winLose(ev).w==='BRA' && (compOf(ev).competitors||[]).length===2 && score((compOf(ev).competitors||[])[0])!==score((compOf(ev).competitors||[])[1])).length;
    setRecord(recordes,'Seleção com mais vitórias',`Brasil — ${HIST.brasilVitorias+vitoriasBra} vitórias`,'Recorde histórico em partidas de Copa do Mundo');

    if(!(data.momentos||[]).some(m=>Number(m.ano)===2026)){
      data.momentos=(data.momentos||[]).concat({ano:2026,titulo:'O vexame de 2026',texto:'O Brasil caiu para a Noruega nas oitavas de final e encerrou precocemente sua participação na Copa de 2026.'});
    }
    return data;
  }

  async function carregar(){
    try{
      const [base, selecoes, estatisticas, eventos] = await Promise.all([
        fetchJson(DATA_URL,null), fetchJson(SELECOES_URL,{selecoes:[]}), fetchJson(ESTATISTICAS_URL,{}), buscarEventosEspn()
      ]);
      if(!base) throw new Error('Base histórica indisponível');
      const preparado=aplicar2026(base,selecoes,estatisticas,eventos);
      render(preparado);
      const ed2026=(preparado.edicoes||[]).find(e=>Number(e.ano)===2026);
      if(refreshTimer) clearTimeout(refreshTimer);
      if(!ed2026 || !ed2026.encerrada) refreshTimer=setTimeout(carregar,120000);
    }catch(err){
      console.error(err);
      if(mainEl) mainEl.innerHTML = '<div class="museu-erro">Não foi possível carregar o Museu da Copa agora.</div>';
    }
  }

  function render(data){
    renderStats(data.stats || {});
    renderSalas(data.salas || []);
    if(mainEl){
      mainEl.innerHTML = [
        renderLinhaDoTempo(data.edicoes || []),
        renderCampeoes(data.campeoesRanking || []),
        renderFinais(data.edicoes || []),
        renderArtilheiros(data.edicoes || [], data.artilheirosHistoricos || []),
        renderRecordes(data.recordes || []),
        renderMascotes(data.mascotes || [], data.notasLegais && data.notasLegais.mascotes),
        renderBolas(data.bolas || [], data.notasLegais && data.notasLegais.bolas),
        renderBrasil(data.brasil || []),
        renderMomentos(data.momentos || [])
      ].join('');
    }
    inicializarNavMuseu();
  }

  function renderStats(s){
    if(!statsEl) return;
    statsEl.innerHTML = `
      <div class="museu-stat"><b>${num(s.copasAte2026 || 23)}</b><span>Copas até 2026</span></div>
      <div class="museu-stat"><b>${num(s.selecoesCampeas)}</b><span>Seleções campeãs</span></div>
      <div class="museu-stat"><b>${num(s.golsAte2026 != null ? s.golsAte2026 : s.golsAte2022)}</b><span>Gols marcados</span></div>
      <div class="museu-stat"><b>2026</b><span>${esc(s.edicao2026Resumo || s.proximaEdicao || 'Edição em andamento')}</span></div>
    `;
  }

  function renderSalas(salas){
    if(!salasEl) return;
    salasEl.innerHTML = salas.map(s => `
      <a class="museu-sala" href="#${esc(s.id)}">
        <span class="museu-sala-ico">${esc(s.icone)}</span>
        <b>${esc(s.titulo)}</b>
        <small>${esc(s.desc)}</small>
      </a>
    `).join('');
  }

  function sec(id, titulo, subtitulo, body){
    return `<section class="museu-section" id="${esc(id)}">
      <div class="museu-sec-head"><h2>${titulo}</h2>${subtitulo ? `<p>${subtitulo}</p>` : ''}</div>
      ${body}
    </section>`;
  }

  function renderLinhaDoTempo(edicoes){
    const cards = edicoes.map(e => `
      <article class="museu-ed-card ${e.ano===2026?'museu-ed-atual':''}">
        <div class="museu-ed-top"><span>${esc(e.ano)}</span><b>${esc(e.sede)}</b></div>
        <div class="museu-ed-campeao">${flagHtml(e.campeaoIso2, e.campeao)}<span>🏆 ${esc(e.campeao)}</span></div>
        <div class="museu-ed-final">${esc(e.final && e.final.placar)}</div>
        <details>
          <summary>Ver detalhes</summary>
          <div class="museu-ed-det">
            <p><b>Período:</b> ${esc(e.periodo)}</p>
            <p><b>Vice:</b> ${esc(e.vice)} · <b>3º:</b> ${esc(e.terceiro)} · <b>4º:</b> ${esc(e.quarto)}</p>
            <p><b>Final:</b> ${esc(e.final && e.final.estadio)} — ${esc(e.final && e.final.cidade)}</p>
            <p><b>${esc(e.artilheiroStatus || 'Artilheiro')}:</b> ${esc(e.artilheiro && e.artilheiro.nome)}${e.artilheiro && e.artilheiro.gols ? ` — ${esc(e.artilheiro.gols)} gols` : ''}</p>
            <p><b>Bola:</b> ${esc(e.bola)} · <b>Mascote:</b> ${esc(e.mascote || 'Não havia')}</p>
            <p><b>Seleções:</b> ${esc(e.selecoes)} · <b>Jogos:</b> ${esc(e.jogos)} · <b>Gols:</b> ${esc(e.gols != null ? e.gols : 'Em andamento')}</p>
            <p><b>Maior goleada:</b> ${esc(e.maior_goleada)}</p>
            <p><b>Curiosidade:</b> ${esc(e.curiosidade)}</p>
            <p><b>Brasil:</b> ${esc(e.brasil)}</p>
          </div>
        </details>
      </article>
    `).join('');
    return sec('linha','📜 Linha do tempo','Todas as edições em cards compactos. Toque em “Ver detalhes” para abrir cada Copa.', `<div class="museu-ed-grid">${cards}</div>`);
  }

  function renderCampeoes(rank){
    const html = `<div class="museu-rank-grid">${rank.map((r,i)=>`
      <div class="museu-rank-card"><span class="museu-rank-pos">${i+1}</span><div class="museu-rank-title">${flagHtml(r.iso2, r.pais)}<b>${esc(r.pais)}</b></div><strong>${esc(r.titulos)} título${r.titulos>1?'s':''}</strong><small>${esc((r.anos||[]).join(', '))}</small></div>
    `).join('')}</div>`;
    return sec('campeoes','🏆 Campeões','As oito seleções que já levantaram a taça.', html);
  }

  function renderFinais(edicoes){
    const finais = edicoes.map(e=>{
      const a=e.artilheiro||{};
      const artilheiro=Number(e.ano)===2026 && e.encerrada && a.nome && a.nome!=='A definir'
        ? `<small>Artilheiro da edição: ${esc(a.nome)}${a.gols!=null ? ` — ${esc(a.gols)} gols` : ''}</small>` : '';
      return `<div class="museu-final-card"><div><b>${esc(e.ano)} — ${esc(e.sede)}</b><span>${esc(e.final && e.final.placar)}</span></div><small>${esc(e.final && e.final.estadio)} · ${esc(e.final && e.final.cidade)}</small>${artilheiro}</div>`;
    }).join('');
    return sec('finais','⚔️ Finais','Placares, palcos das decisões e a atualização da edição de 2026.', `<div class="museu-final-list">${finais}</div>`);
  }

  function renderArtilheiros(edicoes, historicos){
    const porEdicao = edicoes.map(e=>{
      const a = e.artilheiro || {};
      const gols = a.gols ? `${esc(a.gols)} gols` : 'Em andamento';
      const pais = a.pais ? esc(a.pais) : '';
      return `
        <div class="museu-scorer-ed">
          <div class="museu-scorer-year">${esc(e.ano)}</div>
          <div class="museu-scorer-name">${esc(a.nome || 'A definir')}</div>
          <div class="museu-scorer-meta">
            <span class="museu-scorer-goals">${gols}</span>
            ${pais ? `<span class="museu-scorer-country">${pais}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    const hist = historicos.map((a,i)=>`
      <div class="museu-topscorer">
        <span class="museu-topscorer-pos">${i+1}</span>
        <div class="museu-topscorer-main">
          <b>${esc(a.nome)}</b>
          <small>${esc(a.pais)} · ${esc(a.periodo)}</small>
        </div>
        <strong>${esc(a.gols)}</strong>
      </div>
    `).join('');

    return sec('artilheiros','⚽ Artilheiros','Goleadores por edição e ranking histórico, com a Copa de 2026 atualizada automaticamente.', `
      <div class="museu-duo museu-artilheiros-layout">
        <div class="museu-artilheiros-bloco">
          <h3>Por edição</h3>
          <div class="museu-scorer-grid">${porEdicao}</div>
        </div>
        <div class="museu-artilheiros-bloco">
          <h3>Ranking histórico</h3>
          <div class="museu-topscorers">${hist}</div>
        </div>
      </div>
    `);
  }

  function renderRecordes(recordes){
    return sec('recordes','🔥 Recordes','Marcas que ajudam a contar a grandeza do torneio.', `<div class="museu-record-grid">${recordes.map(r=>`<div class="museu-record"><b>${esc(r.titulo)}</b><strong>${esc(r.valor)}</strong><small>${esc(r.detalhe)}</small></div>`).join('')}</div>`);
  }
  function visualCard(tipo, item){
    const arquivo = item.arquivo_png || '';
    const img = item.imagem || (arquivo ? `img/${tipo}/${arquivo}` : '');
    const titulo = `${item.ano} · ${item.nome}`;
    const subtitulo = tipo === 'mascotes' ? item.sede : item.nota;
    const alt = tipo === 'mascotes'
      ? `Mascote ${item.nome} da Copa de ${item.ano}`
      : `Bola ${item.nome} da Copa de ${item.ano}`;
    const previewAttrs = img
      ? ` tabindex="0" role="button" data-image-preview="${esc(img)}" data-preview-title="${esc(titulo)}" data-preview-subtitle="${esc(subtitulo || '')}" aria-label="Ampliar imagem: ${esc(titulo)}"`
      : '';
    const imgHtml = img ? `<div class="museu-visual-imgbox"><img loading="lazy" decoding="async" src="${esc(img)}" alt="${esc(alt)}" onerror="var c=this.closest('.museu-visual');if(c){c.classList.add('sem-img');c.removeAttribute('data-image-preview');c.removeAttribute('tabindex');c.removeAttribute('role');}this.remove();"></div>` : '';
    return `<div class="museu-visual museu-visual-com-img"${previewAttrs}>${imgHtml}<b>${esc(titulo)}</b><small>${esc(subtitulo)}</small></div>`;
  }

  function renderMascotes(mascotes, notaLegal){
    const cards = mascotes.map(m=>visualCard('mascotes', m)).join('');
    const nota = notaLegal ? `<p class="museu-disclaimer"><b>Nota:</b> ${esc(notaLegal)}</p>` : '';
    return sec('mascotes','🦁 Mascotes','Os personagens oficiais que marcaram a identidade visual das Copas.', `<div class="museu-visual-grid">${cards}</div>${nota}`);
  }
  function renderBolas(bolas, notaLegal){
    const cards = bolas.map(b=>visualCard('bolas', b)).join('');
    const nota = notaLegal ? `<p class="museu-disclaimer"><b>Nota:</b> ${esc(notaLegal)}</p>` : '';
    return sec('bolas','🏐 Bolas','As bolas oficiais e seus desenhos mais marcantes em cada geração.', `<div class="museu-visual-grid">${cards}</div>${nota}`);
  }
  function renderBrasil(brasil){
    return sec('brasil','🇧🇷 Brasil nas Copas','Os grandes capítulos da seleção brasileira no torneio.', `<div class="museu-brasil-grid">${brasil.map(b=>`<div class="museu-brasil-card"><span>${esc(b.ano)}</span><b>${esc(b.titulo)}</b><p>${esc(b.texto)}</p></div>`).join('')}</div>`);
  }
  function renderMomentos(momentos){
    return sec('momentos','🎞️ Momentos eternos','Histórias que atravessam gerações.', `<div class="museu-momento-grid">${momentos.map(m=>`<article class="museu-momento"><span>${esc(m.ano)}</span><b>${esc(m.titulo)}</b><p>${esc(m.texto)}</p></article>`).join('')}</div>`);
  }


  function inicializarNavMuseu(){
    const nav = document.getElementById('museu-nav');
    if(!nav) return;
    const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
    if(!links.length) return;

    function centralizarLink(link, behavior){
      if(!link) return;
      const left = link.offsetLeft - (nav.clientWidth / 2) + (link.offsetWidth / 2);
      nav.scrollTo({ left: Math.max(0, left), behavior: behavior || 'smooth' });
    }

    function ativarPorId(id, behavior){
      if(!id) return;
      let ativo = null;
      links.forEach(a => {
        const ok = a.getAttribute('href') === '#' + id;
        a.classList.toggle('ativo', ok);
        if(ok) ativo = a;
      });
      if(ativo) centralizarLink(ativo, behavior);
    }

    links.forEach(a => {
      a.addEventListener('click', function(){
        const id = (a.getAttribute('href') || '').replace('#','');
        window.setTimeout(() => ativarPorId(id, 'smooth'), 80);
      });
    });

    const sectionIds = links.map(a => (a.getAttribute('href') || '').replace('#','')).filter(Boolean);
    const sections = sectionIds.map(id => document.getElementById(id)).filter(Boolean);

    function ativarPeloScroll(){
      let atual = sectionIds[0];
      const ref = 155;
      for(const sec of sections){
        const top = sec.getBoundingClientRect().top;
        if(top <= ref) atual = sec.id;
        else break;
      }
      ativarPorId(atual, 'smooth');
    }

    let ticking = false;
    window.addEventListener('scroll', function(){
      if(ticking) return;
      ticking = true;
      window.requestAnimationFrame(function(){
        ticking = false;
        ativarPeloScroll();
      });
    }, {passive:true});

    window.addEventListener('hashchange', function(){
      ativarPorId((location.hash || '#linha').replace('#',''), 'smooth');
    });

    window.setTimeout(function(){
      ativarPorId((location.hash || '#linha').replace('#',''), 'auto');
    }, 250);
  }

  carregar();
})();
