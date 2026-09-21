(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BRClassificacaoLive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard";
  const SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary";
  const LIVE_STATE_URL = "https://push.formuladogol.com.br/v1/live/state";
  const LIVE_SUMMARY_URL = "https://push.formuladogol.com.br/v1/live/summary";
  const LIVE_STATE_VERSION = "7";
  const LIVE_FACTS_CONTRACT_VERSION = 3;
  const FINAL_MINUTES_AFTER_START = 90;
  const WORKER_TIMEOUT_MS = 4500;
  const DIRECT_TIMEOUT_MS = 4500;
  const ACTIVE_CACHE_MAX_AGE_MS = 90000;
  const IDLE_CACHE_MAX_AGE_MS = 45000;
  const POST_CACHE_MAX_AGE_MS = 180000;
  const STORAGE_KEY = "fdg.br.live-state.v7";
  const FACTS_STORAGE_PREFIX = "fdg.br.live-facts.v3.";

  function numberScore(value) {
    if (value === null || value === undefined || value === "" || value === "-") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function competitorScore(competitor) {
    const raw = competitor && competitor.score;
    if (raw && typeof raw === "object") {
      const value = raw.value ?? raw.displayValue ?? raw.score ?? raw.total;
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return raw !== null && raw !== undefined && raw !== "" ? raw : "-";
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\- ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function liveStatusText(live) {
    return [live && live.status, live && live.statusName, live && live.statusDescription]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase();
  }

  function isInterrupted(live) {
    return /postpon|adiad|suspend|cancel/.test(liveStatusText(live));
  }

  function liveDate(live) {
    if (!live || !live.dataIso) return null;
    const parsed = new Date(live.dataIso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // A ESPN às vezes sinaliza state=post/completed=false para partidas futuras.
  // A mesma trava usada pela tabela principal impede que esses falsos finais
  // alterem a classificação.
  function isRealFinal(live, referenceDate) {
    if (!live || isInterrupted(live)) return false;
    const state = String(live.estado || "").toLowerCase();
    const completed = live.completed === true || live.concluido === true;
    if (state !== "post" && !completed) return false;

    const reference = referenceDate instanceof Date ? referenceDate : new Date();
    const date = liveDate(live);
    if (!date || date.getTime() > reference.getTime() - FINAL_MINUTES_AFTER_START * 60 * 1000) return false;

    return numberScore(live.placarMandante) !== null && numberScore(live.placarVisitante) !== null;
  }

  function livePhase(live, referenceDate) {
    if (!live) return "PRE";
    if (isInterrupted(live)) return "INTERRUPTED";
    const state = String(live.estado || "").toLowerCase();
    if (state === "in") return "IN";
    if (isRealFinal(live, referenceDate)) return "POST_PENDING";
    return "PRE";
  }

  function gameKey(home, away, canonicalize) {
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const h = canon(home);
    const a = canon(away);
    return h && a ? `${h}|${a}` : null;
  }

  function shortPlayerName(player) {
    const athlete = player || {};
    return String(athlete.shortName || athlete.displayName || athlete.fullName || athlete.name || "").trim();
  }

  function normalizeScoreboard(payload, options) {
    const opts = options || {};
    const canonicalize = typeof opts.canonicalize === "function" ? opts.canonicalize : (value) => value;
    const reference = opts.referenceDate instanceof Date ? opts.referenceDate : new Date();
    const map = {};

    for (const event of (payload && payload.events) || []) {
      try {
        const competition = ((event.competitions || [])[0]) || {};
        const competitors = competition.competitors || [];
        const home = competitors.find((item) => item.homeAway === "home");
        const away = competitors.find((item) => item.homeAway === "away");
        if (!home || !away) continue;

        const rawHome = (home.team || {}).displayName || (home.team || {}).shortDisplayName || (home.team || {}).name;
        const rawAway = (away.team || {}).displayName || (away.team || {}).shortDisplayName || (away.team || {}).name;
        const homeName = canonicalize(rawHome);
        const awayName = canonicalize(rawAway);
        const key = gameKey(homeName, awayName, (value) => value);
        if (!key) continue;

        const status = competition.status || event.status || {};
        const type = status.type || {};
        const dataIso = event.date || competition.date || null;
        const eventDate = dataIso ? new Date(dataIso) : null;
        const validDate = eventDate && !Number.isNaN(eventDate.getTime());
        const completed = type.completed === true;
        const statusName = type.name || "";
        const statusDescription = type.description || type.detail || type.shortDetail || "";
        const statusText = [status.displayClock, type.shortDetail, type.detail, statusName, statusDescription]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const interrupted = /postpon|adiad|suspend|cancel/.test(statusText);
        let safeState = String(type.state || (completed ? "post" : "pre")).toLowerCase();

        if (
          safeState === "post" &&
          !completed &&
          (interrupted || !validDate || eventDate.getTime() > reference.getTime() - FINAL_MINUTES_AFTER_START * 60 * 1000)
        ) {
          safeState = "pre";
        }

        const goals = [];
        for (const detail of competition.details || []) {
          if (!detail || detail.scoringPlay !== true) continue;
          const athlete = ((detail.athletesInvolved || [])[0]) || {};
          const player = shortPlayerName(athlete);
          const minute = ((detail.clock || {}).displayValue || "").trim();
          const scoringTeam = String((detail.team || {}).id || "") === String((home.team || {}).id || "")
            ? (home.team || {}).abbreviation
            : (away.team || {}).abbreviation;
          if (player) goals.push(`${player}${minute ? ` ${minute}` : ""}${scoringTeam ? ` (${scoringTeam})` : ""}`);
        }

        map[key] = {
          estado: safeState,
          completed,
          status: status.displayClock || type.shortDetail || type.detail || "",
          statusName,
          statusDescription,
          placarMandante: competitorScore(home),
          placarVisitante: competitorScore(away),
          mandante: homeName,
          visitante: awayName,
          dataIso,
          eventId: event.id || competition.id || null,
          rodada: Number(
            ((((event.seasonType || {}).name || "").match(/\d+/) || [])[0]) ||
            ((((competition.notes || []).map((note) => note && note.headline).join(" ")).match(/\d+/) || [])[0]) ||
            0
          ),
          gols: goals,
        };
      } catch (_) {
        // Evento isolado malformado não derruba o restante do placar.
      }
    }
    return map;
  }


  function personName(value) {
    const person = value && (value.athlete || value.player || value.person || value) || {};
    return String(person.displayName || person.fullName || person.name || person.shortName || "").trim();
  }

  function cleanPlayerName(value) {
    return personName({ name: value })
      .replace(/\s+(?:assisted by|following|after)\s+.*$/i, "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function eventText(item) {
    const type = item && item.type;
    const parts = [];
    if (type && typeof type === "object") parts.push(type.text, type.name, type.displayName, type.description);
    else if (type) parts.push(type);
    parts.push(item && item.text, item && item.description, item && item.shortText, item && item.headline);
    return parts.filter(Boolean).map(String).filter((value, index, all) => all.indexOf(value) === index).join(" ").replace(/\s+/g, " ").trim();
  }

  function eventMinute(item) {
    for (const key of ["clock", "time", "displayClock", "timeDisplayValue", "minute", "minuto"]) {
      const value = item && item[key];
      if (value && typeof value === "object") {
        const text = value.displayValue || value.displayClock || value.text || value.value;
        if (text != null && text !== "") return String(text);
      } else if (value != null && value !== "") return String(value);
    }
    return "";
  }

  function summaryEventNodes(summary) {
    const priorities = { scoringplays:100, keyevents:90, incidents:80, matchevents:75, plays:50, commentary:40, details:30 };
    const out = [], seenLists = new Set();
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        const nk = normalizeText(key).replace(/\s+/g, "");
        if (Array.isArray(value) && priorities[nk] && !seenLists.has(value)) {
          seenLists.add(value);
          value.forEach((item) => { if (item && typeof item === "object") out.push({ item, priority: priorities[nk] }); });
        }
        if (value && typeof value === "object") walk(value);
      }
    };
    walk(summary || {});
    return out.sort((a,b) => b.priority - a.priority);
  }

  function summaryTeamMap(summary, live, canonicalize) {
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const out = {};
    const add = (team, fallback) => {
      if (!team || typeof team !== "object") return;
      const name = canon(team.displayName || team.shortDisplayName || team.name || team.location || fallback || "");
      const id = String(team.id || team.uid || "");
      if (id && name) out[id] = name;
    };
    const competitors = (((summary || {}).header || {}).competitions || [])[0]?.competitors || [];
    competitors.forEach((row) => add(row.team || row, row.homeAway === "home" ? live?.mandante : live?.visitante));
    (((summary || {}).boxscore || {}).teams || []).forEach((row) => add(row.team || row));
    return out;
  }

  function eventAthletes(item) {
    const out = [];
    for (const key of ["athletes", "athletesInvolved", "participants", "players"]) {
      for (const entry of (item && item[key]) || []) {
        if (!entry || typeof entry !== "object") continue;
        const name = personName(entry);
        const role = normalizeText([entry.type, entry.role, entry.position].map((x) => x && typeof x === "object" ? (x.text || x.name || x.description || "") : (x || "")).join(" "));
        if (name) out.push({ name: cleanPlayerName(name), role });
      }
    }
    for (const key of ["athlete", "player", "scorer"]) {
      if (item && item[key] && typeof item[key] === "object") {
        const name = cleanPlayerName(personName(item[key]));
        if (name && !out.some((row) => normalizeText(row.name) === normalizeText(name))) out.push({ name, role: key === "scorer" ? "scorer" : "" });
      }
    }
    return out;
  }

  function isGoalEvent(item, text) {
    const type = normalizeText(item && item.type && typeof item.type === "object" ? [item.type.text,item.type.name,item.type.description].filter(Boolean).join(" ") : item && item.type);
    const normalized = normalizeText(text);
    if (/attempt saved|shot saved|save made|shots on goal|shots on target|expected goals|goalkeeper|missed|blocked/.test(normalized) && !/\b(goal|gol)!/i.test(text)) return false;
    return /\bown goal\b|\bgoal\b|\bgol\b/.test(type) || /\b(?:goal|gol)!/i.test(text) || /\bown goal by\b/i.test(text);
  }

  function teamFromEvent(item, teamMap, live, canonicalize) {
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const raw = item && (item.team || item.competitor || item.club);
    const directId = String(item && (item.teamId || item.team_id || item.competitorId || item.clubId) || "");
    if (directId && teamMap[directId]) return teamMap[directId];
    if (typeof raw === "string" && teamMap[raw]) return teamMap[raw];
    if (raw && typeof raw === "object") {
      const id = String(raw.id || raw.uid || "");
      if (id && teamMap[id]) return teamMap[id];
      const name = canon(raw.displayName || raw.shortDisplayName || raw.name || raw.location || raw.abbreviation || "");
      if (name) return name;
    }
    return "";
  }

  function extractAssists(text) {
    const out = [];
    const regex = /assist(?:ed|ência|encia)?\s+(?:by|de|por)\s+([^.;()]+)/gi;
    let match;
    while ((match = regex.exec(String(text || "")))) {
      const name = cleanPlayerName(match[1]);
      if (name && !out.some((row) => normalizeText(row) === normalizeText(name))) out.push(name);
    }
    return out;
  }

  function summaryAppearances(summary, live, canonicalize, teamMap) {
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const out = [];
    const blocks = [];
    if (Array.isArray(summary && summary.rosters)) blocks.push(...summary.rosters);
    if (Array.isArray(summary && summary.lineups)) blocks.push(...summary.lineups);
    for (const [index, block] of blocks.entries()) {
      if (!block || typeof block !== "object") continue;
      const rawTeam = block.team || block.club || block.competitor || {};
      let team = teamFromEvent({ team: rawTeam }, teamMap, live, canon);
      if (!team) team = index === 0 ? live?.mandante : index === 1 ? live?.visitante : "";
      const entries = [];
      for (const key of ["roster", "athletes", "players", "lineup"]) if (Array.isArray(block[key])) entries.push(...block[key]);
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const dnp = entry.didNotPlay === true || entry.did_not_play === true || entry.dnp === true;
        if (dnp) continue;
        const rawMinutes = entry.minutes ?? entry.minutesPlayed ?? (entry.stats && entry.stats.minutes);
        const minutes = Number(String(rawMinutes ?? "").replace(/[^0-9.]/g, ""));
        const played = entry.starter === true || entry.starting === true || entry.isStarter === true || entry.subbedIn === true || entry.subbed_in === true || entry.entered === true || entry.played === true || entry.appeared === true || entry.participated === true || (Number.isFinite(minutes) && minutes > 0);
        if (!played) continue;
        const name = cleanPlayerName(personName(entry));
        if (name && team) out.push({ name, team });
      }
    }
    const seen = new Set();
    return out.filter((row) => { const key = normalizeText(row.team)+"|"+normalizeText(row.name); if (seen.has(key)) return false; seen.add(key); return true; });
  }

  function normalizeSummaryFacts(summary, live, canonicalize) {
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const teamMap = summaryTeamMap(summary, live || {}, canon);
    const best = new Map();
    for (const node of summaryEventNodes(summary || {})) {
      const item = node.item, text = eventText(item);
      if (!text || !isGoalEvent(item, text)) continue;
      const athletes = eventAthletes(item);
      let scorer = (athletes.find((row) => !/assist/.test(row.role)) || {}).name || "";
      if (!scorer) {
        const m = text.match(/(?:goal|gol)!.*?\.\s*([^().]+?)\s*\(([^)]+)\)/i) || text.match(/own goal by\s+([^,.;]+)/i);
        if (m) scorer = cleanPlayerName(m[1]);
      }
      let assists = athletes.filter((row) => /assist/.test(row.role)).map((row) => row.name);
      if (!assists.length) assists = extractAssists(text);
      const team = teamFromEvent(item, teamMap, live || {}, canon);
      const minute = eventMinute(item);
      const ownGoal = /own goal|gol contra/i.test(text);
      const rawHomeScore = item?.homeScore ?? item?.score?.homeScore ?? item?.score?.home;
      const rawAwayScore = item?.awayScore ?? item?.score?.awayScore ?? item?.score?.away;
      const homeScoreAfter = numberScore(rawHomeScore);
      const awayScoreAfter = numberScore(rawAwayScore);
      const key = [minute.replace(/\s+/g,""), normalizeText(scorer) || normalizeText(text), normalizeText(team), homeScoreAfter ?? "", awayScoreAfter ?? ""].join("|");
      const quality = node.priority + (scorer ? 20 : 0) + (team ? 10 : 0) + (assists.length ? 3 : 0) + (homeScoreAfter !== null && awayScoreAfter !== null ? 4 : 0);
      const previous = best.get(key);
      if (!previous || quality > previous.quality) best.set(key, { quality, goal:{ minute, scorer, team, assists, ownGoal, text, homeScoreAfter, awayScoreAfter } });
    }
    let goals = Array.from(best.values(), (entry) => entry.goal).sort((a,b) => (parseInt(a.minute)||999)-(parseInt(b.minute)||999));
    // Fallback determinístico: se a superfície ESPN omite team/teamId mas informa
    // o placar depois do gol, inferimos o lado pela transição do placar.
    let seenHome = 0, seenAway = 0;
    for (const goal of goals) {
      if (!goal.team && goal.homeScoreAfter !== null && goal.awayScoreAfter !== null) {
        if (goal.homeScoreAfter > seenHome && goal.awayScoreAfter === seenAway) goal.team = canon(live?.mandante);
        else if (goal.awayScoreAfter > seenAway && goal.homeScoreAfter === seenHome) goal.team = canon(live?.visitante);
      }
      if (goal.homeScoreAfter !== null && goal.awayScoreAfter !== null) { seenHome = goal.homeScoreAfter; seenAway = goal.awayScoreAfter; }
      else if (goal.team === canon(live?.mandante)) seenHome += 1;
      else if (goal.team === canon(live?.visitante)) seenAway += 1;
    }
    const limits = new Map([[canon(live?.mandante), numberScore(live?.placarMandante) || 0], [canon(live?.visitante), numberScore(live?.placarVisitante) || 0]]);
    const used = new Map();
    goals = goals.filter((goal) => {
      const team = canon(goal.team);
      if (!team || !limits.has(team)) return true;
      const count = used.get(team) || 0;
      if (count >= limits.get(team)) return false;
      used.set(team, count + 1);
      goal.team = team;
      return true;
    });
    const appearances = summaryAppearances(summary || {}, live || {}, canon, teamMap);
    for (const goal of goals) {
      if (goal.scorer && goal.team) appearances.push({ name: goal.scorer, team: goal.team });
      goal.assists.forEach((name) => { if (name && goal.team) appearances.push({ name, team: goal.team }); });
    }
    const seen = new Set();
    const uniqueAppearances = appearances.filter((row) => { const key=normalizeText(row.team)+"|"+normalizeText(row.name); if(seen.has(key)) return false; seen.add(key); return true; });
    return { goals, appearances: uniqueAppearances };
  }

  function dateToken(date) {
    return date.toISOString().slice(0, 10).replace(/-/g, "");
  }

  function storageFromOptions(opts) {
    if (opts && opts.storage) return opts.storage;
    try { return typeof sessionStorage !== "undefined" ? sessionStorage : null; } catch (_) { return null; }
  }

  function liveValues(liveMap) {
    return Object.values(liveMap || {}).filter((item) => item && typeof item === "object" && item.mandante && item.visitante);
  }

  function liveMapState(liveMap) {
    const values = liveValues(liveMap);
    if (values.some((game) => String(game.estado || "").toLowerCase() === "in")) return "in";
    if (values.some((game) => String(game.estado || "").toLowerCase() === "post" || game.completed === true)) return "post";
    return "pre";
  }

  function cacheMaxAge(liveMap) {
    const state = liveMapState(liveMap);
    if (state === "in") return ACTIVE_CACHE_MAX_AGE_MS;
    if (state === "post") return POST_CACHE_MAX_AGE_MS;
    return IDLE_CACHE_MAX_AGE_MS;
  }

  function readLastLiveState(opts, reference) {
    const storage = storageFromOptions(opts);
    if (!storage || typeof storage.getItem !== "function") return null;
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
      if (!saved || saved.version !== LIVE_STATE_VERSION || !saved.liveMap) return null;
      const fetchedAt = Number(saved.meta && saved.meta.fetchedAt || 0);
      if (!fetchedAt) return null;
      const ageMs = Math.max(0, reference.getTime() - fetchedAt);
      if (ageMs > cacheMaxAge(saved.liveMap)) return null;
      return {
        liveMap: saved.liveMap,
        meta: { ...(saved.meta || {}), source: "last-valid-espn", fallback: true, ageMs, liveStateVersion: LIVE_STATE_VERSION },
      };
    } catch (_) { return null; }
  }

  function writeLastLiveState(opts, state) {
    const storage = storageFromOptions(opts);
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: LIVE_STATE_VERSION, liveMap: state.liveMap, meta: state.meta }));
    } catch (_) { /* cache local é apenas contingência */ }
  }

  function publishLiveState(state) {
    try {
      const diagnostics = {
        ...(state.meta || {}),
        liveGames: liveValues(state.liveMap).filter((game) => String(game.estado || "").toLowerCase() === "in").length,
        totalGames: liveValues(state.liveMap).length,
      };
      if (typeof globalThis !== "undefined") globalThis.__FDG_LIVE_STATE__ = diagnostics;
      if (typeof globalThis !== "undefined" && typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
        globalThis.dispatchEvent(new CustomEvent("fdg:live-state", { detail: diagnostics }));
      }
    } catch (_) { /* observabilidade não interfere no dado */ }
    return state;
  }

  async function fetchJson(url, opts, timeoutMs) {
    const fetcher = opts.fetcher || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error("fetch indisponível");
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetcher(url, { cache: "no-store", signal: opts.signal || (controller && controller.signal) || undefined });
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : "sem resposta"}`);
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function eventIdFromGame(game) {
    return String(game && (game.event_id || game.eventId || game.espn_event_id || game.espnEventId || game.id_espn) || "").trim();
  }

  function findLiveGame(game, liveMap, canonicalize) {
    if (!game || !liveMap) return null;
    const eventId = eventIdFromGame(game);
    if (eventId) {
      const byId = liveValues(liveMap).find((live) => String(live.eventId || "") === eventId);
      if (byId) return byId;
    }
    const home = (game.mandante && typeof game.mandante === "object") ? game.mandante.nome : game.mandante;
    const away = (game.visitante && typeof game.visitante === "object") ? game.visitante.nome : game.visitante;
    const key = gameKey(home, away, canonicalize);
    if (key && liveMap[key]) return liveMap[key];
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const h = canon(home), a = canon(away);
    if (!h || !a) return null;
    return liveValues(liveMap).find((live) => canon(live.mandante) === h && canon(live.visitante) === a) || null;
  }

  async function fetchLiveState(options) {
    const opts = options || {};
    const reference = opts.referenceDate instanceof Date ? opts.referenceDate : new Date();
    const start = dateToken(new Date(reference.getTime() - 86400000));
    const end = dateToken(new Date(reference.getTime() + 86400000));
    const dates = `${start}-${end}`;
    const errors = [];
    let workerFallbackState = null;

    if (opts.worker !== false) {
      try {
        const workerUrl = `${opts.workerUrl || LIVE_STATE_URL}?league=bra.1&dates=${dates}${opts.forceFresh === true ? "&fresh=1" : ""}&_=${reference.getTime()}`;
        const envelope = await fetchJson(workerUrl, opts, Number(opts.workerTimeoutMs || WORKER_TIMEOUT_MS));
        const payload = envelope && envelope.data && Array.isArray(envelope.data.events) ? envelope.data : envelope;
        const liveMap = normalizeScoreboard(payload, { canonicalize: opts.canonicalize, referenceDate: reference });
        const state = {
          liveMap,
          meta: {
            source: "worker-espn",
            transport: "worker",
            upstream: envelope.source || "espn",
            sources: Array.isArray(envelope.sources) ? envelope.sources : [],
            fetchedAt: Number(envelope.fetchedAt || reference.getTime()),
            stale: envelope.stale === true,
            ageMs: Number(envelope.ageMs || 0),
            fallback: false,
            liveStateVersion: LIVE_STATE_VERSION,
          },
        };
        if (envelope.stale === true) {
          workerFallbackState = {
            liveMap: state.liveMap,
            meta: { ...state.meta, fallback: true, source: "worker-espn-stale" },
          };
          errors.push(`worker=stale:${String(envelope.cacheStatus || "fallback")}`);
        } else {
          writeLastLiveState(opts, state);
          return publishLiveState(state);
        }
      } catch (error) {
        errors.push(`worker=${String(error && error.message || error)}`);
      }
    }

    try {
      const directUrl = `${opts.url || SCOREBOARD_URL}?dates=${dates}&limit=60&_=${reference.getTime()}`;
      const payload = await fetchJson(directUrl, opts, Number(opts.directTimeoutMs || DIRECT_TIMEOUT_MS));
      const liveMap = normalizeScoreboard(payload, { canonicalize: opts.canonicalize, referenceDate: reference });
      const state = {
        liveMap,
        meta: {
          source: "direct-espn", transport: "browser", upstream: "espn_site_api",
          sources: ["espn_site_api"], fetchedAt: reference.getTime(), stale: false, ageMs: 0, fallback: errors.length > 0,
          liveStateVersion: LIVE_STATE_VERSION,
        },
      };
      writeLastLiveState(opts, state);
      return publishLiveState(state);
    } catch (error) {
      errors.push(`direct=${String(error && error.message || error)}`);
    }

    if (workerFallbackState) {
      workerFallbackState.meta.errors = errors;
      writeLastLiveState(opts, workerFallbackState);
      return publishLiveState(workerFallbackState);
    }

    const cached = readLastLiveState(opts, reference);
    if (cached) {
      cached.meta.errors = errors;
      return publishLiveState(cached);
    }
    throw new Error(`ESPN live indisponível: ${errors.join(" | ")}`);
  }

  async function fetchScoreboard(options) {
    return (await fetchLiveState(options)).liveMap;
  }

  async function fetchSummary(eventId, options) {
    const opts = options || {};
    const id = encodeURIComponent(String(eventId || ""));
    const expectedGoals = Math.max(0, Number(opts.expectedGoals || 0) || 0);
    const expectedHome = numberScore(opts.expectedHome);
    const expectedAway = numberScore(opts.expectedAway);
    const exactScore = expectedHome !== null && expectedAway !== null
      ? `&expectedHome=${expectedHome}&expectedAway=${expectedAway}`
      : "";
    const errors = [];
    if (opts.worker !== false) {
      try {
        const workerUrl = `${opts.workerSummaryUrl || LIVE_SUMMARY_URL}?league=bra.1&event=${id}&state=${encodeURIComponent(opts.state || "in")}&expectedGoals=${expectedGoals}${exactScore}${opts.forceFresh === true ? "&fresh=1" : ""}&_=${Date.now()}`;
        const envelope = await fetchJson(workerUrl, opts, Number(opts.workerTimeoutMs || WORKER_TIMEOUT_MS));
        if (envelope && envelope.data && typeof envelope.data === "object") return envelope.data;
        throw new Error("payload summary do Worker inválido");
      } catch (error) { errors.push(`worker=${String(error && error.message || error)}`); }
    }
    try { return await fetchJson(`${opts.url || SUMMARY_URL}?event=${id}&_=${Date.now()}`, opts, Number(opts.directTimeoutMs || DIRECT_TIMEOUT_MS)); }
    catch (error) { errors.push(`direct=${String(error && error.message || error)}`); }
    throw new Error(`ESPN summary indisponível: ${errors.join(" | ")}`);
  }

  function factsExpectedScore(live) {
    const home = numberScore(live && live.placarMandante);
    const away = numberScore(live && live.placarVisitante);
    return {
      home: home === null ? 0 : Math.max(0, home),
      away: away === null ? 0 : Math.max(0, away),
    };
  }
  function factsExpectedGoals(live) { const score=factsExpectedScore(live); return score.home+score.away; }
  function factsQuality(facts) {
    const i=facts?.integrity||{};
    if (i.mathematicallyValid === false) return -1;
    return (i.complete?100000:0)+(i.scoreComplete?20000:0)+Number(i.usableGoalCount||0)*1000+Number(i.scorerResolvedCount||0)*100+(facts?.goals||[]).reduce((sum,g)=>sum+(g.assists||[]).length,0)*10+(facts?.appearances||[]).length;
  }
  function finalizeFacts(rawFacts, live, canonicalize, meta) {
    const canon=typeof canonicalize==="function"?canonicalize:(value)=>value;
    const expected=factsExpectedScore(live), expectedGoals=expected.home+expected.away;
    const rawGoals=Array.isArray(rawFacts?.goals)?rawFacts.goals:[];
    const goals=rawGoals.filter((g)=>{
      const h=numberScore(g?.scoreAfter?.home), a=numberScore(g?.scoreAfter?.away);
      if (expectedGoals===0) return false;
      return h!==null&&a!==null&&h<=expected.home&&a<=expected.away&&h+a<=expectedGoals;
    }).map((g)=>{
      const rawTeam=String(g.team||"").trim();
      const team=rawTeam?canon(rawTeam):(g.side==="home"?canon(live?.mandante):g.side==="away"?canon(live?.visitante):"");
      return {...g,team,scorer:cleanPlayerName(g.scorer||""),assists:(Array.isArray(g.assists)?g.assists:[]).map(cleanPlayerName).filter(Boolean)};
    });
    const appearances=(Array.isArray(rawFacts?.appearances)?rawFacts.appearances:[]).map((a)=>({...a,name:cleanPlayerName(a.name||""),team:canon(a.team||"")})).filter((a)=>a.name&&a.team);
    const observedGoalCount=goals.length, teamResolvedCount=goals.filter((g)=>g.team).length, scorerResolvedCount=goals.filter((g)=>g.ownGoal||g.scorer).length, usableGoalCount=goals.filter((g)=>g.team&&(g.ownGoal||g.scorer)).length;
    const upstream=rawFacts?.integrity||{};
    const exactScoreMatches=Number(upstream.expectedHome)===expected.home&&Number(upstream.expectedAway)===expected.away&&Number(upstream.expectedGoals)===expectedGoals;
    const mathematicallyValid=upstream.mathematicallyValid!==false&&observedGoalCount<=expectedGoals&&goals.every((g)=>Number(g?.scoreAfter?.home)<=expected.home&&Number(g?.scoreAfter?.away)<=expected.away);
    const scoreComplete=expectedGoals===0
      ? observedGoalCount===0&&mathematicallyValid
      : exactScoreMatches&&mathematicallyValid&&upstream.scoreComplete===true&&observedGoalCount===expectedGoals;
    const identityComplete=expectedGoals===0?observedGoalCount===0:(teamResolvedCount===expectedGoals&&scorerResolvedCount===expectedGoals&&usableGoalCount===expectedGoals);
    const complete=scoreComplete&&identityComplete;
    return {...rawFacts,contractVersion:LIVE_FACTS_CONTRACT_VERSION,goals,appearances,integrity:{...upstream,expectedHome:expected.home,expectedAway:expected.away,expectedGoals,observedGoalCount,teamResolvedCount,scorerResolvedCount,usableGoalCount,mathematicallyValid,scoreComplete,identityComplete,complete,missingGoals:Math.max(0,expectedGoals-observedGoalCount),missingTeams:Math.max(0,expectedGoals-teamResolvedCount),missingScorers:Math.max(0,expectedGoals-scorerResolvedCount),status:complete?"complete":scoreComplete?"identity-pending":"summary-pending"},meta:meta||rawFacts?.meta||{}};
  }
  function factsStorage(options){if(options&&options.storage)return options.storage; try{return typeof sessionStorage!=="undefined"?sessionStorage:null;}catch(_){return null;}}
  function factsScoreKey(score){return `${Number(score?.home||0)}:${Number(score?.away||0)}`;}
  function readFactsCache(eventId,expectedScore,options){const storage=factsStorage(options); if(!storage)return null; try{const saved=JSON.parse(storage.getItem(FACTS_STORAGE_PREFIX+eventId)||"null"); if(!saved||String(saved.scoreKey||"")!==factsScoreKey(expectedScore)||Date.now()-Number(saved.fetchedAt||0)>600000)return null; const facts=saved.facts||null; if(Number(facts?.contractVersion||0)!==LIVE_FACTS_CONTRACT_VERSION)return null; return facts;}catch(_){return null;}}
  function writeFactsCache(eventId,expectedScore,facts,options){const storage=factsStorage(options); if(!storage||!facts||facts?.integrity?.mathematicallyValid===false)return; try{storage.setItem(FACTS_STORAGE_PREFIX+eventId,JSON.stringify({scoreKey:factsScoreKey(expectedScore),fetchedAt:Date.now(),facts}));}catch(_){}}
  async function fetchMatchFacts(game, options) {
    const opts=options||{}, live=game&&typeof game==="object"?game:{eventId:String(game||"")}, eventId=String(live.eventId||live.id||game||"");
    if(!eventId)throw new Error("event_id ausente");
    const expectedScore=factsExpectedScore(live), expectedGoals=expectedScore.home+expectedScore.away, errors=[];
    let best=null;
    if(opts.worker!==false){
      try{
        const id=encodeURIComponent(eventId);
        const url=`${opts.workerSummaryUrl||LIVE_SUMMARY_URL}?league=bra.1&event=${id}&state=${encodeURIComponent(live.estado||opts.state||"in")}&expectedGoals=${expectedGoals}&expectedHome=${expectedScore.home}&expectedAway=${expectedScore.away}${opts.forceFresh===true?"&fresh=1":""}&_=${Date.now()}`;
        const envelope=await fetchJson(url,opts,Number(opts.workerTimeoutMs||WORKER_TIMEOUT_MS));
        if(Number(envelope?.factsContractVersion||envelope?.facts?.contractVersion||0)===LIVE_FACTS_CONTRACT_VERSION&&envelope?.facts){
          best=finalizeFacts(envelope.facts,live,opts.canonicalize,{source:"worker-canonical-v3-monitor",fetchedAt:Number(envelope.fetchedAt||Date.now()),stale:envelope.stale===true,factsBestKnownApplied:envelope.factsBestKnownApplied===true});
          if(best.integrity.complete){writeFactsCache(eventId,expectedScore,best,opts); return best;}
        } else throw new Error("contrato canônico de fatos incompatível");
      }catch(error){errors.push(`worker=${String(error&&error.message||error)}`);}
    }

    // Live Facts v6: autoria de gol/assistência NUNCA volta a ser inferida do
    // JSON bruto no navegador. Se o Worker falhar, somente um snapshot canônico
    // já validado para o MESMO placar pode ser reutilizado.
    const cached=readFactsCache(eventId,expectedScore,opts);
    if(cached&&(!best||factsQuality(cached)>factsQuality(best)))best={...cached,meta:{...(cached.meta||{}),source:"last-canonical-facts",stale:true,errors}};
    if(best){writeFactsCache(eventId,expectedScore,best,opts); return best;}
    if(expectedGoals===0){
      return finalizeFacts({eventId,goals:[],appearances:[],integrity:{expectedHome:0,expectedAway:0,expectedGoals:0,scoreComplete:true,identityComplete:true,complete:true,mathematicallyValid:true,reconciliationState:"scoreboard-zero-client-guard"}},live,opts.canonicalize,{source:"scoreboard-zero-client-guard",stale:false,errors});
    }
    throw new Error(`Live Facts canônicos indisponíveis: ${errors.join(" | ")}`);
  }

  function resultCounts(results, canonicalize) {
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const counts = {};
    for (const result of results || []) {
      const home = canon((result.mandante || {}).nome || result.mandante);
      const away = canon((result.visitante || {}).nome || result.visitante);
      if (home) counts[home] = (counts[home] || 0) + 1;
      if (away) counts[away] = (counts[away] || 0) + 1;
    }
    return counts;
  }

  function liveResultAlreadyStored(live, results, canonicalize) {
    if (!live) return false;
    const canon = typeof canonicalize === "function" ? canonicalize : (value) => value;
    const home = canon(live.mandante);
    const away = canon(live.visitante);
    const hs = numberScore(live.placarMandante);
    const as = numberScore(live.placarVisitante);
    return (results || []).some((result) =>
      canon((result.mandante || {}).nome || result.mandante) === home &&
      canon((result.visitante || {}).nome || result.visitante) === away &&
      Number(result.placar_mandante) === hs &&
      Number(result.placar_visitante) === as
    );
  }

  function applicableGames(options) {
    const opts = options || {};
    const table = opts.table || [];
    const results = opts.results || [];
    const liveMap = opts.liveMap || {};
    const canonicalize = typeof opts.canonicalize === "function" ? opts.canonicalize : (value) => value;
    const reference = opts.referenceDate instanceof Date ? opts.referenceDate : new Date();
    const official = {};
    for (const row of table) {
      const name = canonicalize(row.time || row.clube);
      if (name) official[name] = row;
    }
    const counts = resultCounts(results, canonicalize);
    const seen = new Set();
    const output = [];

    for (const live of Object.values(liveMap)) {
      if (!live) continue;
      const final = isRealFinal(live, reference);
      if (!(String(live.estado || "").toLowerCase() === "in" || final)) continue;
      const home = canonicalize(live.mandante);
      const away = canonicalize(live.visitante);
      const hs = numberScore(live.placarMandante);
      const as = numberScore(live.placarVisitante);
      if (!home || !away || hs === null || as === null || !official[home] || !official[away]) continue;
      const key = `${home}|${away}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (final) {
        const stored = liveResultAlreadyStored({ ...live, mandante: home, visitante: away }, results, canonicalize);
        const expectedHome = (counts[home] || 0) + (stored ? 0 : 1);
        const expectedAway = (counts[away] || 0) + (stored ? 0 : 1);
        if (Number(official[home].jogos) >= expectedHome && Number(official[away].jogos) >= expectedAway) continue;
      }

      output.push({
        ...live,
        mandante: home,
        visitante: away,
        placarMandante: hs,
        placarVisitante: as,
        livePhase: final ? "POST_PENDING" : "IN",
      });
    }
    return output;
  }

  function projectStandings(options) {
    const opts = options || {};
    const table = opts.table || [];
    const canonicalize = typeof opts.canonicalize === "function" ? opts.canonicalize : (value) => value;
    const reference = opts.referenceDate instanceof Date ? opts.referenceDate : new Date();
    const base = table.map((row) => ({
      ...row,
      time: canonicalize(row.time || row.clube) || row.time || row.clube,
      _aoVivo: false,
      _provisorioFinal: false,
      _basePos: Number(row.pos || 999),
    }));
    const byTeam = Object.fromEntries(base.map((row) => [row.time, row]));
    const games = applicableGames({
      table: base,
      results: opts.results || [],
      liveMap: opts.liveMap || {},
      canonicalize,
      referenceDate: reference,
    });

    for (const game of games) {
      const home = byTeam[game.mandante];
      const away = byTeam[game.visitante];
      if (!home || !away) continue;
      const hs = game.placarMandante;
      const as = game.placarVisitante;
      const final = isRealFinal(game, reference);
      for (const row of [home, away]) {
        row.jogos = Number(row.jogos || 0) + 1;
        row._aoVivo = String(game.estado || "").toLowerCase() === "in";
        row._provisorioFinal = final;
      }
      home.gp = Number(home.gp || 0) + hs;
      home.gc = Number(home.gc || 0) + as;
      away.gp = Number(away.gp || 0) + as;
      away.gc = Number(away.gc || 0) + hs;
      home.vitorias = Number(home.vitorias || 0);
      home.empates = Number(home.empates || 0);
      home.derrotas = Number(home.derrotas || 0);
      away.vitorias = Number(away.vitorias || 0);
      away.empates = Number(away.empates || 0);
      away.derrotas = Number(away.derrotas || 0);
      home.pontos = Number(home.pontos || 0);
      away.pontos = Number(away.pontos || 0);
      if (hs > as) {
        home.vitorias += 1;
        away.derrotas += 1;
        home.pontos += 3;
      } else if (hs < as) {
        away.vitorias += 1;
        home.derrotas += 1;
        away.pontos += 3;
      } else {
        home.empates += 1;
        away.empates += 1;
        home.pontos += 1;
        away.pontos += 1;
      }
    }

    for (const row of base) {
      row.sg = Number(row.gp || 0) - Number(row.gc || 0);
      row.aproveitamento = Number(row.jogos) > 0
        ? Math.round((Number(row.pontos || 0) / (Number(row.jogos) * 3)) * 100)
        : 0;
    }
    base.sort((a, b) =>
      Number(b.pontos) - Number(a.pontos) ||
      Number(b.vitorias) - Number(a.vitorias) ||
      Number(b.sg) - Number(a.sg) ||
      Number(b.gp) - Number(a.gp) ||
      Number(a._basePos || 999) - Number(b._basePos || 999) ||
      String(a.time).localeCompare(String(b.time), "pt-BR")
    );
    base.forEach((row, index) => { row.pos = index + 1; });
    return { tabela: base, jogos: games };
  }

  function scheduleDate(game) {
    const raw = game && (game.data_iso || game.dataIso || game.data);
    if (!raw) return null;
    const text = String(raw);
    let parsed = new Date(text);
    // jogos.json normalmente grava horário de Brasília sem offset.
    if (!/[zZ]|[+\-]\d{2}:?\d{2}$/.test(text)) parsed = new Date(`${text.length <= 16 ? `${text}:00` : text}-03:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function isWindowActive(schedule, liveMap, referenceDate, beforeMinutes, afterMinutes) {
    const reference = referenceDate instanceof Date ? referenceDate : new Date();
    const before = Number.isFinite(Number(beforeMinutes)) ? Number(beforeMinutes) : 20;
    const after = Number.isFinite(Number(afterMinutes)) ? Number(afterMinutes) : 150;
    if (Object.values(liveMap || {}).some((live) => String(live && live.estado || "").toLowerCase() === "in")) return true;
    for (const game of schedule || []) {
      const date = scheduleDate(game);
      if (!date) continue;
      if (
        reference.getTime() >= date.getTime() - before * 60 * 1000 &&
        reference.getTime() <= date.getTime() + after * 60 * 1000
      ) return true;
    }
    return false;
  }

  return {
    SCOREBOARD_URL,
    SUMMARY_URL,
    LIVE_STATE_URL,
    LIVE_SUMMARY_URL,
    LIVE_STATE_VERSION,
    LIVE_FACTS_CONTRACT_VERSION,
    numberScore,
    competitorScore,
    normalizeText,
    liveStatusText,
    isInterrupted,
    isRealFinal,
    livePhase,
    gameKey,
    normalizeScoreboard,
    fetchLiveState,
    fetchScoreboard,
    fetchSummary,
    fetchMatchFacts,
    eventIdFromGame,
    findLiveGame,
    normalizeSummaryFacts,
    resultCounts,
    liveResultAlreadyStored,
    applicableGames,
    projectStandings,
    isWindowActive,
  };
});
