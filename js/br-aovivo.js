(function () {
  "use strict";

  const SCOREBOARD_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard";
  const SUMMARY_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary";
  const REFRESH_MS = 30000;
  const TZ = "America/Sao_Paulo";

  const $ = (sel) => document.querySelector(sel);
  const app = $("#live-app");
  const switcher = $("#live-switcher");
  const badge = $("#live-update-badge");
  const alertBox = $("#live-alert");

  const CLUBES = {
    "athletico pr": "Athletico-PR", "athletico paranaense": "Athletico-PR", "atletico paranaense": "Athletico-PR",
    "atletico mg": "Atlético-MG", "atletico mineiro": "Atlético-MG", "clube atletico mineiro": "Atlético-MG",
    "bahia": "Bahia", "ec bahia": "Bahia", "esporte clube bahia": "Bahia",
    "botafogo": "Botafogo", "botafogo rj": "Botafogo", "botafogo de futebol e regatas": "Botafogo",
    "bragantino": "Bragantino", "rb bragantino": "Bragantino", "red bull bragantino": "Bragantino",
    "chapecoense": "Chapecoense", "associacao chapecoense de futebol": "Chapecoense",
    "corinthians": "Corinthians", "sc corinthians paulista": "Corinthians", "corinthians paulista": "Corinthians",
    "coritiba": "Coritiba", "coritiba fc": "Coritiba",
    "cruzeiro": "Cruzeiro", "cruzeiro ec": "Cruzeiro",
    "flamengo": "Flamengo", "cr flamengo": "Flamengo",
    "fluminense": "Fluminense", "fluminense fc": "Fluminense",
    "gremio": "Grêmio", "gremio fbpa": "Grêmio",
    "internacional": "Internacional", "sc internacional": "Internacional",
    "mirassol": "Mirassol", "mirassol fc": "Mirassol",
    "palmeiras": "Palmeiras", "se palmeiras": "Palmeiras",
    "remo": "Remo", "clube do remo": "Remo",
    "santos": "Santos", "santos fc": "Santos",
    "sao paulo": "São Paulo", "sao paulo fc": "São Paulo",
    "vasco": "Vasco da Gama", "vasco da gama": "Vasco da Gama", "cr vasco da gama": "Vasco da Gama",
    "vitoria": "Vitória", "ec vitoria": "Vitória"
  };

  const SIGLAS = {
    "Athletico-PR": "CAP", "Atlético-MG": "CAM", "Bahia": "BAH", "Botafogo": "BOT",
    "Bragantino": "RBB", "Chapecoense": "CHA", "Corinthians": "COR", "Coritiba": "CFC",
    "Cruzeiro": "CRU", "Flamengo": "FLA", "Fluminense": "FLU", "Grêmio": "GRE",
    "Internacional": "INT", "Mirassol": "MIR", "Palmeiras": "PAL", "Remo": "REM",
    "Santos": "SAN", "São Paulo": "SAO", "Vasco da Gama": "VAS", "Vitória": "VIT"
  };

  const state = {
    agenda: [],
    eventosLocais: [],
    diretos: [],
    transmissoes: {},
    selecionado: "",
    resumoPorId: {},
    ultimaAtualizacao: null,
    ultimaFalha: "",
    timer: null,
    tickTimer: null,
    carregando: false,
    primeiraCarga: true
  };

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function norm(v) {
    return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function canon(v) {
    const n = norm(v);
    if (!n) return "";
    if (CLUBES[n]) return CLUBES[n];
    for (const [k, nome] of Object.entries(CLUBES)) {
      if (n.includes(k) || k.includes(n)) return nome;
    }
    return String(v || "").trim();
  }

  function parseDate(v) {
    if (!v) return null;
    const s = String(v);
    const d = new Date(s.length <= 16 ? s + ":00-03:00" : s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function dateKey(d) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(d);
    const obj = {};
    parts.forEach((p) => { if (p.type !== "literal") obj[p.type] = p.value; });
    return [obj.year, obj.month, obj.day].join("-");
  }

  function compactDate(d) {
    return dateKey(d).replace(/-/g, "");
  }

  function formatDateTime(d) {
    if (!d) return "Horário a definir";
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(d).replace(/\s+às\s+/, ", ");
  }

  function formatShort(d) {
    if (!d) return "A definir";
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(d);
  }

  function formatClockTime(d) {
    return d ? new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d) : "";
  }

  function teamKey(a, b) {
    return canon(a) + "|" + canon(b);
  }

  function localTeam(raw) {
    const t = raw || {};
    const nome = canon(t.nome || t.displayName || t.name || t.shortDisplayName || t.abbreviation);
    return {
      id: String(t.id || ""),
      nome: nome || String(t.displayName || t.name || "Time"),
      sigla: t.sigla || t.abbreviation || SIGLAS[nome] || "",
      escudo: t.escudo || (Array.isArray(t.logos) && t.logos[0] && t.logos[0].href) || t.logo || ""
    };
  }

  function localGamesFromJson(data) {
    return (data && Array.isArray(data.jogos) ? data.jogos : []).map((j) => ({
      id: String(j.event_id || ""),
      rodada: Number(j.rodada || 0),
      date: parseDate(j.data_iso),
      dataIso: j.data_iso || "",
      state: String(j.estado || "pre"),
      completed: String(j.estado || "") === "post",
      detail: j.status || "",
      clock: "",
      venue: j.estadio || "",
      transmissao: j.transmissao || "",
      adiado: j.adiado === true,
      dataDefinir: j.data_definir === true,
      home: { ...localTeam(j.mandante), score: j.placar_mandante },
      away: { ...localTeam(j.visitante), score: j.placar_visitante },
      raw: null,
      source: "local"
    }));
  }

  function getCompetition(ev) {
    return (ev && Array.isArray(ev.competitions) && ev.competitions[0]) || {};
  }

  function statusFromEvent(ev, comp) {
    return (comp && comp.status) || (ev && ev.status) || {};
  }

  function venueFromCompetition(comp) {
    const v = (comp && comp.venue) || {};
    const addr = v.address || {};
    const cidade = [addr.city, addr.state].filter(Boolean).join(", ");
    return [v.fullName || v.displayName || v.name || "", cidade].filter(Boolean).join(" · ");
  }

  function roundFromEvent(ev, comp) {
    const nodes = [ev, comp, ev && ev.week, comp && comp.week, comp && comp.round];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      for (const k of ["number", "week", "round", "value"]) {
        const n = Number(node[k]);
        if (n >= 1 && n <= 38) return n;
      }
      for (const k of ["displayName", "name", "description", "text"]) {
        const m = String(node[k] || "").match(/(?:rodada|round|week|matchday)?\s*([1-3]?\d)\b/i);
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 38) return Number(m[1]);
      }
    }
    return 0;
  }

  function normalizeEvent(ev) {
    const comp = getCompetition(ev);
    const competitors = comp.competitors || [];
    const h = competitors.find((c) => c.homeAway === "home") || competitors[0];
    const a = competitors.find((c) => c.homeAway === "away") || competitors[1];
    if (!h || !a) return null;
    const status = statusFromEvent(ev, comp);
    const type = status.type || {};
    const home = localTeam(h.team || {});
    const away = localTeam(a.team || {});
    home.score = h.score == null || h.score === "" ? null : Number(h.score);
    away.score = a.score == null || a.score === "" ? null : Number(a.score);
    const date = parseDate(ev.date || comp.date);
    return {
      id: String(ev.id || comp.id || ""),
      rodada: roundFromEvent(ev, comp),
      date,
      dataIso: date ? date.toISOString() : "",
      state: String(type.state || (type.completed ? "post" : "pre")).toLowerCase(),
      completed: type.completed === true,
      detail: status.displayClock || type.shortDetail || type.detail || status.type && status.type.detail || "",
      clock: status.displayClock || "",
      period: Number(status.period || comp.period || 0),
      venue: venueFromCompetition(comp),
      transmissao: "",
      adiado: /postpon|adiad|suspend|cancel/i.test([type.name, type.description, type.detail, type.shortDetail].join(" ")),
      dataDefinir: false,
      home,
      away,
      raw: ev,
      competition: comp,
      source: "espn"
    };
  }

  function findLocal(game) {
    if (!game) return null;
    if (game.id) {
      const byId = state.agenda.find((x) => x.id && x.id === game.id);
      if (byId) return byId;
    }
    const key = teamKey(game.home.nome, game.away.nome);
    return state.agenda.find((x) => teamKey(x.home.nome, x.away.nome) === key) || null;
  }

  function mergeLocal(game) {
    const loc = findLocal(game);
    if (!loc) return game;
    return {
      ...loc,
      ...game,
      rodada: loc.rodada || game.rodada,
      date: game.date || loc.date,
      dataIso: game.dataIso || loc.dataIso,
      venue: game.venue || loc.venue,
      transmissao: loc.transmissao || game.transmissao,
      adiado: loc.adiado || game.adiado,
      home: { ...loc.home, ...game.home, nome: loc.home.nome || game.home.nome, escudo: loc.home.escudo || game.home.escudo },
      away: { ...loc.away, ...game.away, nome: loc.away.nome || game.away.nome, escudo: loc.away.escudo || game.away.escudo }
    };
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function safeYouTubeUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      const host = url.hostname.toLowerCase();
      if (host !== "youtube.com" && host !== "www.youtube.com" && host !== "youtu.be") return "";
      if (host === "youtu.be") return /^[A-Za-z0-9_-]{11}$/.test(url.pathname.replace(/^\//, "")) ? url.href : "";
      const id = url.searchParams.get("v");
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  async function loadTransmissions() {
    const data = await fetchJson("dados-br/transmissoes-aovivo.json?t=" + Date.now()).catch(() => ({ jogos: {} }));
    state.transmissoes = data && data.jogos && typeof data.jogos === "object" ? data.jogos : {};
  }

  function transmissionForGame(game) {
    if (!game) return null;
    const direct = game.id && state.transmissoes[String(game.id)];
    if (direct) return direct;
    const wanted = teamKey(game.home && game.home.nome, game.away && game.away.nome);
    const gameDate = game.date ? dateKey(game.date) : "";
    for (const item of Object.values(state.transmissoes)) {
      if (!item || typeof item !== "object") continue;
      if (teamKey(item.mandante, item.visitante) !== wanted) continue;
      const itemDate = parseDate(item.data_iso);
      if (!gameDate || !itemDate || dateKey(itemDate) === gameDate) return item;
    }
    return null;
  }

  function renderTransmission(game) {
    const entry = transmissionForGame(game);
    const principal = entry && entry.principal;
    const url = principal && safeYouTubeUrl(principal.url);
    if (!url) return "";
    const sourceName = principal.nome || (principal.fonte === "cazetv" ? "CazéTV" : "GE TV");
    const liveNow = String(principal.status || "").toLowerCase() === "live" || game.state === "in";
    const kickoff = game.date instanceof Date ? game.date.getTime() : NaN;
    const preLive = !liveNow && isFinite(kickoff) && Date.now() >= kickoff - 60 * 60000;
    const liveStyle = liveNow || preLive;
    const label = liveNow
      ? "🔴 AO VIVO na " + sourceName
      : (preLive ? "🔴 AO VIVO em breve na " + sourceName : "▶ Assistir na " + sourceName);
    const note = liveNow
      ? "Transmissão oficial ao vivo no YouTube"
      : (preLive ? "A bola rola em breve — transmissão oficial no YouTube" : "Transmissão oficial programada no YouTube");
    // Regra do bolão: exibir SEMPRE um único link (CazéTV tem prioridade sobre GE TV).
    // O robô já garante que "principal" respeita essa prioridade; alternativas não são exibidas.
    return '<div class="live-stream-area"><a class="live-stream-button ' + (liveStyle ? "is-live" : "") + '" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a><div class="live-stream-note">' + esc(note) + '</div></div>';
  }

  async function loadLocal() {
    const [jogos, eventos] = await Promise.all([
      fetchJson("jogos.json?t=" + Date.now()),
      fetchJson("espn_eventos.json?t=" + Date.now()).catch(() => ({ eventos: [] }))
    ]);
    state.agenda = localGamesFromJson(jogos).filter((g) => !g.dataDefinir && g.date);
    state.eventosLocais = (eventos.eventos || []).slice();
  }

  async function loadScoreboard() {
    const now = new Date();
    const ini = compactDate(new Date(now.getTime() - 24 * 3600 * 1000));
    const fim = compactDate(new Date(now.getTime() + 2 * 24 * 3600 * 1000));
    const url = SCOREBOARD_API + "?dates=" + ini + "-" + fim + "&limit=80&_=" + Date.now();
    const data = await fetchJson(url);
    state.diretos = (data.events || []).map(normalizeEvent).filter(Boolean).map(mergeLocal);
  }

  function sameFixture(a, b) {
    if (!a || !b || !a.home || !a.away || !b.home || !b.away) return false;
    if (a.id && b.id && String(a.id) === String(b.id)) return true;
    if (teamKey(a.home.nome, a.away.nome) !== teamKey(b.home.nome, b.away.nome)) return false;

    // A ESPN e a agenda local podem usar IDs diferentes para o mesmo jogo,
    // especialmente em partidas adiadas/remarcadas. Nesses casos, a combinação
    // clubes + data/rodada é a identidade mais confiável.
    if (a.date instanceof Date && b.date instanceof Date) {
      const diff = Math.abs(a.date.getTime() - b.date.getTime());
      if (dateKey(a.date) === dateKey(b.date) || diff <= 12 * 3600000) return true;
    }
    if (a.rodada && b.rodada && Number(a.rodada) === Number(b.rodada)) return true;
    return false;
  }

  function mergeGameRecords(a, b) {
    const espn = a && a.source === "espn" ? a : (b && b.source === "espn" ? b : null);
    const primary = espn || b || a;
    const secondary = primary === a ? b : a;
    if (!secondary) return primary;

    return {
      ...secondary,
      ...primary,
      id: primary.id || secondary.id,
      rodada: primary.rodada || secondary.rodada,
      date: primary.date || secondary.date,
      dataIso: primary.dataIso || secondary.dataIso,
      detail: primary.detail || secondary.detail,
      clock: primary.clock || secondary.clock,
      venue: primary.venue || secondary.venue,
      transmissao: primary.transmissao || secondary.transmissao,
      home: { ...secondary.home, ...primary.home, escudo: primary.home.escudo || secondary.home.escudo },
      away: { ...secondary.away, ...primary.away, escudo: primary.away.escudo || secondary.away.escudo }
    };
  }

  function allGames() {
    const merged = [];
    const upsert = (game) => {
      if (!game || !game.home || !game.away) return;
      const index = merged.findIndex((item) => sameFixture(item, game));
      if (index < 0) merged.push(game);
      else merged[index] = mergeGameRecords(merged[index], game);
    };

    state.agenda.forEach(upsert);
    state.diretos.forEach((g) => upsert(mergeLocal(g)));
    return merged;
  }

  function isPostponed(g) {
    return g.adiado && (!g.date || /adiad|postpon|data a definir/i.test(g.detail || ""));
  }

  function priorityGames(games) {
    const now = Date.now();
    const live = games.filter((g) => g.state === "in").sort((a, b) => (a.date || 0) - (b.date || 0));
    if (live.length) return live;

    const recent = games.filter((g) => g.state === "post" && g.date && now - g.date.getTime() >= 0 && now - g.date.getTime() < 150 * 60000)
      .sort((a, b) => b.date - a.date);
    const future = games.filter((g) => g.state !== "post" && !isPostponed(g) && g.date && g.date.getTime() >= now - 30 * 60000)
      .sort((a, b) => a.date - b.date);

    // Depois do apito final, mantém o resultado mais recente por até 2h30.
    // Só então a página migra automaticamente para o próximo compromisso.
    if (recent.length) {
      const latest = recent[0].date.getTime();
      return recent.filter((g) => Math.abs(g.date.getTime() - latest) <= 2 * 60000).slice(0, 8);
    }
    if (future.length) {
      const first = future[0].date.getTime();
      return future.filter((g) => Math.abs(g.date.getTime() - first) <= 2 * 60000).slice(0, 8);
    }
    return [];
  }

  function chooseGame(games) {
    const priorities = priorityGames(games);
    const eligible = priorities.length ? priorities : games.slice().sort((a, b) => (a.date || 0) - (b.date || 0));
    let selected = eligible.find((g) => g.id && g.id === state.selecionado);
    if (!selected && state.selecionado) {
      selected = games.find((g) => g.id === state.selecionado);
    }
    if (!selected) selected = eligible[0] || null;
    if (selected && selected.id) state.selecionado = selected.id;
    return { selected, priorities };
  }

  function teamLogo(team) {
    if (team.escudo) return '<img src="' + esc(team.escudo) + '" alt="" loading="eager">';
    return '<div class="live-logo-fallback">' + esc((team.sigla || team.nome || "?").slice(0, 3)) + "</div>";
  }

  function gameState(g) {
    const text = [g.detail, g.raw && g.raw.status && g.raw.status.type && g.raw.status.type.name].join(" ");
    if (/postpon|adiad/i.test(text)) return { key: "postponed", label: "Adiado" };
    if (/suspend/i.test(text)) return { key: "postponed", label: "Suspenso" };
    if (/cancel/i.test(text)) return { key: "postponed", label: "Cancelado" };
    if (g.state === "in") {
      if (/half/i.test(text) || /interval/i.test(text)) return { key: "live", label: "Intervalo" };
      return { key: "live", label: "Ao vivo" };
    }
    if (g.state === "post" || g.completed) return { key: "post", label: "Encerrado" };
    return { key: "pre", label: "Próximo jogo" };
  }

  function statusText(g) {
    const s = gameState(g);
    if (s.key === "live") {
      if (s.label === "Intervalo") return "Intervalo";
      return g.clock || g.detail || "Bola rolando";
    }
    if (s.key === "post") return "Fim de jogo";
    if (s.key === "postponed") return s.label;
    return g.date ? formatDateTime(g.date) : "Horário a definir";
  }

  function simpleMessage(g) {
    const s = gameState(g);
    if (s.key === "live") return "Bola rolando pelo Brasileirão!";
    if (s.key === "post") return "Fim de jogo no Brasileirão.";
    if (s.key === "postponed") return "A partida aguarda nova definição oficial.";
    if (!g.date) return "Data e horário ainda serão confirmados.";
    const diff = g.date.getTime() - Date.now();
    if (diff <= 20 * 60000 && diff > 0) return "Tá quase na hora. Prepare a torcida!";
    const today = dateKey(g.date) === dateKey(new Date());
    return today ? "Hoje tem Brasileirão!" : "Próximo compromisso do Brasileirão.";
  }

  function countdownText(g) {
    if (!g || !g.date || g.state === "in" || g.state === "post") return "";
    let diff = g.date.getTime() - Date.now();
    if (diff <= 0) return "Aguardando início oficial";
    const days = Math.floor(diff / 86400000); diff %= 86400000;
    const hours = Math.floor(diff / 3600000); diff %= 3600000;
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    if (days > 0) return "Começa em " + days + "d " + hours + "h " + mins + "min";
    if (hours > 0) return "Começa em " + hours + "h " + mins + "min";
    return "Começa em " + mins + "min " + String(secs).padStart(2, "0") + "s";
  }

  function teamIdMap(g) {
    const map = {};
    if (g.home.id) map[String(g.home.id)] = g.home;
    if (g.away.id) map[String(g.away.id)] = g.away;
    return map;
  }

  function eventType(obj) {
    const text = norm([
      obj && obj.type && (obj.type.text || obj.type.name || obj.type.description),
      obj && obj.text, obj && obj.description
    ].filter(Boolean).join(" "));
    if (obj && obj.scoringPlay === true || /\bgoal\b|\bgol\b/.test(text)) return { key: "goal", label: "Gol", icon: "⚽" };
    if (obj && obj.redCard === true || /red card|cartao vermelho|expuls/.test(text)) return { key: "red", label: "Cartão vermelho", icon: "🟥" };
    if (obj && obj.yellowCard === true || /yellow card|cartao amarelo/.test(text)) return { key: "yellow", label: "Cartão amarelo", icon: "🟨" };
    return null;
  }

  function eventMinute(obj) {
    return String((obj && obj.clock && obj.clock.displayValue) || (obj && obj.displayClock) || "").trim();
  }

  function eventAthlete(obj) {
    const involved = obj && obj.athletesInvolved;
    if (Array.isArray(involved) && involved[0]) return involved[0].displayName || involved[0].shortName || involved[0].name || "";
    return (obj && obj.athlete && (obj.athlete.displayName || obj.athlete.name)) || "";
  }

  function eventRows(g, summary) {
    const candidates = [];
    const comp = g.competition || getCompetition(g.raw || {});
    for (const d of (comp.details || [])) candidates.push(d);
    for (const p of ((summary && summary.plays) || [])) candidates.push(p);
    const teamMap = teamIdMap(g);
    const out = [];
    const seen = new Set();
    for (const item of candidates) {
      const type = eventType(item);
      if (!type) continue;
      const min = eventMinute(item);
      const athlete = eventAthlete(item);
      const teamId = String((item.team && item.team.id) || item.teamId || "");
      const team = teamMap[teamId];
      const fallbackText = String(item.text || item.description || type.label);
      const text = athlete ? type.label + " — " + athlete : fallbackText;
      const identity = athlete ? norm(athlete) : norm(fallbackText);
      const key = [type.key, min, identity, teamId].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type, min, text, team: team ? team.nome : "", sort: Number((min.match(/\d+/) || [999])[0]) });
    }
    out.sort((a, b) => a.sort - b.sort || a.text.localeCompare(b.text, "pt-BR"));
    return out;
  }

  function statsMapFromList(list) {
    const map = {};
    for (const s of (list || [])) {
      const key = norm(s.name || s.abbreviation || s.label || s.displayName);
      if (!key) continue;
      map[key] = s.displayValue != null ? String(s.displayValue) : String(s.value != null ? s.value : "");
    }
    return map;
  }

  function collectStats(g, summary) {
    const byTeam = {};
    const add = (team, stats) => {
      if (!team) return;
      const id = String(team.id || "");
      const name = canon(team.displayName || team.name || team.shortDisplayName || team.abbreviation);
      const key = id || name;
      if (key) byTeam[key] = { ...(byTeam[key] || {}), ...statsMapFromList(stats) };
    };

    const comp = g.competition || getCompetition(g.raw || {});
    for (const c of (comp.competitors || [])) add(c.team || {}, c.statistics || []);
    const boxTeams = summary && summary.boxscore && summary.boxscore.teams;
    for (const t of (boxTeams || [])) add(t.team || {}, t.statistics || []);

    function forSide(side) {
      const team = g[side];
      return byTeam[String(team.id || "")] || byTeam[canon(team.nome)] || {};
    }
    const h = forSide("home"), a = forSide("away");
    const defs = [
      ["Posse de bola", ["possession", "possessionpct", "possession percentage"]],
      ["Finalizações", ["shots", "total shots", "totalshots", "shot attempts"]],
      ["Finalizações no gol", ["shots on target", "shotsontarget", "shots on goal", "shotsongoal"]],
      ["Escanteios", ["corner kicks", "cornerkicks", "corners"]],
      ["Faltas", ["fouls committed", "foulscommitted", "fouls"]],
      ["Impedimentos", ["offsides", "offside"]]
    ];
    const pick = (obj, keys) => {
      for (const k of keys) {
        const nk = norm(k);
        if (obj[nk] != null && obj[nk] !== "") return obj[nk];
      }
      for (const [k, v] of Object.entries(obj)) {
        if (keys.some((x) => k.includes(norm(x)) || norm(x).includes(k))) return v;
      }
      return "";
    };
    const num = (v) => {
      const m = String(v || "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : NaN;
    };
    const rows = [];
    for (const [label, keys] of defs) {
      const hv = pick(h, keys), av = pick(a, keys);
      if (hv === "" || av === "") continue;
      const hn = num(hv), an = num(av);
      let pct = 50;
      if (Number.isFinite(hn) && Number.isFinite(an) && hn + an > 0) pct = Math.max(4, Math.min(96, hn / (hn + an) * 100));
      rows.push({ label, home: hv, away: av, pct });
    }
    return rows;
  }

  async function loadSummary(g) {
    if (!g || !g.id || g.source !== "espn") return null;
    try {
      const data = await fetchJson(SUMMARY_API + "?event=" + encodeURIComponent(g.id) + "&_=" + Date.now());
      state.resumoPorId[g.id] = data;
      return data;
    } catch (e) {
      return state.resumoPorId[g.id] || null;
    }
  }

  function renderSwitcher(games, selected) {
    if (!games || games.length <= 1) {
      switcher.hidden = true;
      switcher.innerHTML = "";
      return;
    }
    switcher.hidden = false;
    switcher.innerHTML = games.map((g) => {
      const active = selected && g.id === selected.id;
      const live = g.state === "in";
      return '<button type="button" class="live-game-tab ' + (active ? "active" : "") + '" data-game-id="' + esc(g.id) + '">' +
        (live ? '<span class="dot-live"></span>' : "") +
        (g.home.escudo ? '<img src="' + esc(g.home.escudo) + '" alt="">' : "") +
        esc(g.home.sigla || SIGLAS[g.home.nome] || g.home.nome.slice(0, 3)) + " " +
        (g.state === "pre" ? "×" : esc(g.home.score == null ? "-" : g.home.score) + "×" + esc(g.away.score == null ? "-" : g.away.score)) + " " +
        esc(g.away.sigla || SIGLAS[g.away.nome] || g.away.nome.slice(0, 3)) +
        (g.away.escudo ? '<img src="' + esc(g.away.escudo) + '" alt="">' : "") + "</button>";
    }).join("");
    switcher.querySelectorAll("[data-game-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.selecionado = btn.getAttribute("data-game-id") || "";
        await renderPage();
        setTimeout(() => btn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }), 30);
      });
    });
  }

  function renderEvents(g, summary) {
    const rows = eventRows(g, summary);
    if (!rows.length) return '<div class="live-empty">Gols e cartões aparecerão aqui assim que a fonte disponibilizar os lances.</div>';
    return '<div class="live-events">' + rows.map((r) => '<div class="live-event">' +
      '<div class="live-event-minute">' + esc(r.min || "—") + '</div>' +
      '<div class="live-event-icon">' + r.type.icon + '</div>' +
      '<div><div class="live-event-text">' + esc(r.text) + '</div>' +
      (r.team ? '<div class="live-event-team">' + esc(r.team) + '</div>' : "") + '</div></div>').join("") + '</div>';
  }

  function renderStats(g, summary) {
    const rows = collectStats(g, summary);
    if (!rows.length) return '<div class="live-empty">As estatísticas serão exibidas quando estiverem disponíveis para esta partida.</div>';
    return '<div class="live-stats">' + rows.map((r) => '<div class="live-stat-row">' +
      '<div class="live-stat-value">' + esc(r.home) + '</div><div class="live-stat-mid">' +
      '<div class="live-stat-label">' + esc(r.label) + '</div>' +
      '<div class="live-stat-track" style="--home:' + r.pct.toFixed(1) + '%"></div></div>' +
      '<div class="live-stat-value">' + esc(r.away) + '</div></div>').join("") + '</div>';
  }

  function renderNextList(all, selected) {
    const now = Date.now();
    const next = all.filter((g) => g.date && g.date.getTime() > now && (!selected || !sameFixture(g, selected)))
      .sort((a, b) => a.date - b.date).slice(0, 6);
    if (!next.length) return "";
    return '<section class="panel live-subpanel"><div class="panel-inner"><div class="live-section-head"><h2>Próximos jogos</h2></div>' +
      '<div class="live-next-list">' + next.map((g) => '<div class="live-next-item"><div class="live-next-teams">' +
        esc(g.home.nome) + ' × ' + esc(g.away.nome) + '</div><div class="live-next-meta">Rodada ' + esc(g.rodada || "—") + '<br>' + esc(formatShort(g.date)) + '</div></div>').join("") +
      '</div></div></section>';
  }

  function renderMain(g, summary, all) {
    if (!g) {
      app.innerHTML = '<div class="panel"><div class="panel-inner"><div class="live-empty">Nenhuma partida futura foi encontrada na agenda publicada. O robô continuará tentando atualizar os dados.</div></div></div>';
      return;
    }
    const s = gameState(g);
    const scoreVisible = s.key === "live" || s.key === "post";
    const score = scoreVisible
      ? '<div class="live-score">' + esc(g.home.score == null ? 0 : g.home.score) + ' × ' + esc(g.away.score == null ? 0 : g.away.score) + '</div>'
      : '<div class="live-vs">×</div>';
    const roundText = g.rodada ? "Rodada " + g.rodada : "Brasileirão";
    const delayed = g.adiado ? " · jogo adiado" : "";
    const countdown = countdownText(g);
    const venue = g.venue ? '<span>🏟️ <strong>' + esc(g.venue) + '</strong></span>' : "";
    const transmission = g.transmissao ? '<span>📺 ' + esc(g.transmissao) + '</span>' : "";

    app.innerHTML = '<section class="live-main-card"><div class="live-card-inner">' +
      '<div class="live-round-row"><span class="live-round-badge">' + esc(roundText + delayed) + '</span>' +
      '<span class="live-state-badge ' + esc(s.key) + '">' + esc(s.label) + '</span></div>' +
      '<div class="live-score-grid"><div class="live-team">' + teamLogo(g.home) + '<div class="live-team-name">' + esc(g.home.nome) + '</div><div class="live-team-abbr">' + esc(g.home.sigla || SIGLAS[g.home.nome] || "") + '</div></div>' +
      '<div class="live-score-center">' + score + '<div class="live-clock">' + esc(statusText(g)) + '</div>' +
      (s.key === "pre" ? '<div class="live-kickoff">Horário de Brasília</div>' : "") +
      (countdown ? '<div class="live-countdown" data-countdown-game="' + esc(g.id) + '">' + esc(countdown) + '</div>' : "") + '</div>' +
      '<div class="live-team">' + teamLogo(g.away) + '<div class="live-team-name">' + esc(g.away.nome) + '</div><div class="live-team-abbr">' + esc(g.away.sigla || SIGLAS[g.away.nome] || "") + '</div></div></div>' +
      '<div class="live-meta">' + venue + transmission + '</div>' +
      renderTransmission(g) +
      '<div class="live-message">' + esc(simpleMessage(g)) + '</div></div></section>' +
      '<div class="live-content-grid"><section class="panel live-subpanel"><div class="panel-inner"><div class="live-section-head"><h2>⚽ Gols e cartões</h2><span class="live-section-note">lances oficiais</span></div>' + renderEvents(g, summary) + '</div></section>' +
      '<section class="panel live-subpanel"><div class="panel-inner"><div class="live-section-head"><h2>📊 Estatísticas</h2><span class="live-section-note">durante o jogo</span></div>' + renderStats(g, summary) + '</div></section></div>' +
      renderNextList(all, g);
  }

  async function renderPage() {
    const all = allGames();
    const { selected, priorities } = chooseGame(all);
    const switchGames = priorities.length ? priorities : (selected ? [selected] : []);
    renderSwitcher(switchGames, selected);
    const summary = await loadSummary(selected);
    renderMain(selected, summary, all);
    updateCountdowns();
    if (badge) {
      badge.classList.toggle("is-live", Boolean(selected && selected.state === "in"));
      badge.classList.remove("is-error");
      badge.textContent = state.ultimaAtualizacao ? "Atualizado " + formatClockTime(state.ultimaAtualizacao) + " · 30s" : "Atualizando a cada 30s";
    }
  }

  function updateCountdowns() {
    const all = allGames();
    document.querySelectorAll("[data-countdown-game]").forEach((el) => {
      const id = el.getAttribute("data-countdown-game");
      const g = all.find((x) => x.id === id);
      if (g) el.textContent = countdownText(g);
    });
  }

  function showAlert(msg) {
    if (!msg) {
      alertBox.classList.remove("show");
      alertBox.textContent = "";
      return;
    }
    alertBox.textContent = msg;
    alertBox.classList.add("show");
  }

  async function refresh() {
    if (state.carregando || document.hidden) return;
    state.carregando = true;
    try {
      if (state.primeiraCarga) await loadLocal();
      await Promise.all([loadScoreboard(), loadTransmissions()]);
      state.ultimaAtualizacao = new Date();
      state.ultimaFalha = "";
      state.primeiraCarga = false;
      showAlert("");
      await renderPage();
    } catch (e) {
      console.warn("Ao vivo indisponível:", e);
      state.ultimaFalha = e && e.message ? e.message : String(e);
      if (badge) {
        badge.classList.add("is-error");
        badge.classList.remove("is-live");
        badge.textContent = "Fonte temporariamente indisponível";
      }
      showAlert("A ESPN não respondeu nesta tentativa. A última informação válida permanece na tela e uma nova tentativa ocorrerá automaticamente.");
      if (state.primeiraCarga) {
        try {
          await Promise.all([loadLocal(), loadTransmissions()]);
          state.primeiraCarga = false;
          await renderPage();
        } catch (_) {
          app.innerHTML = '<div class="panel"><div class="panel-inner"><div class="live-empty">Não foi possível carregar a agenda agora. Tente novamente em alguns instantes.</div></div></div>';
        }
      }
    } finally {
      state.carregando = false;
      clearTimeout(state.timer);
      state.timer = setTimeout(refresh, REFRESH_MS);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      clearTimeout(state.timer);
      refresh();
    }
  });

  state.tickTimer = setInterval(updateCountdowns, 1000);
  refresh();
})();
