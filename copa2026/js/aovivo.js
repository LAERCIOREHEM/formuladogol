/* =========================================================================
   aovivo.js — Tela "AO VIVO" (Copa 2026)
   Lê o feed da ESPN. Fora da janela de jogo não atualiza; quando há jogo ao vivo (ou nos
   15 min de pré-jogo), mostra a tela cheia; quando acaba (status oficial),
   sai sozinho. Esta versão pública carrega somente dados esportivos.
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
  function selecaoLinkHTML(id, conteudo, classeExtra) {
    var sig = dpSigla(id);
    if (!sig) return conteudo;
    var nomeSel = dpNome(sig);
    var cls = classeExtra ? " " + classeExtra : "";
    return `<a class="team-link${cls}" href="selecoes.html#${encodeURIComponent(sig)}" title="Ver seleção: ${escTxt(nomeSel)}" aria-label="Ver seleção ${escTxt(nomeSel)}">${conteudo}</a>`;
  }

  const $ = s => document.querySelector(s);
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const SUMMARY_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary";
  const DEMO = /[?&]demo=1/.test(location.search);
  const PRE_MIN = 15;                 // abre 15 min antes do início oficial
  const LIVE_REFRESH_MS = 30000;        // durante jogo/janela ativa
  const LIVE_POST_MS = 60 * 60 * 1000; // 1h após fim detectado/estimado
  const LIVE_ESTIMATED_GAME_MS = 4 * 60 * 60 * 1000;
  const LIVE_OPEN_WINDOW_MS = 8 * 60 * 60 * 1000;
  const LIVE_RECHECK_MS = 12 * 60 * 60 * 1000;
  const LIVE_DONE_KEY = "copa2026_aovivo_post_";
  const ESPN_OVR = {};               // se alguma sigla da ESPN diferir do nosso id, mapear aqui (ex.: {"GER":"ALE"})
  let DADOS = {}, JOGOS = [], PART = [], timer = null;
  let TVS = {};
  let RANKING_SITE = {}; // sigla -> {pos, indice}; usado só no card Ao vivo
  let LANCES_CACHE = {}; // eventId -> {ts, dados}; gols ao vivo exibidos no card
  let LIVES = {};
  let AGENDA_COPA = [];

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

  function fmtIndiceRank(v) {
    const n = Number(v);
    if (!isFinite(n)) return "";
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  function montarRankingAoVivo(dados) {
    const arr = ((dados && dados.ranking) || []).slice().sort((a, b) =>
      Number(b.indice_final || 0) - Number(a.indice_final || 0) || String(a.nome || a.equipe || "").localeCompare(String(b.nome || b.equipe || ""), "pt-BR")
    );
    const map = {};
    arr.forEach((item, idx) => {
      const sig = dpSigla(item.equipe || item.sigla || item.nome);
      const indice = Number(item.indice_final);
      if (sig && isFinite(indice)) map[sig] = { pos: Number(item.posicao || idx + 1), indice };
    });
    return map;
  }
  function rankBadgeAoVivo(id) {
    const sig = dpSigla(id);
    const r = sig && RANKING_SITE[sig];
    if (!r || !r.pos || !isFinite(Number(r.indice))) return "";
    return `<div class="live-team-rank" title="Ranking de Desempenho: ${escTxt(r.pos)}º · índice ${escTxt(fmtIndiceRank(r.indice))}">${escTxt(r.pos)}º · ${escTxt(fmtIndiceRank(r.indice))}</div>`;
  }


  function venueDaESPN(ev) {
    const comp = getPath(ev, ["competitions", 0], {}) || {};
    const v = comp.venue || ev.venue || {};
    if (!v || typeof v !== "object") return "";
    const nome = v.fullName || v.displayName || v.name || v.shortName || "";
    const addr = v.address || {};
    const cidade = [addr.city, addr.state || addr.country].filter(Boolean).join(", ");
    const txt = [nome, cidade].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
    return txt;
  }
  function agendaLocalJogo(ev, hAb, aAb) {
    const hId = dpSigla(hAb) || hAb;
    const aId = dpSigla(aAb) || aAb;
    const hNome = dpNorm(dpNome(hId));
    const aNome = dpNorm(dpNome(aId));
    const dt = new Date(ev && ev.date ? ev.date : 0).getTime();
    if (!dt || !isFinite(dt) || !AGENDA_COPA.length) return "";
    let melhor = null;
    let melhorDif = Infinity;
    (AGENDA_COPA || []).forEach(function (j) {
      if (!j || !j.local || !j.inicio_brt || !j.descricao) return;
      const desc = dpNorm(j.descricao);
      if (!(desc.indexOf(hNome) !== -1 && desc.indexOf(aNome) !== -1)) return;
      const jd = new Date(j.inicio_brt).getTime();
      const dif = Math.abs(jd - dt);
      if (dif < melhorDif && dif <= 6 * 60 * 60 * 1000) {
        melhor = j;
        melhorDif = dif;
      }
    });
    return melhor ? String(melhor.local || "").trim() : "";
  }
  function localJogoHTML(ev, hAb, aAb, classe) {
    const local = venueDaESPN(ev) || agendaLocalJogo(ev, hAb, aAb);
    if (!local) return "";
    return `<div class="${classe || "live-venue"}" title="Local da partida">🏟️ <span>${escTxt(local)}</span></div>`;
  }

  function statsBlocoAoVivo(ev, home, away) {
    if (!window.COPA_JOGO_STATS || !ev || !ev.id) return "";
    const hAb = (home.team && (home.team.abbreviation || home.team.displayName)) || "";
    const aAb = (away.team && (away.team.abbreviation || away.team.displayName)) || "";
    const hId = dpSigla(hAb) || hAb;
    const aId = dpSigla(aAb) || aAb;
    return window.COPA_JOGO_STATS.bloco({
      eventId: ev.id,
      homeId: hId,
      awayId: aId,
      homeName: dpNome(hId),
      awayName: dpNome(aId),
      live: estadoEventoAoVivo(ev) === "in"
    });
  }

  async function init() {
    try { TVS = await fetch("dados/transmissoes.json").then(r => r.json()); } catch (e) { TVS = {}; }
    try { LIVES = (await fetch("dados/lives.json?t=" + Date.now()).then(r => r.json())).jogos || {}; } catch (e) { LIVES = {}; }
    try { AGENDA_COPA = (await fetch("dados/agenda_workflow_copa.json?t=" + Date.now()).then(r => r.json())).jogos || []; } catch (e) { AGENDA_COPA = []; }
    try { RANKING_SITE = montarRankingAoVivo(await fetch("dados/ranking-desempenho.json?t=" + Date.now()).then(r => r.json())); } catch (e) { RANKING_SITE = {}; }
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
    PART = [];
    loop();
  }

  function estadoEventoAoVivo(ev) {
    return getPath(ev, ["competitions", 0, "status", "type", "state"], "pre");
  }
  function statusTextoAoVivo(ev) {
    const st = getPath(ev, ["competitions", 0, "status"], {}) || {};
    const tp = st.type || {};
    return [
      st.displayClock, st.period, st.detail, st.shortDetail,
      tp.id, tp.name, tp.description, tp.detail, tp.shortDetail, tp.state, tp.completed
    ].filter(v => v != null && v !== "").join(" ").toLowerCase();
  }
  function eventoAoVivoOuAtrasado(ev) {
    const state = estadoEventoAoVivo(ev);
    const txt = statusTextoAoVivo(ev);
    if (state === "in") return true;
    return /delay|delayed|weather|suspend|suspended|postpon|adiad|atras|chuva|clima|interromp|penalt|shootout|extra time|overtime|halftime|half time|intervalo/.test(txt);
  }
  function eventoIdAoVivo(ev) {
    return String((ev && (ev.id || getPath(ev, ["competitions", 0, "id"], ""))) || "");
  }
  function postDetectadoAoVivoMs(ev, inicio, agora) {
    const id = eventoIdAoVivo(ev);
    if (!id || typeof localStorage === "undefined") return 0;
    const key = LIVE_DONE_KEY + id;
    const salvo = parseInt(localStorage.getItem(key) || "0", 10);
    if (salvo > 0) return salvo;
    if (agora >= inicio - PRE_MIN * 60000 && agora <= inicio + LIVE_ESTIMATED_GAME_MS) {
      try { localStorage.setItem(key, String(agora)); } catch (e) {}
      return agora;
    }
    return 0;
  }
  function fimEstimadoAoVivoMs(ev, inicio, agora) {
    if (estadoEventoAoVivo(ev) === "post") {
      const detectado = postDetectadoAoVivoMs(ev, inicio, agora);
      if (detectado) return detectado;
    }
    return inicio + LIVE_ESTIMATED_GAME_MS;
  }
  function eventoPedeLoop(ev, agoraMs) {
    if (!ev || !ev.date) return false;
    const inicio = new Date(ev.date).getTime();
    if (!isFinite(inicio)) return false;
    const agora = agoraMs || Date.now();
    const state = estadoEventoAoVivo(ev);
    const preMs = PRE_MIN * 60000;

    if (eventoAoVivoOuAtrasado(ev)) {
      return agora >= inicio - preMs && agora <= inicio + LIVE_OPEN_WINDOW_MS;
    }
    if (state === "post") {
      const fim = fimEstimadoAoVivoMs(ev, inicio, agora);
      return agora >= inicio - preMs && agora <= fim + LIVE_POST_MS;
    }
    return agora >= inicio - preMs && agora <= inicio + LIVE_OPEN_WINDOW_MS;
  }
  function inicioJanelaAoVivo(ev) {
    if (!ev || !ev.date) return Infinity;
    const t = new Date(ev.date).getTime();
    return isFinite(t) ? t - PRE_MIN * 60000 : Infinity;
  }
  function proximoInicioAoVivo(events, agora) {
    let prox = Infinity;
    (events || []).forEach(ev => {
      const ini = inicioJanelaAoVivo(ev);
      if (ini > agora && ini < prox) prox = ini;
    });
    return prox;
  }
  function agendarLoop(delay) {
    if (timer) clearTimeout(timer);
    const d = Math.max(15000, Math.min(delay || LIVE_RECHECK_MS, LIVE_RECHECK_MS));
    timer = setTimeout(loop, d);
  }
  function delayProximoLoop(events) {
    const agora = Date.now();
    if ((events || []).some(ev => eventoPedeLoop(ev, agora))) return LIVE_REFRESH_MS;
    const prox = proximoInicioAoVivo(events || [], agora);
    if (isFinite(prox)) return Math.max(15000, Math.min(prox - agora, LIVE_RECHECK_MS));
    return LIVE_RECHECK_MS;
  }

  async function loop() {
    let data;
    // Calendário da Copa: permite saber quando acordar novamente sem ficar
    // atualizando a página fora de horário de jogo.
    const url = `${API}?dates=20260611-20260719&limit=200&_=${Date.now()}`;
    try { data = await (await fetch(url, { cache: "no-store" })).json(); }
    catch (e) {
      if (!DEMO) { $("#app").innerHTML = '<p class="vazio">Sem conexão com o feed agora. Tentando de novo…</p>'; agendarLoop(5 * 60 * 1000); return; }
      data = { events: [] };
    }

    const now = Date.now();
    const eventos = (data.events || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));

    // jogos REALMENTE ao vivo agora
    const noAr = eventos.filter(ev => estadoEventoAoVivo(ev) === "in");
    let lives;
    if (noAr.length) {
      // TRAVA: se tem jogo ao vivo de verdade, mostra SÓ ele(s).
      lives = noAr;
    } else {
      // ninguém ao vivo: mostra apenas jogos que estão na janela de pré-jogo/atraso.
      lives = eventos.filter(ev => {
        const st = estadoEventoAoVivo(ev);
        const dt = new Date(ev.date).getTime();
        if (st === "pre") {
          if (eventoAoVivoOuAtrasado(ev)) return now >= dt - PRE_MIN * 60000 && now <= dt + LIVE_OPEN_WINDOW_MS;
          return now >= dt - PRE_MIN * 60000 && now <= dt + 60 * 60000;
        }
        return false;
      });
    }

    let demoFlag = false;
    if (DEMO && !lives.length) { lives = [fabricar()]; demoFlag = true; }
    render(lives, data, demoFlag);
    agendarLoop(delayProximoLoop(eventos));
  }

  function idsStatsAbertos(root) {
    root = root || document;
    return Array.from(root.querySelectorAll("[data-jstats].open")).map(function (el) {
      return el.getAttribute("data-jstats");
    }).filter(Boolean);
  }
  function restaurarStatsAbertos(root, ids) {
    if (!ids || !ids.length || !window.COPA_JOGO_STATS) return;
    root = root || document;
    ids.forEach(function (id) {
      var host = root.querySelector("[data-jstats='" + String(id).replace(/'/g, "\\'") + "']");
      if (!host) return;
      var btn = host.querySelector("[data-jstats-btn]");
      host.classList.add("open");
      host.dataset.loaded = "1";
      if (btn) btn.innerHTML = "📊 Ocultar estatísticas ▴";
      if (COPA_JOGO_STATS.refreshHost) COPA_JOGO_STATS.refreshHost(host);
    });
  }
  function avisoStatsAoVivo(lives) {
    var tem = (lives || []).some(function (ev) { return estadoEventoAoVivo(ev) === "in"; });
    return tem ? '<div class="stat-live-status live-page-status">🔴 Estatísticas do jogo atualizando ao vivo a cada 30s</div>' : '';
  }

  function render(lives, data, demoFlag) {
    var app = $("#app");
    var abertos = idsStatsAbertos(app || document);
    if (!lives.length) {
      if (app) app.innerHTML = telaEspera(data);
      iniciarContadores();
      return;
    }
    app.innerHTML = (demoFlag ? '<div class="demobar">⚙ DEMONSTRAÇÃO — jogo simulado para validar o painel ao vivo.</div>' : "")
      + avisoStatsAoVivo(lives)
      + lives.map(ev => card(ev)).join("");
    carregarLancesAoVivo(lives);
    if (window.COPA_JOGO_STATS) {
      window.COPA_JOGO_STATS.bind(app);
      restaurarStatsAbertos(app, abertos);
      if (COPA_JOGO_STATS.refreshLive) COPA_JOGO_STATS.refreshLive(app);
    }
  }

  function ourGame(ev) {
    if ((ev.season && ev.season.slug) !== "group-stage") return null;
    const cs = ev.competitions[0].competitors;
    const h = norm((cs.find(c => c.homeAway === "home").team || {}).abbreviation);
    const a = norm((cs.find(c => c.homeAway === "away").team || {}).abbreviation);
    return JOGOS.find(j => (j.a === h && j.b === a) || (j.a === a && j.b === h)) || null;
  }

  // ===== Gols ao vivo no card =====
  // Mesmo princípio da aba Jogos: placar vem do scoreboard; marcadores vêm do summary ESPN.
  function escTxt(s) {
    return String(s || "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }
  function getPath(obj, path, def) {
    let cur = obj;
    for (const k of path) {
      if (cur && typeof cur === "object" && k in cur) cur = cur[k];
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
      const n = nomeAtleta(o[k]);
      if (n) return n;
    }
    for (const k of ["athletes", "participants", "athletesInvolved", "players"]) {
      const arr = o[k];
      if (Array.isArray(arr)) {
        for (const it of arr) {
          const n = nomeAtleta(it);
          if (n) return n;
        }
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
    for (const p of pats) {
      const m = txt.match(p);
      if (m && m[1] && m[1].length <= 60) return m[1].replace(/\s+/g, " ").trim();
    }
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
    const pares = [["homeScore", "awayScore"], ["home_score", "away_score"], ["homeTeamScore", "awayTeamScore"], ["home", "away"]];
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
      const arr = getPath(summary, p, []);
      if (Array.isArray(arr)) out.push(...arr);
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
  function extrairGols(summary, ev) {
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
    function scoreLance(lance) { return scoreDoLance(lance) || scoreDoTextoLocal(textoLance(lance)); }
    function ladoDoGol(lance) {
      const isOG = ehGolContra(lance);
      if (!isOG) {
        const sig = siglaObjTime(lance, mapaTimes);
        if (sig && homeSig && sig === homeSig) return { lado: "home", fonte: "time" };
        if (sig && awaySig && sig === awaySig) return { lado: "away", fonte: "time" };
      }
      const sigTxt = dpSigla(timeDoTexto(textoLance(lance)));
      if (!isOG && sigTxt) {
        if (sigTxt === homeSig) return { lado: "home", fonte: "texto" };
        if (sigTxt === awaySig) return { lado: "away", fonte: "texto" };
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
      let h = gols.filter(g => g.lado === "home").length;
      let a = gols.filter(g => g.lado === "away").length;
      gols.filter(g => !g.lado).sort((x, y) => ordemMinuto(x) - ordemMinuto(y)).forEach(g => {
        let faltaH = Math.max(0, finalHome - h);
        let faltaA = Math.max(0, finalAway - a);
        if (faltaH > 0 && faltaA <= 0) { g.lado = "home"; h++; return; }
        if (faltaA > 0 && faltaH <= 0) { g.lado = "away"; a++; return; }
        if (faltaH > faltaA) { g.lado = "home"; h++; return; }
        if (faltaA > faltaH) { g.lado = "away"; a++; return; }
      });
      h = gols.filter(g => g.lado === "home").length;
      a = gols.filter(g => g.lado === "away").length;
      gols.filter(g => !g.lado).sort((x, y) => ordemMinuto(x) - ordemMinuto(y)).forEach(g => {
        const faltaH = Math.max(0, finalHome - h);
        const faltaA = Math.max(0, finalAway - a);
        if (faltaH >= faltaA && faltaH > 0) { g.lado = "home"; h++; }
        else if (faltaA > 0) { g.lado = "away"; a++; }
        else { g.lado = h <= a ? "home" : "away"; if (g.lado === "home") h++; else a++; }
      });
    }
    function registrarGol(lance) {
      const og = ehGolContra(lance);
      const txt = textoLance(lance);
      const nome = (og ? (nomeGolContraDoTexto(txt) || jogadorDoLance(lance) || golDoTexto(txt)) : (jogadorDoLance(lance) || golDoTexto(txt)));
      if (!nome) return;
      const min = minutoDoLance(lance);
      const infoLado = ladoDoGol(lance);
      const key = min + "|" + nome.toLowerCase() + "|" + (og ? "OG" : "GOL");
      if (usados.has(key)) return;
      usados.add(key);
      gols.push({ minuto: min, nome: nome, lado: infoLado.lado, og: og });
      const sc = scoreLance(lance);
      if (sc) ultimoScore = sc;
    }

    arraysLances(summary).forEach(sp => {
      const raw = (textoTipo(sp) + " " + textoLance(sp)).toLowerCase();
      if (/shootout|penalty shootout|disputa de p[eê]naltis/.test(raw)) return;
      if (!(raw.includes("goal") || raw.includes("gol") || parseInt(sp.scoreValue || "0", 10) === 1)) return;
      registrarGol(sp);
    });
    arraysComentario(summary).forEach(ev2 => {
      const raw = (textoTipo(ev2) + " " + textoLance(ev2)).toLowerCase();
      if (/shootout|penalty shootout|disputa de p[eê]naltis/.test(raw)) return;
      const ehGol = raw.includes("goal") || raw.includes("gol!") || ehGolContra(ev2);
      if (!ehGol) return;
      registrarGol(ev2);
    });
    normalizarLadosDosGols();
    const ordenados = gols.slice().sort((x, y) => ordemMinuto(x) - ordemMinuto(y));
    return { gols: ordenados, golsHome: ordenados.filter(g => g.lado === "home"), golsAway: ordenados.filter(g => g.lado === "away") };
  }
  function chipGolAoVivo(g) {
    const og = g && g.og ? ` <span class="live-og-tag" title="Gol contra">OG</span>` : "";
    return `<span class="live-gol-chip">⚽ ${g.minuto ? escTxt(g.minuto) + " " : ""}${escTxt(g.nome)}${og}</span>`;
  }
  function htmlGolsAoVivo(dados) {
    if (!dados || !dados.gols || !dados.gols.length) return "";
    const home = (dados.golsHome || []).map(chipGolAoVivo).join("");
    const away = (dados.golsAway || []).map(chipGolAoVivo).join("");
    return `<div class="live-gols-time live-gols-home">${home}</div><div class="live-gols-centro"></div><div class="live-gols-time live-gols-away">${away}</div>`;
  }
  async function carregarLancesAoVivo(events) {
    const lista = (events || []).filter(ev => getPath(ev, ["competitions", 0, "status", "type", "state"], "pre") !== "pre");
    lista.forEach(async ev => {
      const id = ev.id;
      const el = document.getElementById("live-gols-" + id);
      if (!id || !el) return;
      try {
        let dados;
        const c = LANCES_CACHE[id];
        const ttl = 25000;
        if (c && (Date.now() - c.ts) < ttl) dados = c.dados;
        else {
          const summary = await fetch(`${SUMMARY_API}?event=${encodeURIComponent(id)}&_=${Date.now()}`).then(r => r.json());
          dados = extrairGols(summary, ev);
          LANCES_CACHE[id] = { ts: Date.now(), dados };
        }
        const alvo = document.getElementById("live-gols-" + id);
        if (alvo) alvo.innerHTML = htmlGolsAoVivo(dados);
      } catch (e) {
        // Sem lances não quebra o ao vivo; o placar segue normal.
      }
    });
  }

  function card(ev) {
    const comp = ev.competitions[0], st = comp.status.type, cs = comp.competitors;
    const home = cs.find(c => c.homeAway === "home") || cs[0];
    const away = cs.find(c => c.homeAway === "away") || cs[1];
    const hs = parseInt(home.score || "0", 10), as = parseInt(away.score || "0", 10);
    const pre = st.state === "pre";
    const minuto = pre ? "Pré-jogo" : (st.shortDetail || "Ao vivo");
    const timeId = c => (c.team && (c.team.abbreviation || c.team.displayName)) || "";
    const escudo = c => {
      const ab = timeId(c);
      const src = dpFlag(ab, 80) || (c.team && c.team.logo) || "";
      return src ? `<img src="${src}" alt="" title="${dpNome(ab)}" onerror="this.style.visibility='hidden'">` : "";
    };
    const tNome = c => dpNome(timeId(c));
    const timeAoVivoHTML = c => {
      const id = timeId(c);
      return selecaoLinkHTML(id, `${rankBadgeAoVivo(id)}${escudo(c)}<div class="nm">${escTxt(tNome(c))}</div>`, "team-link-live");
    };

    const palpHTML = "";

    return `<div class="placar ${pre ? "pre" : ""}">
      <div class="topo"><span class="fase">${faseLabel(ev)}</span>
        <span class="aovivo ${pre ? "preb" : ""}"><span class="pulse"></span> ${pre ? "Em breve" : "Ao vivo"}</span></div>
      <div class="lp">
        <div class="sel">${timeAoVivoHTML(home)}</div>
        <div class="escore"><div class="g">${pre ? "–" : hs}</div><div class="x">×</div><div class="g">${pre ? "–" : as}</div></div>
        <div class="sel">${timeAoVivoHTML(away)}</div>
      </div>
      ${pre ? "" : `<div class="live-gols-jogo" id="live-gols-${ev.id}" aria-label="Gols do jogo ao vivo"></div>`}
      <div class="minuto">${minuto}</div>
      ${localJogoHTML(ev, (home.team || {}).abbreviation, (away.team || {}).abbreviation, "live-venue")}
      ${tvChips((home.team || {}).abbreviation, (away.team || {}).abbreviation)}
      ${botaoCaze((home.team || {}).abbreviation, (away.team || {}).abbreviation)}
      ${statsBlocoAoVivo(ev, home, away)}
      ${palpHTML}
    </div>`;
  }

  // acha a live certa pro jogo no lives.json (gerado pelo robô).
  // Regra preferencial: usa link validado por confronto.
  // Fallback v27: durante a Copa, se o robô ainda não achou o link exato,
  // abre a live principal da CazéTV. Isso resolve casos em que o /live aponta
  // para o jogo da Copa, mas o título/YouTube API não permitiu validação exata.
  function chaveJogoCaze(aAb, bAb) {
    var sa = dpSigla(aAb) || aAb, sb = dpSigla(bAb) || bAb;
    return [sa, sb].sort().join("-");
  }
  function liveDoJogo(aAb, bAb) {
    return LIVES[chaveJogoCaze(aAb, bAb)] || null;
  }
  function linkCazeValidado(L) {
    if (!L || !L.url) return false;
    // Bloqueia os fallbacks problemáticos. O /live só poderia ser usado se o
    // robô marcasse expressamente como validado; na prática ele salva watch?v=.
    if (L.url.indexOf("@CazeTV/search") !== -1) return false;
    if (L.url.indexOf("@CazeTV/live") !== -1 && L.validado_confronto !== true) return false;
    return L.validado_confronto === true || L.fonte === "admin" || L.url.indexOf("watch?v=") !== -1 || L.url.indexOf("youtu.be/") !== -1;
  }
  function botaoCaze(aAb, bAb) {
    var L = liveDoJogo(aAb, bAb);
    if (linkCazeValidado(L)) {
      return `<a class="btn-caze" href="${L.url}" target="_blank" rel="noopener">▶️ Assistir ao vivo na CazéTV</a>`;
    }
    // Fallback operacional até o fim da Copa: a CazéTV tende a usar o /live
    // como transmissão principal dos jogos. Se o link exato ainda não foi
    // validado pelo robô, ainda assim oferecemos o atalho principal.
    return `<a class="btn-caze fallback" href="https://www.youtube.com/@CazeTV/live" target="_blank" rel="noopener" title="Fallback: abre a transmissão principal atual da CazéTV.">▶️ Abrir CazéTV ao vivo</a>`;
  }

  function faseLabel(ev) {
    const map = { "group-stage": "Fase de grupos", "round-of-32": "Segunda fase", "round-of-16": "Oitavas", "quarterfinals": "Quartas", "semifinals": "Semifinal", "third-place": "Disputa de 3º", "final": "Final" };
    return map[(ev.season && ev.season.slug)] || "Copa do Mundo";
  }
  // ===== Tela de espera (nenhum jogo ao vivo): cartaz do próximo jogo =====
  function frasePorHora(h) {
    // h = hora (0-23) do início do jogo, fuso de Brasília
    var manha = ["Começa o dia com Copa!", "Café da manhã com gol?", "Bom dia com futebol!"];
    var almoco = ["Prepara o lanche que já vem jogo!", "Hora do jogo da Copa!", "Separa o prato e chama a galera!"];
    var tarde = ["Larga tudo, é dia de Copa!", "A tarde é nossa e da bola!", "Chama a galera pro jogo!"];
    var noite = ["Esquenta que a noite é de Copa!", "Prepara o lanche, é jogo!", "Fim de dia é com futebol!"];
    var arr = h < 11 ? manha : h < 15 ? almoco : h < 18 ? tarde : noite;
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function cartazJogo(ev) {
    var cs = ev.competitions[0].competitors;
    var h = cs.find(c => c.homeAway === "home") || cs[0];
    var a = cs.find(c => c.homeAway === "away") || cs[1];
    var hAb = (h.team || {}).abbreviation || (h.team || {}).displayName;
    var aAb = (a.team || {}).abbreviation || (a.team || {}).displayName;
    var d = new Date(ev.date);
    var hora = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(d);
    var diaTxt = rotuloDiaJogo(d);
    var bandH = dpFlag(hAb, 160), bandA = dpFlag(aAb, 160);
    // grupo do jogo (só na fase de grupos)
    var grupoTag = "";
    if ((ev.season && ev.season.slug) === "group-stage") {
      var g = grupoDoJogoAV(hAb, aAb);
      if (g) grupoTag = `<div class="cz-grupo">Grupo ${g}</div>`;
    }
    var hConteudo = `${bandH ? `<img class="cz-flag" src="${bandH}" alt="">` : ""}<span class="cz-nome">${dpNome(hAb)}</span>`;
    var aConteudo = `${bandA ? `<img class="cz-flag" src="${bandA}" alt="">` : ""}<span class="cz-nome">${dpNome(aAb)}</span>`;
    return `<div class="cartaz">
      <div class="cz-tag">PRÓXIMO JOGO</div>
      ${grupoTag}
      <div class="cz-times">
        <div class="cz-time">
          ${selecaoLinkHTML(hAb, hConteudo, "team-link-cartaz")}
        </div>
        <span class="cz-x">×</span>
        <div class="cz-time">
          ${selecaoLinkHTML(aAb, aConteudo, "team-link-cartaz")}
        </div>
      </div>
      <div class="cz-quando">${diaTxt}, <b>${hora}</b> <span class="cz-bsb">(Brasília)</span></div>
      ${localJogoHTML(ev, hAb, aAb, "cz-venue")}
      <div class="cz-contador" data-inicio="${d.getTime()}">calculando…</div>
      <div class="cz-frase">${frasePorHora(horaBSB(d))}</div>
    </div>`;
  }
  // descobre o grupo do jogo pela sigla (via seleções carregadas)
  function grupoDoJogoAV(hAb, aAb) {
    var hId = dpSigla(hAb) || hAb, aId = dpSigla(aAb) || aAb;
    var sels = (DADOS.selecoes || []);
    var t = sels.find(x => x.id === hId) || sels.find(x => x.id === aId);
    return t ? t.grupo : null;
  }
  function horaBSB(d) {
    return parseInt(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(d), 10);
  }
  function rotuloDiaJogo(d) {
    var hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    var dia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
    var amanha = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() + 864e5));
    if (dia === hoje) return "Hoje";
    if (dia === amanha) return "Amanhã";
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" }).format(d);
  }
  function telaEspera(data) {
    var agora = Date.now();
    // só jogos realmente futuros (com 70min de tolerância, caso a ESPN demore a virar "in")
    var pres = (data.events || []).filter(e => e.competitions[0].status.type.state === "pre"
        && new Date(e.date).getTime() > agora - 70 * 60000)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!pres.length) {
      return `<div class="nada"><div class="bola">⚽</div>
        <h2>Sem jogos ao vivo agora</h2>
        <p>Os jogos da Copa aparecem aqui automaticamente quando começam.</p>
        <a href="onde-assistir.html" class="oa-destaque">📺 Onde assistir cada jogo da Copa (horários de Brasília) →</a>
        <a class="link" href="index.html">Ver todos os jogos →</a></div>`;
    }
    // jogos simultâneos: mesmo horário do primeiro "pre"
    var t0 = new Date(pres[0].date).getTime();
    var simultaneos = pres.filter(e => Math.abs(new Date(e.date).getTime() - t0) < 60000);
    var cartazes = simultaneos.map(cartazJogo).join("");
    var multi = simultaneos.length > 1 ? " multi" : "";
    return `<div class="espera">
      <a href="onde-assistir.html" class="oa-destaque">📺 Onde assistir cada jogo da Copa (horários de Brasília) →</a>
      <div class="cartazes${multi}">${cartazes}</div>
      <p class="cz-auto">⏱️ Deixe esta tela aberta: assim que a bola rolar, ela vira o jogo ao vivo sozinha.</p>
      <a class="link" href="index.html">Ver todos os jogos →</a>
    </div>`;
  }
  function iniciarContadores() {
    function tick() {
      document.querySelectorAll(".cz-contador").forEach(function (el) {
        var ini = parseInt(el.dataset.inicio, 10);
        var ms = ini - Date.now();
        if (ms <= 0) { el.textContent = "Começando agora!"; el.classList.add("cz-agora"); return; }
        var min = Math.floor(ms / 60000), hh = Math.floor(min / 60), mm = min % 60;
        el.textContent = "Começa em " + (hh > 0 ? hh + "h " : "") + mm + "min";
      });
    }
    tick();
    if (window._czTimer) clearInterval(window._czTimer);
    window._czTimer = setInterval(tick, 30000);
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
