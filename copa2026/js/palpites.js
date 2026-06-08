/* =========================================================================
   palpites.js — "Palpites de todos" (versão real, lê do Supabase)
   Liberado só depois da trava: copa_revelados() só devolve dados após a
   trava (ou se o admin revelar). Sem resultados oficiais ainda, então
   mostramos as escolhas de cada um (sem apagar por fase — isso entra junto
   com a tela de resultados ao vivo).
   ========================================================================= */
(function () {
  "use strict";
  const CFG = window.COPA_CFG || { url: "", key: "" };
  const $ = s => document.querySelector(s);
  let DADOS = {}, PART = [], JOGOS = [], GRUPOS = [], aba = "jogo";

  async function rpc(fn, body) {
    const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": CFG.key, "Authorization": "Bearer " + CFG.key },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error("RPC " + fn + " HTTP " + r.status);
    return r.json();
  }

  const nome = id => (DADOS.nomeDe && DADOS.nomeDe[id]) || id || "—";
  const iso = id => (DADOS.isoDe && DADOS.isoDe[id]) || "";
  function flag(id, w) { const c = iso(id); return c ? `<img src="https://flagcdn.com/w${w || 40}/${c}.png" alt="" title="${nome(id)}" onerror="this.style.visibility='hidden'">` : ""; }
  function bloqueio(msg) {
    $("#app").innerHTML = `<div class="bloq"><div class="cad">🔒</div>
      <h2>Palpites ainda fechados</h2><p>${msg || "Os palpites de todos ficam visíveis <b>a partir de 11/06 às 00:00</b>, depois que as apostas travarem (10/06 23h59). Volte aqui depois!"}</p></div>`;
  }

  async function init() {
    let s, e, t, rows;
    try {
      [s, e, t] = await Promise.all([
        fetch("dados/selecoes.json").then(r => r.json()),
        fetch("dados/estrutura_mata_mata.json").then(r => r.json()),
        fetch("dados/terceiros_map.json").then(r => r.json())
      ]);
      DADOS.selecoes = s.selecoes; DADOS.estrutura = e; DADOS.terceirosMap = t;
      DADOS.nomeDe = {}; DADOS.isoDe = {};
      s.selecoes.forEach(x => { DADOS.nomeDe[x.id] = x.nome; DADOS.isoDe[x.id] = x.iso2; });
    } catch (err) { bloqueio("Erro ao carregar os dados da Copa. Tente recarregar a página."); return; }

    JOGOS = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes);
    GRUPOS = [...new Set(JOGOS.map(j => j.grupo))].sort();

    try { rows = await rpc("copa_revelados", {}); } catch (err) { rows = []; }
    if (!rows || !rows.length) { bloqueio(); return; }

    PART = rows.map(r => {
      const pl = r.payload || {};
      const g = Object.keys(pl.placaresGrupos || {}).map(id => ({ jogo_id: id, ga: pl.placaresGrupos[id].ga, gb: pl.placaresGrupos[id].gb }));
      let d = null;
      try { d = COPA_ENGINE.derivar(DADOS.selecoes, g, pl.placaresMata || {}, DADOS.estrutura, DADOS.terceirosMap); } catch (e2) {}
      return { nome: r.nome, grupos: pl.placaresGrupos || {}, d };
    }).sort((a, b) => a.nome.localeCompare(b.nome));

    montarTopo(); render();
  }

  function montarTopo() {
    $("#topo").style.display = "";
    $("#contagem").textContent = PART.length + " participantes";
    $("#ab-jogo").onclick = () => { aba = "jogo"; render(); };
    $("#ab-class").onclick = () => { aba = "class"; render(); };
  }

  // ---------- aba: por jogo ----------
  function viewJogo() {
    let html = "";
    GRUPOS.forEach(g => {
      html += `<div class="grupo-tit">Grupo ${g}</div>`;
      JOGOS.filter(j => j.grupo === g).forEach((j, i) => {
        const id = "j_" + j.jogo_id;
        const linhas = PART.map(p => {
          const sc = p.grupos[j.jogo_id];
          const txt = (sc && sc.ga != null && sc.gb != null) ? `${sc.ga}<i>×</i>${sc.gb}` : "—";
          return `<div class="pp"><span class="nm">${p.nome}</span><span class="pl">${txt}</span></div>`;
        }).join("");
        html += `<div class="jogo" id="${id}">
          <div class="cab" data-tg="${id}">
            <span class="conf">${flag(j.a)}${j.a}<span class="vs">×</span>${j.b}${flag(j.b)}</span>
            <span class="seta">▶</span></div>
          <div class="palps">${linhas}</div></div>`;
      });
    });
    return html;
  }

  // ---------- aba: por classificação ----------
  function cel(id) { return `<div class="cel">${flag(id)}<span class="sg">${id || "—"}</span></div>`; }
  function viewClass() {
    return PART.map((p, idx) => {
      const d = p.d || {};
      const c = d.campeao, v = d.vice, t = d.terceiro, q = d.quarto;
      const trinta2 = d.classificados32 || [];
      const grid = trinta2.length
        ? trinta2.map(s => `<div class="t ${s === c ? "campeao" : ""}">${flag(s)}<span class="sg">${s}</span></div>`).join("")
        : `<p class="incompleto">Palpite incompleto — sem chave completa.</p>`;
      return `<div class="pessoa" id="p_${idx}">
        <div class="linha" data-tp="p_${idx}">
          <span class="nm"><span class="seta">▶</span>${p.nome}</span>
          ${cel(c)}${cel(v)}${cel(t)}</div>
        <div class="det">
          <div class="q">4º lugar: <b>${nome(q)}</b> · Campeão: <b>${nome(c)}</b></div>
          <div class="tit">As 32 classificadas no palpite de ${p.nome}</div>
          <div class="grid32">${grid}</div></div></div>`;
    }).join("");
  }

  function render() {
    $("#ab-jogo").className = aba === "jogo" ? "on" : "";
    $("#ab-class").className = aba === "class" ? "on" : "";
    $("#app").innerHTML = aba === "jogo" ? viewJogo() : viewClass();
    document.querySelectorAll("[data-tg]").forEach(e => e.onclick = () => e.closest(".jogo").classList.toggle("aberto"));
    document.querySelectorAll("[data-tp]").forEach(e => e.onclick = () => e.closest(".pessoa").classList.toggle("aberto"));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
