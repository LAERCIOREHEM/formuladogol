(function(){
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const cacheBust = () => "?v=" + Date.now();
  const state = { clubes: [], tabela: [], ranking: [], probabilidades: {}, filtroTexto: "", filtroRegiao: "Todas" };

  function escapeHtml(value){
    return String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[ch]));
  }
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
  function tabelaDo(nome){ return state.tabela.find(x => x.time === nome) || {}; }
  function rankingDo(nome){ return state.ranking.find(x => x.time === nome) || {}; }
  function probabilidadeDo(nome){ return state.probabilidades[slug(nome)] || {}; }
  function probDisplay(prob, key){
    const detail = prob?.probabilidades_detalhes?.[key];
    if (detail?.exibicao) return detail.exibicao;
    const n = Number(prob?.probabilidades_pct?.[key]);
    if (!Number.isFinite(n)) return "—";
    if (n === 0) return "0%";
    if (n > 0 && n < 0.001) return "<0,001%";
    if (n > 99.999) return ">99,999%";
    const digits = n < 0.1 ? 3 : n < 1 ? 2 : 1;
    return n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + "%";
  }
  function paginaClubeUrl(clube){ return `/clube/${slug(clube?.nome || "")}/`; }
  function escudoHtml(clube){
    const fallback = "img/escudo-neutro.svg";
    const src = String(clube?.escudo || "");
    return `<img class="club-logo${src ? "" : " is-neutral-shield"}" src="${escapeHtml(src || fallback)}" alt="Escudo do ${escapeHtml(clube?.nome || "")}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">`;
  }
  function pontosProjetados(prob){
    const p = prob?.pontos_projetados;
    const n = Number(p && typeof p === "object" ? (p.media ?? p.mediana ?? p.media_estimada) : p);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  function posicaoProjetada(prob){
    const n = Number(prob?.posicao_classificacao_projetada ?? prob?.posicao_projetada);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  function probabilidadeResumoHtml(prob){
    const pos = posicaoProjetada(prob);
    const pts = pontosProjetados(prob);
    const titulo = probDisplay(prob, "campeao");
    const lib = probDisplay(prob, "libertadores");
    return `<div class="club-probability-pill"><strong>🎲 AF-Previsão: ${pos ? `${pos}º` : "—"}${pts !== null ? ` · ${pts} pts` : ""}</strong><span>Título ${escapeHtml(titulo)} · Lib ${escapeHtml(lib)}</span></div>`;
  }
  function rankingResumoHtml(rank){
    const score = Number(rank?.indice_final ?? rank?.score);
    const value = Number.isFinite(score) ? score.toLocaleString("pt-BR", { minimumFractionDigits:1, maximumFractionDigits:1 }) : "—";
    return `<div class="club-performance-pill"><strong>AF-Score ${value}</strong><span>${rank?.pos ? `${rank.pos}º no ranking de desempenho` : "ranking em atualização"}</span></div>`;
  }
  function renderChips(){
    const target = $("#chips-regiao");
    if (!target) return;
    const regioes = ["Todas", ...new Set(state.clubes.map(c => c.regiao).filter(Boolean).sort((a,b) => a.localeCompare(b, "pt-BR")))];
    target.innerHTML = regioes.map(r => `<button class="chip ${state.filtroRegiao === r ? "active" : ""}" type="button" data-regiao="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join("");
    target.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => { state.filtroRegiao = btn.dataset.regiao || "Todas"; render(); }));
  }
  function clubesFiltrados(){
    const termo = slug(state.filtroTexto);
    return state.clubes.filter(c => {
      if (state.filtroRegiao !== "Todas" && c.regiao !== state.filtroRegiao) return false;
      if (!termo) return true;
      return slug([c.nome,c.nome_completo,c.cidade,c.uf,c.estadio,c.mascote,c.apelido].join(" ")).includes(termo);
    });
  }
  function renderGrid(){
    const target = $("#grid-clubes");
    if (!target) return;
    const lista = clubesFiltrados();
    if (!lista.length) {
      target.innerHTML = `<div class="empty-state">Nenhum clube encontrado para o filtro atual.</div>`;
      return;
    }
    target.innerHTML = lista.map(c => {
      const t = tabelaDo(c.nome);
      const r = rankingDo(c.nome);
      const p = probabilidadeDo(c.nome);
      const url = paginaClubeUrl(c);
      return `<article class="club-card" data-clube="${escapeHtml(c.nome)}" data-club-url="${url}" tabindex="0" role="link" aria-label="Abrir página completa do ${escapeHtml(c.nome)}">
        <a class="club-page-link" href="${url}" style="color:inherit;text-decoration:none;display:block;position:relative;z-index:1">
          <div class="club-head">${escudoHtml(c)}<div><div class="club-name">${escapeHtml(c.nome)}</div><div class="club-sub">${escapeHtml(c.cidade)}-${escapeHtml(c.uf)} · ${escapeHtml(c.apelido || "")}</div></div></div>
          <p>${escapeHtml(c.curiosidade || c.momento || "")}</p>
          <div class="club-kpis"><div class="kpi"><strong>${t.pos || "—"}º</strong><span>posição</span></div><div class="kpi"><strong>${t.pontos ?? "—"}</strong><span>pontos</span></div><div class="kpi"><strong>${r.pos || "—"}º</strong><span>AF-Score</span></div></div>
          ${probabilidadeResumoHtml(p)}${rankingResumoHtml(r)}
          <span class="club-page-cta">Página completa do clube →</span>
        </a>
      </article>`;
    }).join("");
    target.querySelectorAll(".club-card").forEach(card => {
      const go = () => { if (card.dataset.clubUrl) window.location.href = card.dataset.clubUrl; };
      card.addEventListener("click", ev => { if (!ev.target.closest("a")) go(); });
      card.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });
  }
  function render(){ renderChips(); renderGrid(); }

  async function init(){
    const [clubesData, tabelaData, rankingData, probabilidadesData] = await Promise.all([
      fetchJson("dados-br/clubes.json", { clubes: [] }),
      fetchJson("tabela.json", { tabela: [] }),
      fetchJson("dados-br/ranking-desempenho.json", { ranking: [] }),
      fetchJson("dados-br/probabilidades-brasileirao.json", { clubes: [] })
    ]);
    state.clubes = (clubesData.clubes || []).sort((a,b) => a.nome.localeCompare(b.nome, "pt-BR"));
    state.tabela = tabelaData.tabela || [];
    state.ranking = rankingData.ranking || [];
    state.probabilidades = Object.fromEntries((probabilidadesData.clubes || []).map(item => [slug(item.clube), item]));

    const oldHash = decodeURIComponent(location.hash.replace("#", ""));
    if (oldHash) {
      const club = state.clubes.find(c => slug(c.nome) === slug(oldHash));
      if (club) {
        location.replace(paginaClubeUrl(club));
        return;
      }
    }
    $("#busca-clube")?.addEventListener("input", ev => { state.filtroTexto = ev.target.value; renderGrid(); });
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
