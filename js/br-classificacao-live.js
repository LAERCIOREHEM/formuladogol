(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BRClassificacaoLive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard";
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
    numberScore,
    normalizeText,
    liveStatusText,
    isInterrupted,
    isRealFinal,
    gameKey,
    normalizeScoreboard,
    fetchScoreboard,
    resultCounts,
    liveResultAlreadyStored,
    applicableGames,
    projectStandings,
    isWindowActive,
  };
});
