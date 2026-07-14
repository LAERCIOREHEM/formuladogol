(function(){
  "use strict";
  const $ = (sel) => document.querySelector(sel);
  const state = { data: null, filtro: "Todos", busca: "" };
  function escapeHtml(value){ return String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[ch])); }
  function escapeAttr(value){ return escapeHtml(value); }
  function slug(value){ return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
  function cacheBust(){ return "?v=" + Date.now(); }
  async function fetchJson(path){
    const res = await fetch(path + cacheBust(), { cache: "no-store" });
    if (!res.ok) throw new Error(path + " HTTP " + res.status);
    return await res.json();
  }
  function escudo(c){
    return c.escudo ? `<img src="${escapeAttr(c.escudo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : "";
  }
  function decada(ano){ return Math.floor(Number(ano)/10)*10 + "s"; }
  function renderRecordes(){
    $("#recordes").innerHTML = state.data.records.map(r => `<article class="record-card"><div class="kicker">${escapeHtml(r.titulo)}</div><strong>${escapeHtml(r.valor)}</strong><p>${escapeHtml(r.detalhe)}</p></article>`).join("");
  }
  function renderBarras(){
    const max = Math.max(...state.data.contagem_titulos.map(c => c.titulos), 1);
    $("#barras-titulos").innerHTML = state.data.contagem_titulos.map(c => {
      const pct = Math.max(8, Math.round(c.titulos / max * 100));
      return `<div class="title-bar"><span>${escapeHtml(c.clube)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><strong>${c.titulos}</strong></div>`;
    }).join("");
  }
  function renderMarcos(){
    $("#marcos").innerHTML = state.data.marcos.map(m => `<div class="row"><span class="date">${escapeHtml(m.ano)}</span><span><strong>${escapeHtml(m.titulo)}</strong><br><small>${escapeHtml(m.texto)}</small></span><span class="score">★</span></div>`).join("");
  }
  function renderChips(){
    const decadas = ["Todos", ...Array.from(new Set(state.data.campeoes.map(c => decada(c.ano)))).sort()];
    $("#chips-museu").innerHTML = decadas.map(d => `<button class="chip ${state.filtro === d ? "active" : ""}" type="button" data-filtro="${escapeAttr(d)}">${escapeHtml(d)}</button>`).join("");
    $("#chips-museu").querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => { state.filtro = btn.dataset.filtro || "Todos"; renderTimeline(); renderChips(); }));
  }
  function campeoesFiltrados(){
    const termo = slug(state.busca);
    return state.data.campeoes.filter(c => {
      if (state.filtro !== "Todos" && decada(c.ano) !== state.filtro) return false;
      if (!termo) return true;
      return slug([c.ano, c.campeao, c.formato, c.nota].join(" ")).includes(termo);
    });
  }
  function renderTimeline(){
    const lista = campeoesFiltrados();
    if (!lista.length) {
      $("#timeline").innerHTML = `<div class="empty-state">Nenhum campeão encontrado com esse filtro.</div>`;
      return;
    }
    $("#timeline").innerHTML = lista.slice().reverse().map(c => `<article class="timeline-item">
      <div class="year-pill">${escapeHtml(c.ano)}</div>
      <div class="timeline-card">
        <h3>${escudo(c)}<span>${escapeHtml(c.campeao)}</span></h3>
        <p>${escapeHtml(c.formato)}${c.nota ? " · " + escapeHtml(c.nota) : ""}</p>
      </div>
    </article>`).join("");
  }
  function render(){ renderRecordes(); renderBarras(); renderMarcos(); renderChips(); renderTimeline(); }
  async function init(){
    try {
      state.data = await fetchJson("dados-br/museu-brasileirao.json");
      $("#busca-museu")?.addEventListener("input", ev => { state.busca = ev.target.value; renderTimeline(); });
      render();
    } catch (err) {
      console.error(err);
      $("#timeline").innerHTML = `<div class="empty-state">Falha ao carregar dados do Museu do Brasileirão.</div>`;
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
