(function () {
  "use strict";

  const TZ = "America/Sao_Paulo";
  const app = document.getElementById("agenda-app");
  const statusBox = document.getElementById("agenda-status");
  const competitionBox = document.getElementById("agenda-competition-filters");
  const monthBox = document.getElementById("agenda-month-filters");
  const FALLBACK_SHIELD = "img/escudo-neutro.svg";

  const competitionOrder = ["todos", "brasileirao", "copa_do_brasil", "libertadores", "sul_americana"];
  const competitionLabels = {
    todos: "Todos",
    brasileirao: "Brasileirão",
    copa_do_brasil: "Copa do Brasil",
    libertadores: "Libertadores",
    sul_americana: "Sul-Americana"
  };

  const state = {
    games: [],
    transmissions: {},
    youtube: {},
    competition: "todos",
    month: ""
  };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  function parseDate(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const date = new Date(text.length <= 16 ? text + ":00-03:00" : text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date);
    const map = {};
    parts.forEach((part) => { if (part.type !== "literal") map[part.type] = part.value; });
    return { day: map.day, month: map.month, year: map.year };
  }

  function dateKey(date) {
    const p = dateParts(date);
    return p.year + "-" + p.month + "-" + p.day;
  }

  function monthKey(date) {
    const p = dateParts(date);
    return p.year + "-" + p.month;
  }

  function todayKey() { return dateKey(new Date()); }

  function formatDay(date) {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ, weekday: "long", day: "2-digit", month: "long"
    }).format(date);
  }

  function formatMonth(key) {
    const date = new Date(key + "-01T12:00:00-03:00");
    const label = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, month: "long", year: "numeric" }).format(date);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(date);
  }

  async function fetchJson(url, fallback) {
    try {
      const response = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } catch (_) {
      return fallback;
    }
  }

  function transmissionFor(game) {
    const id = String(game.event_id || "");
    const tv = state.transmissions[id] || null;
    const yt = state.youtube[id] || null;
    const channels = tv && Array.isArray(tv.canais) ? tv.canais.filter(Boolean) : [];
    const principal = yt && yt.principal;
    return {
      label: channels.join(" / ") || (principal && (principal.nome || (principal.fonte === "cazetv" ? "CazéTV" : "GE TV"))) || "Transmissão a confirmar",
      youtubeUrl: principal && safeYoutube(principal.url)
    };
  }

  function safeYoutube(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      if (!["youtube.com", "www.youtube.com", "youtu.be"].includes(url.hostname.toLowerCase())) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function phaseText(game) {
    if (game.competicao_chave === "brasileirao") return game.rodada ? "Rodada " + game.rodada : "Série A 2026";
    const parts = [];
    if (game.fase) parts.push(game.fase);
    if (Number(game.perna) === 1) parts.push("Ida");
    if (Number(game.perna) === 2) parts.push("Volta");
    return parts.join(" · ") || "Fase em andamento";
  }

  function logo(team) {
    const src = String(team && team.escudo || FALLBACK_SHIELD);
    return '<img src="' + esc(src) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'' + FALLBACK_SHIELD + '\';this.classList.add(\'is-neutral-shield\')">';
  }

  function gameState(game) {
    const stateName = String(game.estado || game.status_estado || "").toLowerCase();
    const detail = String(game.status_detalhe || "").trim();
    if (["in", "live", "em_andamento"].includes(stateName)) {
      return { label: detail || "Ao vivo", css: "live", cardCss: "is-live" };
    }
    if (["post", "final", "encerrado"].includes(stateName) || game.concluido === true) {
      return { label: detail || "Encerrado", css: "", cardCss: "" };
    }
    if (game.adiado === true) return { label: "Adiado", css: "", cardCss: "" };
    return { label: "pré-jogo", css: "", cardCss: "" };
  }

  function renderGame(game) {
    const date = parseDate(game.data_iso);
    const home = game.mandante || {};
    const away = game.visitante || {};
    const transmission = transmissionFor(game);
    const competition = String(game.competicao_chave || "");
    const currentState = gameState(game);
    const liveLink = "aovivo.html?event=" + encodeURIComponent(String(game.event_id || ""));
    const probability = game.probabilidades_disponiveis === true
      ? '<a class="agenda-action probability" href="/jogos">📊 Probabilidades</a>'
      : "";
    const youtube = transmission.youtubeUrl
      ? '<a class="agenda-action live" href="' + esc(transmission.youtubeUrl) + '" target="_blank" rel="noopener noreferrer">▶ Assistir</a>'
      : "";
    const venue = game.estadio ? '<span>📍 ' + esc(game.estadio) + '</span>' : '<span>📍 Local a confirmar</span>';

    return '<article class="agenda-game ' + currentState.cardCss + '" data-event-id="' + esc(game.event_id) + '">' +
      '<div class="agenda-card-top">' +
        '<div class="agenda-card-heading">' +
          '<span class="agenda-competition ' + esc(competition) + '">' + esc(game.competicao_nome_curto || competitionLabels[competition] || game.competicao_nome) + '</span>' +
          '<span class="agenda-phase">' + esc(phaseText(game)) + '</span>' +
        '</div>' +
        '<span class="agenda-time">' + esc(formatTime(date)) + '<small>Brasília</small></span>' +
      '</div>' +
      '<div class="agenda-fixture">' +
        '<div class="agenda-teams">' +
          '<div class="agenda-team home">' + logo(home) + '<span class="agenda-team-name">' + esc(home.nome) + '</span></div>' +
          '<div class="agenda-versus">×</div>' +
          '<div class="agenda-team away">' + logo(away) + '<span class="agenda-team-name">' + esc(away.nome) + '</span></div>' +
        '</div>' +
        '<div class="agenda-extra">' +
          '<div class="agenda-meta">' +
            '<span class="agenda-state-pill ' + currentState.css + '">' + esc(currentState.label) + '</span>' +
            venue +
            '<span class="agenda-watch">📺 ' + esc(transmission.label) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="agenda-actions">' +
        '<span class="agenda-source-pill">Dados: ESPN</span>' +
        '<div class="agenda-actions-links"><a class="agenda-action live" href="' + esc(liveLink) + '">🔴 Abrir ao vivo</a>' + probability + youtube + '</div>' +
      '</div>' +
    '</article>';
  }

  function filteredGames() {
    return state.games.filter((game) => {
      const date = parseDate(game.data_iso);
      if (!date || monthKey(date) !== state.month) return false;
      return state.competition === "todos" || game.competicao_chave === state.competition;
    });
  }

  function renderFilters() {
    const available = new Set(state.games.map((game) => String(game.competicao_chave || "")));
    competitionBox.innerHTML = competitionOrder.filter((key) => key === "todos" || available.has(key)).map((key) =>
      '<button type="button" class="agenda-chip ' + (state.competition === key ? "active" : "") + '" data-competition="' + esc(key) + '" aria-pressed="' + (state.competition === key ? "true" : "false") + '">' + esc(competitionLabels[key]) + '</button>'
    ).join("");

    const months = Array.from(new Set(state.games.map((game) => {
      const date = parseDate(game.data_iso);
      return date ? monthKey(date) : "";
    }).filter(Boolean))).sort();
    if (!state.month || !months.includes(state.month)) state.month = months[0] || "";
    monthBox.innerHTML = months.map((key) =>
      '<button type="button" class="agenda-chip ' + (state.month === key ? "active" : "") + '" data-month="' + esc(key) + '" aria-pressed="' + (state.month === key ? "true" : "false") + '">' + esc(formatMonth(key)) + '</button>'
    ).join("");
  }

  function render() {
    renderFilters();
    const games = filteredGames();
    const groups = new Map();
    games.forEach((game) => {
      const date = parseDate(game.data_iso);
      const key = dateKey(date);
      if (!groups.has(key)) groups.set(key, { date, games: [] });
      groups.get(key).games.push(game);
    });

    if (!games.length) {
      statusBox.textContent = "Nenhum jogo encontrado para os filtros selecionados.";
      app.innerHTML = '<div class="agenda-empty">Não há partidas publicadas neste período.</div>';
      return;
    }

    const today = todayKey();
    app.innerHTML = Array.from(groups.entries()).map(([key, group]) => {
      const isToday = key === today;
      const title = formatDay(group.date);
      const count = group.games.length;
      return '<section class="agenda-day ' + (isToday ? "is-today" : "") + '" id="agenda-' + esc(key) + '">' +
        '<header class="agenda-day-head"><div class="agenda-day-title"><strong>' + esc(title.charAt(0).toUpperCase() + title.slice(1)) + '</strong><span>' + count + (count === 1 ? " jogo" : " jogos") + '</span></div>' +
        (isToday ? '<span class="agenda-today-badge">Hoje</span>' : "") + '</header>' +
        '<div class="agenda-game-list">' + group.games.map(renderGame).join("") + '</div></section>';
    }).join("");
    statusBox.textContent = games.length + (games.length === 1 ? " partida exibida" : " partidas exibidas") + " · horários de Brasília";
  }

  async function init() {
    const [agenda, tv, youtube] = await Promise.all([
      fetchJson("dados-br/agenda-clubes-br.json", { jogos: [] }),
      fetchJson("dados-br/transmissoes-tv.json", { jogos: {} }),
      fetchJson("dados-br/transmissoes-aovivo.json", { jogos: {} })
    ]);
    state.games = Array.isArray(agenda.jogos) ? agenda.jogos.slice().sort((a, b) => String(a.data_iso || "").localeCompare(String(b.data_iso || ""))) : [];
    state.transmissions = tv && tv.jogos && typeof tv.jogos === "object" ? tv.jogos : {};
    state.youtube = youtube && youtube.jogos && typeof youtube.jogos === "object" ? youtube.jogos : {};
    const currentMonth = monthKey(new Date());
    const months = new Set(state.games.map((game) => {
      const date = parseDate(game.data_iso);
      return date ? monthKey(date) : "";
    }));
    state.month = months.has(currentMonth) ? currentMonth : "";
    render();
  }

  competitionBox.addEventListener("click", (event) => {
    const button = event.target.closest("[data-competition]");
    if (!button) return;
    state.competition = button.getAttribute("data-competition") || "todos";
    render();
  });

  monthBox.addEventListener("click", (event) => {
    const button = event.target.closest("[data-month]");
    if (!button) return;
    state.month = button.getAttribute("data-month") || state.month;
    render();
  });

  init().catch((error) => {
    console.error("Falha ao carregar agenda:", error);
    statusBox.textContent = "Não foi possível carregar a agenda agora.";
    app.innerHTML = '<div class="agenda-empty">Tente novamente em alguns instantes.</div>';
  });
})();
