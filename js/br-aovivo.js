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

  const PROVIDERS = {
    premiere: {
      label: "Premiere",
      aliases: ["premiere"],
      links: [
        { label: "Globoplay", url: "https://globoplay.globo.com/categorias/premiere/" },
        { label: "Claro tv+", url: "https://www.clarotvmais.com.br/ao-vivo" },
        { label: "Prime Video", url: "https://www.primevideo.com/-/pt/channel/65837b7c-1c81-4f8a-80f5-d1bba5cde8f1" }
      ]
    },
    sportv: {
      label: "SporTV",
      aliases: ["sportv", "sport tv"],
      links: [
        { label: "Globoplay", url: "https://globoplay.globo.com/" },
        { label: "Claro tv+", url: "https://www.clarotvmais.com.br/ao-vivo" }
      ]
    },
    disney: {
      label: "Disney+ / ESPN",
      aliases: ["disney+", "disney plus", "espn"],
      links: [
        { label: "Disney+", url: "https://www.disneyplus.com/pt-br" }
      ]
    },
    prime: {
      label: "Prime Video",
      aliases: ["prime video", "amazon prime", "amazon prime video"],
      links: [
        { label: "Prime Video", url: "https://www.primevideo.com/-/pt/store" }
      ]
    },
    globo: {
      label: "Globo",
      aliases: ["globo", "tv globo"],
      links: [
        { label: "Globoplay", url: "https://globoplay.globo.com/" }
      ]
    }
  };

  const OFFICIAL_HOSTS = new Set([
    "globoplay.globo.com", "www.globoplay.globo.com",
    "clarotvmais.com.br", "www.clarotvmais.com.br",
    "claro.com.br", "www.claro.com.br",
    "primevideo.com", "www.primevideo.com",
    "disneyplus.com", "www.disneyplus.com"
  ]);

  const state = {
    agenda: [],
    eventosLocais: [],
    diretos: [],
    transmissoes: {},
    transmissoesTv: {},
    selecionado: "",
    resumoPorId: {},
    ultimaAtualizacao: null,
    ultimaFalha: "",
    timer: null,
    tickTimer: null,
    carregando: false,
    primeiraCarga: true,
    finalizadosEm: {}
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

  function broadcastNames(ev, comp) {
    const out = [];
    const add = (value) => {
      const name = String(value || "").trim();
      if (!name || out.some((x) => norm(x) === norm(name))) return;
      out.push(name);
    };
    const lists = [comp && comp.broadcasts, ev && ev.broadcasts];
    for (const list of lists) {
      for (const item of (Array.isArray(list) ? list : [])) {
        if (Array.isArray(item.names)) item.names.forEach(add);
        add(item.name || item.shortName || item.displayName || item.network);
        if (item.media && Array.isArray(item.media.shortName)) item.media.shortName.forEach(add);
      }
    }
    return out;
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
      detail: type.shortDetail || type.detail || status.displayClock || (status.type && status.type.detail) || "",
      clock: status.displayClock || "",
      period: Number(status.period || comp.period || 0),
      venue: venueFromCompetition(comp),
      transmissao: broadcastNames(ev, comp).join(" / "),
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

  function safeOfficialUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      if (url.protocol !== "https:" || !OFFICIAL_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  const TRANSMISSION_CACHE_YT = "br2026_transmissoes_youtube_v1";
  const TRANSMISSION_CACHE_TV = "br2026_transmissoes_tv_v1";

  function cachedTransmissionMap(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveTransmissionMap(key, value) {
    try {
      if (value && typeof value === "object" && Object.keys(value).length) {
        localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (_) {}
  }

  async function loadTransmissions() {
    const previousYoutube = state.transmissoes && Object.keys(state.transmissoes).length
      ? state.transmissoes
      : cachedTransmissionMap(TRANSMISSION_CACHE_YT);
    const previousTv = state.transmissoesTv && Object.keys(state.transmissoesTv).length
      ? state.transmissoesTv
      : cachedTransmissionMap(TRANSMISSION_CACHE_TV);

    const [youtubeResult, manualResult, tvResult] = await Promise.allSettled([
      fetchJson("dados-br/transmissoes-aovivo.json?t=" + Date.now()),
      fetchJson("dados-br/transmissoes-aovivo-manual.json?t=" + Date.now()),
      fetchJson("dados-br/transmissoes-tv.json?t=" + Date.now())
    ]);

    const automatic = youtubeResult.status === "fulfilled" && youtubeResult.value && youtubeResult.value.jogos && typeof youtubeResult.value.jogos === "object"
      ? youtubeResult.value.jogos
      : {};
    const manual = manualResult.status === "fulfilled" && manualResult.value && manualResult.value.jogos && typeof manualResult.value.jogos === "object"
      ? manualResult.value.jogos
      : {};
    const tv = tvResult.status === "fulfilled" && tvResult.value && tvResult.value.jogos && typeof tvResult.value.jogos === "object"
      ? tvResult.value.jogos
      : {};

    // Nunca apaga um link válido por causa de uma falha transitória, 404 durante
    // deploy ou resposta vazia em um único ciclo. O manual prevalece sobre o robô.
    const mergedYoutube = Object.assign({}, previousYoutube, automatic, manual);
    state.transmissoes = Object.keys(mergedYoutube).length ? mergedYoutube : previousYoutube;
    state.transmissoesTv = Object.keys(tv).length ? Object.assign({}, previousTv, tv) : previousTv;
    saveTransmissionMap(TRANSMISSION_CACHE_YT, state.transmissoes);
    saveTransmissionMap(TRANSMISSION_CACHE_TV, state.transmissoesTv);
  }

  function transmissionEntryForGame(game, source) {
    if (!game || !source) return null;
    const direct = game.id && source[String(game.id)];
    if (direct) return direct;
    if (game.id) {
      const byEventId = Object.values(source).find((item) => item && String(item.event_id || "") === String(game.id));
      if (byEventId) return byEventId;
    }
    const wanted = teamKey(game.home && game.home.nome, game.away && game.away.nome);
    const gameDate = game.date ? dateKey(game.date) : "";
    for (const item of Object.values(source)) {
      if (!item || typeof item !== "object") continue;
      if (teamKey(item.mandante, item.visitante) !== wanted) continue;
      const itemDate = parseDate(item.data_iso);
      if (!gameDate || !itemDate || dateKey(itemDate) === gameDate) return item;
    }
    return null;
  }

  function transmissionForGame(game) {
    return transmissionEntryForGame(game, state.transmissoes);
  }

  function providerForChannel(channel) {
    const wanted = norm(channel);
    if (!wanted) return null;
    for (const [key, provider] of Object.entries(PROVIDERS)) {
      if (provider.aliases.some((alias) => wanted.includes(norm(alias)) || norm(alias).includes(wanted))) {
        return { key, ...provider };
      }
    }
    return null;
  }

  function channelsFromText(value) {
    const text = String(value || "").trim();
    if (!text) return [];
    const found = [];
    for (const provider of Object.values(PROVIDERS)) {
      if (provider.aliases.some((alias) => norm(text).includes(norm(alias)))) found.push(provider.label);
    }
    if (found.length) return Array.from(new Set(found));
    return Array.from(new Set(text.split(/\s*(?:\/|,|;|\be\b)\s*/i).map((x) => x.trim()).filter(Boolean)));
  }

  function closedTransmissionForGame(game) {
    const manual = transmissionEntryForGame(game, state.transmissoesTv);
    if (manual) return manual;
    const canais = channelsFromText(game && game.transmissao);
    return canais.length ? { canais, origem: "ESPN" } : null;
  }

  function transmissionLabel(game) {
    const yt = transmissionForGame(game);
    const principal = yt && yt.principal;
    if (principal && safeYouTubeUrl(principal.url)) return principal.nome || (principal.fonte === "cazetv" ? "CazéTV" : "GE TV");
    const closed = closedTransmissionForGame(game);
    const canais = closed && Array.isArray(closed.canais) ? closed.canais.filter(Boolean) : [];
    return canais.join(" / ");
  }

  function renderClosedTransmission(game) {
    const entry = closedTransmissionForGame(game);
    if (!entry) return "";
    const canais = Array.isArray(entry.canais) ? entry.canais.filter(Boolean) : [];
    if (!canais.length) return "";

    const links = [];
    const seen = new Set();
    const addLink = (label, value) => {
      const url = safeOfficialUrl(value);
      const key = norm(label) + "|" + url;
      if (!url || seen.has(key) || links.length >= 3) return;
      seen.add(key);
      links.push({ label: String(label || "Acessar"), url });
    };

    for (const item of (Array.isArray(entry.links) ? entry.links : [])) addLink(item.label, item.url);
    for (const canal of canais) {
      const provider = providerForChannel(canal);
      for (const item of ((provider && provider.links) || [])) addLink(item.label, item.url);
    }

    const buttons = links.length
      ? '<div class="live-provider-actions">' + links.map((item) => '<a class="live-provider-button" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' + esc(item.label) + '</a>').join("") + '</div>'
      : '<div class="live-provider-no-link">Consulte o aplicativo ou a operadora da sua assinatura.</div>';

    return '<aside class="live-provider-card" aria-label="Onde assistir"><div class="live-provider-heading"><span class="live-provider-icon">📺</span><div><span class="live-provider-kicker">Onde assistir</span><strong>' + esc(canais.join(" / ")) + '</strong></div></div>' +
      '<p>Acesso sujeito à assinatura do serviço escolhido.</p>' + buttons + '</aside>';
  }

  function renderTransmission(game) {
    const entry = transmissionForGame(game);
    const principal = entry && entry.principal;
    const url = principal && safeYouTubeUrl(principal.url);
    let youtube = "";
    if (url) {
      const sourceName = principal.nome || (principal.fonte === "cazetv" ? "CazéTV" : "GE TV");
      const liveNow = String(principal.status || "").toLowerCase() === "live" || game.state === "in";
      const kickoff = game.date instanceof Date ? game.date.getTime() : NaN;
      const preLive = !liveNow && isFinite(kickoff) && Date.now() >= kickoff - 60 * 60000;
      const liveStyle = liveNow || preLive;
      const finished = game.state === "post";
      const label = finished
        ? "▶ Rever na " + sourceName
        : (liveNow ? "AO VIVO na " + sourceName : (preLive ? "AO VIVO em breve na " + sourceName : "▶ Assistir na " + sourceName));
      const note = finished
        ? "Transmissão oficial encerrada no YouTube"
        : (liveNow ? "Transmissão oficial ao vivo no YouTube" : (preLive ? "A bola rola em breve — transmissão oficial no YouTube" : "Transmissão oficial programada no YouTube"));
      youtube = '<div class="live-stream-area"><a class="live-stream-button ' + (liveStyle ? "is-live" : "") + '" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a><div class="live-stream-note">' + esc(note) + '</div></div>';
    }
    return youtube + renderClosedTransmission(game);
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
    const normalized = (data.events || []).map(normalizeEvent).filter(Boolean).map(mergeLocal);
    const seen = new Set();
    for (const game of normalized) {
      const key = String(game.id || teamKey(game.home && game.home.nome, game.away && game.away.nome));
      if (!key) continue;
      seen.add(key);
      if (game.state === "post" && !state.finalizadosEm[key]) state.finalizadosEm[key] = Date.now();
      if (game.state !== "post") delete state.finalizadosEm[key];
    }
    for (const key of Object.keys(state.finalizadosEm)) {
      if (!seen.has(key) || Date.now() - state.finalizadosEm[key] > 6 * 3600000) delete state.finalizadosEm[key];
    }
    state.diretos = normalized;
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

    // Mantém jogos encerrados em destaque por quinze minutos contados da
    // primeira resposta em que a ESPN os marcou como post/finalizados.
    const recent = games.filter((g) => {
      if (g.state !== "post") return false;
      const key = String(g.id || teamKey(g.home && g.home.nome, g.away && g.away.nome));
      const endedAt = Number(state.finalizadosEm[key] || 0);
      return endedAt > 0 && now - endedAt <= 15 * 60000;
    }).sort((a, b) => {
      const ka = String(a.id || teamKey(a.home && a.home.nome, a.away && a.away.nome));
      const kb = String(b.id || teamKey(b.home && b.home.nome, b.away && b.away.nome));
      return Number(state.finalizadosEm[kb] || 0) - Number(state.finalizadosEm[ka] || 0);
    });
    const future = games.filter((g) => g.state !== "post" && !isPostponed(g) && g.date && g.date.getTime() >= now - 30 * 60000)
      .sort((a, b) => a.date - b.date);

    if (recent.length) {
      const latestKey = String(recent[0].id || teamKey(recent[0].home.nome, recent[0].away.nome));
      const latest = Number(state.finalizadosEm[latestKey] || 0);
      return recent.filter((g) => {
        const key = String(g.id || teamKey(g.home.nome, g.away.nome));
        return Math.abs(Number(state.finalizadosEm[key] || 0) - latest) <= 2 * 60000;
      }).slice(0, 8);
    }
    if (future.length) {
      const first = future[0].date.getTime();
      return future.filter((g) => Math.abs(g.date.getTime() - first) <= 2 * 60000).slice(0, 8);
    }
    return [];
  }

  function chooseGame(games) {
    const priorities = priorityGames(games);
    // A seleção principal deve vir SOMENTE dos jogos prioritários: ao vivo,
    // encerrados há no máximo 15 minutos ou próximos jogos. O fallback antigo
    // usava todos os jogos — inclusive encerrados — e fazia uma partida finalizada
    // reaparecer indefinidamente depois que a janela pós-jogo expirava.
    const eligible = priorities;
    let selected = eligible.find((g) => g.id && g.id === state.selecionado);
    if (!selected) selected = eligible[0] || null;
    if (selected && selected.id) state.selecionado = selected.id;
    else state.selecionado = null;
    return { selected, priorities };
  }

  function teamLogo(team) {
    if (team.escudo) return '<img src="' + esc(team.escudo) + '" alt="" loading="eager">';
    return '<div class="live-logo-fallback">' + esc((team.sigla || team.nome || "?").slice(0, 3)) + "</div>";
  }

  function clockMinute(g) {
    const raw = String((g && (g.clock || g.detail)) || "").trim();
    const match = raw.match(/^(\d{1,3})(?::\d{2})?(?:\+\d+)?(?:['’])?$/);
    return match ? Number(match[1]) : NaN;
  }

  // Detecta intervalo APENAS quando a ESPN confirma isso pelo shortDetail
  // ("HT"/"Halftime"/"Intervalo"), que é o campo canônico. STATUS_HALFTIME no
  // type.name só é aceito quando o shortDetail é vazio/genérico — assim um
  // STATUS_HALFTIME residual da ESPN não sobrescreve um minuto de jogo válido.
  function isHalftime(statusType, shortDetail) {
    const sd = String(shortDetail || "").trim();
    if (/^HT$/i.test(sd)) return true;
    if (/^half\s*time$/i.test(sd)) return true;
    if (/^intervalo$/i.test(sd)) return true;
    const name = String((statusType && statusType.name) || "").toUpperCase();
    if (name === "STATUS_HALFTIME") {
      // Aceita STATUS_HALFTIME só se o shortDetail não indica jogo rolando.
      // Se o shortDetail tem um minuto ("30'", "45+2'"), o jogo está andando.
      if (!sd) return true;
      if (/^\d+/.test(sd)) return false;
      return true;
    }
    return false;
  }

  // Detecta fim de jogo com precisão. type.completed é o sinal canônico da ESPN.
  function isFinished(g, statusType, shortDetail) {
    if (g && (g.state === "post" || g.completed)) return true;
    if (statusType && statusType.completed === true) return true;
    const name = String((statusType && statusType.name) || "").toUpperCase();
    if (name === "STATUS_FULL_TIME" || name === "STATUS_FINAL" || name === "STATUS_END_OF_PERIOD" && (g && g.state === "post")) return true;
    const sd = String(shortDetail || "").trim();
    if (/^FT$/i.test(sd)) return true;
    if (/^full\s*time$/i.test(sd)) return true;
    return false;
  }

  function gameState(g) {
    const statusType = g && g.raw && g.raw.status && g.raw.status.type;
    const shortDetail = statusType && statusType.shortDetail;
    const text = [g && g.detail, statusType && statusType.name, statusType && statusType.description, statusType && statusType.detail, shortDetail].join(" ");
    if (/postpon|adiad/i.test(text)) return { key: "postponed", label: "Adiado" };
    if (/suspend/i.test(text)) return { key: "postponed", label: "Suspenso" };
    if (/cancel/i.test(text)) return { key: "postponed", label: "Cancelado" };
    // Fim de jogo tem prioridade sobre qualquer outra classificação.
    if (isFinished(g, statusType, shortDetail)) return { key: "post", label: "Encerrado" };
    if (g.state === "in") {
      if (isHalftime(statusType, shortDetail)) return { key: "live", label: "Intervalo" };
      return { key: "live", label: "Ao vivo" };
    }
    return { key: "pre", label: "Próximo jogo" };
  }

  // Igual ao Copa2026: confia no shortDetail da ESPN, que já entrega "30'",
  // "45+2'", "HT", "FT" prontos. g.detail = displayClock || shortDetail (ver
  // normalizeEvent), então já é a fonte certa para exibir.
  function statusText(g) {
    const s = gameState(g);
    if (s.key === "live") {
      if (s.label === "Intervalo") return "Intervalo";
      return g.detail || g.clock || "Ao vivo";
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

  function compactPlayerName(raw) {
    let s = String(raw || "").trim().replace(/\s+/g, " ");
    if (!s) return "";
    // Remove sufixos geracionais e partículas que não ajudam no nome esportivo.
    const parts = s.split(" ").filter(Boolean);
    const suffixes = new Set(["junior", "júnior", "neto", "filho", "sobrinho", "ii", "iii", "iv"]);
    while (parts.length > 1 && suffixes.has(norm(parts[parts.length - 1]))) parts.pop();
    if (parts.length <= 2) return parts.join(" ");
    // Para nomes extensos, mantém o primeiro nome e o último sobrenome útil.
    const particles = new Set(["da", "de", "do", "das", "dos", "e"]);
    const genericSurnames = new Set(["silva", "santos", "souza", "sousa", "oliveira", "pereira", "costa", "lima", "alves", "rocha", "nascimento", "ferreira", "gomes", "ribeiro", "martins", "carvalho"]);
    let last = parts.length - 1;
    while (last > 1 && (particles.has(norm(parts[last])) || genericSurnames.has(norm(parts[last])))) last--;
    while (last > 1 && particles.has(norm(parts[last]))) last--;
    return parts[0] + " " + parts[last];
  }

  function rosterNameMap(summary) {
    const out = {};
    const add = (athlete) => {
      if (!athlete) return;
      const id = athlete.id != null ? String(athlete.id) : "";
      const short = athlete.shortName || athlete.displayName || athlete.fullName || athlete.name || "";
      if (id && short) out[id] = compactPlayerName(short);
    };
    for (const roster of ((summary && summary.rosters) || [])) {
      for (const entry of (roster.roster || roster.athletes || [])) add(entry.athlete || entry);
    }
    for (const team of (((summary || {}).boxscore || {}).players || [])) {
      for (const statGroup of (team.statistics || [])) {
        for (const athlete of (statGroup.athletes || [])) add(athlete.athlete || athlete);
      }
    }
    return out;
  }

  function eventAthlete(obj, summary) {
    const roster = rosterNameMap(summary);
    const involved = obj && obj.athletesInvolved;
    const athlete = Array.isArray(involved) && involved[0] ? involved[0] : (obj && obj.athlete) || null;
    if (!athlete) return "";
    const id = athlete.id != null ? String(athlete.id) : "";
    const raw = (id && roster[id]) || athlete.shortName || athlete.displayName || athlete.fullName || athlete.name || "";
    return compactPlayerName(raw);
  }

  function eventRows(g, summary) {
    const candidates = [];
    const comp = g.competition || getCompetition(g.raw || {});
    for (const d of (comp.details || [])) candidates.push(d);
    for (const d of ((summary && summary.scoringPlays) || [])) candidates.push(d);
    for (const p of ((summary && summary.plays) || [])) candidates.push(p);
    const teamMap = teamIdMap(g);
    const out = [];
    const seen = new Set();
    for (const item of candidates) {
      const type = eventType(item);
      if (!type) continue;
      const min = eventMinute(item);
      const athlete = eventAthlete(item, summary);
      const teamId = String((item.team && item.team.id) || item.teamId || "");
      const team = teamMap[teamId];
      const fallbackText = String(item.text || item.description || type.label);
      const text = athlete ? type.label + " — " + athlete : fallbackText;
      const identity = athlete ? norm(athlete) : norm(fallbackText);
      const key = [type.key, min, identity, teamId].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type, min, athlete, text, teamId, team: team ? team.nome : "", sort: Number((min.match(/\d+/) || [999])[0]) });
    }
    out.sort((a, b) => a.sort - b.sort || a.text.localeCompare(b.text, "pt-BR"));
    return out;
  }

  const LIVE_METRIC_RULES = [
    { keys:["expected goals","expectedgoals","xg"], label:"xG", order:1 },
    { keys:["possession pct","possession percent","possession percentage","possessionpct","possession","posse"], label:"Posse", order:2, percent:true },
    { keys:["total shots","totalshots","shots total","shots","shot attempts","finalizacoes","finalizações"], label:"Finalizações", order:3 },
    { keys:["shots on goal","shots on target","shotsongoal","shotsontarget","chutes no gol"], label:"Chutes no gol", order:4 },
    { keys:["shots off target","shotsofftarget"], label:"Chutes para fora", order:5 },
    { keys:["blocked shots","blockedshots"], label:"Chutes bloqueados", order:6 },
    { keys:["shot pct","shot percent","shot percentage","shotpct","shooting percentage","aproveitamento dos chutes"], label:"Aproveitamento dos chutes", order:7, percent01:true, derived:"shotPct" },
    { keys:["big chances created","bigchancescreated"], label:"Grandes chances", order:8 },
    { keys:["big chances missed","bigchancesmissed"], label:"Chances perdidas", order:9 },
    { keys:["corner kicks","cornerkicks","won corners","woncorners","corners"], label:"Escanteios", order:10 },
    { keys:["fouls committed","foulscommitted","fouls"], label:"Faltas", order:11 },
    { keys:["yellow cards","yellowcards"], label:"Amarelos", order:12 },
    { keys:["red cards","redcards"], label:"Vermelhos", order:13 },
    { keys:["offsides","offside"], label:"Impedimentos", order:14 },
    { keys:["saves","goalkeeper saves"], label:"Defesas", order:15 },
    { keys:["accurate passes","accuratepasses","completed passes","passes completed"], label:"Passes certos", order:16 },
    { keys:["pass pct","pass percent","pass percentage","pass accuracy","passpct","passaccuracy"], label:"Precisão de passe", order:17, percent01:true },
    { keys:["total passes","totalpasses","passes"], label:"Passes", order:18 },
    { keys:["duels won","duelswon"], label:"Duelos vencidos", order:19 },
    { keys:["tackles won","tackleswon","tackles"], label:"Desarmes", order:20 },
    { keys:["interceptions"], label:"Interceptações", order:21 },
    { keys:["crosses","total crosses","totalcrosses"], label:"Cruzamentos", order:22 }
  ];

  function metricKey(s) {
    return norm(String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2")).replace(/\s+/g, " ").trim();
  }
  function ruleForMetric(name) {
    const key = metricKey(name), compact = key.replace(/\s+/g, "");
    for (const r of LIVE_METRIC_RULES) {
      const label = norm(r.label), lc = label.replace(/\s+/g, "");
      if (key === label || compact === lc) return r;
      if (r.keys.some(k => key === norm(k) || compact === norm(k).replace(/\s+/g, ""))) return r;
    }
    for (const r of LIVE_METRIC_RULES) {
      if (r.label === "Finalizações") continue;
      if (r.keys.some(k => key.includes(norm(k)) || compact.includes(norm(k).replace(/\s+/g, "")))) return r;
    }
    return null;
  }
  function rawStatValue(s) {
    return s && s.displayValue != null ? String(s.displayValue) : String(s && s.value != null ? s.value : "");
  }
  function numericStat(v) {
    const m = String(v == null ? "" : v).replace(",", ".").replace("%", "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }
  function formatStatValue(rule, raw) {
    if (raw == null || raw === "") return "";
    const s = String(raw).trim();
    const n = numericStat(s);
    if ((rule.percent || rule.percent01) && !/%/.test(s) && Number.isFinite(n)) {
      const value = rule.percent01 && n >= 0 && n <= 1 ? n * 100 : n;
      return (Math.round(value * 10) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
    }
    return s;
  }

  function collectStats(g, summary) {
    const byTeam = {};
    const add = (team, stats) => {
      if (!team) return;
      const id = String(team.id || "");
      const name = canon(team.displayName || team.name || team.shortDisplayName || team.abbreviation);
      const key = id || name;
      if (!key) return;
      const current = byTeam[key] || {};
      for (const stat of (stats || [])) {
        const rule = ruleForMetric(stat.displayName || stat.shortDisplayName || stat.name || stat.label || stat.abbreviation || "");
        if (!rule) continue;
        const value = formatStatValue(rule, rawStatValue(stat));
        if (value !== "") current[rule.label] = value;
      }
      byTeam[key] = current;
    };

    const comp = g.competition || getCompetition(g.raw || {});
    for (const c of (comp.competitors || [])) add(c.team || {}, c.statistics || []);
    for (const t of (((summary || {}).boxscore || {}).teams || [])) add(t.team || {}, t.statistics || t.stats || []);

    const side = (which) => {
      const team = g[which];
      return byTeam[String(team.id || "")] || byTeam[canon(team.nome)] || {};
    };
    const home = side("home"), away = side("away");

    // Se a ESPN não trouxer aproveitamento, calcula chutes no gol ÷ finalizações.
    const deriveShotPct = (obj) => {
      if (obj["Aproveitamento dos chutes"] != null) return;
      const shots = numericStat(obj["Finalizações"]), on = numericStat(obj["Chutes no gol"]);
      if (Number.isFinite(shots) && shots > 0 && Number.isFinite(on)) obj["Aproveitamento dos chutes"] = (Math.round((on / shots) * 1000) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
    };
    deriveShotPct(home); deriveShotPct(away);

    const rows = [];
    for (const rule of LIVE_METRIC_RULES) {
      const hv = home[rule.label] != null ? home[rule.label] : "";
      const av = away[rule.label] != null ? away[rule.label] : "";
      // Só exibe quando a fonte trouxe a métrica para os dois lados.
      if (hv === "" || av === "") continue;
      const hn = numericStat(hv), an = numericStat(av);
      let pct = 50;
      if (Number.isFinite(hn) && Number.isFinite(an) && hn + an > 0) pct = Math.max(4, Math.min(96, hn / (hn + an) * 100));
      rows.push({ label: rule.label, home: hv, away: av, pct, order: rule.order });
    }
    return rows.sort((a,b) => a.order - b.order);
  }

  function goalsBySide(g, summary) {
    const rows = eventRows(g, summary).filter(r => r.type.key === "goal");
    const home = [], away = [];
    const homeId = String(g.home.id || ""), awayId = String(g.away.id || "");
    for (const row of rows) {
      const item = { min: row.min, athlete: row.athlete || compactPlayerName(row.text.replace(/^Gol\s*[—-]?\s*/i, "")) || "Gol" };
      if (row.teamId && row.teamId === homeId) home.push(item);
      else if (row.teamId && row.teamId === awayId) away.push(item);
      else if (row.team === g.home.nome) home.push(item);
      else if (row.team === g.away.nome) away.push(item);
    }
    return { home, away };
  }

  function renderGoalsUnderTeams(g, summary) {
    const goals = goalsBySide(g, summary);
    const side = (items) => items.length ? '<div class="live-team-goals">' + items.map(x => '<div><span>' + esc(x.min || "") + '</span> ' + esc(x.athlete) + '</div>').join("") + '</div>' : '';
    return { home: side(goals.home), away: side(goals.away) };
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

  function renderStats(g, summary) {
    const rows = collectStats(g, summary);
    if (!rows.length) return '<div class="live-empty">As estatísticas serão exibidas quando estiverem disponíveis para esta partida.</div>';
    const names = '<div class="live-stats-head"><div>' + esc(g.home.nome) + '</div><div>comparativo</div><div>' + esc(g.away.nome) + '</div></div>';
    return '<div class="live-stats live-stats-complete">' + names + rows.map((r) => '<div class="live-stat-row">' +
      '<div class="live-stat-value"><strong>' + esc(r.home) + '</strong><div class="live-stat-mini"><span style="width:' + r.pct.toFixed(1) + '%"></span></div></div>' +
      '<div class="live-stat-label">' + esc(r.label) + (r.label === "Aproveitamento dos chutes" ? ' <small title="Chutes no gol ÷ finalizações">ⓘ</small>' : '') + '</div>' +
      '<div class="live-stat-value right"><strong>' + esc(r.away) + '</strong><div class="live-stat-mini"><span style="width:' + (100-r.pct).toFixed(1) + '%"></span></div></div>' +
      '</div>').join("") + '<div class="live-stats-note">Mostramos somente métricas disponibilizadas pela ESPN. O site não inventa dados ausentes.</div></div>';
  }

  function renderNextList(all, selected) {
    const now = Date.now();
    const next = all.filter((g) => g.date && g.date.getTime() > now && (!selected || !sameFixture(g, selected)))
      .sort((a, b) => a.date - b.date).slice(0, 6);
    if (!next.length) return "";
    return '<section class="panel live-subpanel"><div class="panel-inner"><div class="live-section-head"><h2>Próximos jogos</h2></div>' +
      '<div class="live-next-list">' + next.map((g) => {
        const canal = transmissionLabel(g);
        return '<div class="live-next-item"><div><div class="live-next-teams">' + esc(g.home.nome) + ' × ' + esc(g.away.nome) + '</div>' +
          (canal ? '<span class="live-next-channel">📺 ' + esc(canal) + '</span>' : '') + '</div><div class="live-next-meta">Rodada ' + esc(g.rodada || "—") + '<br>' + esc(formatShort(g.date)) + '</div></div>';
      }).join("") + '</div></div></section>';
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
    const transmission = "";
    const goalLines = renderGoalsUnderTeams(g, summary);

    app.innerHTML = '<section class="live-main-card"><div class="live-card-inner">' +
      '<div class="live-round-row"><span class="live-round-badge">' + esc(roundText + delayed) + '</span>' +
      '<span class="live-state-badge ' + esc(s.key) + '">' + esc(s.label) + '</span></div>' +
      '<div class="live-score-grid"><div class="live-team">' + teamLogo(g.home) + '<div class="live-team-name">' + esc(g.home.nome) + '</div>' + goalLines.home + '<div class="live-team-abbr">' + esc(g.home.sigla || SIGLAS[g.home.nome] || "") + '</div></div>' +
      '<div class="live-score-center">' + score + '<div class="live-clock">' + esc(statusText(g)) + '</div>' +
      (s.key === "pre" ? '<div class="live-kickoff">Horário de Brasília</div>' : "") +
      (countdown ? '<div class="live-countdown" data-countdown-game="' + esc(g.id) + '">' + esc(countdown) + '</div>' : "") + '</div>' +
      '<div class="live-team">' + teamLogo(g.away) + '<div class="live-team-name">' + esc(g.away.nome) + '</div>' + goalLines.away + '<div class="live-team-abbr">' + esc(g.away.sigla || SIGLAS[g.away.nome] || "") + '</div></div></div>' +
      '<div class="live-meta">' + venue + transmission + '</div>' +
      renderTransmission(g) +
      '<div class="live-message">' + esc(simpleMessage(g)) + '</div></div></section>' +
      '<section class="panel live-subpanel live-stats-panel"><div class="panel-inner"><div class="live-section-head"><h2>📊 Estatísticas</h2><span class="live-section-note">ESPN summary</span></div>' + renderStats(g, summary) + '</div></section>' +
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
