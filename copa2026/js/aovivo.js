/* =========================================================================
   aovivo.js — Tela "AO VIVO" (Copa 2026)
   Lê o feed da ESPN (navegador direto, 30s). Quando há jogo ao vivo (ou nos
   10 min de pré-jogo), mostra a tela cheia; quando acaba (status oficial),
   sai sozinho. Na FASE DE GRUPOS, cruza com os palpites e mostra as bolinhas
   (acertando / cravou). No mata-mata, só o placar (palpite por jogo não se
   aplica — cada um tem chave diferente).
   ========================================================================= */
(function () {
  "use strict";
  // ===== DE-PARA embutido (à prova de timing): sigla/nome EN -> PT + bandeira =====
  var DEPARA = {"MEX": {"n": "México", "i": "mx"}, "RSA": {"n": "África do Sul", "i": "za"}, "KOR": {"n": "Coreia do Sul", "i": "kr"}, "CZE": {"n": "Rep. Tcheca", "i": "cz"}, "CAN": {"n": "Canadá", "i": "ca"}, "BIH": {"n": "Bósnia", "i": "ba"}, "QAT": {"n": "Catar", "i": "qa"}, "SUI": {"n": "Suíça", "i": "ch"}, "BRA": {"n": "Brasil", "i": "br"}, "MAR": {"n": "Marrocos", "i": "ma"}, "HAI": {"n": "Haiti", "i": "ht"}, "SCO": {"n": "Escócia", "i": "gb-sct"}, "USA": {"n": "EUA", "i": "us"}, "PAR": {"n": "Paraguai", "i": "py"}, "AUS": {"n": "Austrália", "i": "au"}, "TUR": {"n": "Turquia", "i": "tr"}, "GER": {"n": "Alemanha", "i": "de"}, "CUW": {"n": "Curaçao", "i": "cw"}, "CIV": {"n": "Costa do Marfim", "i": "ci"}, "ECU": {"n": "Equador", "i": "ec"}, "NED": {"n": "Holanda", "i": "nl"}, "JPN": {"n": "Japão", "i": "jp"}, "SWE": {"n": "Suécia", "i": "se"}, "TUN": {"n": "Tunísia", "i": "tn"}, "BEL": {"n": "Bélgica", "i": "be"}, "EGY": {"n": "Egito", "i": "eg"}, "IRN": {"n": "Irã", "i": "ir"}, "NZL": {"n": "Nova Zelândia", "i": "nz"}, "ESP": {"n": "Espanha", "i": "es"}, "CPV": {"n": "Cabo Verde", "i": "cv"}, "KSA": {"n": "Arábia Saudita", "i": "sa"}, "URU": {"n": "Uruguai", "i": "uy"}, "FRA": {"n": "França", "i": "fr"}, "SEN": {"n": "Senegal", "i": "sn"}, "IRQ": {"n": "Iraque", "i": "iq"}, "NOR": {"n": "Noruega", "i": "no"}, "ARG": {"n": "Argentina", "i": "ar"}, "ALG": {"n": "Argélia", "i": "dz"}, "AUT": {"n": "Áustria", "i": "at"}, "JOR": {"n": "Jordânia", "i": "jo"}, "POR": {"n": "Portugal", "i": "pt"}, "COD": {"n": "RD Congo", "i": "cd"}, "UZB": {"n": "Uzbequistão", "i": "uz"}, "COL": {"n": "Colômbia", "i": "co"}, "ENG": {"n": "Inglaterra", "i": "gb-eng"}, "CRO": {"n": "Croácia", "i": "hr"}, "GHA": {"n": "Gana", "i": "gh"}, "PAN": {"n": "Panamá", "i": "pa"}};
  var DEPARA_EN = {"mexico": "MEX", "south africa": "RSA", "south korea": "KOR", "korea republic": "KOR", "czechia": "CZE", "czech republic": "CZE", "canada": "CAN", "bosnia and herzegovina": "BIH", "bosnia": "BIH", "qatar": "QAT", "switzerland": "SUI", "brazil": "BRA", "morocco": "MAR", "haiti": "HAI", "scotland": "SCO", "united states": "USA", "paraguay": "PAR", "australia": "AUS", "turkey": "TUR", "turkiye": "TUR", "germany": "GER", "curacao": "CUW", "ivory coast": "CIV", "cote d ivoire": "CIV", "ecuador": "ECU", "netherlands": "NED", "japan": "JPN", "sweden": "SWE", "tunisia": "TUN", "belgium": "BEL", "egypt": "EGY", "iran": "IRN", "new zealand": "NZL", "spain": "ESP", "cape verde": "CPV", "saudi arabia": "KSA", "uruguay": "URU", "france": "FRA", "senegal": "SEN", "iraq": "IRQ", "norway": "NOR", "argentina": "ARG", "algeria": "ALG", "austria": "AUT", "jordan": "JOR", "portugal": "POR", "dr congo": "COD", "congo dr": "COD", "congo": "COD", "uzbekistan": "UZB", "colombia": "COL", "england": "ENG", "croatia": "CRO", "ghana": "GHA", "panama": "PAN"};
  function dpNorm(s){return String(s||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();}
  function dpSigla(x){ if(!x) return null; if(DEPARA[x]) return x; var n=dpNorm(x); for(var k in DEPARA){ if(dpNorm(DEPARA[k].n)===n) return k; } return DEPARA_EN[n]||null; }
  function dpNome(x){ var s=dpSigla(x); return s?DEPARA[s].n:(x||"—"); }
  function dpIso(x){ var s=dpSigla(x); return s?DEPARA[s].i:""; }
  function dpFlag(x,w){ var c=dpIso(x); return c?("https://flagcdn.com/w"+(w||80)+"/"+c+".png"):""; }

  const CFG = window.COPA_CFG || { url: "", key: "" };
  const $ = s => document.querySelector(s);
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const DEMO = /[?&]demo=1/.test(location.search);
  const PRE_MIN = 10;                 // abre 10 min antes do início oficial
  const ESPN_OVR = {};               // se alguma sigla da ESPN diferir do nosso id, mapear aqui (ex.: {"GER":"ALE"})
  let DADOS = {}, JOGOS = [], PART = [], timer = null;
  let TVS = {};

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
  const flagcdn = id => { const c = iso(id); return c ? `https://flagcdn.com/w80/${c}.png` : ""; };
  const norm = ab => ESPN_OVR[ab] || ab;
  const sgn = n => n > 0 ? 1 : n < 0 ? -1 : 0;

  const TV_CAT = { // ordem de exibição; cores aproximadas das marcas
    globo:   ["Globo", "#0a7cff", "#fff"],
    sbt:     ["SBT", "#00a651", "#fff"],
    sportv:  ["SporTV", "#ff7a00", "#fff"],
    getv:    ["ge tv", "#06aa48", "#fff"],
    gplay:   ["Globoplay", "#fb0234", "#fff"],
    nsports: ["N Sports", "#222a38", "#fff"],
    caze:    ["CazéTV", "#f7d116", "#3a2a00"]
  };
  function tvChips(aAb, bAb) {
    const k = [aAb, bAb].sort().join("-");
    const extras = (TVS.jogos && TVS.jogos[k]) || [];
    const lista = Object.keys(TV_CAT).filter(c => c === "caze" || extras.indexOf(c) !== -1);
    return `<div class="tvs">📺 ${lista.map(c => `<span class="tvchip" style="background:${TV_CAT[c][1]};color:${TV_CAT[c][2]}">${TV_CAT[c][0]}</span>`).join("")}</div>`;
  }

  async function init() {
    try { TVS = await fetch("dados/transmissoes.json").then(r => r.json()); } catch (e) { TVS = {}; }
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
    try {
      const rows = await rpc("copa_revelados", {});
      PART = (rows || []).map(r => ({ nome: r.nome, grupos: (r.payload || {}).placaresGrupos || {} })).sort((a, b) => a.nome.localeCompare(b.nome));
    } catch (e) { PART = []; }
    loop(); timer = setInterval(loop, 30000);
  }

  async function loop() {
    let data;
    try { data = await (await fetch(API)).json(); }
    catch (e) { if (!DEMO) { $("#app").innerHTML = '<p class="vazio">Sem conexão com o feed agora. Tentando de novo…</p>'; return; } data = { events: [] }; }
    const now = Date.now();
    let lives = (data.events || []).filter(ev => {
      const st = ev.competitions[0].status.type;
      if (st.state === "in") return true;
      if (st.state === "pre") { const dt = new Date(ev.date).getTime(); return now >= dt - PRE_MIN * 60000 && now <= dt + 60 * 60000; } // entra 10min antes; segura até 1h se a ESPN demorar a virar "ao vivo"
      return false;
    });
    let demoFlag = false;
    if (DEMO && !lives.length) { lives = [fabricar()]; demoFlag = true; }
    render(lives, data, demoFlag);
  }

  function render(lives, data, demoFlag) {
    if (!lives.length) {
      $("#app").innerHTML = `<div class="nada"><div class="bola">⚽</div>
        <h2>Nenhum jogo ao vivo agora</h2>
        <p>Quando uma partida começa, ela aparece aqui sozinha — e some quando acaba.</p>
        ${proximo(data) ? `<p class="prox">Próximo jogo: <b>${proximo(data)}</b></p>` : ""}
        <a class="link" href="index.html">Ver jogos →</a></div>`;
      return;
    }
    $("#app").innerHTML = (demoFlag ? '<div class="demobar">⚙ DEMONSTRAÇÃO — jogo simulado com os palpites reais. No dia, é automático (abra sem <b>?demo=1</b>).</div>' : "")
      + lives.map(card).join("");
  }

  function ourGame(ev) {
    if ((ev.season && ev.season.slug) !== "group-stage") return null;
    const cs = ev.competitions[0].competitors;
    const h = norm((cs.find(c => c.homeAway === "home").team || {}).abbreviation);
    const a = norm((cs.find(c => c.homeAway === "away").team || {}).abbreviation);
    return JOGOS.find(j => (j.a === h && j.b === a) || (j.a === a && j.b === h)) || null;
  }

  function card(ev) {
    const comp = ev.competitions[0], st = comp.status.type, cs = comp.competitors;
    const home = cs.find(c => c.homeAway === "home") || cs[0];
    const away = cs.find(c => c.homeAway === "away") || cs[1];
    const hs = parseInt(home.score || "0", 10), as = parseInt(away.score || "0", 10);
    const pre = st.state === "pre";
    const minuto = pre ? "Pré-jogo" : (st.shortDetail || "Ao vivo");
    const escudo = c => {
      const ab = (c.team && c.team.abbreviation) || (c.team && c.team.displayName);
      const src = dpFlag(ab, 80) || (c.team && c.team.logo) || "";
      return src ? `<img src="${src}" alt="" title="${dpNome(ab)}" onerror="this.style.visibility='hidden'">` : "";
    };
    const tNome = c => dpNome((c.team && c.team.abbreviation) || (c.team && c.team.displayName));

    // palpites (só fase de grupos e se já houver palpites revelados)
    const j = ourGame(ev);
    let palpHTML = "";
    if (j && PART.length) {
      const homeId = norm(home.team.abbreviation);
      const arr = PART.map(p => {
        const pr = p.grupos[j.jogo_id];
        if (!pr || pr.ga == null || pr.gb == null) return { nome: p.nome, s: "vazio", txt: "—" };
        let ph, pa;
        if (j.a === homeId) { ph = pr.ga; pa = pr.gb; } else { ph = pr.gb; pa = pr.ga; }
        const exato = ph === hs && pa === as;
        const s = exato ? "exato" : (sgn(ph - pa) === sgn(hs - as) ? "acertando" : "errando");
        return { nome: p.nome, s, txt: ph + "×" + pa };
      });
      const ord = { exato: 0, acertando: 1, errando: 2, vazio: 3 };
      arr.sort((x, y) => ord[x.s] - ord[y.s] || x.nome.localeCompare(y.nome));
      const n = arr.filter(x => x.s === "acertando" || x.s === "exato").length;
      palpHTML = `<div class="contador"><b>${n}</b> de ${PART.length} acertando o resultado</div>
        <div class="lista">${arr.map(x => {
          const marca = x.s === "exato" ? '<span class="badge-ex">cravando</span>'
            : x.s === "acertando" ? '<span class="dot v"></span>'
            : x.s === "vazio" ? '<span class="dot z"></span>' : '<span class="dot x"></span>';
          return `<div class="pp ${x.s}"><span class="nm">${x.nome}</span><span class="chip">${x.txt}</span>${marca}</div>`;
        }).join("")}</div>
        <div class="legenda"><span><span class="dot v"></span> acertando</span><span><span class="badge-ex" style="animation:none">cravando</span> placar exato</span><span><span class="dot x"></span> errando</span></div>`;
    } else if (!j) {
      palpHTML = `<div class="obs-fase">Mata-mata: o palpite por placar vale na fase de grupos. Aqui mostramos só o jogo ao vivo.</div>`;
    }

    return `<div class="placar ${pre ? "pre" : ""}">
      <div class="topo"><span class="fase">${faseLabel(ev)}</span>
        <span class="aovivo ${pre ? "preb" : ""}"><span class="pulse"></span> ${pre ? "Em breve" : "Ao vivo"}</span></div>
      <div class="lp">
        <div class="sel">${escudo(home)}<div class="nm">${tNome(home)}</div></div>
        <div class="escore"><div class="g">${pre ? "–" : hs}</div><div class="x">×</div><div class="g">${pre ? "–" : as}</div></div>
        <div class="sel">${escudo(away)}<div class="nm">${tNome(away)}</div></div>
      </div>
      <div class="minuto">${minuto}</div>
      ${tvChips((home.team || {}).abbreviation, (away.team || {}).abbreviation)}
      <a class="btn-caze" href="https://www.youtube.com/@CazeTV/live" target="_blank" rel="noopener">▶️ Assistir ao vivo na CazéTV</a>
      ${palpHTML}
    </div>`;
  }

  function faseLabel(ev) {
    const map = { "group-stage": "Fase de grupos", "round-of-32": "Segunda fase", "round-of-16": "Oitavas", "quarterfinals": "Quartas", "semifinals": "Semifinal", "third-place": "Disputa de 3º", "final": "Final" };
    return map[(ev.season && ev.season.slug)] || "Copa do Mundo";
  }
  function proximo(data) {
    const ev = (data.events || []).filter(e => e.competitions[0].status.type.state === "pre").sort((a, b) => new Date(a.date) - new Date(b.date))[0];
    if (!ev) return "";
    const cs = ev.competitions[0].competitors, h = cs.find(c => c.homeAway === "home"), a = cs.find(c => c.homeAway === "away");
    const t = new Date(ev.date).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
    return `${dpNome(h.team.abbreviation || h.team.displayName)} × ${dpNome(a.team.abbreviation || a.team.displayName)} — ${t}`;
  }

  // jogo simulado (apenas com ?demo=1) usando o 1º jogo de grupo e placar fixo 2×1
  function fabricar() {
    const j = JOGOS[0];
    const mk = (id, sc) => ({ homeAway: id === j.a ? "home" : "away", score: String(sc), winner: false, team: { abbreviation: id, displayName: nome(id), shortDisplayName: nome(id), logo: flagcdn(id) } });
    return {
      season: { slug: "group-stage" }, date: new Date().toISOString(),
      competitions: [{ status: { type: { state: "in", shortDetail: "DEMO 2ºT 67'" } }, competitors: [mk(j.a, 2), mk(j.b, 1)] }]
    };
  }

  document.addEventListener("DOMContentLoaded", init);
})();
