(function(){
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const fmtData = new Intl.DateTimeFormat("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
  const cacheBust = () => "?v=" + Date.now();
  const state = { clubes: [], tabela: [], ranking: [], eventos: [], elencos: {}, mascotes: {}, filtroTexto: "", filtroRegiao: "Todas", selecionado: "" };

  function escapeHtml(value){
    return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[ch]));
  }
  function escapeAttr(value){ return escapeHtml(value); }
  function slug(value){
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  async function fetchJson(path, fallback){
    try {
      const res = await fetch(path + cacheBust(), { cache: "no-store" });
      if (!res.ok) throw new Error(path + " HTTP " + res.status);
      return await res.json();
    } catch (err) {
      console.warn("Falha ao carregar", path, err);
      return fallback;
    }
  }
  function escudoHtml(c, cls="club-logo"){
    if (c && c.escudo) return `<img class="${cls}" src="${escapeAttr(c.escudo)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
    return `<span class="${cls}" aria-hidden="true">${escapeHtml((c && (c.sigla || c.nome) || "?").slice(0,3).toUpperCase())}</span>`;
  }

  function mascotInfo(clube){
    if (!clube) return { nome: "", arquivo: "" };
    const direto = state.mascotes?.[clube.nome];
    if (typeof direto === "string") return { nome: clube.mascote || "Mascote", arquivo: direto };
    if (direto && typeof direto === "object") return { nome: direto.nome || clube.mascote || "Mascote", arquivo: direto.arquivo || "" };
    const fallback = `img/mascotes/${clube.nome}.png`;
    return { nome: clube.mascote || "Mascote", arquivo: fallback };
  }
  function mascotCardHtml(clube){
    const info = mascotInfo(clube);
    const nomeMascote = escapeHtml(info.nome || clube?.mascote || "Mascote");
    const src = escapeAttr(info.arquivo || `img/mascotes/${clube?.nome || ""}.png`);
    return `<div class="info-card mascot-card">
      <span>Mascote</span>
      <button type="button" class="mascot-frame mascot-zoom-trigger" data-mascote-src="${src}" data-mascote-clube="${escapeAttr(clube?.nome || '')}" aria-label="Abrir mascote do ${escapeAttr(clube?.nome || '')} em tamanho maior">
        <img class="mascot-figure" src="${src}" alt="Mascote do ${escapeAttr(clube?.nome || '')}" loading="lazy" onerror="this.closest('.mascot-card').classList.add('is-fallback'); this.remove();">
        <div class="mascot-fallback" aria-hidden="true">🦁</div>
      </button>
      <strong class="mascot-caption">${nomeMascote}</strong>
    </div>`;
  }
  function tabelaDo(nome){ return state.tabela.find(t => t.time === nome) || {}; }
  function rankingDo(nome){ return state.ranking.find(r => r.time === nome) || {}; }
  function numeroRanking(v){ const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—"; }
  function rankingResumoHtml(r){
    if (!r || !r.time) return `<span class="club-ranking-pill muted">⚡ Ranking desempenho: aguardando</span>`;
    return `<span class="club-ranking-pill">⚡ Ranking desempenho: <strong>${escapeHtml(r.pos || "—")}º</strong> · índice <strong>${escapeHtml(numeroRanking(r.indice_final ?? r.score))}</strong></span>`;
  }
  function rankingComponentesHtml(r){
    if (!r || !r.time) return `<section class="club-performance-card muted"><div class="club-performance-title">Ranking de desempenho</div><p>Aguardando dados suficientes.</p></section>`;
    const comps = [["Ataque", r.ataque], ["Defesa", r.defesa], ["Domínio", r.dominio], ["Eficiência", r.eficiencia], ["Disciplina", r.disciplina]];
    const score = numeroRanking(r.indice_final ?? r.score);
    return `<section class="club-performance-card" aria-label="Desempenho do ${escapeAttr(r.time)}">
      <div class="club-performance-header"><div><span>AF-Score</span><strong>Ranking de desempenho</strong></div><div class="club-performance-score"><b>${escapeHtml(score)}</b><small>${escapeHtml(r.pos || "—")}º lugar</small></div></div>
      <div class="club-performance-bars">${comps.map(([label, valor]) => { const n = Math.max(0, Math.min(100, Number(valor) || 0)); return `<div class="club-performance-row"><span>${escapeHtml(label)}</span><div><i style="width:${n.toFixed(1)}%"></i></div><strong>${escapeHtml(numeroRanking(valor))}</strong></div>`; }).join("")}</div>
      <a class="club-performance-method" href="estatisticas.html#metodologia-ranking">Entenda como o ranking é calculado →</a>
    </section>`;
  }
  function eventosDo(nome){
    return state.eventos.filter(e => e.mandante === nome || e.visitante === nome)
      .sort((a,b) => String(a.data_iso||"").localeCompare(String(b.data_iso||"")));
  }
  function isPost(e){
    const d = new Date(String(e.data_iso || '').length <= 16 ? `${e.data_iso}:00-03:00` : e.data_iso);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() - (90 * 60 * 1000)) return false;
    const status = String(e.status || '').trim().toLowerCase();
    if (String(e.estado || '').toLowerCase() === 'pre' || status === "0'" || status === '0') return false;
    return String(e.estado || "").toLowerCase() === "post" || (e.placar_mandante !== null && e.placar_mandante !== undefined && e.placar_visitante !== null && e.placar_visitante !== undefined);
  }
  function dataCurta(iso){
    try { return fmtData.format(new Date(iso)); } catch { return "—"; }
  }

  function garantirMascoteModal(){
    let modal = document.getElementById("mascote-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "mascote-modal";
    modal.className = "mascote-modal";
    modal.hidden = true;
    modal.innerHTML = `<div class="mascote-modal-backdrop" data-close="1"></div>
      <div class="mascote-modal-card" role="dialog" aria-modal="true" aria-label="Mascote em tamanho ampliado">
        <button type="button" class="mascote-modal-close" data-close="1" aria-label="Fechar mascote">×</button>
        <img class="mascote-modal-img" alt="">
        <div class="mascote-modal-title"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", ev => { if (ev.target?.dataset?.close) fecharMascoteModal(); });
    document.addEventListener("keydown", ev => { if (ev.key === "Escape") fecharMascoteModal(); });
    return modal;
  }
  function abrirMascoteModal(src, clube){
    const modal = garantirMascoteModal();
    const img = modal.querySelector(".mascote-modal-img");
    const title = modal.querySelector(".mascote-modal-title");
    img.src = src;
    img.alt = `Mascote do ${clube}`;
    title.textContent = clube ? `Mascote — ${clube}` : "Mascote";
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }
  function fecharMascoteModal(){
    const modal = document.getElementById("mascote-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  }
  function ativarZoomMascote(){
    document.querySelectorAll(".mascot-zoom-trigger").forEach(btn => {
      btn.addEventListener("click", () => abrirMascoteModal(btn.dataset.mascoteSrc || "", btn.dataset.mascoteClube || ""));
    });
  }

  function renderChips(){
    const regioes = ["Todas", ...new Set(state.clubes.map(c => c.regiao).filter(Boolean).sort())];
    $("#chips-regiao").innerHTML = regioes.map(r => `<button class="chip ${state.filtroRegiao === r ? "active" : ""}" type="button" data-regiao="${escapeAttr(r)}">${escapeHtml(r)}</button>`).join("");
    $("#chips-regiao").querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => {
      state.filtroRegiao = btn.dataset.regiao || "Todas";
      render();
    }));
  }
  function clubesFiltrados(){
    const termo = slug(state.filtroTexto);
    return state.clubes.filter(c => {
      if (state.filtroRegiao !== "Todas" && c.regiao !== state.filtroRegiao) return false;
      if (!termo) return true;
      const hay = slug([c.nome, c.nome_completo, c.cidade, c.uf, c.estadio, c.mascote, c.apelido].join(" "));
      return hay.includes(termo);
    });
  }
  function renderGrid(){
    const lista = clubesFiltrados();
    if (!lista.length) {
      $("#grid-clubes").innerHTML = `<div class="empty-state">Nenhum clube encontrado para o filtro atual.</div>`;
      return;
    }
    $("#grid-clubes").innerHTML = lista.map(c => {
      const t = tabelaDo(c.nome);
      const r = rankingDo(c.nome);
      return `<article class="club-card ${state.selecionado === c.nome ? "active" : ""}" tabindex="0" role="button" data-clube="${escapeAttr(c.nome)}">
        <div class="club-head">
          ${escudoHtml(c)}
          <div><div class="club-name">${escapeHtml(c.nome)}</div><div class="club-sub">${escapeHtml(c.cidade)}-${escapeHtml(c.uf)} · ${escapeHtml(c.apelido)}</div></div>
        </div>
        <p>${escapeHtml(c.curiosidade)}</p>
        <div class="club-kpis">
          <div class="kpi"><strong>${t.pos || "—"}º</strong><span>posição</span></div>
          <div class="kpi"><strong>${t.pontos ?? "—"}</strong><span>pontos</span></div>
          <div class="kpi"><strong>${r.pos || "—"}º</strong><span>desemp.</span></div>
        </div>
        ${rankingResumoHtml(r)}
      </article>`;
    }).join("");
    $("#grid-clubes").querySelectorAll(".club-card").forEach(card => {
      const select = () => selecionar(card.dataset.clube);
      card.addEventListener("click", select);
      card.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(); } });
    });
  }
  function clubeDoHash(){
    const hash = decodeURIComponent(location.hash.replace("#", ""));
    if (!hash) return null;
    return state.clubes.find(c => slug(c.nome) === hash) || null;
  }
  function rolarParaDetalhe(behavior="auto"){
    const detalhe = document.getElementById("detalhe-wrapper");
    if (!detalhe || detalhe.hidden) return;
    const executar = () => detalhe.scrollIntoView({ behavior, block: "start", inline: "nearest" });
    executar();
    requestAnimationFrame(() => requestAnimationFrame(executar));
    window.setTimeout(executar, 120);
    window.setTimeout(executar, 420);
  }
  function selecionar(nome, { atualizarHash=true, behavior="smooth" } = {}){
    state.selecionado = nome;
    const novoHash = `#${slug(nome)}`;
    if (atualizarHash && location.hash !== novoHash) history.pushState(null, "", novoHash);
    renderGrid();
    renderDetalhe();
    rolarParaDetalhe(behavior);
  }
  function renderDetalhe(){
    const c = state.clubes.find(x => x.nome === state.selecionado) || state.clubes[0];
    if (!c) return;
    state.selecionado = c.nome;
    const t = tabelaDo(c.nome);
    const r = rankingDo(c.nome);
    $("#detalhe-wrapper").hidden = false;
    $("#detalhe-clube").innerHTML = `
      <div class="detail-hero">
        ${escudoHtml(c)}
        <div>
          <div class="kicker">${escapeHtml(c.nome_completo)}</div>
          <h2>${escapeHtml(c.nome)}</h2>
          <p>${escapeHtml(c.momento)}</p>
        </div>
      </div>
      <div class="info-grid">
        <div class="info-card"><span>Cidade / UF</span><strong>${escapeHtml(c.cidade)}-${escapeHtml(c.uf)}</strong></div>
        <div class="info-card"><span>Estádio</span><strong>${escapeHtml(c.estadio)}</strong></div>
        <div class="info-card"><span>Capacidade</span><strong>${escapeHtml(c.capacidade)}</strong></div>
        <div class="info-card"><span>Fundação</span><strong>${escapeHtml(c.fundacao)}</strong></div>
        ${mascotCardHtml(c)}
        <div class="info-card"><span>Títulos BR</span><strong>${escapeHtml(c.titulos_brasileiros)}</strong></div>
        <div class="info-card"><span>Torcida</span><strong>${escapeHtml(c.torcida)}</strong></div>
        <div class="info-card"><span>Tabela atual</span><strong>${t.pos ? `${t.pos}º · ${t.pontos} pts · SG ${t.sg}` : "aguardando"}</strong></div>
      </div>
      ${rankingComponentesHtml(r)}
      <p><strong>Curiosidade:</strong> ${escapeHtml(c.curiosidade)}</p>
    `;
    ativarZoomMascote();
    renderJogos(c.nome);
    renderElenco(c.nome);
  }
  function renderJogos(nome){
    const eventos = eventosDo(nome);
    const agora = new Date();
    const ultimos = eventos.filter(isPost).slice(-4).reverse();
    const proximos = eventos.filter(e => !isPost(e) && new Date(e.data_iso) >= agora).slice(0,4);
    const bloco = [];
    if (proximos.length) {
      bloco.push(`<div class="kicker">Próximos</div>`);
      proximos.forEach(e => bloco.push(rowJogo(e, false)));
    }
    if (ultimos.length) {
      bloco.push(`<div class="kicker" style="margin-top:${proximos.length ? 12 : 0}px">Últimos</div>`);
      ultimos.forEach(e => bloco.push(rowJogo(e, true)));
    }
    $("#jogos-clube").innerHTML = bloco.join("") || `<div class="empty-state">Ainda não há jogos mapeados para este clube nos snapshots locais.</div>`;
  }
  function rowJogo(e, finalizado){
    const placar = finalizado ? `${e.placar_mandante ?? "—"} × ${e.placar_visitante ?? "—"}` : "vs";
    return `<div class="row"><span class="date">${escapeHtml(dataCurta(e.data_iso))}</span><span>${escapeHtml(e.mandante)} × ${escapeHtml(e.visitante)}<br><small>${escapeHtml(e.estadio || "estádio a confirmar")}</small></span><span class="score">${escapeHtml(placar)}</span></div>`;
  }
  function grupoPosicao(posicao){
    const p = slug(posicao);
    if (p.includes("goleir")) return "Goleiros";
    if (p.includes("zagueir") || p.includes("lateral") || p.includes("defensor")) return "Defensores";
    if (p.includes("volante") || p.includes("meia") || p.includes("meio-campista")) return "Meio-campistas";
    if (p.includes("atacante") || p.includes("ponta")) return "Atacantes";
    return "Outros";
  }
  function renderElenco(nome){
    const jogadores = Array.isArray(state.elencos[nome]) ? state.elencos[nome] : [];
    if (!jogadores.length) {
      $("#elenco-clube").className = "empty-state";
      $("#elenco-clube").innerHTML = `Elenco de <strong>${escapeHtml(nome)}</strong> ainda não está preenchido.`;
      return;
    }
    const ordem = ["Goleiros", "Defensores", "Meio-campistas", "Atacantes", "Outros"];
    const grupos = Object.fromEntries(ordem.map(grupo => [grupo, []]));
    jogadores.forEach(jogador => grupos[grupoPosicao(jogador.posicao)].push(jogador));
    $("#elenco-clube").className = "squad-list";
    $("#elenco-clube").innerHTML = `<div class="squad-summary"><strong>${jogadores.length}</strong><span>jogadores cadastrados</span></div>${ordem.filter(grupo => grupos[grupo].length).map(grupo => `
      <section class="squad-group">
        <div class="squad-group-title"><span>${escapeHtml(grupo)}</span><b>${grupos[grupo].length}</b></div>
        <div class="squad-rows">${grupos[grupo].map(j => `<div class="squad-row">
          <div class="squad-number"><span>Camisa</span><strong>${escapeHtml(j.numero || "—")}</strong></div>
          <div class="squad-player"><strong>${escapeHtml(j.nome)}</strong><small>${escapeHtml(j.posicao || "Posição não informada")}</small></div>
          <div class="squad-age"><span>Idade</span><strong>${escapeHtml(j.idade || "—")}</strong></div>
        </div>`).join("")}</div>
      </section>`).join("")}`;
  }
  function render(){
    renderChips(); renderGrid(); renderDetalhe();
  }
  async function init(){
    const [clubesData, tabelaData, rankingData, eventosData, elencosData, mascotesData] = await Promise.all([
      fetchJson("dados-br/clubes.json", { clubes: [] }),
      fetchJson("tabela.json", { tabela: [] }),
      fetchJson("dados-br/ranking-desempenho.json", { ranking: [] }),
      fetchJson("espn_eventos.json", { eventos: [] }),
      fetchJson("dados-br/elencos.json", { elencos: {} }),
      fetchJson("dados-br/mascotes.json", { mascotes: {} })
    ]);
    state.clubes = (clubesData.clubes || []).sort((a,b) => a.nome.localeCompare(b.nome, "pt-BR"));
    state.tabela = tabelaData.tabela || [];
    state.ranking = rankingData.ranking || [];
    state.eventos = eventosData.eventos || [];
    state.elencos = elencosData.elencos || {};
    state.mascotes = mascotesData.mascotes || {};
    const clubeInicialHash = clubeDoHash();
    const inicial = clubeInicialHash?.nome || state.tabela[0]?.time || state.clubes[0]?.nome || "";
    state.selecionado = inicial;
    $("#busca-clube")?.addEventListener("input", ev => { state.filtroTexto = ev.target.value; renderGrid(); });
    window.addEventListener("hashchange", () => {
      const clube = clubeDoHash();
      if (!clube) return;
      selecionar(clube.nome, { atualizarHash:false, behavior:"auto" });
    });
    render();
    if (clubeInicialHash) {
      rolarParaDetalhe("auto");
      window.addEventListener("load", () => rolarParaDetalhe("auto"), { once:true });
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
