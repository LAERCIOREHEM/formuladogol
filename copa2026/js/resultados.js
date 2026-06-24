/* =========================================================================
   resultados.js — Resultados das partidas (Copa 2026), direto da ESPN
   Navegador puxa o feed público da ESPN (sem chave, CORS liberado).
   Navegação por dia + atualização automática a cada 30s para jogos, grupos e mata-mata ao vivo.
   NOVO: na FASE DE GRUPOS, cada jogo mostra os palpites de todos (recolhidos,
   abre no "ver palpites"). Verde = acertou o resultado · 🎯 = cravou o placar.
   ========================================================================= */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const SUMMARY_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary";
  const START = "20260611", END = "20260719";
  const CFG = window.COPA_CFG || { url: "", key: "" };

  // ===== DE-PARA embutido (à prova de timing): sigla/nome EN -> PT + bandeira =====
  var DEPARA = {"MEX": {"n": "México", "i": "mx"}, "RSA": {"n": "África do Sul", "i": "za"}, "KOR": {"n": "Coreia do Sul", "i": "kr"}, "CZE": {"n": "Rep. Tcheca", "i": "cz"}, "CAN": {"n": "Canadá", "i": "ca"}, "BIH": {"n": "Bósnia", "i": "ba"}, "QAT": {"n": "Catar", "i": "qa"}, "SUI": {"n": "Suíça", "i": "ch"}, "BRA": {"n": "Brasil", "i": "br"}, "MAR": {"n": "Marrocos", "i": "ma"}, "HAI": {"n": "Haiti", "i": "ht"}, "SCO": {"n": "Escócia", "i": "gb-sct"}, "USA": {"n": "EUA", "i": "us"}, "PAR": {"n": "Paraguai", "i": "py"}, "AUS": {"n": "Austrália", "i": "au"}, "TUR": {"n": "Turquia", "i": "tr"}, "GER": {"n": "Alemanha", "i": "de"}, "CUW": {"n": "Curaçao", "i": "cw"}, "CIV": {"n": "Costa do Marfim", "i": "ci"}, "ECU": {"n": "Equador", "i": "ec"}, "NED": {"n": "Holanda", "i": "nl"}, "JPN": {"n": "Japão", "i": "jp"}, "SWE": {"n": "Suécia", "i": "se"}, "TUN": {"n": "Tunísia", "i": "tn"}, "BEL": {"n": "Bélgica", "i": "be"}, "EGY": {"n": "Egito", "i": "eg"}, "IRN": {"n": "Irã", "i": "ir"}, "NZL": {"n": "Nova Zelândia", "i": "nz"}, "ESP": {"n": "Espanha", "i": "es"}, "CPV": {"n": "Cabo Verde", "i": "cv"}, "KSA": {"n": "Arábia Saudita", "i": "sa"}, "URU": {"n": "Uruguai", "i": "uy"}, "FRA": {"n": "França", "i": "fr"}, "SEN": {"n": "Senegal", "i": "sn"}, "IRQ": {"n": "Iraque", "i": "iq"}, "NOR": {"n": "Noruega", "i": "no"}, "ARG": {"n": "Argentina", "i": "ar"}, "ALG": {"n": "Argélia", "i": "dz"}, "AUT": {"n": "Áustria", "i": "at"}, "JOR": {"n": "Jordânia", "i": "jo"}, "POR": {"n": "Portugal", "i": "pt"}, "COD": {"n": "RD Congo", "i": "cd"}, "UZB": {"n": "Uzbequistão", "i": "uz"}, "COL": {"n": "Colômbia", "i": "co"}, "ENG": {"n": "Inglaterra", "i": "gb-eng"}, "CRO": {"n": "Croácia", "i": "hr"}, "GHA": {"n": "Gana", "i": "gh"}, "PAN": {"n": "Panamá", "i": "pa"}};
  var DEPARA_EN = {"mexico": "MEX", "south africa": "RSA", "south korea": "KOR", "korea republic": "KOR", "czechia": "CZE", "czech republic": "CZE", "canada": "CAN", "bosnia and herzegovina": "BIH", "bosnia": "BIH", "qatar": "QAT", "switzerland": "SUI", "brazil": "BRA", "morocco": "MAR", "haiti": "HAI", "scotland": "SCO", "united states": "USA", "paraguay": "PAR", "australia": "AUS", "turkey": "TUR", "turkiye": "TUR", "germany": "GER", "curacao": "CUW", "ivory coast": "CIV", "cote d ivoire": "CIV", "ecuador": "ECU", "netherlands": "NED", "japan": "JPN", "sweden": "SWE", "tunisia": "TUN", "belgium": "BEL", "egypt": "EGY", "iran": "IRN", "new zealand": "NZL", "spain": "ESP", "cape verde": "CPV", "saudi arabia": "KSA", "uruguay": "URU", "france": "FRA", "senegal": "SEN", "iraq": "IRQ", "norway": "NOR", "argentina": "ARG", "algeria": "ALG", "austria": "AUT", "jordan": "JOR", "portugal": "POR", "dr congo": "COD", "congo dr": "COD", "congo": "COD", "uzbekistan": "UZB", "colombia": "COL", "england": "ENG", "croatia": "CRO", "ghana": "GHA", "panama": "PAN", "us": "USA", "usmnt": "USA", "ned": "NED", "ger": "GER", "sui": "SUI", "esp": "ESP", "por": "POR", "rsa": "RSA", "kor": "KOR", "uae": "UAE", "ksa": "KSA", "rou": "ROU", "den": "DEN", "cze": "CZE", "cro": "CRO", "uru": "URU", "par": "PAR"};
  function dpNorm(s){return String(s||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();}
  function dpSigla(x){ if(!x) return null; if(DEPARA[x]) return x; var n=dpNorm(x); for(var k in DEPARA){ if(dpNorm(DEPARA[k].n)===n) return k; } return DEPARA_EN[n]||null; }
  function dpNome(x){ var s=dpSigla(x); return s?DEPARA[s].n:(x||"—"); }
  function dpIso(x){ var s=dpSigla(x); return s?DEPARA[s].i:""; }
  function dpFlag(x,w){ var c=dpIso(x); return c?("https://flagcdn.com/w"+(w||80)+"/"+c+".png"):""; }

  let JOGOS = [], PALP = [], dia, timer = null, TVS = {};
  let MM = {}; // melhores momentos: chave siglas -> {url,titulo}
  let ABA = "jogos", SEL = [], GRP_EVENTS = [], GRP_EVENTS_TS = 0;
  let ESTRUT = null, TERMAP = null, MATA_EVENTS = [], MATA_EVENTS_TS = 0, PALPMATA = {};
  let FAIRPLAY = {}, FAIRPLAY_TS = 0; // {sigla: pontos de conduta}, cache 5min
  let FASE_MATA = "16-avos"; // fase selecionada na aba mata-mata
  let MATA_CACHE = null; // guarda o resultado do engine pra trocar de fase sem recalcular
  let VOLTAR_JOGO = null, FOCO_GRUPO = null; // navegação Grupo X -> tabela -> voltar
  let LANCES_CACHE = {}; // eventId -> {ts, dados}; gols/cartões exibidos nos cards

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
  // SEM curto para a faixa (3 letras)
  const SEM3 = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
  const MES3 = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  function montarFaixaDias() {
    const faixa = document.getElementById("dias-faixa");
    if (!faixa) return;
    const hoje = hojeYMD();
    let html = "";
    let cur = START;
    while (cur <= END) {
      const d = ymdToDate(cur);
      const ativo = cur === dia ? " ativo" : "";
      const ehHoje = cur === hoje ? " hoje" : "";
      html += `<div class="dia-item${ativo}${ehHoje}" data-ymd="${cur}">
        <span class="dsem">${SEM3[d.getDay()]}</span>
        <span class="dnum">${d.getDate()}</span>
        <span class="dmes">${MES3[d.getMonth()]}</span>
      </div>`;
      cur = dateToYMD(new Date(ymdToDate(cur).getTime() + 864e5));
    }
    faixa.innerHTML = html;
    // liga o clique em cada dia
    faixa.querySelectorAll(".dia-item[data-ymd]").forEach(el => {
      el.onclick = () => { dia = el.dataset.ymd; carregar(); };
    });
    // centraliza o dia ativo: roda várias vezes para garantir que o layout já foi medido
    centralizarDia();
  }
  function centralizarDia() {
    const faixa = document.getElementById("dias-faixa");
    if (!faixa) return;
    const fazer = () => {
      const at = faixa.querySelector(".dia-item.ativo");
      if (!at || !faixa.clientWidth) return;
      // mede pela posição REAL na tela (getBoundingClientRect é imune a transform:scale e offsetParent)
      const rFaixa = faixa.getBoundingClientRect();
      const rItem = at.getBoundingClientRect();
      // centro do item na tela menos centro da faixa na tela = quanto precisa rolar
      const centroItem = rItem.left + rItem.width / 2;
      const centroFaixa = rFaixa.left + rFaixa.width / 2;
      const delta = centroItem - centroFaixa;
      const max = faixa.scrollWidth - faixa.clientWidth;
      faixa.scrollLeft = Math.max(0, Math.min(faixa.scrollLeft + delta, max));
    };
    // roda várias vezes: o layout/fontes/scale podem mudar a medida após o 1º paint
    fazer();
    requestAnimationFrame(fazer);
    setTimeout(fazer, 50);
    setTimeout(fazer, 150);
    setTimeout(fazer, 350);
  }
  function horaBR(iso) { try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }); } catch (e) { return ""; } }

  // ===== Gols e cartões vermelhos nos cards de jogos =====
  // A página principal usa o scoreboard da ESPN para placar. Para não poluir nem
  // atrasar a tela, os lances são carregados em segundo plano via summary do jogo.
  function escTxt(s) {
    return String(s || "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }
  function getPath(obj, path, def) {
    let cur = obj;
    for (const p of path) {
      if (cur && typeof cur === "object" && p in cur) cur = cur[p];
      else return def;
    }
    return cur == null ? def : cur;
  }
  function textoTipo(o) {
    const t = o && o.type;
    if (!t) return "";
    if (typeof t === "string") return t;
    if (typeof t === "object") return [t.id, t.text, t.name, t.displayName, t.abbreviation].filter(Boolean).join(" ");
    return String(t);
  }
  function textoLance(o) {
    return String((o && (o.text || o.description || o.shortText || o.displayText || o.headline)) || "");
  }
  function nomeAtleta(a) {
    if (!a || typeof a !== "object") return "";
    if (a.athlete) return nomeAtleta(a.athlete);
    return String(a.displayName || a.fullName || a.shortName || a.name || "").replace(/\s+/g, " ").trim();
  }
  function jogadorDoLance(o) {
    if (!o || typeof o !== "object") return "";
    for (const k of ["athlete", "player", "scorer"]) {
      const n = nomeAtleta(o[k]); if (n) return n;
    }
    for (const k of ["athletes", "participants", "athletesInvolved", "players"]) {
      const arr = o[k];
      if (Array.isArray(arr)) {
        for (const it of arr) { const n = nomeAtleta(it); if (n) return n; }
      }
    }
    return String(o.displayName || o.athleteDisplayName || o.name || "").replace(/\s+/g, " ").trim();
  }
  function minutoDoLance(o) {
    let v = getPath(o, ["clock", "displayValue"], "") || getPath(o, ["time", "displayValue"], "") || o.displayClock || o.clock || o.minute || "";
    v = String(v || "").trim();
    if (!v) return "";
    if (/^\d+$/.test(v)) return v + "'";
    return v.replace(/\s+/g, " ");
  }
  function golDoTexto(txt) {
    if (!txt) return "";
    const pats = [
      /Goal!.*?\.\s*([^\.]+?)\s*\((?:[^)]*)\)/i,
      /Gol!.*?\.\s*([^\.]+?)\s*\((?:[^)]*)\)/i,
      /^\s*([^\.]+?)\s+\((?:[^)]*)\)\s*(?:right|left|header|converts|marca|finaliza|chuta)/i
    ];
    for (const p of pats) { const m = txt.match(p); if (m && m[1] && m[1].length <= 60) return m[1].replace(/\s+/g, " ").trim(); }
    return "";
  }
  function ehGolContra(lance) {
    const raw = (textoTipo(lance) + " " + textoLance(lance)).toLowerCase();
    return /own goal|gol contra|autogol/.test(raw);
  }
  function nomeGolContraDoTexto(txt) {
    txt = String(txt || "");
    const pats = [
      /own goal by\s+([^,.]+)(?:[,\.]|$)/i,
      /gol contra de\s+([^,.]+)(?:[,\.]|$)/i,
      /autogol de\s+([^,.]+)(?:[,\.]|$)/i
    ];
    for (const p of pats) {
      const m = txt.match(p);
      if (m && m[1]) return m[1].replace(/\s+/g, " ").trim();
    }
    return "";
  }
  function escRegex(s) { return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function timeDoTexto(txt) {
    if (!txt) return "";
    const pats = [
      /Goal!.*?\.\s*[^\.]+?\s*\(([^)]+)\)/i,
      /Gol!.*?\.\s*[^\.]+?\s*\(([^)]+)\)/i,
      /^\s*[^\.]+?\s+\(([^)]+)\)\s*(?:right|left|header|converts|marca|finaliza|chuta)/i
    ];
    for (const p of pats) {
      const m = txt.match(p);
      if (m && m[1]) return String(m[1]).replace(/\s+/g, " ").trim();
    }
    return "";
  }
  function scoreNum(v) {
    if (v == null || v === "") return null;
    const n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
    return isNaN(n) ? null : n;
  }
  function scoreDoLance(o) {
    const pares = [
      ["homeScore", "awayScore"], ["home_score", "away_score"],
      ["homeTeamScore", "awayTeamScore"], ["home", "away"]
    ];
    for (const [h, a] of pares) {
      if (!o || !(h in o) || !(a in o)) continue;
      const hs = scoreNum(o[h]), as = scoreNum(o[a]);
      if (hs != null && as != null) return { home: hs, away: as };
    }
    const sh = getPath(o, ["score", "home"], null), sa = getPath(o, ["score", "away"], null);
    const hs = scoreNum(sh), as = scoreNum(sa);
    if (hs != null && as != null) return { home: hs, away: as };
    return null;
  }
  function mapTimesDoSummary(summary, ev) {
    const m = {};
    function addKey(k, sig) { if (k != null && k !== "" && sig) m[String(k).toLowerCase()] = sig; }
    function addTeam(t, sigFallback) {
      if (!t || typeof t !== "object") return;
      const sig = dpSigla(t.abbreviation) || dpSigla(t.shortDisplayName) || dpSigla(t.displayName) || dpSigla(t.name) || sigFallback || "";
      if (!sig) return;
      addKey(t.id, sig); addKey(t.uid, sig); addKey(t.guid, sig); addKey(t.slug, sig);
      [t.abbreviation, t.shortDisplayName, t.displayName, t.name, t.location, t.nickname].forEach(v => addKey(dpNorm(v), sig));
    }
    function addCompetitor(c) {
      if (!c || typeof c !== "object") return;
      const t = c.team || c;
      const sig = dpSigla(t.abbreviation) || dpSigla(t.shortDisplayName) || dpSigla(t.displayName) || dpSigla(t.name) || "";
      addKey(c.id, sig); addKey(c.uid, sig); addKey(c.competitorId, sig);
      addTeam(t, sig);
    }
    const comps = [];
    const a = getPath(summary, ["header", "competitions", 0, "competitors"], []);
    const b = getPath(summary, ["competitions", 0, "competitors"], []);
    const c = getPath(ev || {}, ["competitions", 0, "competitors"], []);
    if (Array.isArray(a)) comps.push(...a);
    if (Array.isArray(b)) comps.push(...b);
    if (Array.isArray(c)) comps.push(...c);
    comps.forEach(addCompetitor);
    return m;
  }
  function siglaObjTime(o, mapa) {
    if (!o || typeof o !== "object") return "";
    const candObjs = [o.team, o.scoringTeam, o.competitor, o.participant, o.club];
    for (const t of candObjs) {
      if (!t || typeof t !== "object") continue;
      const sig = dpSigla(t.abbreviation) || dpSigla(t.shortDisplayName) || dpSigla(t.displayName) || dpSigla(t.name);
      if (sig) return sig;
      for (const k of ["id", "uid", "guid", "slug"]) {
        if (t[k] != null && mapa[String(t[k]).toLowerCase()]) return mapa[String(t[k]).toLowerCase()];
      }
    }
    for (const k of ["teamId", "teamID", "competitorId", "competitorID", "participantId", "participantID", "athleteTeamId"]) {
      if (o[k] != null && mapa[String(o[k]).toLowerCase()]) return mapa[String(o[k]).toLowerCase()];
    }
    const txtTeam = dpSigla(timeDoTexto(textoLance(o)));
    if (txtTeam) return txtTeam;
    return "";
  }
  function arraysLances(summary) {
    const out = [];
    for (const p of [["scoringPlays"], ["competitions", 0, "scoringPlays"], ["header", "competitions", 0, "scoringPlays"]]) {
      const arr = getPath(summary, p, []); if (Array.isArray(arr)) out.push(...arr);
    }
    return out;
  }
  function arraysComentario(summary) {
    const out = [];
    for (const p of [["commentary"], ["plays"], ["competitions", 0, "details"]]) {
      let arr = getPath(summary, p, []);
      if (arr && !Array.isArray(arr) && typeof arr === "object") arr = arr.items || arr.plays || [];
      if (Array.isArray(arr)) out.push(...arr);
    }
    return out;
  }
  function contarVermelhosPorEstatistica(summary, mapaTimes, homeSig, awaySig) {
    const out = { home: 0, away: 0, total: 0 };
    const equipes = getPath(summary, ["boxscore", "teams"], []);
    if (!Array.isArray(equipes)) return out;
    equipes.forEach(t => {
      const stats = t.statistics || [];
      if (!Array.isArray(stats)) return;
      let nTime = 0;
      stats.forEach(st => {
        const nome = String(st.name || st.displayName || st.label || "").toLowerCase();
        if (/red/.test(nome) || /vermelh/.test(nome)) {
          const n = parseInt(st.value ?? st.displayValue ?? "0", 10);
          if (!isNaN(n)) nTime += n;
        }
      });
      if (!nTime) return;
      const sig = siglaObjTime(t, mapaTimes) || dpSigla(getPath(t, ["team", "abbreviation"], "")) || dpSigla(getPath(t, ["team", "displayName"], ""));
      if (sig && homeSig && sig === homeSig) out.home += nTime;
      else if (sig && awaySig && sig === awaySig) out.away += nTime;
      out.total += nTime;
    });
    return out;
  }
  function extrairLances(summary, ev) {
    const comp = getPath(ev, ["competitions", 0], {}) || {};
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === "home") || cs[0] || {};
    const away = cs.find(c => c.homeAway === "away") || cs[1] || {};
    const homeSig = dpSigla(getPath(home, ["team", "abbreviation"], "")) || dpSigla(getPath(home, ["team", "displayName"], ""));
    const awaySig = dpSigla(getPath(away, ["team", "abbreviation"], "")) || dpSigla(getPath(away, ["team", "displayName"], ""));
    const mapaTimes = mapTimesDoSummary(summary, ev);
    const gols = [], usados = new Set();
    let ultimoScore = { home: 0, away: 0 };

    const finalHome = scoreNum(home.score);
    const finalAway = scoreNum(away.score);

    function nomesDoCompetidor(c, sig) {
      const t = (c && c.team) || {};
      const vals = [t.displayName, t.shortDisplayName, t.name, t.location, t.nickname, t.abbreviation, sig ? dpNome(sig) : "", sig].filter(Boolean);
      const unicos = [];
      vals.forEach(v => { const n = dpNorm(v); if (n && !unicos.includes(n)) unicos.push(n); });
      return unicos;
    }
    const nomesHome = nomesDoCompetidor(home, homeSig);
    const nomesAway = nomesDoCompetidor(away, awaySig);
    function scoreDoTextoLocal(txt) {
      const n = dpNorm(txt);
      if (!n) return null;
      for (const hn of nomesHome) for (const an of nomesAway) {
        let re = new RegExp("\\b" + escRegex(hn) + "\\s+(\\d+)\\s+" + escRegex(an) + "\\s+(\\d+)\\b");
        let m = n.match(re);
        if (m) return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
        re = new RegExp("\\b" + escRegex(an) + "\\s+(\\d+)\\s+" + escRegex(hn) + "\\s+(\\d+)\\b");
        m = n.match(re);
        if (m) return { home: parseInt(m[2], 10), away: parseInt(m[1], 10) };
      }
      return null;
    }
    function scoreLance(lance) {
      return scoreDoLance(lance) || scoreDoTextoLocal(textoLance(lance));
    }

    function ladoDoGol(lance) {
      const isOG = ehGolContra(lance);
      // Gol contra: o time associado ao atleta é, por definição, o time que sofreu o gol.
      // Por isso, primeiro tentamos inferir pelo placar do lance; se não vier claro,
      // deixamos sem lado para a normalização encaixar no lado que falta no placar final.
      if (!isOG) {
        const sig = siglaObjTime(lance, mapaTimes);
        if (sig && homeSig && sig === homeSig) return { lado: "home", fonte: "time" };
        if (sig && awaySig && sig === awaySig) return { lado: "away", fonte: "time" };
      }
      const sc = scoreLance(lance);
      if (sc) {
        if (sc.home > ultimoScore.home && sc.away === ultimoScore.away) return { lado: "home", fonte: isOG ? "placar-og" : "placar" };
        if (sc.away > ultimoScore.away && sc.home === ultimoScore.home) return { lado: "away", fonte: isOG ? "placar-og" : "placar" };
      }
      return { lado: "", fonte: isOG ? "og-pendente" : "" };
    }
    function ordemMinuto(g) {
      const m = String(g.minuto || "").match(/\d+/);
      return m ? parseInt(m[0], 10) : 999;
    }
    function normalizarLadosDosGols() {
      if (finalHome == null || finalAway == null) return;

      // 1) Se algum lance veio sem time no feed da ESPN, encaixa pelo placar final.
      // Ex.: jogo 6x0; qualquer gol sem time só pode ser do lado que ainda falta completar.
      let h = gols.filter(g => g.lado === "home").length;
      let a = gols.filter(g => g.lado === "away").length;
      gols.filter(g => !g.lado).sort((x, y) => ordemMinuto(x) - ordemMinuto(y)).forEach(g => {
        let faltaH = Math.max(0, finalHome - h);
        let faltaA = Math.max(0, finalAway - a);
        if (faltaH > 0 && faltaA <= 0) { g.lado = "home"; g.fonte = "placar-final"; h++; return; }
        if (faltaA > 0 && faltaH <= 0) { g.lado = "away"; g.fonte = "placar-final"; a++; return; }
        if (faltaH > faltaA) { g.lado = "home"; g.fonte = "inferido"; h++; return; }
        if (faltaA > faltaH) { g.lado = "away"; g.fonte = "inferido"; a++; return; }
      });

      // 2) Segurança: se ainda sobrou algum sem lado, distribui sem deixar no meio do card.
      h = gols.filter(g => g.lado === "home").length;
      a = gols.filter(g => g.lado === "away").length;
      gols.filter(g => !g.lado).sort((x, y) => ordemMinuto(x) - ordemMinuto(y)).forEach(g => {
        const faltaH = Math.max(0, finalHome - h);
        const faltaA = Math.max(0, finalAway - a);
        if (faltaH >= faltaA && faltaH > 0) { g.lado = "home"; h++; }
        else if (faltaA > 0) { g.lado = "away"; a++; }
        else { g.lado = h <= a ? "home" : "away"; if (g.lado === "home") h++; else a++; }
        g.fonte = g.fonte || "distribuido";
      });
    }
    function registrarGol(lance) {
      const og = ehGolContra(lance);
      const txt = textoLance(lance);
      const nome = (og ? (nomeGolContraDoTexto(txt) || jogadorDoLance(lance) || golDoTexto(txt)) : (jogadorDoLance(lance) || golDoTexto(txt)));
      if (!nome) return;
      const min = minutoDoLance(lance);
      const infoLado = ladoDoGol(lance);
      const lado = infoLado.lado;
      const key = min + "|" + nome.toLowerCase() + "|" + (og ? "OG" : "GOL");
      if (usados.has(key)) return;
      usados.add(key);
      gols.push({ minuto: min, nome: nome, lado: lado, fonte: infoLado.fonte, og: og });
      const sc = scoreLance(lance);
      if (sc) ultimoScore = sc;
    }

    arraysLances(summary).forEach(sp => {
      const raw = (textoTipo(sp) + " " + textoLance(sp)).toLowerCase();
      if (/shootout|penalty shootout|disputa de p[eê]naltis/.test(raw)) return;
      // scoringPlays às vezes inclui cartões em outros esportes; aqui aceitamos só lance com cara de gol.
      if (!(raw.includes("goal") || raw.includes("gol") || parseInt(sp.scoreValue || "0", 10) === 1)) return;
      registrarGol(sp);
    });

    // Complemento: após o apito final, a ESPN às vezes esvazia/limita scoringPlays
    // e deixa os gols completos apenas em commentary/plays. Por isso varremos os comentários
    // SEM depender de gols.length. O dedupe acima evita repetir os gols que já vieram em scoringPlays.
    arraysComentario(summary).forEach(ev2 => {
      const raw = (textoTipo(ev2) + " " + textoLance(ev2)).toLowerCase();
      if (/shootout|penalty shootout|disputa de p[eê]naltis/.test(raw)) return;
      const ehGol = raw.includes("goal") || raw.includes("gol!") || ehGolContra(ev2);
      if (!ehGol) return;
      registrarGol(ev2);
    });

    const vermelhos = { home: 0, away: 0, total: 0 };
    const redsUsados = new Set();
    function ladoDoCartao(lance) {
      const sig = siglaObjTime(lance, mapaTimes) || dpSigla(timeDoTexto(textoLance(lance)));
      if (sig && homeSig && sig === homeSig) return "home";
      if (sig && awaySig && sig === awaySig) return "away";
      return "";
    }
    arraysComentario(summary).forEach(ev2 => {
      const raw = (textoTipo(ev2) + " " + textoLance(ev2)).toLowerCase();
      const ehVermelho = /red card|cart[aã]o vermelho|second yellow|segundo amarelo/.test(raw);
      if (!ehVermelho) return;
      const key = (minutoDoLance(ev2) + "|" + textoLance(ev2)).toLowerCase();
      if (redsUsados.has(key)) return;
      redsUsados.add(key);
      const lado = ladoDoCartao(ev2);
      if (lado === "home") vermelhos.home++;
      else if (lado === "away") vermelhos.away++;
      vermelhos.total++;
    });

    // Complemento/segurança: quando o comentário não traz o time do cartão,
    // usa o boxscore da ESPN, que normalmente informa cartões por seleção.
    const statsReds = contarVermelhosPorEstatistica(summary, mapaTimes, homeSig, awaySig);
    if (statsReds.home > vermelhos.home) vermelhos.home = statsReds.home;
    if (statsReds.away > vermelhos.away) vermelhos.away = statsReds.away;
    vermelhos.total = Math.max(vermelhos.total, statsReds.total, vermelhos.home + vermelhos.away);

    normalizarLadosDosGols();
    const ordenados = gols.slice().sort((x, y) => ordemMinuto(x) - ordemMinuto(y));
    return {
      gols: ordenados,
      golsHome: ordenados.filter(g => g.lado === "home"),
      golsAway: ordenados.filter(g => g.lado === "away"),
      vermelhosHome: vermelhos.home,
      vermelhosAway: vermelhos.away,
      vermelhos: vermelhos.total
    };
  }
  function chipGol(g) {
    const og = g && g.og ? ` <span class="og-tag" title="Gol contra">OG</span>` : "";
    return `<span class="gol-chip">⚽ ${g.minuto ? escTxt(g.minuto) + " " : ""}${escTxt(g.nome)}${og}</span>`;
  }
  function chipVermelho(qtd, lado) {
    if (!qtd) return "";
    const icones = "🟥".repeat(Math.min(qtd, 4));
    const extra = qtd > 4 ? `<span class="rednum">×${qtd}</span>` : "";
    const rotulo = lado === "home" ? "seleção da esquerda" : "seleção da direita";
    return `<span class="redcards" title="${qtd} cartão(ões) vermelho(s) — ${rotulo}">${icones}${extra}</span>`;
  }
  function htmlLances(dados) {
    if (!dados || ((!dados.gols || !dados.gols.length) && !dados.vermelhos)) return "";
    const home = chipVermelho(dados.vermelhosHome || 0, "home") + (dados.golsHome || []).map(chipGol).join("");
    const away = chipVermelho(dados.vermelhosAway || 0, "away") + (dados.golsAway || []).map(chipGol).join("");
    return `<div class="gols-time gols-home">${home}</div><div class="gols-centro"></div><div class="gols-time gols-away">${away}</div>`;
  }
  async function carregarLancesVisiveis(events) {
    const lista = (events || []).filter(ev => getPath(ev, ["competitions", 0, "status", "type", "state"], "pre") !== "pre");
    lista.forEach(async ev => {
      const id = ev.id;
      const el = document.getElementById("gols-" + id);
      if (!id || !el) return;
      const st = getPath(ev, ["competitions", 0, "status", "type", "state"], "post");
      const ttl = st === "in" ? 25000 : 6 * 60 * 60 * 1000;
      try {
        let dados;
        const c = LANCES_CACHE[id];
        if (c && (Date.now() - c.ts) < ttl) dados = c.dados;
        else {
          const url = `${SUMMARY_API}?event=${encodeURIComponent(id)}${st === "in" ? "&_=" + Date.now() : ""}`;
          const summary = await fetch(url).then(r => r.json());
          dados = extrairLances(summary, ev);
          LANCES_CACHE[id] = { ts: Date.now(), dados };
        }
        const alvo = document.getElementById("gols-" + id);
        if (alvo) alvo.innerHTML = htmlLances(dados);
      } catch (e) {
        // Sem lances não quebra a página. O placar/estádio continuam normais.
      }
    });
  }

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
    // normaliza as siglas da ESPN para a nossa sigla padrão (DE-PARA),
    // senão "US" vs "USA" etc. fazem a chave não bater com o arquivo.
    const sa = dpSigla(aAb) || aAb, sb = dpSigla(bAb) || bAb;
    const k = [sa, sb].sort().join("-");
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
      ESTRUT = await fetch("dados/estrutura_mata_mata.json").then(r => r.json());
      TERMAP = await fetch("dados/terceiros_map.json").then(r => r.json());
    } catch (e) { ESTRUT = null; TERMAP = null; }
    try {
      const rows = await rpc("copa_revelados", {});
      PALP = (rows || []).map(r => ({ nome: r.nome, pg: (r.payload || {}).placaresGrupos || {} }));
    } catch (e) { PALP = []; } // antes da trava vem vazio — normal
    // Palpites do mata-mata auditados (com hash) — fonte imutável de quem cada um
    // colocou avançando em cada fase. Usado para corrigir a exibição quando o
    // desempate FIFA muda quem ocupa cada posição do chaveamento. NÃO altera o banco.
    try {
      const pm = await fetch("dados/palpites_mata.json?t=" + Date.now()).then(r => r.json());
      PALPMATA = (pm && pm.apostadores) || {};
    } catch (e) { PALPMATA = {}; }
  }
  // busca case-insensitive das listas canônicas do mata-mata por nome do apostador
  function canonicoDe(nome) {
    if (!nome || !PALPMATA) return null;
    if (PALPMATA[nome]) return PALPMATA[nome];
    const alvo = String(nome).trim().toUpperCase();
    for (const k in PALPMATA) { if (k.toUpperCase() === alvo) return PALPMATA[k]; }
    return null;
  }

  async function carregar() {
    if (ABA !== "jogos") return;
    montarFaixaDias();
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
    if (!evs.length) { $("#lista").innerHTML = abasHTML() + '<p class="vazio">⚽ Nenhum jogo neste dia.</p>'; document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba); return; }
    $("#lista").innerHTML = abasHTML() + evs.map(card).join("");
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
    document.querySelectorAll(".vermais[data-sp]").forEach(b => b.onclick = () => {
      const d = document.getElementById("sp-" + b.dataset.sp), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "Ocultar palpites ▴" : "Ver palpites ▾";
    });
    document.querySelectorAll(".grupo-link[data-grupo]").forEach(b => b.onclick = () => {
      VOLTAR_JOGO = b.dataset.jogo;   // lembra o jogo de origem
      FOCO_GRUPO = b.dataset.grupo;   // grupo a destacar/rolar
      ABA = "grupos";
      $("#prev").parentElement.style.display = "none";
      renderGrupos();
    });
    carregarLancesVisiveis(evs);
  }

  function abasHTML() {
    return `<div class="vistog">
      <button class="vbtn ${ABA === "jogos" ? "on" : ""}" data-v="jogos">📅 Partidas</button>
      <button class="vbtn ${ABA === "grupos" ? "on" : ""}" data-v="grupos">📊 Grupos</button>
      <button class="vbtn ${ABA === "mata" ? "on" : ""}" data-v="mata">🏆 Mata-mata</button>
    </div>`;
  }
  function fetchJSONNoCache(url) {
    // Durante jogo ao vivo, alguns navegadores/CDNs seguram resposta por alguns segundos.
    // IMPORTANTE: não enviar headers customizados (Cache-Control/Pragma) para a ESPN,
    // porque isso dispara preflight CORS e pode bloquear a chamada no navegador.
    // O carimbo na URL + cache:no-store já força resposta fresca sem quebrar CORS.
    const sep = url.includes("?") ? "&" : "?";
    return fetch(url + sep + "_=" + Date.now(), { cache: "no-store" }).then(r => r.json());
  }
  function estadoEvento(ev) {
    return getPath(ev, ["competitions", 0, "status", "type", "state"], "pre");
  }
  function placarCompetidor(c) {
    // ESPN pode entregar score como número/string, displayScore, curScore ou linescores.
    const candidatos = [
      c && c.score,
      c && c.displayScore,
      c && c.curScore,
      c && c.currentScore,
      c && c.value,
      getPath(c, ["score", "value"], null)
    ];
    for (const v of candidatos) {
      const n = scoreNum(v);
      if (n != null) return n;
    }
    const ls = c && c.linescores;
    if (Array.isArray(ls) && ls.length) {
      const ultimo = ls[ls.length - 1];
      const n = scoreNum(ultimo && (ultimo.value ?? ultimo.displayValue));
      if (n != null) return n;
    }
    return null;
  }
  function infoPlacarEvento(ev) {
    const comp = getPath(ev, ["competitions", 0], null);
    const cs = comp && Array.isArray(comp.competitors) ? comp.competitors : [];
    if (cs.length < 2) return null;
    const h = cs.find(x => x.homeAway === "home") || cs[0];
    const a = cs.find(x => x.homeAway === "away") || cs[1];
    const hId = dpSigla((h.team || {}).abbreviation) || dpSigla((h.team || {}).shortDisplayName) || dpSigla((h.team || {}).displayName) || (h.team || {}).abbreviation;
    const aId = dpSigla((a.team || {}).abbreviation) || dpSigla((a.team || {}).shortDisplayName) || dpSigla((a.team || {}).displayName) || (a.team || {}).abbreviation;
    const hs = placarCompetidor(h), as = placarCompetidor(a);
    if (!hId || !aId || hs == null || as == null) return null;
    return { comp, home: h, away: a, hId, aId, hs, as, state: estadoEvento(ev) };
  }
  function eventoTemPlacar(ev) {
    return !!infoPlacarEvento(ev);
  }
  function eventoEhGrupo(ev) {
    const slug = ((ev && ev.season && ev.season.slug) || "").toLowerCase();
    if (slug === "group-stage") return true;
    if (slug && slug !== "group-stage") return false;
    // Segurança: alguns retornos do scoreboard diário vêm sem season.slug.
    // Nesse caso, identifica pelo par de seleções cadastrado em selecoes.json.
    const info = infoPlacarEvento(ev);
    if (info) return !!grupoDoJogo(info.home, info.away);
    const cs = getPath(ev, ["competitions", 0, "competitors"], []);
    if (!Array.isArray(cs) || cs.length < 2) return false;
    const h = cs.find(x => x.homeAway === "home") || cs[0];
    const a = cs.find(x => x.homeAway === "away") || cs[1];
    return !!grupoDoJogo(h, a);
  }
  function preferirEvento(novo, antigo, prioridadeDiaria) {
    if (!antigo) return novo;
    const en = estadoEvento(novo), ea = estadoEvento(antigo);
    // O scoreboard diário é o que atualiza placar ao vivo com mais rapidez.
    // Quando ele traz o mesmo jogo, ele deve sobrescrever o retorno grande da fase.
    if (prioridadeDiaria && (en !== "pre" || eventoTemPlacar(novo))) return novo;
    if (en === "in" && ea !== "in") return novo;
    if (en === "post" && ea !== "post") return novo;
    if (eventoTemPlacar(novo) && !eventoTemPlacar(antigo)) return novo;
    const sn = getPath(novo, ["competitions", 0, "status", "displayClock"], "");
    const sa = getPath(antigo, ["competitions", 0, "status", "displayClock"], "");
    if (en === "in" && sn && sn !== sa) return novo;
    return antigo;
  }
  async function buscarGruposEvents() {
    // Cache bem curto: a tabela de grupos deve reagir quase junto com o placar ao vivo.
    if (GRP_EVENTS.length && (Date.now() - GRP_EVENTS_TS) < 8000) return GRP_EVENTS;
    try {
      const mapa = new Map();
      const adicionar = (evs, prioridadeDiaria) => {
        (evs || []).filter(eventoEhGrupo).forEach(ev => {
          const id = String(ev.id || getPath(ev, ["competitions", 0, "id"], ""));
          if (!id) return;
          mapa.set(id, preferirEvento(ev, mapa.get(id), !!prioridadeDiaria));
        });
      };

      // 1) Busca geral da fase de grupos, para trazer todos os jogos.
      const geral = await fetchJSONNoCache(`${API}?dates=20260611-20260627&limit=120`);
      adicionar(geral.events || [], false);

      // 2) Sobrepõe com scoreboards diários, que são os mais frescos para jogos AO VIVO.
      // Usa janela maior para cobrir fuso/UTC e jogos perto da virada do dia.
      const base = ymdToDate(hojeYMD());
      const dias = [-2, -1, 0, 1, 2].map(off => dateToYMD(new Date(base.getTime() + off * 864e5)));
      await Promise.all(dias.map(async dstr => {
        try {
          const dd = await fetchJSONNoCache(`${API}?dates=${dstr}&limit=80`);
          adicionar(dd.events || [], true);
        } catch (e) { /* ignora um dia que falhe */ }
      }));

      GRP_EVENTS = Array.from(mapa.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
      GRP_EVENTS_TS = Date.now();
    } catch (e) { /* mantém o cache anterior se a busca falhar */ }
    return GRP_EVENTS;
  }
  function nomeDe(id) { const t = SEL.find(x => x.id === id); return t ? t.nome : id; }
  // ====== ABA MATA-MATA (chaveamento "as it stands") ======
  // converte os resultados dos grupos (ESPN) para o formato do engine (placaresGrupos)
  function placaresGruposDaESPN(events) {
    const res = [];
    const jogosBase = COPA_ENGINE.gerarJogosGrupos(SEL); // tem jogo_id, a, b
    events.forEach(ev => {
      const info = infoPlacarEvento(ev);
      // Só entra jogo iniciado/encerrado. Jogo futuro 0x0 não pode virar empate.
      if (!info || info.state === "pre") return;
      const jb = jogosBase.find(j => (j.a === info.hId && j.b === info.aId) || (j.a === info.aId && j.b === info.hId));
      if (!jb) return;
      // respeita a ordem a/b do jogo base
      if (jb.a === info.hId) res.push({ jogo_id: jb.jogo_id, ga: info.hs, gb: info.as });
      else res.push({ jogo_id: jb.jogo_id, ga: info.as, gb: info.hs });
    });
    return res;
  }


  // casa um confronto (par de ids) com o jogo real da ESPN no mata-mata (pra placar/horário)
  function eventoMataDe(idA, idB, mataEvents) {
    if (!idA || !idB) return null;
    return (mataEvents || []).find(ev => {
      const cs = ev.competitions[0].competitors;
      const x = dpSigla((cs[0].team || {}).abbreviation) || (cs[0].team || {}).abbreviation;
      const y = dpSigla((cs[1].team || {}).abbreviation) || (cs[1].team || {}).abbreviation;
      return (x === idA && y === idB) || (x === idB && y === idA);
    }) || null;
  }

  // monta uma caixa de confronto (times + placar + horário)
  function caixaConfronto(idA, idB, mataEvents) {
    const ev = eventoMataDe(idA, idB, mataEvents);
    let linhaInfo = "", scoreA = "", scoreB = "", vA = "", vB = "";
    if (ev) {
      const comp = ev.competitions[0], st = comp.status.type, cs = comp.competitors;
      const h = cs.find(c => c.homeAway === "home") || cs[0];
      const a = cs.find(c => c.homeAway === "away") || cs[1];
      const hId = dpSigla((h.team || {}).abbreviation) || (h.team || {}).abbreviation;
      const hs = h.score, as = a.score;
      // alinha placar com idA/idB
      const aScore = (hId === idA) ? hs : as, bScore = (hId === idA) ? as : hs;
      if (st.state === "post") {
        scoreA = `<b>${aScore ?? ""}</b>`; scoreB = `<b>${bScore ?? ""}</b>`;
        if (h.winner) { if (hId === idA) vA = "mm-venc"; else vB = "mm-venc"; }
        else if (a.winner) { if (hId === idA) vB = "mm-venc"; else vA = "mm-venc"; }
        // disputa de pênaltis: a ESPN traz shootoutScore quando o jogo foi decidido nos pênaltis
        const hPen = h.shootoutScore, aPen = a.shootoutScore;
        if (hPen != null && aPen != null) {
          const aPenV = (hId === idA) ? hPen : aPen, bPenV = (hId === idA) ? aPen : hPen;
          linhaInfo = `<div class="mm-info">Encerrado · <span class="mm-pen">pênaltis ${aPenV}-${bPenV}</span></div>`;
        } else {
          linhaInfo = `<div class="mm-info">Encerrado</div>`;
        }
      } else if (st.state === "in") {
        scoreA = `<b class="mm-live">${aScore ?? ""}</b>`; scoreB = `<b class="mm-live">${bScore ?? ""}</b>`;
        linhaInfo = `<div class="mm-info mm-aovivo">● ${comp.status.displayClock || "ao vivo"}</div>`;
      } else {
        const d = new Date(ev.date);
        const dia = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
        linhaInfo = `<div class="mm-info">${dia} · ${horaBR(ev.date)}</div>`;
      }
    }
    const time = (id, score, vcls) => {
      if (!id) return `<div class="mm-time mm-tbd"><span class="mm-nome">A definir</span></div>`;
      const fl = dpFlag(id, 40);
      return `<div class="mm-time ${vcls}">${fl ? `<img src="${fl}" alt="">` : ""}<span class="mm-nome">${dpNome(id)}</span><span class="mm-score">${score}</span></div>`;
    };
    return `<div class="mm-jogo">${time(idA, scoreA, vA)}${time(idB, scoreB, vB)}${linhaInfo}</div>`;
  }

  // ranking "quem acertou as seleções que avançaram" (sem importar posição/cruzamento)
  function rankingSelecoesHTML(d) {
    if (!PALP.length) return "";
    // fases com seleções já definidas (só mostra a linha se a fase tem gente avançando)
    const fases = [
      { rot: "Classificados (32)", real: d.classificados32 || [], campo: "classificados32" },
      { rot: "Oitavas (16)", real: d.avancam_oitavas || [], campo: "avancam_oitavas" },
      { rot: "Quartas (8)", real: d.avancam_quartas || [], campo: "avancam_quartas" },
      { rot: "Semifinais (4)", real: d.semifinalistas || [], campo: "semifinalistas" },
      { rot: "Finalistas (2)", real: d.finalistas || [], campo: "finalistas" }
    ].filter(f => f.real.length > 0);

    // deriva cada palpite e conta a interseção por fase
    const linhas = PALP.map(p => {
      let pd;
      try { pd = COPA_ENGINE.derivar(SEL, pgToArr(p.pg), {}, ESTRUT, TERMAP); }
      catch (e) { pd = null; }
      // Sobrescreve as fases do mata-mata com as listas auditadas (imutáveis): como
      // o palpite é derivado sem placares de mata-mata ({}), as fases de avanço
      // viriam vazias. As listas com hash refletem quem cada um cravou avançando.
      const pmt = pd && canonicoDe(p.nome);
      if (pmt) {
        pd.classificados32 = pmt.classificados32 || pd.classificados32;
        pd.avancam_oitavas = pmt.avancam_oitavas || pd.avancam_oitavas;
        pd.avancam_quartas = pmt.avancam_quartas || pd.avancam_quartas;
        pd.semifinalistas = pmt.semifinalistas || pd.semifinalistas;
        pd.finalistas = pmt.finalistas || pd.finalistas;
      }
      const acertosPorFase = fases.map(f => {
        if (!pd) return 0;
        const setReal = new Set(f.real);
        return (pd[f.campo] || []).filter(id => setReal.has(id)).length;
      });
      // ordena pelo acerto da PRIMEIRA fase (32) como critério principal, depois as seguintes
      return { nome: p.nome, acertos: acertosPorFase, chave: acertosPorFase };
    });

    // ordena: mais acertos nas 32, desempate nas fases seguintes
    linhas.sort((a, b) => {
      for (let i = 0; i < a.acertos.length; i++) {
        if (b.acertos[i] !== a.acertos[i]) return b.acertos[i] - a.acertos[i];
      }
      return a.nome.localeCompare(b.nome);
    });

    const cabecalho = `<tr><th class="rs-nome">Apostador</th>${fases.map(f => `<th>${f.rot}</th>`).join("")}</tr>`;
    const corpo = linhas.map((l, i) => {
      const cels = l.acertos.map((n, j) => `<td><b>${n}</b><span class="rs-de">/${fases[j].real.length}</span></td>`).join("");
      return `<tr><td class="rs-nome">${i + 1}. ${l.nome}</td>${cels}</tr>`;
    }).join("");

    return `<div class="rs-box" id="rs-box" style="display:none">
      <p class="rs-leg">Quantas seleções que avançaram (ou estão avançando) cada um cravou — <b>não importa a posição nem o cruzamento</b>, só se a seleção certa passou.</p>
      <div class="rs-scroll"><table class="rs-tab"><thead>${cabecalho}</thead><tbody>${corpo}</tbody></table></div>
    </div>`;
  }
  // converte o placaresGrupos {jogo_id:{ga,gb}} para o array que o engine espera
  function pgToArr(pg) {
    return Object.keys(pg || {}).map(jid => ({ jogo_id: jid, ga: pg[jid].ga, gb: pg[jid].gb }));
  }

  // lê o fair play (cartões) do JSON gerado pelo robô (estável, rápido).
  // Antes buscava 38 summaries ao vivo — lento e oscilava quando algum falhava.
  async function buscarFairPlay() {
    if (Object.keys(FAIRPLAY).length && (Date.now() - FAIRPLAY_TS) < 300000) return FAIRPLAY;
    try {
      const j = await fetch("dados/fairplay.json?t=" + Date.now()).then(r => r.json());
      FAIRPLAY = j.fairplay || {};
      FAIRPLAY_TS = Date.now();
    } catch (e) { /* sem fair play: o engine cai pro ranking FIFA, ainda funciona */ }
    return FAIRPLAY;
  }

  async function renderMata() {
    $("#lista").innerHTML = abasHTML() + '<p class="vazio">Montando o chaveamento…</p>';
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
    if (!ESTRUT || !TERMAP) { $("#lista").innerHTML = abasHTML() + '<p class="vazio">Não foi possível carregar a estrutura do mata-mata.</p>'; document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba); return; }

    // 1) resultados dos grupos (as it stands)
    const grpEvents = await buscarGruposEvents();
    const placG = placaresGruposDaESPN(grpEvents);
    // 1b) fair play (cartões) — lido do JSON do robô; desempate antes do ranking FIFA
    const fp = await buscarFairPlay();
    // 2) roda o engine
    let d;
    try { d = COPA_ENGINE.derivar(SEL, placG, {}, ESTRUT, TERMAP, fp); }
    catch (e) { $("#lista").innerHTML = abasHTML() + '<p class="vazio">Erro ao calcular o chaveamento.</p>'; document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba); return; }
    MATA_CACHE = d;
    // 3) jogos reais do mata-mata na ESPN (placar/horário)
    if (!MATA_EVENTS.length || (Date.now() - MATA_EVENTS_TS) >= 90000) {
      try {
        const r = await fetch(`${API}?dates=20260628-20260719&limit=80&_=${Date.now()}`).then(x => x.json());
        MATA_EVENTS = (r.events || []).filter(e => ((e.season && e.season.slug) || "") !== "group-stage");
        MATA_EVENTS_TS = Date.now();
      } catch (e) { /* mantém cache anterior */ }
    }
    pintarFaseMata();
  }

  // desenha SÓ a fase selecionada (uma por vez, ocupando a tela no celular)
  function pintarFaseMata() {
    const d = MATA_CACHE; if (!d) return;
    const FASES = [
      { nome: "16-avos", jogos: d.r32.map(m => ({ a: m.a, b: m.b })) },
      { nome: "Oitavas", jogos: ESTRUT.arvore.filter(m => m.fase === "oitavas").map(m => d.timeDe[m.id] || {}) },
      { nome: "Quartas", jogos: ESTRUT.arvore.filter(m => m.fase === "quartas").map(m => d.timeDe[m.id] || {}) },
      { nome: "Semis", jogos: ESTRUT.arvore.filter(m => m.fase === "semifinais").map(m => d.timeDe[m.id] || {}) },
      { nome: "Final", jogos: ESTRUT.arvore.filter(m => m.fase === "final").map(m => d.timeDe[m.id] || {}) }
    ];
    // seletor de fases (pílulas)
    const pills = FASES.map(f =>
      `<button class="mm-pill ${FASE_MATA === f.nome ? "on" : ""}" data-fase="${f.nome}">${f.nome}</button>`
    ).join("");

    const faseAtual = FASES.find(f => f.nome === FASE_MATA) || FASES[0];
    const caixas = faseAtual.jogos.map(j => caixaConfronto(j.a, j.b, MATA_EVENTS)).join("");

    // a disputa de 3º entra junto da Final
    let extra = "";
    if (FASE_MATA === "Final") {
      const t3 = ESTRUT.arvore.find(m => m.fase === "terceiro");
      if (t3 && d.timeDe[t3.id]) {
        extra = `<div class="mm-3tit">Disputa de 3º lugar</div><div class="mm-fase-grid">${caixaConfronto(d.timeDe[t3.id].a, d.timeDe[t3.id].b, MATA_EVENTS)}</div>`;
      }
    }

    // após o fim da fase de grupos (mesma virada do Ranking Simulado), o chaveamento é oficial
    const VIRADA_MATA = new Date("2026-06-28T02:00:00-03:00").getTime();
    const oficial = Date.now() >= VIRADA_MATA;
    let aviso;
    if (oficial) {
      aviso = '<p class="mm-aviso">🏆 Chaveamento <b>oficial</b> do mata-mata.</p>';
    } else if (d.faltaMapa) {
      aviso = '<p class="mm-aviso">⚠️ O cruzamento exato ainda depende da definição dos grupos. Mostrando a melhor estimativa.</p>';
    } else {
      aviso = '<p class="mm-aviso">📊 Chaveamento <b>como está agora</b> — muda conforme os jogos avançam.</p>';
    }

    $("#lista").innerHTML = abasHTML() + aviso
      + `<div class="mm-pills">${pills}</div>`
      + `<div class="mm-fase-grid">${caixas}</div>`
      + extra
      + (PALP.length ? `<button class="rs-toggle" id="rs-toggle">🎯 Quem acertou as seleções que avançaram ▾</button>` + rankingSelecoesHTML(d) : "");
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
    document.querySelectorAll(".mm-pill[data-fase]").forEach(b => b.onclick = () => { FASE_MATA = b.dataset.fase; pintarFaseMata(); });
    const rsBtn = document.getElementById("rs-toggle");
    if (rsBtn) rsBtn.onclick = () => {
      const box = document.getElementById("rs-box"), ab = box.style.display === "none";
      box.style.display = ab ? "block" : "none";
      rsBtn.innerHTML = ab ? "🎯 Quem acertou as seleções que avançaram ▴" : "🎯 Quem acertou as seleções que avançaram ▾";
    };
  }

  // jogos de UM grupo, formatados (encerrado com placar; futuro/ao vivo com hora)
  function jogosDoGrupoHTML(events, G) {
    const jogos = (events || []).filter(ev => {
      const cs = ev.competitions[0].competitors;
      const h = cs.find(c => c.homeAway === "home") || cs[0];
      const a = cs.find(c => c.homeAway === "away") || cs[1];
      return grupoDoJogo(h, a) === G;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!jogos.length) return '<p class="jg-vazio">Sem jogos para mostrar.</p>';
    return jogos.map(ev => {
      const comp = ev.competitions[0], st = comp.status.type, cs = comp.competitors;
      const home = cs.find(c => c.homeAway === "home") || cs[0];
      const away = cs.find(c => c.homeAway === "away") || cs[1];
      const hAb = (home.team || {}).abbreviation, aAb = (away.team || {}).abbreviation;
      const info = infoPlacarEvento(ev);
      const hScore = info ? info.hs : (home.score ?? "");
      const aScore = info ? info.as : (away.score ?? "");
      const flagH = dpFlag(hAb, 40), flagA = dpFlag(aAb, 40);
      let meio, cls = "";
      if (st.state === "pre") {
        const d = new Date(ev.date);
        const dia = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
        meio = `<span class="jg-hora">${dia} · ${horaBR(ev.date)}</span>`;
      } else if (st.state === "in") {
        meio = `<span class="jg-placar jg-live">${hScore} × ${aScore}</span>`;
        cls = " jg-aovivo";
      } else {
        meio = `<span class="jg-placar">${hScore} × ${aScore}</span>`;
      }
      return `<div class="jg-row${cls}">
        <span class="jg-lado jg-h">${dpNome(hAb)} ${flagH ? `<img src="${flagH}" alt="">` : ""}</span>
        ${meio}
        <span class="jg-lado jg-a">${flagA ? `<img src="${flagA}" alt="">` : ""} ${dpNome(aAb)}</span>
      </div>`;
    }).join("");
  }
  function isoDe(id) { const t = SEL.find(x => x.id === id); return t ? t.iso2 : ""; }
  function flagId(id) { const c = isoDe(id); return c ? `<img src="https://flagcdn.com/w40/${c}.png" alt="" onerror="this.style.visibility='hidden'">` : ""; }
  function tabelaGrupos(events) {
    const tab = {};
    SEL.forEach(t => {
      (tab[t.grupo] = tab[t.grupo] || {})[t.id] = { id: t.id, j: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0, pts: 0 };
    });
    events.forEach(ev => {
      const info = infoPlacarEvento(ev);
      // Só contabiliza jogo que já começou. Isso inclui o placar parcial ao vivo.
      if (!info || info.state === "pre") return;
      let g = null;
      for (const G in tab) {
        if (tab[G][info.hId] && tab[G][info.aId]) { g = G; break; }
      }
      if (!g) return;
      const H = tab[g][info.hId], A = tab[g][info.aId];
      const hs = info.hs, as = info.as;
      H.j++; A.j++;
      H.gp += hs; H.gc += as;
      A.gp += as; A.gc += hs;
      if (hs > as) { H.v++; A.d++; H.pts += 3; }
      else if (as > hs) { A.v++; H.d++; A.pts += 3; }
      else { H.e++; A.e++; H.pts++; A.pts++; }
    });
    return tab;
  }


  // Ordenação oficial FIFA também durante jogos ao vivo.
  // A tabela acima calcula números (P/J/V/E/D/GP/GC/SG); esta função usa a
  // engine para ordenar cada grupo pelos critérios oficiais, inclusive fair play
  // quando o JSON já tiver sido atualizado pelo robô.
  function classificacaoGruposEngine(events, fairplay) {
    try {
      if (!COPA_ENGINE || !SEL || !SEL.length) return null;
      const plac = {};
      placaresGruposDaESPN(events).forEach(p => { plac[p.jogo_id] = p; });
      const jogos = COPA_ENGINE.gerarJogosGrupos(SEL);
      const seed = {}; SEL.forEach(s => { seed[s.id] = s.seed; });
      const porGrupo = {};
      jogos.forEach(j => {
        const p = plac[j.jogo_id];
        const jj = Object.assign({}, j, { ga: p ? p.ga : null, gb: p ? p.gb : null });
        (porGrupo[j.grupo] = porGrupo[j.grupo] || []).push(jj);
      });
      const out = {};
      Object.keys(porGrupo).sort().forEach(G => {
        const times = [...new Set(porGrupo[G].map(j => [j.a, j.b]).flat())];
        out[G] = COPA_ENGINE.classificarGrupo(porGrupo[G], times, seed, fairplay || {})
          .map(t => Object.assign({}, t, { grupo: G }));
      });
      return out;
    } catch (e) { return null; }
  }
  function renderGrupos() {
    $("#lista").innerHTML = abasHTML() + '<p class="vazio">Carregando tabela…</p>';
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
    buscarGruposEvents().then(async events => {
      if (ABA !== "grupos") return;
      const tab = tabelaGrupos(events);
      const fp = await buscarFairPlay();
      const classifEngine = classificacaoGruposEngine(events, fp);
      const ord = (a, b) => b.pts - a.pts || (b.gp - b.gc) - (a.gp - a.gc) || b.gp - a.gp || nomeDe(a.id).localeCompare(nomeDe(b.id));
      const blocos = Object.keys(tab).sort().map(G => {
        const listaOrdenada = (classifEngine && classifEngine[G])
          ? classifEngine[G].map(x => tab[G][x.id]).filter(Boolean)
          : Object.values(tab[G]).sort(ord);
        const linhas = listaOrdenada.map((t, i) => {
          const sg = t.gp - t.gc, cls = i < 2 ? "classif" : "";
          return `<tr class="${cls}"><td class="cpos">${i + 1}</td><td class="ctime">${flagId(t.id)} <span>${nomeDe(t.id)}</span></td><td><b>${t.pts}</b></td><td>${t.j}</td><td>${t.v}</td><td>${t.e}</td><td>${t.d}</td><td class="men">${t.gp}</td><td class="men">${t.gc}</td><td>${sg > 0 ? "+" + sg : sg}</td></tr>`;
        }).join("");
        const focado = (FOCO_GRUPO === G) ? " grp-focado" : "";
        const voltar = (FOCO_GRUPO === G && VOLTAR_JOGO)
          ? `<button class="voltar-jogo" data-voltar="${VOLTAR_JOGO}">‹ Voltar ao jogo</button>` : "";
        const jogosHTML = jogosDoGrupoHTML(events, G);
        return `<div class="grpcard${focado}" id="grp-${G}"><div class="grpcab">Grupo ${G}</div>${voltar}<table class="tabgrp"><thead><tr><th></th><th class="ctime">Seleção</th><th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th class="men">GP</th><th class="men">GC</th><th>SG</th></tr></thead><tbody>${linhas}</tbody></table>
          <button class="jg-toggle" data-jg-grupo="${G}">⚽ Ver jogos do grupo ▾</button>
          <div class="jg-box" id="jgs-${G}" style="display:none">${jogosHTML}</div>
        </div>`;
      }).join("");
      $("#lista").innerHTML = abasHTML() + '<p class="leg-grp">As <b>2 primeiras</b> de cada grupo avançam, mais os 8 melhores terceiros. Durante jogos ao vivo, a tabela é calculada <b>como está agora</b> e atualiza automaticamente.</p>' + blocos;
      document.querySelectorAll(".vbtn").forEach(b => b.onclick = trocarAba);
      // toggle dos jogos do grupo
      document.querySelectorAll(".jg-toggle[data-jg-grupo]").forEach(b => b.onclick = () => {
        const d = document.getElementById("jgs-" + b.dataset.jgGrupo), ab = d.style.display === "none";
        d.style.display = ab ? "block" : "none";
        b.innerHTML = ab ? "⚽ Ocultar jogos do grupo ▴" : "⚽ Ver jogos do grupo ▾";
      });
      document.querySelectorAll(".voltar-jogo[data-voltar]").forEach(b => b.onclick = () => {
        const idJogo = b.dataset.voltar;
        ABA = "jogos";
        $("#prev").parentElement.style.display = "";
        FOCO_GRUPO = null; VOLTAR_JOGO = null;
        carregar().then(() => {
          const alvo = document.getElementById("jogo-" + idJogo);
          if (alvo) { alvo.scrollIntoView({ behavior: "smooth", block: "center" }); alvo.classList.add("jogo-destaque"); setTimeout(() => alvo.classList.remove("jogo-destaque"), 2000); }
        });
      });
      // rola até o grupo focado
      if (FOCO_GRUPO) {
        const alvo = document.getElementById("grp-" + FOCO_GRUPO);
        if (alvo) setTimeout(() => alvo.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
      }
    });
  }
  function trocarAba(e) {
    const v = e.currentTarget.dataset.v; if (v === ABA) return;
    ABA = v;
    FOCO_GRUPO = null; VOLTAR_JOGO = null; // entrada normal: sem grupo focado
    if (ABA === "grupos") { $("#prev").parentElement.style.display = "none"; renderGrupos(); }
    else if (ABA === "mata") { $("#prev").parentElement.style.display = "none"; renderMata(); }
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
    // grupo do jogo (só na fase de grupos): link que leva à Tabela dos Grupos
    let grupoTag = "";
    if (slug === "group-stage") {
      const gJogo = grupoDoJogo(home, away);
      if (gJogo) grupoTag = `<button class="grupo-link" data-grupo="${gJogo}" data-jogo="${ev.id}">Grupo ${gJogo} ›</button>`;
    }
    return `<div class="jogo" id="jogo-${ev.id}">
      <div class="topo"><span class="fase">${fase}</span>${grupoTag}${badge}</div>
      <div class="linha">
        <div class="lado ${vencH}">${escudo(home)}<span class="t">${teamNome(home)}</span></div>
        ${meio}
        <div class="lado f ${vencA}"><span class="t">${teamNome(away)}</span>${escudo(away)}</div>
      </div>
      ${st.state !== "pre" ? `<div class="gols-jogo" id="gols-${ev.id}" aria-label="Gols e cartões vermelhos"></div>` : ""}
      ${venue ? `<div class="venue">${venue}</div>` : ""}
      ${(st.state === "post" && momentoDe((home.team || {}).abbreviation, (away.team || {}).abbreviation))
        ? blocoMomento((home.team || {}).abbreviation, (away.team || {}).abbreviation)
        : tvChips((home.team || {}).abbreviation, (away.team || {}).abbreviation)}
      ${palpites}
    </div>`;
  }

  // descobre o grupo de um jogo pela sigla de um dos times (via DE-PARA + selecoes.json)
  function grupoDoJogo(home, away) {
    const hAb = dpSigla((home.team || {}).abbreviation) || (home.team || {}).abbreviation;
    const aAb = dpSigla((away.team || {}).abbreviation) || (away.team || {}).abbreviation;
    const t = SEL.find(x => x.id === hAb) || SEL.find(x => x.id === aAb);
    return t ? t.grupo : null;
  }

  // palpites de todos para UM jogo de grupo (recolhido)
  function palpiteBloco(ev, home, away, st) {
    if (!PALP.length || !JOGOS.length) return "";
    const hId = home.team && home.team.abbreviation, aId = away.team && away.team.abbreviation;
    const j = JOGOS.find(x => (x.a === hId && x.b === aId) || (x.a === aId && x.b === hId));
    if (!j) return "";
    const inv = (j.a !== hId); // ESPN mostra invertido em relação à engine?
    const jogado = st.state !== "pre";
    let ra, rb;
    if (jogado) {
      const hs = parseInt(home.score || "0", 10), as = parseInt(away.score || "0", 10);
      ra = hs; rb = as; // já na ordem da ESPN (mandante x visitante)
    }
    let ac = 0;
    const rows = PALP.map(p => {
      const graw = p.pg[j.jogo_id];
      if (!graw) return `<div class="prow"><span>${p.nome}</span><span class="pal">—</span></div>`;
      // orienta o palpite na MESMA ordem da exibição (ESPN/mandante)
      const pga = inv ? graw.gb : graw.ga, pgb = inv ? graw.ga : graw.gb;
      let tag = "";
      if (jogado) {
        const exato = pga === ra && pgb === rb;
        const certo = Math.sign(pga - pgb) === Math.sign(ra - rb);
        if (certo) ac++;
        const rotuloEx = st.state === "post" ? "CRAVOU" : "CRAVANDO";
        tag = exato ? `<span class="cravou">${rotuloEx} 🎯</span>` : `<span class="bola ${certo ? "v" : "x"}"></span>`;
      } else { tag = '<span class="aguard">aguardando</span>'; }
      return `<div class="prow"><span>${p.nome}</span><span class="pal">${pga} - ${pgb}${tag}</span></div>`;
    }).join("");
    const cnt = jogado ? `${ac} de ${PALP.length} acertaram o resultado` : "Palpites de todos (jogo ainda não começou)";
    return `<button class="vermais" data-sp="${ev.id}">Ver palpites (${PALP.length}) ▾</button>
      <div class="subpal" id="sp-${ev.id}" style="display:none"><div class="subcnt">${cnt}</div>${rows}</div>`;
  }

  function teamNome(c) { return dpNome((c.team && c.team.abbreviation) || (c.team && c.team.displayName)); }
  function escudo(c) {
    const ab = (c.team && c.team.abbreviation) || (c.team && c.team.displayName);
    const tit = dpNome(ab);
    const fl = dpFlag(ab, 80) || (c.team && c.team.logo) || "";
    return fl ? `<img src="${fl}" alt="" title="${tit}" onerror="this.style.visibility='hidden'">` : "";
  }
  function faseLabel(slug) {
    const map = { "group-stage": "Fase de grupos", "round-of-32": "Segunda fase", "round-of-16": "Oitavas", "quarterfinals": "Quartas", "semifinals": "Semifinal", "third-place": "Disputa de 3º", "final": "Final" };
    return map[slug] || "Copa do Mundo";
  }

  async function baixarICSJogos(btn) {
    const txtOrig = btn.textContent;
    btn.textContent = "⏳ Gerando seu calendário…";
    btn.disabled = true;
    try {
      // busca todos os jogos da Copa (mesma janela do onde-assistir)
      const data = await fetch(API + "?dates=20260611-20260719&limit=200").then(r => r.json());
      const pad = n => (n < 10 ? "0" : "") + n;
      const dt = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00Z";
      const linhas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bolao Copa 2026//PT-BR", "CALSCALE:GREGORIAN"];
      (data.events || []).forEach(ev => {
        const c = ev.competitions[0], cs = c.competitors;
        const home = cs.find(x => x.homeAway === "home") || cs[0];
        const away = cs.find(x => x.homeAway === "away") || cs[1];
        const ini = new Date(ev.date), fim = new Date(ini.getTime() + 2 * 3600 * 1000);
        const an = dpNome((home.team || {}).abbreviation), bn = dpNome((away.team || {}).abbreviation);
        const venue = c.venue ? c.venue.fullName + (c.venue.address && c.venue.address.city ? " · " + c.venue.address.city : "") : "";
        linhas.push("BEGIN:VEVENT");
        linhas.push("UID:" + ev.id + "@brasileirao2026almoco");
        linhas.push("DTSTAMP:" + dt(new Date()));
        linhas.push("DTSTART:" + dt(ini));
        linhas.push("DTEND:" + dt(fim));
        linhas.push("SUMMARY:" + an + " x " + bn + " — Copa 2026");
        if (venue) linhas.push("LOCATION:" + venue.replace(/,/g, "\\,"));
        linhas.push("DESCRIPTION:Copa do Mundo 2026. Acompanhe o bolão em brasileirao2026almoco.com.br/copa2026");
        linhas.push("END:VEVENT");
      });
      linhas.push("END:VCALENDAR");
      const blob = new Blob([linhas.join("\r\n")], { type: "text/calendar;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "copa-2026-jogos.ics";
      document.body.appendChild(a); a.click(); a.remove();
      btn.textContent = "✅ Pronto! Abra o arquivo pra adicionar";
      setTimeout(() => { btn.textContent = txtOrig; btn.disabled = false; }, 4000);
    } catch (e) {
      btn.textContent = "❌ Erro ao gerar. Tente de novo";
      setTimeout(() => { btn.textContent = txtOrig; btn.disabled = false; }, 3000);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    dia = clamp(hojeYMD());
    await carregarBase();
    $("#prev").onclick = () => { dia = clamp(dateToYMD(new Date(ymdToDate(dia).getTime() - 864e5))); carregar(); };
    $("#next").onclick = () => { dia = clamp(dateToYMD(new Date(ymdToDate(dia).getTime() + 864e5))); carregar(); };
    const bcal = $("#btn-cal-jogos"); if (bcal) bcal.onclick = () => baixarICSJogos(bcal);
    carregar();
    timer = setInterval(() => {
      if (ABA === "jogos") carregar();
      else if (ABA === "grupos") renderGrupos();
      else if (ABA === "mata") renderMata();
    }, 30000);
  });
})();
