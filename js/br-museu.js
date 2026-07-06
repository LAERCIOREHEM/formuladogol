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
  function renderResumo(){
    const d = state.data;
    const total = d.campeoes.length;
    const clubes = new Set(d.campeoes.map(c => c.campeao)).size;
    const maior = d.contagem_titulos[0];
    const pontosCorridos = d.campeoes.filter(c => c.formato === "Pontos corridos").length;
    $("#cards-resumo").innerHTML = `
      <article class="summary-card"><div class="summary-label">Conquistas listadas</div><div class="summary-value">${total}</div><div class="summary-sub">inclui anos com dois torneios nacionais</div></article>
      <article class="summary-card"><div class="summary-label">Clubes campeões</div><div class="summary-value">${clubes}</div><div class="summary-sub">linha principal 1959–2025</div></article>
      <article class="summary-card"><div class="summary-label">Maior campeão</div><div class="summary-value">${escapeHtml(maior.clube)}</div><div class="summary-sub">${maior.titulos} títulos nacionais</div></article>
      <article class="summary-card"><div class="summary-label">Pontos corridos</div><div class="summary-value">${pontosCorridos}</div><div class="summary-sub">desde 2003</div></article>
    `;
  }
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
  function renderMeta(){
    $("#meta-line").innerHTML = `<span class="meta-pill">${escapeHtml(state.data.nota_oficial)}</span>`;
  }
  function render(){ renderResumo(); renderRecordes(); renderBarras(); renderMarcos(); renderChips(); renderTimeline(); renderMeta(); }
  async function init(){
    try {
      state.data = await fetchJson("dados-br/museu-brasileirao.json");
      $("#busca-museu")?.addEventListener("input", ev => { state.busca = ev.target.value; renderTimeline(); });
      render();
    } catch (err) {
      console.error(err);
      $("#meta-line").innerHTML = `<span class="meta-pill">Não foi possível carregar o museu. Confira dados-br/museu-brasileirao.json.</span>`;
      $("#timeline").innerHTML = `<div class="empty-state">Falha ao carregar dados do Museu do Brasileirão.</div>`;
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
