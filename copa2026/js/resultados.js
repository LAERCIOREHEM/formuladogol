/* =========================================================================
   resultados.js — Resultados das partidas (Copa 2026), direto da ESPN
   Navegador puxa o feed público da ESPN (sem chave, CORS liberado).
   Navegação por dia + atualização automática a cada 60s para os jogos ao vivo.
   NOVO: na FASE DE GRUPOS, cada jogo mostra os palpites de todos (recolhidos,
   abre no "ver palpites"). Verde = acertou o resultado · 🎯 = cravou o placar.
   ========================================================================= */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const START = "20260611", END = "20260719";
  const CFG = window.COPA_CFG || { url: "", key: "" };

  let JOGOS = [], PALP = [], dia, timer = null, TVS = {};
  let MM = {}; // melhores momentos: chave siglas -> {url,titulo}
  let ABA = "jogos", SEL = [], GRP_EVENTS = [];

  async function rpc(fn, body) {
    const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": CFG.key, "Authorization": "Bearer " + CFG.key },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error("RPC " + fn);
    return r.json();
  }

  const SEM = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

  function hojeYMD() {
    const d = new Date();
    return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }
  function clamp(ymd) { return ymd < START ? START : (ymd > END ? END : ymd); }
  function ymdToDate(ymd) { return new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12, 0, 0); }
  function dateToYMD(d) { return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0"); }
  function rotuloDia(ymd) { const d = ymdToDate(ymd); return `${SEM[d.getDay()]}, ${d.getDate()} de ${["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"][d.getMonth()]}`; }
  function horaBR(iso) { try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }); } catch (e) { return ""; } }

  // carrega seleções (p/ casar jogo da ESPN -> nosso id) e palpites (Supabase)
  const TV_CAT = { // ordem de exibição; cores aproximadas das marcas
    globo:   ["Globo", "#0a7cff", "#fff"],
    sbt:     ["SBT", "#00a651", "#fff"],
    sportv:  ["SporTV", "#ff7a00", "#fff"],
    getv:    ["ge tv", "#06aa48", "#fff"],
    gplay:   ["Globoplay", "#fb0234", "#fff"],
    nsports: ["N Sports", "#222a38", "#fff"],
    caze:    ["CazéTV", "#f7d116", "#3a2a00"]
  };
  function momentoDe(aAb, bAb) {
    const k = [aAb, bAb].sort().join("-");
    return MM[k] || null;
  }
  function blocoMomento(aAb, bAb) {
    const m = momentoDe(aAb, bAb);
    if (!m || !m.url) return "";
    return `<a class="assista" href="${m.url}" target="_blank" rel="noopener">▶️ Assista como foi (melhores momentos)</a>`;
  }

  function tvChips(aAb, bAb) {
    const k = [aAb, bAb].sort().join("-");
    const extras = (TVS.jogos && TVS.jogos[k]) || [];
    const lista = Object.keys(TV_CAT).filter(c => c === "caze" || extras.indexOf(c) !== -1);
    return `<div class="tvs">📺 ${lista.map(c => `<span class="tvchip" style="background:${TV_CAT[c][1]};color:${TV_CAT[c][2]}">${TV_CAT[c][0]}</span>`).join("")}</div>`;
  }

  async function carregarBase() {
    try { TVS = await fetch("dados/transmissoes.json").then(r => r.json()); } catch (e) { TVS = {}; }
    try { const mm = await fetch("dados/melhores-momentos.json?t=" + Date.now()).then(r => r.json()); MM = mm.jogos || {}; } catch (e) { MM = {}; }
    try {
      const sj = await fetch("dados/selecoes.json").then(r => r.json());
      SEL = sj.selecoes;
      JOGOS = COPA_ENGINE.gerarJogosGrupos(sj.selecoes);
    } catch (e) { JOGOS = []; }
    try {
      const rows = await rpc("copa_revelados", {});
      PALP = (rows || []).map(r => ({ nome: r.nome, pg: (r.payload || {}).placaresGrupos || {} }));
    } catch (e) { PALP = []; } // antes da trava vem vazio — normal
  }

  async function carregar() {
    if (ABA !== "jogos") return;
    $("#dia-rotulo").textContent = rotuloDia(dia);
    $("#prev").disabled = dia <= START;
    $("#next").disabled = dia >= END;
    let data;
    try {
      const r = await fetch(`${API}?dates=${dia}&limit=60`);
      data = await r.json();
    } catch (e) {
      $("#lista").innerHTML = '<p class="vazio">Não consegui buscar os jogos agora. Verifique a conexão e tente recarregar.</p>';
      return;
    }
    const evs = (data.events || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!evs.length) { $("#lista").innerHTML = abasHTML() + '<p class="vazio">Nenhum jogo neste dia.</p>'; document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba); return; }
    $("#lista").innerHTML = abasHTML() + evs.map(card).join("");
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
    document.querySelectorAll(".vermais[data-sp]").forEach(b => b.onclick = () => {
      const d = document.getElementById("sp-" + b.dataset.sp), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "Ocultar palpites ▴" : "Ver palpites ▾";
    });
  }

  function abasHTML() {
    return `<div class="vistog">
      <button class="vbtn ${ABA === "jogos" ? "on" : ""}" data-v="jogos">📅 Jogos</button>
      <button class="vbtn ${ABA === "grupos" ? "on" : ""}" data-v="grupos">📊 Grupos</button>
    </div>`;
  }
  async function buscarGruposEvents() {
    if (GRP_EVENTS.length) return GRP_EVENTS;
    try {
      const d = await fetch(`${API}?dates=20260611-20260627&limit=120`).then(r => r.json());
      GRP_EVENTS = (d.events || []).filter(e => ((e.season && e.season.slug) || "") === "group-stage");
    } catch (e) { GRP_EVENTS = []; }
    return GRP_EVENTS;
  }
  function nomeDe(id) { const t = SEL.find(x => x.id === id); return t ? t.nome : id; }
  function isoDe(id) { const t = SEL.find(x => x.id === id); return t ? t.iso2 : ""; }
  function flagId(id) { const c = isoDe(id); return c ? `<img src="https://flagcdn.com/w40/${c}.png" alt="" onerror="this.style.visibility='hidden'">` : ""; }
  function tabelaGrupos(events) {
    const tab = {};
    SEL.forEach(t => { (tab[t.grupo] = tab[t.grupo] || {})[t.id] = { id: t.id, j: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0, pts: 0 }; });
    events.forEach(ev => {
      const c = ev.competitions[0]; if (!c || c.status.type.state !== "post") return;
      const cs = c.competitors || [];
      const h = cs.find(x => x.homeAway === "home") || cs[0], a = cs.find(x => x.homeAway === "away") || cs[1];
      const hId = (h.team || {}).abbreviation, aId = (a.team || {}).abbreviation;
      const hs = parseInt(h.score || "0", 10), as = parseInt(a.score || "0", 10);
      let g = null; for (const G in tab) { if (tab[G][hId] && tab[G][aId]) { g = G; break; } }
      if (!g) return;
      const H = tab[g][hId], A = tab[g][aId];
      H.j++; A.j++; H.gp += hs; H.gc += as; A.gp += as; A.gc += hs;
      if (hs > as) { H.v++; A.d++; H.pts += 3; }
      else if (as > hs) { A.v++; H.d++; A.pts += 3; }
      else { H.e++; A.e++; H.pts++; A.pts++; }
    });
    return tab;
  }
  function renderGrupos() {
    $("#lista").innerHTML = abasHTML() + '<p class="vazio">Carregando tabela…</p>';
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
    buscarGruposEvents().then(events => {
      if (ABA !== "grupos") return;
      const tab = tabelaGrupos(events);
      const ord = (a, b) => b.pts - a.pts || (b.gp - b.gc) - (a.gp - a.gc) || b.gp - a.gp || nomeDe(a.id).localeCompare(nomeDe(b.id));
      const blocos = Object.keys(tab).sort().map(G => {
        const linhas = Object.values(tab[G]).sort(ord).map((t, i) => {
          const sg = t.gp - t.gc, cls = i < 2 ? "classif" : "";
          return `<tr class="${cls}"><td class="cpos">${i + 1}</td><td class="ctime">${flagId(t.id)} <span>${nomeDe(t.id)}</span></td><td><b>${t.pts}</b></td><td>${t.j}</td><td>${t.v}</td><td>${t.e}</td><td>${t.d}</td><td class="men">${t.gp}</td><td class="men">${t.gc}</td><td>${sg > 0 ? "+" + sg : sg}</td></tr>`;
        }).join("");
        return `<div class="grpcard"><div class="grpcab">Grupo ${G}</div><table class="tabgrp"><thead><tr><th></th><th class="ctime">Seleção</th><th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th class="men">GP</th><th class="men">GC</th><th>SG</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
      }).join("");
      $("#lista").innerHTML = abasHTML() + '<p class="leg-grp">As <b>2 primeiras</b> de cada grupo avançam, mais os 8 melhores terceiros. Tabela calculada dos resultados oficiais.</p>' + blocos;
      document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
    });
  }
  function trocarAba(e) {
    const v = e.currentTarget.dataset.v; if (v === ABA) return;
    ABA = v;
    if (ABA === "grupos") { $("#prev").parentElement.style.display = "none"; renderGrupos(); }
    else { $("#prev").parentElement.style.display = ""; carregar(); }
  }

  function card(ev) {
    const comp = ev.competitions[0];
    const st = comp.status.type;
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === "home") || cs[0] || {};
    const away = cs.find(c => c.homeAway === "away") || cs[1] || {};
    const slug = (ev.season && ev.season.slug) || "";
    const fase = faseLabel(slug);
    const venue = comp.venue ? (comp.venue.fullName + (comp.venue.address && comp.venue.address.city ? " · " + comp.venue.address.city : "")) : "";

    let meio, badge;
    if (st.state === "pre") {
      meio = `<div class="hora">${horaBR(ev.date)}</div>`;
      badge = `<span class="badge ag">Agendado</span>`;
    } else if (st.state === "in") {
      meio = `<div class="placar"><span class="g">${home.score ?? ""}</span><span class="x">×</span><span class="g">${away.score ?? ""}</span></div>`;
      badge = `<span class="badge live"><span class="pulse"></span> ${st.shortDetail || "Ao vivo"}</span>`;
    } else {
      meio = `<div class="placar"><span class="g">${home.score ?? ""}</span><span class="x">×</span><span class="g">${away.score ?? ""}</span></div>`;
      badge = `<span class="badge fim">Encerrado${st.shortDetail && /pen/i.test(st.shortDetail) ? " (pên.)" : ""}</span>`;
    }
    const vencH = home.winner ? "venc" : "", vencA = away.winner ? "venc" : "";
    const palpites = slug === "group-stage" ? palpiteBloco(ev, home, away, st) : "";
    return `<div class="jogo">
      <div class="topo"><span class="fase">${fase}</span>${badge}</div>
      <div class="linha">
        <div class="lado ${vencH}">${escudo(home)}<span class="t">${teamNome(home)}</span></div>
        ${meio}
        <div class="lado f ${vencA}"><span class="t">${teamNome(away)}</span>${escudo(away)}</div>
      </div>
      ${venue ? `<div class="venue">${venue}</div>` : ""}
      ${(st.state === "post" && momentoDe((home.team || {}).abbreviation, (away.team || {}).abbreviation))
        ? blocoMomento((home.team || {}).abbreviation, (away.team || {}).abbreviation)
        : tvChips((home.team || {}).abbreviation, (away.team || {}).abbreviation)}
      ${palpites}
    </div>`;
  }

  // palpites de todos para UM jogo de grupo (recolhido)
  function palpiteBloco(ev, home, away, st) {
    if (!PALP.length || !JOGOS.length) return "";
    const hId = home.team && home.team.abbreviation, aId = away.team && away.team.abbreviation;
    const j = JOGOS.find(x => (x.a === hId && x.b === aId) || (x.a === aId && x.b === hId));
    if (!j) return "";
    const jogado = st.state !== "pre";
    let ra, rb;
    if (jogado) {
      const hs = parseInt(home.score || "0", 10), as = parseInt(away.score || "0", 10);
      ra = j.a === hId ? hs : as; rb = j.a === hId ? as : hs;
    }
    let ac = 0;
    const rows = PALP.map(p => {
      const g = p.pg[j.jogo_id];
      if (!g) return `<div class="prow"><span>${p.nome}</span><span class="pal">—</span></div>`;
      let tag = "";
      if (jogado) {
        const exato = g.ga === ra && g.gb === rb;
        const certo = Math.sign(g.ga - g.gb) === Math.sign(ra - rb);
        if (certo) ac++;
        const rotuloEx = st.state === "post" ? "CRAVOU" : "CRAVANDO";
        tag = exato ? `<span class="cravou">${rotuloEx} 🎯</span>` : `<span class="bola ${certo ? "v" : "x"}"></span>`;
      } else { tag = '<span class="aguard">aguardando</span>'; }
      return `<div class="prow"><span>${p.nome}</span><span class="pal">${g.ga} - ${g.gb}${tag}</span></div>`;
    }).join("");
    const cnt = jogado ? `${ac} de ${PALP.length} acertaram o resultado` : "Palpites de todos (jogo ainda não começou)";
    return `<button class="vermais" data-sp="${ev.id}">Ver palpites (${PALP.length}) ▾</button>
      <div class="subpal" id="sp-${ev.id}" style="display:none"><div class="subcnt">${cnt}</div>${rows}</div>`;
  }

  function teamNome(c) { return (c.team && (c.team.shortDisplayName || c.team.displayName || c.team.abbreviation)) || "—"; }
  function escudo(c) {
    const logo = c.team && c.team.logo;
    return logo ? `<img src="${logo}" alt="" title="${(c.team.displayName) || ""}" onerror="this.style.visibility='hidden'">` : "";
  }
  function faseLabel(slug) {
    const map = { "group-stage": "Fase de grupos", "round-of-32": "Segunda fase", "round-of-16": "Oitavas", "quarterfinals": "Quartas", "semifinals": "Semifinal", "third-place": "Disputa de 3º", "final": "Final" };
    return map[slug] || "Copa do Mundo";
  }

  document.addEventListener("DOMContentLoaded", async () => {
    dia = clamp(hojeYMD());
    await carregarBase();
    $("#prev").onclick = () => { dia = clamp(dateToYMD(new Date(ymdToDate(dia).getTime() - 864e5))); carregar(); };
    $("#next").onclick = () => { dia = clamp(dateToYMD(new Date(ymdToDate(dia).getTime() + 864e5))); carregar(); };
    carregar();
    timer = setInterval(() => { if (ABA === "jogos") carregar(); }, 60000);
  });
})();
