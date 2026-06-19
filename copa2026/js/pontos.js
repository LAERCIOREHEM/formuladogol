/* =========================================================================
   pontos.js — Classificação do bolão por PONTOS (Copa 2026)
   Cruza o palpite de cada um (derivado pela engine) com o resultado OFICIAL
   (montado a partir do feed da ESPN) usando COPA_PONTUACAO.calcular.
   Pontuação só começa na 2ª fase (quando as 32 são definidas).
   ========================================================================= */
(function () {
  "use strict";
  const CFG = window.COPA_CFG || { url: "", key: "" };
  const $ = s => document.querySelector(s);
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const ESPN_OVR = {};
  // janelas de data por fase (calendário oficial da ESPN)
  const JANELAS = ["20260611-20260627", "20260628-20260703", "20260704-20260707", "20260709-20260711", "20260714-20260715", "20260718-20260718", "20260719-20260719"];
  let DADOS = {}, JOGOS = [], GRUPOS = [], PART = [], timer = null;
  let FILTRO = "", ORDEM = "atuais", ULTIMO_O = null;
  let ABA = (new URLSearchParams(location.search).get("aba") === "placares") ? "placares" : "bolao";
  let ORDEM_P = "pts";
  // Até esta data/hora (Brasília), o Ranking mostra a PRÉVIA SIMULADA (foto de hoje).
  // Depois, vira o Ranking normal (pontuação real da 2ª fase).
  const VIRADA_SIMULADO = new Date("2026-06-28T02:00:00-03:00");
  function modoSimulado() { return Date.now() < VIRADA_SIMULADO.getTime(); }

  async function rpc(fn, body) {
    const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": CFG.key, "Authorization": "Bearer " + CFG.key },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error("RPC " + fn);
    return r.json();
  }
  const nome = id => (DADOS.nomeDe && DADOS.nomeDe[id]) || id || "—";
  const iso = id => (DADOS.isoDe && DADOS.isoDe[id]) || "";
  const flag = id => { const c = iso(id); return c ? `<img src="https://flagcdn.com/w40/${c}.png" title="${nome(id)}" alt="" onerror="this.style.visibility='hidden'">` : ""; };
  const norm = ab => ESPN_OVR[ab] || ab;
  const inter = (a, b) => { const s = new Set(b || []); return (a || []).filter(x => s.has(x)); };
  const fateDe = (team, o) => {
    if (!o.classificados32 || !o.classificados32.length) return "pend";
    if (o.classificados32.indexOf(team) === -1) return "wrong";
    if ((o.eliminados || []).indexOf(team) !== -1) return "out";
    return "alive";
  };

  async function init() {
    try {
      const [s, e, t] = await Promise.all([
        fetch("dados/selecoes.json").then(r => r.json()),
        fetch("dados/estrutura_mata_mata.json").then(r => r.json()),
        fetch("dados/terceiros_map.json").then(r => r.json())
      ]);
      DADOS.selecoes = s.selecoes; DADOS.estrutura = e; DADOS.terceirosMap = t;
      DADOS.nomeDe = {}; DADOS.isoDe = {};
      s.selecoes.forEach(x => { DADOS.nomeDe[x.id] = x.nome; DADOS.isoDe[x.id] = x.iso2; });
    } catch (err) { $("#app").innerHTML = '<p class="vazio">Erro ao carregar os dados da Copa.</p>'; return; }
    JOGOS = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes);
    GRUPOS = [...new Set(JOGOS.map(j => j.grupo))].sort();

    try {
      const rows = await rpc("copa_revelados", {});
      PART = (rows || []).map(r => {
        const pl = r.payload || {};
        const g = Object.keys(pl.placaresGrupos || {}).map(id => ({ jogo_id: id, ga: pl.placaresGrupos[id].ga, gb: pl.placaresGrupos[id].gb }));
        let d = null;
        try { d = COPA_ENGINE.derivar(DADOS.selecoes, g, pl.placaresMata || {}, DADOS.estrutura, DADOS.terceirosMap); } catch (e) {}
        return { nome: r.nome, d, pg: pl.placaresGrupos || {} };
      }).filter(p => p.d);
    } catch (e) { PART = []; }

    if (!PART.length) { $("#app").innerHTML = '<div class="bloq"><div class="cad">🔒</div><h2>Aguardando a trava</h2><p>A classificação aparece depois que as apostas travarem (10/06 23h59) e os palpites forem liberados.</p></div>'; return; }

    atualizar(); timer = setInterval(atualizar, 120000); // recalcula a cada 2 min
  }

  // ---- monta o resultado OFICIAL a partir da ESPN ----
  function phaseOf(ev) { return (ev.season && ev.season.slug) || ""; }
  function teamsOf(ev) { return (ev.competitions[0].competitors || []).map(c => norm((c.team || {}).abbreviation)).filter(t => DADOS.nomeDe && DADOS.nomeDe[t]); }
  function isPost(ev) { return ev.competitions[0].status.type.state === "post"; }
  function winLoseOf(ev) {
    const cs = ev.competitions[0].competitors || [];
    const w = cs.find(c => c.winner), l = cs.find(c => !c.winner);
    const W = w ? norm((w.team || {}).abbreviation) : null, L = l ? norm((l.team || {}).abbreviation) : null;
    return { w: (W && DADOS.nomeDe[W]) ? W : null, l: (L && DADOS.nomeDe[L]) ? L : null };
  }

  function buildOficial(events) {
    const o = { decididos: {} };
    const slugTeams = slug => [...new Set(events.filter(e => phaseOf(e) === slug).flatMap(teamsOf))];

    // --- mata-mata: quem ALCANÇOU cada fase = quem está nos confrontos daquela fase ---
    const r32 = slugTeams("round-of-32");
    o.avancam_oitavas = slugTeams("round-of-16");
    o.avancam_quartas = slugTeams("quarterfinals");
    o.semifinalistas = slugTeams("semifinals");
    o.finalistas = slugTeams("final");

    // --- grupos: posições + melhores terceiros, derivados com a própria engine ---
    const realG = [];
    events.filter(e => phaseOf(e) === "group-stage" && isPost(e)).forEach(ev => {
      const cs = ev.competitions[0].competitors;
      const home = cs.find(c => c.homeAway === "home") || cs[0], away = cs.find(c => c.homeAway === "away") || cs[1];
      const hId = norm(home.team.abbreviation), aId = norm(away.team.abbreviation);
      const j = JOGOS.find(x => (x.a === hId && x.b === aId) || (x.a === aId && x.b === hId));
      if (!j) return;
      const hs = parseInt(home.score || "0", 10), as = parseInt(away.score || "0", 10);
      const ga = j.a === hId ? hs : as, gb = j.a === hId ? as : hs;
      const inv = (j.a !== hId); // ESPN mostra invertido vs engine?
      realG.push({ jogo_id: j.jogo_id, ga, gb, inv: inv, homeId: hId, awayId: aId });
    });
    const completos = {}; GRUPOS.forEach(g => completos[g] = realG.filter(p => p.jogo_id.startsWith("G_" + g + "_")).length === 6);
    const todosGrupos = GRUPOS.every(g => completos[g]);

    if (realG.length) {
      let dg = null; try { dg = COPA_ENGINE.derivar(DADOS.selecoes, realG, {}, DADOS.estrutura, DADOS.terceirosMap); } catch (e) {}
      if (dg) {
        o.classificacao = {};
        GRUPOS.forEach(g => { if (completos[g]) o.classificacao[g] = dg.classificacao[g]; });
        if (todosGrupos) { o.classificados32 = dg.classificados32; o.melhores_terceiros = dg.melhores_terceiros; }
        else if (modoSimulado()) {
          // PRÉVIA: usa a foto parcial de hoje para simular os classificados
          o.classificados32 = dg.classificados32;
          o.melhores_terceiros = dg.melhores_terceiros;
          o._simulado = true;
        }
      }
    }
    if (r32.length === 32) o.classificados32 = r32; // so vale com os 32 REAIS definidos (ignora placeholders 'a definir' da ESPN)

    // --- 1º a 4º ---
    const fin = events.find(e => phaseOf(e) === "final" && isPost(e));
    if (fin) { const wl = winLoseOf(fin); o.campeao = wl.w; o.vice = wl.l; o.decididos.campeao = true; o.decididos.vice = true; }
    const ter = events.find(e => (phaseOf(e) === "third-place") && isPost(e));
    if (ter) { const wl = winLoseOf(ter); o.terceiro = wl.w; o.quarto = wl.l; o.decididos.terceiro = true; o.decididos.quarto = true; }

    // --- eliminados (para os "perdidos") ---
    const elim = new Set();
    events.forEach(ev => { if (phaseOf(ev) !== "group-stage" && isPost(ev)) { const wl = winLoseOf(ev); if (wl.l) elim.add(wl.l); } });
    if (todosGrupos && o.classificados32) {
      const passou = new Set(o.classificados32);
      DADOS.selecoes.forEach(s => { if (!passou.has(s.id)) elim.add(s.id); });
    } else if (o._simulado && o.classificados32) {
      // SIMULADO: quem ficou fora dos 32 de hoje E cujo grupo JÁ encerrou (6 jogos) está
      // realmente eliminado. Quem está fora mas o grupo ainda não acabou continua "possível".
      const passou = new Set(o.classificados32);
      DADOS.selecoes.forEach(s => {
        if (!passou.has(s.id) && completos[s.grupo]) elim.add(s.id);
      });
    }
    o.eliminados = [...elim];

    o._realGrupos = {}; realG.forEach(x => o._realGrupos[x.jogo_id] = { ga: x.ga, gb: x.gb, inv: x.inv, homeId: x.homeId, awayId: x.awayId });
    o._meta = { todosGrupos, segundaFase: !!(o.classificados32 && o.classificados32.length), nGruposCompletos: GRUPOS.filter(g => completos[g]).length, simulado: !!o._simulado };
    return o;
  }

  async function atualizar() {
    let events = [];
    try {
      const lotes = await Promise.all(JANELAS.map(d => fetch(`${API}?dates=${d}&limit=120`).then(r => r.json()).catch(() => ({ events: [] }))));
      const vistos = new Set();
      lotes.forEach(l => (l.events || []).forEach(ev => { if (!vistos.has(ev.id)) { vistos.add(ev.id); events.push(ev); } }));
    } catch (e) {}
    const o = buildOficial(events);
    ULTIMO_O = o;
    render(o);
  }

  function cravadosDe(pg, real) { let n = 0; for (const id in real) { const a = pg[id]; if (a && a.ga === real[id].ga && a.gb === real[id].gb) n++; } return n; }

  // ---- render ----
  const FASES = [
    { k: "classificados32", n: 32, lab: "2ª fase" },
    { k: "avancam_oitavas", n: 16, lab: "Oitavas" },
    { k: "avancam_quartas", n: 8, lab: "Quartas" },
    { k: "semifinalistas", n: 4, lab: "Semifinal" }
  ];
  function detalheFinal(p, o) {
    const labs = [["campeao", "Campeão", 40], ["vice", "Vice", 25], ["terceiro", "3º lugar", 15], ["quarto", "4º lugar", 10]];
    return labs.map(([k, lab]) => {
      const pick = p[k]; if (!pick) return "";
      let st = "", cls = "pend";
      if (o.decididos && o.decididos[k]) { if (o[k] === pick) { st = "✓ acertou"; cls = "ok"; } else { st = "✗ errou"; cls = "err"; } }
      else st = "aguardando";
      return `<div class="fp"><span>${lab}: ${flag(pick)} ${nome(pick)}</span><span class="${cls}">${st}</span></div>`;
    }).join("");
  }

  function toggleHTML() {
    return `<div class="vistog">
      <button class="vbtn ${ABA === "bolao" ? "on" : ""}" data-v="bolao">🏆 ${modoSimulado() ? "Ranking Simulado" : "Ranking"}</button>
      <button class="vbtn ${ABA === "placares" ? "on" : ""}" data-v="placares">🎯 Reis do Cravo</button>
    </div>`;
  }
  function wireToggle() {
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = () => {
      if (ABA === b.dataset.v) return;
      ABA = b.dataset.v; FILTRO = "";
      if (ULTIMO_O) render(ULTIMO_O);
    });
  }
  function render(o) { if (ABA === "placares") renderPlacares(o); else renderBolao(o); }

  function renderBolao(o) {
    const KEY = { atuais: x => x.r.atuais, possiveis: x => x.r.possiveis, perdidos: x => x.r.perdidos };
    const kf = KEY[ORDEM] || KEY.atuais;
    const lin = PART.map(p => {
      const r = COPA_PONTUACAO.calcular(p.d, o);
      const cr = cravadosDe(p.pg, o._realGrupos || {});
      return { nome: p.nome, d: p.d, r, cr };
    }).sort((a, b) => kf(b) - kf(a) || b.cr - a.cr || b.r.teto - a.r.teto || a.nome.localeCompare(b.nome));
    lin.forEach((x, i) => x.posReal = i + 1);
    const visiveis = FILTRO ? lin.filter(x => x.nome === FILTRO) : lin;

    const opts = PART.map(p => p.nome).sort((a, b) => a.localeCompare(b))
      .map(n => `<option value="${n}" ${n === FILTRO ? "selected" : ""}>${n}</option>`).join("");
    const ROT = { atuais: "conquistados", possiveis: "possíveis", perdidos: "perdidos" };
    const pills = Object.keys(ROT).map(k => `<button class="ordbtn ${ORDEM === k ? "on" : ""}" data-ord="${k}">${ROT[k]}</button>`).join("");
    const controles = `<div class="ctrlbar">
      <select id="filtro-part"><option value="">👥 Todos os participantes</option>${opts}</select>
      <div class="ordwrap"><span class="ordlab">ordenar:</span>${pills}</div>
    </div>`;

    let banner = "";
    if (o._meta.simulado) {
      banner = `<div class="aviso">⚠️ <b>Ranking SIMULADO</b>: como ficaria se a fase de grupos acabasse <b>agora</b>. Muda a cada jogo — <b>nada está definido!</b> ${o._meta.nGruposCompletos ? `(${o._meta.nGruposCompletos}/12 grupos encerrados)` : ""}</div>`;
    } else if (!o._meta.segundaFase) {
      banner = `<div class="aviso">A pontuação <b>começa na 2ª fase</b> (quando as 32 forem definidas, no fim dos grupos). Por enquanto mostramos o <b>teto</b> de cada palpite — o máximo que dá pra fazer. ${o._meta.nGruposCompletos ? `(${o._meta.nGruposCompletos}/12 grupos encerrados)` : ""}</div>`;
    }

    const tbnote = '<p class="tbnote">Desempate: mais placares <b>cravados</b> na fase de grupos 🎯</p>';
    $("#app").innerHTML = toggleHTML() + controles + banner + tbnote + visiveis.map((x, i) => {
      const pos = x.posReal, r = x.r;
      const tot = r.atuais + r.perdidos + r.possiveis || 1;
      const medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
      const cls = pos <= 3 ? " p" + pos : "";
      const left = medal ? `<span class="medal">${medal}</span>` : `<span class="pos">${pos}</span>`;
      const fasesHTML = FASES.map(f => {
        const real = o[f.k] || [];
        if (!real.length) return `<span class="ph">${f.lab}: <b>—</b></span>`;
        const ac = inter(x.d[f.k], real).length;
        return `<span class="ph">${f.lab}: <b>${ac}/${f.n}</b></span>`;
      }).join("");
      const decidiu = o.classificados32 && o.classificados32.length;
      const picks32 = x.d.classificados32 || [];
      const vivos = picks32.filter(t => fateDe(t, o) === "alive").length;
      const funil = picks32.map(t => `<span class="${fateDe(t, o)}">${flag(t)}</span>`).join("");
      const f32lab = decidiu ? `As 32 de ${x.nome} — <b>${vivos} ainda vivas</b>:` : `As 32 que ${x.nome} classificou no palpite:`;
      const f32leg = decidiu ? '<div class="f32leg"><span><i class="lg-a"></i>na disputa</span><span><i class="lg-o"></i>caiu</span><span><i class="lg-w"></i>não classificou</span></div>' : "";
      return `<div class="card${cls}">
        <div class="head">${left}<span class="nm">${x.nome}</span><span class="conq">${r.atuais}<small>conquistados</small></span></div>
        <div class="barra"><span class="b v" style="width:${r.atuais / tot * 100}%"></span><span class="b r" style="width:${r.perdidos / tot * 100}%"></span><span class="b g" style="width:${r.possiveis / tot * 100}%"></span></div>
        <div class="nums"><span class="cn">conquistados <b>${r.atuais}</b></span><span class="pn">perdidos <b>${r.perdidos}</b></span><span class="sn">possíveis <b>${r.possiveis}</b></span><span class="tn">teto <b>${r.teto}</b></span></div>
        <div class="fases">${fasesHTML}<span class="ph">🎯 <b>${x.cr}</b> cravados</span></div>
        <div class="podiodet">${detalheFinal(x.d, o)}</div>
        <div class="f32lab">${f32lab}</div>${f32leg}
        <div class="f32">${funil}</div>
      </div>`;
    }).join("");
    const fp = $("#filtro-part");
    if (fp) fp.onchange = e => { FILTRO = e.target.value; if (ULTIMO_O) render(ULTIMO_O); };
    document.querySelectorAll(".ordbtn[data-ord]").forEach(b => b.onclick = () => { ORDEM = b.dataset.ord; if (ULTIMO_O) render(ULTIMO_O); });
    wireToggle();
  }

  // ===== 🎯 PLACARES (Reis do Cravo) — fase de grupos, 5/3/2/0 =====
  function tierDe(g, R) { // retorna [pontos, simbolo]
    if (!g || g.ga == null || g.gb == null) return [0, "—"];
    const sg = Math.sign(g.ga - g.gb), sR = Math.sign(R.ga - R.gb);
    if (g.ga === R.ga && g.gb === R.gb) return [5, "🎯"];
    if (sg === sR && sR !== 0 && (g.ga - g.gb) === (R.ga - R.gb)) return [3, "📐"];
    if (sg === sR) return [2, "✅"];
    return [0, "❌"];
  }
  function calcPlacares(o) {
    const real = o._realGrupos || {};
    const ids = Object.keys(real);
    const lin = PART.map(p => {
      let pts = 0, cr = 0, sal = 0, res = 0;
      ids.forEach(id => {
        const [v] = tierDe(p.pg[id], real[id]);
        pts += v;
        if (v === 5) cr++; else if (v === 3) sal++; else if (v === 2) res++;
      });
      return { nome: p.nome, pts, cr, sal, res };
    });
    return { lin, n: ids.length };
  }
  const SELO = { 5: "CRAVOU", 3: "acertou saldo", 2: "acertou resultado", 0: "errou" };
  function extrato(p, o) {
    const real = o._realGrupos || {};
    const ids = Object.keys(real).sort();
    if (!ids.length) return '<p class="pend" style="padding:4px 2px">Nenhum jogo encerrado ainda.</p>';
    return ids.map(id => {
      const j = JOGOS.find(x => x.jogo_id === id); if (!j) return "";
      const R = real[id], g = p.pg[id];
      const [pts, tag] = tierDe(g, R); // pontuação SEMPRE na ordem da engine (não muda)
      // exibição na ordem da ESPN (mandante na frente):
      const inv = R.inv;
      const ladoA = inv ? j.b : j.a, ladoB = inv ? j.a : j.b;
      const rGa = inv ? R.gb : R.ga, rGb = inv ? R.ga : R.gb;
      const pGa = (g && g.ga != null) ? (inv ? g.gb : g.ga) : null;
      const pGb = (g && g.ga != null) ? (inv ? g.ga : g.gb) : null;
      const pal = (pGa != null) ? `${pGa}×${pGb}` : "—";
      const cls = pts === 5 ? "s5" : pts === 3 ? "s3" : pts === 2 ? "s2" : "s0";
      return `<div class="extrow">
        <span class="extj"><i>${j.grupo}</i> ${flag(ladoA)} ${ladoA} <b>${rGa}×${rGb}</b> ${ladoB} ${flag(ladoB)}</span>
        <span class="extp">palpite ${pal}</span>
        <span class="extpts ${cls}">${tag} ${SELO[pts]} · ${pts}pt</span></div>`;
    }).join("");
  }
  const cssId = nm => nm.replace(/[^a-zA-Z0-9]/g, "_");

  function renderPlacares(o) {
    const { lin, n } = calcPlacares(o);
    const cmpN = (a, b) => a.nome.localeCompare(b.nome);
    lin.sort(ORDEM_P === "cr"
      ? (a, b) => b.cr - a.cr || b.pts - a.pts || b.sal - a.sal || cmpN(a, b)
      : (a, b) => b.pts - a.pts || b.cr - a.cr || b.sal - a.sal || cmpN(a, b));
    lin.forEach((x, i) => x.posReal = i + 1);
    const vis = FILTRO ? lin.filter(x => x.nome === FILTRO) : lin;

    const opts = PART.map(p => p.nome).sort((a, b) => a.localeCompare(b))
      .map(x => `<option value="${x}" ${x === FILTRO ? "selected" : ""}>${x}</option>`).join("");
    const pills = [["pts", "pontos"], ["cr", "cravadas"]]
      .map(([k, lab]) => `<button class="ordbtn ${ORDEM_P === k ? "on" : ""}" data-ordp="${k}">${lab}</button>`).join("");
    const controles = `<div class="ctrlbar">
      <select id="filtro-part"><option value="">👥 Todos os participantes</option>${opts}</select>
      <div class="ordwrap"><span class="ordlab">ordenar:</span>${pills}</div></div>`;
    const banner = `<div class="aviso">🍷 <b>Reis do Cravo</b> — desafio apartado da fase de grupos:
      placar cravado <b>5</b> · vencedor + saldo de gols <b>3</b> · só o resultado <b>2</b> · errou <b>0</b>
      (empate vale 5 ou 2). Prêmio do organizador ao 1º no fim dos grupos: <b>duas garrafas de vinho</b> 🍷🍷.
      Pontua só jogo <b>encerrado</b> — <b>${n} de 72</b> computados.
      Regra completa em <a href="regras.html" style="color:var(--gold)">Regras</a>.</div>`;
    const cards = vis.map(x => {
      const pos = x.posReal, medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
      const cls = pos <= 3 ? " p" + pos : "";
      const left = medal ? `<span class="medal">${medal}</span>` : `<span class="pos">${pos}</span>`;
      const p = PART.find(pp => pp.nome === x.nome);
      const aberto = FILTRO === x.nome; // ao filtrar 1 pessoa, já abre
      return `<div class="card${cls}">
        <div class="head">${left}<span class="nm">${x.nome}</span><span class="conq">${x.pts}<small>pontos</small></span></div>
        <div class="fases"><span class="ph">🎯 cravadas <b>${x.cr}</b></span><span class="ph">📐 no saldo <b>${x.sal}</b></span><span class="ph">✅ resultados <b>${x.res}</b></span></div>
        <button class="vermais" data-jg="${x.nome}">${aberto ? "Ocultar jogos ▴" : "Ver jogos ▾"}</button>
        <div class="extbox" id="jg-${cssId(x.nome)}" style="display:${aberto ? "block" : "none"}">${extrato(p, o)}</div>
      </div>`;
    }).join("");
    $("#app").innerHTML = toggleHTML() + controles + banner + cards;
    wireToggle();
    const fp = $("#filtro-part");
    if (fp) fp.onchange = e => { FILTRO = e.target.value; if (ULTIMO_O) render(ULTIMO_O); };
    document.querySelectorAll(".ordbtn[data-ordp]").forEach(b => b.onclick = () => { ORDEM_P = b.dataset.ordp; if (ULTIMO_O) render(ULTIMO_O); });
    document.querySelectorAll(".vermais[data-jg]").forEach(b => b.onclick = () => {
      const d = document.getElementById("jg-" + cssId(b.dataset.jg)), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "Ocultar jogos ▴" : "Ver jogos ▾";
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
