(function(){
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const fmtData = new Intl.DateTimeFormat("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
  const cacheBust = () => "?v=" + Date.now();
  const POS_ORDEM = ["Goleiro", "Defensor", "Zagueiro", "Lateral", "Meio-campista", "Meia", "Atacante", "Técnico", "Outros"];
  const state = {
    clubes: [], tabela: [], ranking: [], eventos: [], elencos: {},
    filtroTexto: "", filtroRegiao: "Todas", selecionado: ""
  };

  function escapeHtml(value){
    return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[ch]));
  }
  function escapeAttr(value){ return escapeHtml(value); }
  function slug(value){
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function normalize(value){ return slug(value).replace(/-/g, " ").trim(); }
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
  function safeUrl(url){
    const s = String(url || "").trim();
    if (!s) return "";
    return /^https:\/\//i.test(s) ? s : "";
  }
  function escudoHtml(c, cls="club-logo"){
    if (c && c.escudo) return `<img class="${cls}" src="${escapeAttr(c.escudo)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
    return `<span class="${cls} logo-fallback" aria-hidden="true">${escapeHtml((c && (c.sigla || c.nome) || "?").slice(0,3).toUpperCase())}</span>`;
  }
  function playerPhotoHtml(j){
    const nome = j.nome || j.displayName || j.fullName || j.name || "Jogador";
    const foto = safeUrl(j.foto || j.headshot || j.headshot_href || j.imagem);
    if (foto) return `<img class="player-photo" src="${escapeAttr(foto)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'player-photo player-fallback',textContent:'${escapeAttr(iniciais(nome))}'}))">`;
    return `<span class="player-photo player-fallback" aria-hidden="true">${escapeHtml(iniciais(nome))}</span>`;
  }
  function iniciais(nome){
    return String(nome || "?").trim().split(/\s+/).filter(Boolean).slice(0,2).map(p => p[0]).join("").toUpperCase() || "?";
  }
  function tabelaDo(nome){ return state.tabela.find(t => t.time === nome) || {}; }
  function rankingDo(nome){ return state.ranking.find(r => r.time === nome) || {}; }
  function eventosDo(nome){
    return state.eventos.filter(e => e.mandante === nome || e.visitante === nome)
      .sort((a,b) => String(a.data_iso||"").localeCompare(String(b.data_iso||"")));
  }
  function isPost(e){ return String(e.estado || "").toLowerCase() === "post" || (e.placar_mandante !== null && e.placar_mandante !== undefined && e.placar_visitante !== null && e.placar_visitante !== undefined); }
  function dataCurta(iso){
    try { return fmtData.format(new Date(iso)); } catch { return "—"; }
  }
  function hinoUrl(c){
    const direto = safeUrl(c?.links?.hino_spotify || c?.hino_spotify || c?.links?.spotify);
    if (direto) return direto;
    return "https://open.spotify.com/search/" + encodeURIComponent(`hino ${c?.nome_completo || c?.nome || "clube"}`);
  }
  function coresHtml(c){
    const cores = Array.isArray(c.cores) ? c.cores : [];
    if (!cores.length) return `<span class="color-chip">cores a confirmar</span>`;
    return cores.map(cor => `<span class="color-chip">${escapeHtml(cor)}</span>`).join("");
  }
  function formaHtml(r){
    const forma = r.forma_ultimos5 || r.forma || [];
    if (!Array.isArray(forma) || !forma.length) return `<span class="muted">—</span>`;
    return `<span class="form-line">${forma.slice(-5).map(v => `<span class="form-dot ${escapeAttr(String(v).toLowerCase())}">${escapeHtml(v)}</span>`).join("")}</span>`;
  }
  function renderResumo(){
    const estados = [...new Set(state.clubes.map(c => c.uf).filter(Boolean))].length;
    const lider = state.tabela[0];
    const numeroTitulos = (c) => parseInt(String(c.titulos_brasileiros || "0"), 10) || 0;
    const maisTitulos = state.clubes.slice().sort((a,b) => numeroTitulos(b) - numeroTitulos(a))[0];
    const comElenco = state.clubes.filter(c => getRoster(c.nome).length).length;
    $("#cards-resumo").innerHTML = `
      <article class="summary-card"><div class="summary-label">Clubes</div><div class="summary-value">${state.clubes.length}</div><div class="summary-sub">Série A 2026 mapeada</div></article>
      <article class="summary-card"><div class="summary-label">UFs</div><div class="summary-value">${estados}</div><div class="summary-sub">distribuição por estado</div></article>
      <article class="summary-card"><div class="summary-label">Líder atual</div><div class="summary-value">${escapeHtml(lider?.time || "—")}</div><div class="summary-sub">${lider ? `${lider.pontos} pts · ${lider.aproveitamento}%` : "aguardando tabela"}</div></article>
      <article class="summary-card"><div class="summary-label">Elencos</div><div class="summary-value">${comElenco}/${state.clubes.length}</div><div class="summary-sub">preenchidos via ESPN roster</div></article>
      <article class="summary-card wide"><div class="summary-label">Maior campeão</div><div class="summary-value">${escapeHtml(maisTitulos?.nome || "—")}</div><div class="summary-sub">${escapeHtml(maisTitulos?.titulos_brasileiros || "—")} títulos brasileiros na curadoria</div></article>
    `;
  }
  function renderSelect(){
    const sel = $("#select-clube");
    if (!sel) return;
    const opts = [`<option value="">Selecione um clube...</option>`].concat(state.clubes.map(c => `<option value="${escapeAttr(c.nome)}" ${state.selecionado === c.nome ? "selected" : ""}>${escapeHtml(c.sigla || "")} — ${escapeHtml(c.nome)}</option>`));
    sel.innerHTML = opts.join("");
  }
  function renderChips(){
    const regioes = ["Todas", ...new Set(state.clubes.map(c => c.regiao).filter(Boolean).sort())];
    const el = $("#chips-regiao");
    if (!el) return;
    el.innerHTML = regioes.map(r => `<button class="chip ${state.filtroRegiao === r ? "active" : ""}" type="button" data-regiao="${escapeAttr(r)}">${escapeHtml(r)}</button>`).join("");
    el.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => {
      state.filtroRegiao = btn.dataset.regiao || "Todas";
      renderGrid();
      renderChips();
    }));
  }
  function clubesFiltrados(){
    const termo = slug(state.filtroTexto);
    return state.clubes.filter(c => {
      if (state.filtroRegiao !== "Todas" && c.regiao !== state.filtroRegiao) return false;
      if (!termo) return true;
      const hay = slug([c.nome, c.nome_completo, c.cidade, c.uf, c.uf_nome, c.estadio, c.mascote, c.apelido, c.torcida, c.regiao].join(" "));
      return hay.includes(termo);
    });
  }
  function renderGrid(){
    const lista = clubesFiltrados();
    const grid = $("#grid-clubes");
    if (!grid) return;
    if (!lista.length) {
      grid.innerHTML = `<div class="empty-state">Nenhum clube encontrado para o filtro atual.</div>`;
      return;
    }
    grid.innerHTML = lista.map(c => {
      const t = tabelaDo(c.nome);
      const r = rankingDo(c.nome);
      const roster = getRoster(c.nome);
      return `<article class="club-card premium ${state.selecionado === c.nome ? "active" : ""}" tabindex="0" role="button" data-clube="${escapeAttr(c.nome)}">
        <div class="club-card-bg">${escudoHtml(c, "club-bg-logo")}</div>
        <div class="club-head">
          ${escudoHtml(c)}
          <div><div class="club-name">${escapeHtml(c.nome)}</div><div class="club-sub">${escapeHtml(c.cidade)}-${escapeHtml(c.uf)} · ${escapeHtml(c.apelido)}</div></div>
          <span class="uf-pill">${escapeHtml(c.uf)}</span>
        </div>
        <div class="mascot-line"><span class="mascot-emoji">${escapeHtml(c.mascote_emoji || "🛡️")}</span><strong>${escapeHtml(c.mascote || "Mascote")}</strong></div>
        <p>${escapeHtml(c.curiosidade)}</p>
        <div class="club-kpis">
          <div class="kpi"><strong>${t.pos || "—"}º</strong><span>posição</span></div>
          <div class="kpi"><strong>${t.pontos ?? "—"}</strong><span>pontos</span></div>
          <div class="kpi"><strong>${r.score ?? "—"}</strong><span>índice</span></div>
          <div class="kpi"><strong>${roster.length || "—"}</strong><span>elenco</span></div>
        </div>
      </article>`;
    }).join("");
    grid.querySelectorAll(".club-card").forEach(card => {
      const select = () => selecionar(card.dataset.clube);
      card.addEventListener("click", select);
      card.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(); } });
    });
  }
  function selecionar(nome){
    if (!nome) return;
    state.selecionado = nome;
    history.replaceState(null, "", "#" + slug(nome));
    renderSelect();
    renderGrid();
    renderDetalhe();
    document.getElementById("detalhe-wrapper")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderDetalhe(){
    const c = state.clubes.find(x => x.nome === state.selecionado) || state.clubes[0];
    if (!c) return;
    state.selecionado = c.nome;
    const t = tabelaDo(c.nome);
    const r = rankingDo(c.nome);
    const hino = hinoUrl(c);
    $("#detalhe-wrapper").hidden = false;
    $("#detalhe-clube").innerHTML = `
      <div class="detail-premium-hero">
        <div class="detail-bg-logo">${escudoHtml(c, "club-bg-logo")}</div>
        <div class="detail-hero-main">
          ${escudoHtml(c, "detail-logo")}
          <div>
            <div class="kicker">${escapeHtml(c.nome_completo)}</div>
            <h2>${escapeHtml(c.nome)}</h2>
            <p>${escapeHtml(c.momento || c.curiosidade || "")}</p>
            <div class="club-actions">
              <a class="action-btn" href="${escapeAttr(hino)}" target="_blank" rel="noopener noreferrer">🎵 Ouvir hino</a>
              <a class="action-btn ghost" href="./?brasileirao=1&view=jogos#${escapeAttr(slug(c.nome))}">⚽ Ver jogos</a>
              <a class="action-btn ghost" href="estatisticas.html?clube=${encodeURIComponent(c.nome)}">📈 Estatísticas</a>
            </div>
          </div>
        </div>
        <div class="club-identity-strip">
          <span>${escapeHtml(c.uf_nome || c.uf || "UF")}</span>
          <span>${escapeHtml(c.regiao || "Região")}</span>
          <span>${escapeHtml(c.apelido || "Apelido")}</span>
        </div>
      </div>

      <div class="info-grid premium-info">
        <div class="info-card mascot-card"><span>Mascote</span><strong><b class="mascot-big">${escapeHtml(c.mascote_emoji || "🛡️")}</b> ${escapeHtml(c.mascote || "—")}</strong></div>
        <div class="info-card"><span>Cidade / UF</span><strong>${escapeHtml(c.cidade)}-${escapeHtml(c.uf)}</strong></div>
        <div class="info-card"><span>Estádio</span><strong>${escapeHtml(c.estadio)}</strong><small>${escapeHtml(c.capacidade || "capacidade a confirmar")}</small></div>
        <div class="info-card"><span>Fundação</span><strong>${escapeHtml(c.fundacao)}</strong></div>
        <div class="info-card"><span>Títulos BR</span><strong>${escapeHtml(c.titulos_brasileiros)}</strong></div>
        <div class="info-card"><span>Torcida</span><strong>${escapeHtml(c.torcida)}</strong></div>
        <div class="info-card"><span>Tabela atual</span><strong>${t.pos ? `${t.pos}º · ${t.pontos} pts · SG ${t.sg}` : "aguardando"}</strong><small>${t.jogos ? `${t.jogos} jogos · ${t.aproveitamento}%` : "snapshot ESPN"}</small></div>
        <div class="info-card"><span>Forma</span><strong>${formaHtml(r)}</strong></div>
      </div>

      <div class="club-color-row"><span>Cores:</span>${coresHtml(c)}</div>
      <div class="club-note"><strong>Curiosidade:</strong> ${escapeHtml(c.curiosidade || "—")}</div>
      <div class="club-note"><strong>Desempenho:</strong> ${escapeHtml(r.justificativa || "Ranking de desempenho será exibido após geração do robô.")}</div>
    `;
    renderJogos(c.nome);
    renderElenco(c.nome);
  }
  function renderJogos(nome){
    const eventos = eventosDo(nome);
    const agora = new Date();
    const ultimos = eventos.filter(isPost).slice(-5).reverse();
    const proximos = eventos.filter(e => !isPost(e) && new Date(e.data_iso) >= agora).slice(0,5);
    const bloco = [];
    if (proximos.length) {
      bloco.push(`<div class="kicker">Próximos</div>`);
      proximos.forEach(e => bloco.push(rowJogo(e, false, nome)));
    }
    if (ultimos.length) {
      bloco.push(`<div class="kicker" style="margin-top:${proximos.length ? 12 : 0}px">Últimos</div>`);
      ultimos.forEach(e => bloco.push(rowJogo(e, true, nome)));
    }
    $("#jogos-clube").innerHTML = bloco.join("") || `<div class="empty-state">Ainda não há jogos mapeados para este clube nos snapshots locais.</div>`;
  }
  function rowJogo(e, finalizado, nome){
    const placar = finalizado ? `${e.placar_mandante ?? "—"} × ${e.placar_visitante ?? "—"}` : "vs";
    const casa = e.mandante === nome;
    const adversario = casa ? e.visitante : e.mandante;
    return `<div class="row game-row"><span class="date">${escapeHtml(dataCurta(e.data_iso))}</span><span><strong>${casa ? "Casa" : "Fora"}</strong> · ${escapeHtml(adversario)}<br><small>${escapeHtml(e.estadio || "estádio a confirmar")}</small></span><span class="score">${escapeHtml(placar)}</span></div>`;
  }
  function getRoster(nome){
    const e = state.elencos || {};
    const candidatos = [nome, slug(nome), normalize(nome), nome?.toUpperCase?.(), nome?.toLowerCase?.()];
    for (const key of candidatos) {
      const valor = e[key];
      if (Array.isArray(valor)) return valor;
      if (valor && Array.isArray(valor.jogadores)) return valor.jogadores;
      if (valor && Array.isArray(valor.athletes)) return valor.athletes;
    }
    const n = normalize(nome);
    for (const [key, valor] of Object.entries(e)) {
      if (normalize(key) === n || slug(key) === slug(nome)) {
        if (Array.isArray(valor)) return valor;
        if (valor && Array.isArray(valor.jogadores)) return valor.jogadores;
        if (valor && Array.isArray(valor.athletes)) return valor.athletes;
      }
    }
    return [];
  }
  function posicaoNormalizada(j){
    const bruto = j.posicao || j.position || j.pos || j.positionName || j.position_abbreviation || "Outros";
    const s = String(bruto || "");
    const low = normalize(s);
    if (/goleiro|goalkeeper|gol/.test(low)) return "Goleiro";
    if (/zagueiro|defensor|defender|back|lateral/.test(low)) return "Defensor";
    if (/meia|meio|midfielder/.test(low)) return "Meio-campista";
    if (/atacante|forward|striker|winger/.test(low)) return "Atacante";
    if (/tecnico|coach|manager/.test(low)) return "Técnico";
    return s || "Outros";
  }
  function renderElenco(nome){
    const jogadores = getRoster(nome).slice().sort((a,b) => {
      const pa = POS_ORDEM.indexOf(posicaoNormalizada(a));
      const pb = POS_ORDEM.indexOf(posicaoNormalizada(b));
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || String(a.nome || a.displayName || "").localeCompare(String(b.nome || b.displayName || ""), "pt-BR");
    });
    const status = $("#elenco-status");
    if (!jogadores.length) {
      if (status) status.textContent = "aguardando coleta";
      $("#elenco-clube").className = "empty-state roster-empty";
      $("#elenco-clube").innerHTML = `
        <strong>Elenco de ${escapeHtml(nome)} ainda em coleta.</strong><br>
        A página já está preparada para exibir fotos, posições e números quando o workflow <em>Atualizar Brasileirao (ESPN)</em> preencher <code>dados-br/elencos.json</code>.
      `;
      return;
    }
    if (status) status.textContent = `${jogadores.length} jogadores`;
    $("#elenco-clube").className = "roster-grid";
    $("#elenco-clube").innerHTML = jogadores.slice(0, 36).map(j => {
      const nomeJog = j.nome || j.displayName || j.fullName || j.name || "Jogador";
      const pos = posicaoNormalizada(j);
      const num = j.numero || j.jersey || j.number || "";
      const idade = j.idade || j.age || "";
      return `<article class="player-card">
        ${playerPhotoHtml({...j, nome:nomeJog})}
        <div class="player-info"><strong>${escapeHtml(nomeJog)}</strong><span>${escapeHtml(pos)}${num ? ` · nº ${escapeHtml(num)}` : ""}${idade ? ` · ${escapeHtml(idade)} anos` : ""}</span></div>
      </article>`;
    }).join("");
  }
  function renderMeta(){
    const meta = $("#meta-line");
    if (!meta) return;
    const jogadores = Object.values(state.elencos || {}).reduce((acc, v) => acc + (Array.isArray(v) ? v.length : Array.isArray(v?.jogadores) ? v.jogadores.length : 0), 0);
    meta.innerHTML = `<span class="meta-pill">${state.clubes.length} clubes</span><span class="meta-pill">tabela ESPN integrada</span><span class="meta-pill">${jogadores || "elencos"} ${jogadores ? "jogadores" : "em coleta"}</span><span class="meta-pill">hinos por Spotify</span>`;
  }
  function render(){
    renderResumo(); renderSelect(); renderChips(); renderGrid(); renderMeta(); renderDetalhe();
  }
  async function init(){
    const [clubesData, tabelaData, rankingData, eventosData, elencosData] = await Promise.all([
      fetchJson("dados-br/clubes.json", { clubes: [] }),
      fetchJson("tabela.json", { tabela: [] }),
      fetchJson("dados-br/ranking-desempenho.json", { ranking: [] }),
      fetchJson("espn_eventos.json", { eventos: [] }),
      fetchJson("dados-br/elencos.json", { elencos: {} })
    ]);
    state.clubes = (clubesData.clubes || []).sort((a,b) => a.nome.localeCompare(b.nome, "pt-BR"));
    state.tabela = tabelaData.tabela || [];
    state.ranking = rankingData.ranking || [];
    state.eventos = eventosData.eventos || [];
    state.elencos = elencosData.elencos || {};
    const hash = decodeURIComponent(location.hash.replace("#", ""));
    const inicial = state.clubes.find(c => slug(c.nome) === hash)?.nome || state.tabela[0]?.time || state.clubes[0]?.nome || "";
    state.selecionado = inicial;
    $("#busca-clube")?.addEventListener("input", ev => { state.filtroTexto = ev.target.value; renderGrid(); });
    $("#select-clube")?.addEventListener("change", ev => selecionar(ev.target.value));
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
