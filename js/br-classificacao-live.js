(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BRClassificacaoLive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard";
  const SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary";
  const FINAL_MINUTES_AFTER_START = 90;

  function numberScore(value) {
    if (value === null || value === undefined || value === "" || value === "-") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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

        const rawHome = (home.team || {}).displayName || (home.team || {}).name;
        const rawAway = (away.team || {}).displayName || (away.team || {}).name;
        const homeName = canonicalize(rawHome);
        const awayName = canonicalize(rawAway);
        const key = gameKey(homeName, awayName, (value) => value);
        if (!key) continue;

        const status = competition.status || {};
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
          placarMandante: home.score != null ? home.score : "-",
          placarVisitante: away.score != null ? away.score : "-",
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
      const key = [minute.replace(/\s+/g,""), normalizeText(scorer) || normalizeText(text), normalizeText(team)].join("|");
      const quality = node.priority + (scorer ? 20 : 0) + (team ? 10 : 0) + (assists.length ? 3 : 0);
      const previous = best.get(key);
      if (!previous || quality > previous.quality) best.set(key, { quality, goal:{ minute, scorer, team, assists, ownGoal, text } });
    }
    let goals = Array.from(best.values(), (entry) => entry.goal).sort((a,b) => (parseInt(a.minute)||999)-(parseInt(b.minute)||999));
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

  async function fetchSummary(eventId, options) {
    const opts = options || {};
    const fetcher = opts.fetcher || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error("fetch indisponível");
    const url = `${opts.url || SUMMARY_URL}?event=${encodeURIComponent(String(eventId || ""))}&_=${Date.now()}`;
    const response = await fetcher(url, { cache:"no-store", signal: opts.signal });
    if (!response || !response.ok) throw new Error(`ESPN summary HTTP ${response ? response.status : "sem resposta"}`);
    return response.json();
  }

  function dateToken(date) {
    return date.toISOString().slice(0, 10).replace(/-/g, "");
  }

  async function fetchScoreboard(options) {
    const opts = options || {};
    const reference = opts.referenceDate instanceof Date ? opts.referenceDate : new Date();
    const start = dateToken(new Date(reference.getTime() - 86400000));
    const end = dateToken(new Date(reference.getTime() + 86400000));
    const url = `${opts.url || SCOREBOARD_URL}?dates=${start}-${end}&limit=60&_=${reference.getTime()}`;
    const fetcher = opts.fetcher || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new Error("fetch indisponível");
    const response = await fetcher(url, { cache: "no-store" });
    if (!response || !response.ok) throw new Error(`ESPN HTTP ${response ? response.status : "sem resposta"}`);
    const payload = await response.json();
    return normalizeScoreboard(payload, { canonicalize: opts.canonicalize, referenceDate: reference });
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
    numberScore,
    normalizeText,
    liveStatusText,
    isInterrupted,
    isRealFinal,
    gameKey,
    normalizeScoreboard,
    fetchScoreboard,
    fetchSummary,
    normalizeSummaryFacts,
    resultCounts,
    liveResultAlreadyStored,
    applicableGames,
    projectStandings,
    isWindowActive,
  };
});
