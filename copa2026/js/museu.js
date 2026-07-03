(function(){
  'use strict';
  const DATA_URL = 'dados/museu-copa.json?v=20260703museu-v2';
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

  async function carregar(){
    try{
      const res = await fetch(DATA_URL, {cache:'no-store'});
      if(!res.ok) throw new Error('HTTP '+res.status);
      const data = await res.json();
      render(data);
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
  }

  function renderStats(s){
    if(!statsEl) return;
    statsEl.innerHTML = `
      <div class="museu-stat"><b>${num(s.copasAte2022)}</b><span>Copas até 2022</span></div>
      <div class="museu-stat"><b>${num(s.selecoesCampeas)}</b><span>Seleções campeãs</span></div>
      <div class="museu-stat"><b>${num(s.golsAte2022)}</b><span>Gols marcados</span></div>
      <div class="museu-stat"><b>2026</b><span>${esc(s.proximaEdicao || 'A próxima grande edição')}</span></div>
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
            <p><b>Artilheiro:</b> ${esc(e.artilheiro && e.artilheiro.nome)}${e.artilheiro && e.artilheiro.gols ? ` — ${esc(e.artilheiro.gols)} gols` : ''}</p>
            <p><b>Bola:</b> ${esc(e.bola)} · <b>Mascote:</b> ${esc(e.mascote || 'Não havia')}</p>
            <p><b>Seleções:</b> ${esc(e.selecoes)} · <b>Jogos:</b> ${esc(e.jogos)} · <b>Gols:</b> ${esc(e.gols || 'Em andamento')}</p>
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
    const finais = edicoes.map(e=>`
      <div class="museu-final-card"><div><b>${esc(e.ano)} — ${esc(e.sede)}</b><span>${esc(e.final && e.final.placar)}</span></div><small>${esc(e.final && e.final.estadio)} · ${esc(e.final && e.final.cidade)}</small></div>
    `).join('');
    return sec('finais','⚔️ Finais','Placares e palcos das decisões.', `<div class="museu-final-list">${finais}</div>`);
  }

  function renderArtilheiros(edicoes, historicos){
    const porEdicao = edicoes.map(e=>`
      <div class="museu-mini-card"><b>${esc(e.ano)}</b><span>${esc(e.artilheiro && e.artilheiro.nome)}</span><small>${e.artilheiro && e.artilheiro.gols ? `${esc(e.artilheiro.gols)} gols · ${esc(e.artilheiro.pais)}` : 'Em andamento'}</small></div>
    `).join('');
    const hist = historicos.map((a,i)=>`
      <div class="museu-topscorer"><span>${i+1}</span><b>${esc(a.nome)}</b><strong>${esc(a.gols)}</strong><small>${esc(a.pais)} · ${esc(a.periodo)}</small></div>
    `).join('');
    return sec('artilheiros','⚽ Artilheiros','Goleadores por edição e ranking histórico até 2022.', `<div class="museu-duo"><div><h3>Por edição</h3><div class="museu-mini-grid">${porEdicao}</div></div><div><h3>Ranking histórico</h3><div class="museu-topscorers">${hist}</div></div></div>`);
  }

  function renderRecordes(recordes){
    return sec('recordes','🔥 Recordes','Marcas que ajudam a contar a grandeza do torneio.', `<div class="museu-record-grid">${recordes.map(r=>`<div class="museu-record"><b>${esc(r.titulo)}</b><strong>${esc(r.valor)}</strong><small>${esc(r.detalhe)}</small></div>`).join('')}</div>`);
  }
  function renderMascotes(mascotes, notaLegal){
    const cards = mascotes.map(m=>`<div class="museu-visual"><span>${esc(m.emoji)}</span><b>${esc(m.ano)} · ${esc(m.nome)}</b><small>${esc(m.sede)}</small><code>${esc(m.arquivo_png || '')}</code></div>`).join('');
    const nota = notaLegal ? `<p class="museu-disclaimer"><b>Nota:</b> ${esc(notaLegal)}</p>` : '';
    return sec('mascotes','🦁 Mascotes','Nomes dos mascotes oficiais e o arquivo PNG sugerido para você gerar/subir depois.', `<div class="museu-visual-grid">${cards}</div>${nota}`);
  }
  function renderBolas(bolas, notaLegal){
    const cards = bolas.map(b=>`<div class="museu-visual"><span>⚽</span><b>${esc(b.ano)} · ${esc(b.nome)}</b><small>${esc(b.nota)}</small><code>${esc(b.arquivo_png || '')}</code></div>`).join('');
    const nota = notaLegal ? `<p class="museu-disclaimer"><b>Nota:</b> ${esc(notaLegal)}</p>` : '';
    return sec('bolas','🏐 Bolas','Nomes das bolas oficiais e o arquivo PNG sugerido para você gerar/subir depois.', `<div class="museu-visual-grid">${cards}</div>${nota}`);
  }
  function renderBrasil(brasil){
    return sec('brasil','🇧🇷 Brasil nas Copas','Os grandes capítulos da seleção brasileira no torneio.', `<div class="museu-brasil-grid">${brasil.map(b=>`<div class="museu-brasil-card"><span>${esc(b.ano)}</span><b>${esc(b.titulo)}</b><p>${esc(b.texto)}</p></div>`).join('')}</div>`);
  }
  function renderMomentos(momentos){
    return sec('momentos','🎞️ Momentos eternos','Histórias que atravessam gerações.', `<div class="museu-momento-grid">${momentos.map(m=>`<article class="museu-momento"><span>${esc(m.ano)}</span><b>${esc(m.titulo)}</b><p>${esc(m.texto)}</p></article>`).join('')}</div>`);
  }

  carregar();
})();
