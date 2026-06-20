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

  const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  let RES = {}; // jogo_id -> {ga, gb, fim, inv, homeId, awayId}
  let ESPNORD = {}; // jogo_id -> {homeId, awayId, inv} (ordem oficial da ESPN)

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

    // resultados reais da fase de grupos (ESPN) — para as medalhinhas por jogo
    try {
      const d = await fetch(ESPN + "?dates=20260611-20260627&limit=120").then(r => r.json());
      (d.events || []).forEach(ev => {
        if (((ev.season && ev.season.slug) || "") !== "group-stage") return;
        const c = ev.competitions[0]; if (!c || c.status.type.state === "pre") return;
        const cs = c.competitors || [];
        const h = cs.find(x => x.homeAway === "home") || cs[0], a = cs.find(x => x.homeAway === "away") || cs[1];
        const hId = (h.team || {}).abbreviation, aId = (a.team || {}).abbreviation;
        const j = JOGOS.find(x => (x.a === hId && x.b === aId) || (x.a === aId && x.b === hId));
        if (!j) return;
        const hs = parseInt(h.score || "0", 10), as = parseInt(a.score || "0", 10);
        // inv = ESPN mostra invertido em relação à engine (mandante = j.b)
        const inv = (j.a !== hId);
        RES[j.jogo_id] = { ga: hs, gb: as, fim: c.status.type.state === "post", inv: inv, homeId: hId, awayId: aId };
        ESPNORD[j.jogo_id] = { homeId: hId, awayId: aId, inv: inv };
      });
    } catch (e) { RES = {}; }

    try { rows = await rpc("copa_revelados", {}); } catch (err) { rows = []; }
    if (!rows || !rows.length) { bloqueio(); return; }

    PART = rows.map(r => {
      const pl = r.payload || {};
      const g = Object.keys(pl.placaresGrupos || {}).map(id => ({ jogo_id: id, ga: pl.placaresGrupos[id].ga, gb: pl.placaresGrupos[id].gb }));
      let d = null;
      try { d = COPA_ENGINE.derivar(DADOS.selecoes, g, pl.placaresMata || {}, DADOS.estrutura, DADOS.terceirosMap); } catch (e2) {}
      return { nome: r.nome, grupos: pl.placaresGrupos || {}, d, raw: pl };
    }).sort((a, b) => a.nome.localeCompare(b.nome));

    montarTopo(); render();
  }

  function montarTopo() {
    $("#topo").style.display = "";
    $("#contagem").textContent = PART.length + " participantes";
    $("#ab-jogo").onclick = () => { aba = "jogo"; render(); };
    $("#ab-class").onclick = () => { aba = "class"; render(); };
    $("#ab-grupo").onclick = () => { aba = "grupo"; render(); };
  }

  // ---------- aba: por jogo ----------
  function viewJogo() {
    let html = "";
    GRUPOS.forEach(g => {
      html += `<div class="grupo-tit">Grupo ${g}</div>`;
      JOGOS.filter(j => j.grupo === g).forEach((j, i) => {
        const id = "j_" + j.jogo_id;
        const real = RES[j.jogo_id];
        const encerrado = !!(real && real.fim);
        const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0;
        let acertos = 0;
        const ord = ESPNORD[j.jogo_id];
        const inv = ord ? ord.inv : false; // se ESPN inverteu, espelha tudo
        const ladoA = inv ? j.b : j.a, ladoB = inv ? j.a : j.b; // mandante x visitante (ordem ESPN)
        const linhas = PART.map(p => {
          const sc = p.grupos[j.jogo_id];
          const tem = sc && sc.ga != null && sc.gb != null;
          const pga = tem ? (inv ? sc.gb : sc.ga) : null, pgb = tem ? (inv ? sc.ga : sc.gb) : null;
          const txt = tem ? `${pga}<i>×</i>${pgb}` : "—";
          let tag = "";
          if (encerrado && tem) {
            const exato = pga === real.ga && pgb === real.gb;
            const certo = sgn(pga - pgb) === sgn(real.ga - real.gb);
            if (certo) acertos++;
            tag = exato ? '<span class="medalha">CRAVOU 🎯</span>' : `<span class="bolinha ${certo ? "v" : "x"}"></span>`;
          }
          return `<div class="pp"><span class="nm">${p.nome}</span><span class="pl">${txt}${tag}</span></div>`;
        }).join("");
        const chipReal = real ? `<span class="realsc ${encerrado ? "" : "andamento"}">${real.ga}×${real.gb}${encerrado ? "" : " 🔴"}</span>` : "";
        const resumo = encerrado ? `<div class="resumo-jogo">${acertos} de ${PART.length} acertaram o resultado · 🎯 = cravou o placar</div>` : "";
        html += `<div class="jogo" id="${id}">
          <div class="cab" data-tg="${id}">
            <span class="conf">${flag(ladoA)}${ladoA}<span class="vs">×</span>${ladoB}${flag(ladoB)}${chipReal}</span>
            <span class="seta">▶</span></div>
          <div class="palps">${resumo}${linhas}</div></div>`;
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
          <div class="grid32">${grid}</div>
          <div class="hashlinha">🔐 Impressão digital deste palpite (confira com seu comprovante):<br><code id="hash_${idx}">calculando…</code></div></div></div>`;
    }).join("");
  }

  // ===== Por grupo: como cada apostador classificou 1º/2º/3º/4º de cada grupo =====
  function viewGrupo() {
    const POS = ["1º", "2º", "3º", "4º"];
    // bloco por grupo; dentro, cada apostador com sua linha de classificação
    const blocos = GRUPOS.map((g, gi) => {
      const linhas = PART.map(p => {
        const cg = (p.d && p.d.classificacao && p.d.classificacao[g]) || null;
        if (!cg) return `<div class="pg-linha"><span class="pg-nome">${p.nome}</span><span class="pg-vazio">palpite incompleto</span></div>`;
        const cels = POS.map((lab, i) => {
          const id = cg[i] && cg[i].id;
          return id ? `<span class="pg-cel"><i>${lab}</i> ${flag(id)} <b>${id}</b></span>` : `<span class="pg-cel"><i>${lab}</i> —</span>`;
        }).join("");
        return `<div class="pg-linha"><span class="pg-nome">${p.nome}</span><div class="pg-cels">${cels}</div></div>`;
      }).join("");
      return `<div class="pg-grupo" id="pg_${g}">
        <button class="pg-cab" data-pgg="${g}"><span class="seta">▶</span> Grupo ${g} <span class="pg-cont">${PART.length} palpites</span></button>
        <div class="pg-corpo">${linhas}</div>
      </div>`;
    }).join("");
    return `<p class="pg-intro">Veja como cada apostador classificou os 4 times de cada grupo. Toque num grupo para abrir.</p>${blocos}`;
  }

  function canonical(o) {
    if (o === null || typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(canonical).join(",") + "]";
    return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  async function sha256hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function preencherHashes() {
    for (let i = 0; i < PART.length; i++) {
      const el = document.getElementById("hash_" + i);
      if (!el) continue;
      const pl = PART[i].raw || {};
      el.textContent = await sha256hex(canonical({ g: pl.placaresGrupos || {}, m: pl.placaresMata || {} }));
    }
  }

  function render() {
    $("#ab-jogo").className = aba === "jogo" ? "on" : "";
    $("#ab-class").className = aba === "class" ? "on" : "";
    $("#ab-grupo").className = aba === "grupo" ? "on" : "";
    $("#app").innerHTML = aba === "jogo" ? viewJogo() : aba === "class" ? viewClass() : viewGrupo();
    document.querySelectorAll("[data-tg]").forEach(e => e.onclick = () => e.closest(".jogo").classList.toggle("aberto"));
    document.querySelectorAll("[data-tp]").forEach(e => e.onclick = () => e.closest(".pessoa").classList.toggle("aberto"));
    document.querySelectorAll("[data-pgg]").forEach(e => e.onclick = () => e.closest(".pg-grupo").classList.toggle("aberto"));
    if (aba === "class") preencherHashes();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
