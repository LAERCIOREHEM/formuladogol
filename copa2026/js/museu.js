(function(){
  'use strict';
  const DATA_URL = 'dados/museu-copa.json?v=20260703museu-v12legal';
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
    inicializarNavMuseu();
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

    return sec('artilheiros','⚽ Artilheiros','Goleadores por edição e ranking histórico até 2022.', `
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
