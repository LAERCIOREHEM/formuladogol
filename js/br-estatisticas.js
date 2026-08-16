(function () {
  "use strict";

  const FILES = {
    leaders: "dados-br/lideres-jogadores.json",
    competition: "dados-br/estatisticas-competicao.json",
    details: "dados-br/jogos-detalhes.json",
    ranking: "dados-br/ranking-desempenho.json",
    rankingHistory: "dados-br/historico-ranking-desempenho.json",
    table: "tabela.json",
    results: "resultados.json",
    schedule: "jogos.json",
    audit: "dados-br/auditoria-estatisticas.json",
    probabilities: "dados-br/probabilidades-brasileirao.json",
    probabilitiesAudit: "dados-br/auditoria-probabilidades.json",
    probabilitiesHistory: "dados-br/historico-probabilidades.json",
    probabilityModelsAudit: "dados-br/auditoria-modelos-af-previsao.json",
    probabilityEvaluation: "dados-br/avaliacao-af-previsao.json",
    pointsThresholds: "dados-br/probabilidades-por-pontuacao.json",
    continentalAudit: "dados-br/auditoria-competicoes-af-previsao.json",
    // Sentinelas leves usadas para detectar mudança de dados sem
    // rebaixar os 5,8 MB do conjunto completo a cada verificação.
    updateStatus: "dados-br/status-atualizacao.json",
  };

  // Intervalo igual ao do AO VIVO da home e do br-aovivo.js (ESPN_LIVE_MS).
  const REFRESH_MS = 30000;

  const refreshState = { timer: null, ocupado: false, assinatura: null };
  const liveRefreshState = { timer: null, ocupado: false, assinatura: null };

  const state = {
    leaders: null,
    competition: null,
    details: null,
    ranking: null,
    rankingHistory: null,
    table: null,
    results: null,
    schedule: null,
    espnLive: {},
    espnLiveFetchedAt: null,
    espnLiveError: null,
    audit: null,
    probabilities: null,
    probabilitiesAudit: null,
    probabilitiesHistory: null,
    probabilityModelsAudit: null,
    probabilityEvaluation: null,
    pointsThresholds: null,
    updateStatus: null,
    continentalAudit: null,
    probabilitySort: "classificacao",
    probabilityInlineClub: "",
    probabilityHistoryClub: "",
    probabilityHistoryMetric: "campeao_pct",
    tab: "probabilidades",
    expanded: { artilheiros: false, assistencias: false, publico: false },
    expandedClubGoals: {},
    clubFilter: "",
    gamesLimit: 10,
    rankingMetric: "indice_final",
    rankingCompareOpen: false,
    rankingCompare: ["", "", ""],
    attendanceClub: "",
    attendanceScope: "mandante",
    attendanceClubSort: "average_desc",
    attendanceGameSort: "publico_desc",
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[c]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function eventText(value) {
    if (value && typeof value === "object") {
      return String(value.displayValue ?? value.displayClock ?? value.text ?? value.name ?? value.value ?? "").trim();
    }
    const text = String(value ?? "").trim();
    if (!text) return "";
    const display = text.match(/displayValue['"\s:]+([^,}\]]+)/i);
    return display ? display[1].replace(/^['"\s]+|['"\s]+$/g, "") : text;
  }

  function eventMinute(event) {
    return eventText(event?.minuto ?? event?.clock ?? event?.displayClock ?? event?.time);
  }

  function eventTeam(event) {
    const raw = event?.time;
    let text = "";
    if (raw && typeof raw === "object") {
      text = String(raw.displayName ?? raw.shortDisplayName ?? raw.fullName ?? raw.name ?? raw.abbreviation ?? "").trim();
    } else {
      text = String(raw ?? "").trim();
    }
    if (!text || /^[{[]/.test(text) || /displayValue|['"]value['"]\s*:/i.test(text)) return "";
    return text;
  }

  function minuteKey(value) {
    const nums = eventText(value).match(/\d+/g) || [];
    return nums.length ? `${Number(nums[0])}+${Number(nums[1] || 0)}` : normalize(value);
  }

  function uniqueEvents(list, kind) {
    const best = new Map();
    for (const original of (Array.isArray(list) ? list : [])) {
      if (!original || typeof original !== "object") continue;
      const item = {
        ...original,
        minuto: eventMinute(original),
        jogador: String(original.jogador || "").trim(),
        time: eventTeam(original),
      };
      const identity = normalize(item.jogador) || normalize(item.descricao || "");
      const key = [kind, normalize(item.tipo || ""), minuteKey(item.minuto), identity].join("|");
      const quality = (item.jogador ? 20 : 0) + (item.time ? 10 : 0) + (item.descricao ? 2 : 0);
      const previous = best.get(key);
      if (!previous || quality > previous.quality) best.set(key, { item, quality });
    }
    return Array.from(best.values(), (entry) => entry.item);
  }

  function clubSlug(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function clubHref(name) {
    return `clubes.html#${encodeURIComponent(clubSlug(name))}`;
  }

  function probabilityCardId(name) {
    return `probabilidade-${clubSlug(name) || "clube"}`;
  }

  function probabilityCardHref(name) {
    return `#${probabilityCardId(name)}`;
  }

  function probabilityInlinePanelId(name) {
    return `probabilidade-resumo-${clubSlug(name) || "clube"}`;
  }

  function clubIdentityLink(name, inner, className = "", stopPropagation = false) {
    const club = String(name || "").trim();
    if (!club) return inner;
    const cls = className ? ` class="${escapeAttr(className)}"` : "";
    const stop = stopPropagation ? ' onclick="event.stopPropagation()"' : "";
    return `<a${cls} href="${escapeAttr(clubHref(club))}" aria-label="Abrir página de ${escapeAttr(club)}"${stop}>${inner}</a>`;
  }

  function number(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function integer(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("pt-BR") : "—";
  }

  function dateTimeBR(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  function dateBR(value) {
    if (!value) return "Data não informada";
    const s = String(value);
    const d = new Date(s.length <= 16 ? `${s}:00-03:00` : s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  function dateTimeCompactBR(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).replace(",", "") + " BRT";
  }

  function coverageLabel(done, total) {
    const n = Number(done);
    const d = Number(total);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return "—";
    const pct = Math.max(0, Math.min(100, n / d * 100));
    return `${integer(n)}/${integer(d)} (${number(pct, Math.abs(pct - 100) < 1e-9 ? 0 : 1)}%)`;
  }

  function totalFinishedGames() {
    const results = resultsRows().length;
    if (results) return results;
    const competitionTotal = Number(state.competition?.resumo?.jogos_finalizados);
    if (Number.isFinite(competitionTotal) && competitionTotal > 0) return competitionTotal;
    const tableTotal = tableRows().reduce((sum, row) => sum + (Number(row?.jogos) || 0), 0) / 2;
    return Number.isFinite(tableTotal) ? Math.round(tableTotal) : 0;
  }

  function statsCountForGames(games) {
    return games.reduce((count, game) => {
      const detail = gameDetail(game) || {};
      const stats = Array.isArray(detail.stats) ? detail.stats : (Array.isArray(detail.estatisticas) ? detail.estatisticas : []);
      return count + (stats.length ? 1 : 0);
    }, 0);
  }

  function expectedClubGames(name) {
    const row = tableRows().find((item) => normalize(item?.time) === normalize(name));
    const value = Number(row?.jogos);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function moneyBR(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function fetchJson(path, fallback) {
    try {
      const response = await fetch(`${path}${path.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.warn(`Falha ao carregar ${path}:`, error);
      return fallback;
    }
  }

  function tableRows() {
    return Array.isArray(state.table?.tabela) ? state.table.tabela : [];
  }

  function resultsRows() {
    return Array.isArray(state.results?.resultados) ? state.results.resultados : [];
  }

  function teamMap() {
    const map = new Map();
    const add = (team) => {
      if (!team || typeof team !== "object") return;
      const name = String(team.time || team.nome || "").trim();
      if (!name) return;
      const key = normalize(name);
      const previous = map.get(key) || {};
      map.set(key, {
        ...previous,
        ...team,
        time: String(team.time || previous.time || team.nome || previous.nome || name),
        nome: String(team.nome || previous.nome || team.time || previous.time || name),
        escudo: String(team.escudo || previous.escudo || ""),
        sigla: String(team.sigla || previous.sigla || ""),
      });
    };

    tableRows().forEach(add);
    resultsRows().forEach((game) => [game?.mandante, game?.visitante].forEach(add));
    (Array.isArray(state.competition?.gols_por_clube) ? state.competition.gols_por_clube : []).forEach(add);
    (Array.isArray(state.ranking?.ranking) ? state.ranking.ranking : []).forEach(add);
    if (leadersValid()) {
      [...state.leaders.artilharia, ...state.leaders.assistencias].forEach((player) => add({
        time: player?.time,
        nome: player?.time,
        escudo: player?.escudo,
        sigla: player?.sigla,
      }));
    }
    return map;
  }

  function teamInfo(name) {
    return teamMap().get(normalize(name)) || { time: name || "", nome: name || "", escudo: "", sigla: "" };
  }

  function teamName(obj) {
    return String(obj?.time || obj?.nome || obj || "");
  }

  function shield(obj, cls = "stats-shield") {
    const name = teamName(obj);
    const info = teamInfo(name);
    const src = String((obj && typeof obj === "object" ? obj.escudo : "") || info?.escudo || "");
    const fallback = "img/escudo-neutro.svg";
    return `<img class="${escapeAttr(cls)}${src ? "" : " is-neutral-shield"}" src="${escapeAttr(src || fallback)}" alt="" loading="lazy" onerror="this.onerror=null; this.src='${fallback}'; this.classList.add('is-neutral-shield')">`;
  }

  function leadersValid() {
    return state.leaders?.status === "valido" && Array.isArray(state.leaders?.artilharia) && Array.isArray(state.leaders?.assistencias);
  }

  function detailMap() {
    return state.details?.jogos && typeof state.details.jogos === "object" ? state.details.jogos : {};
  }

  function gameDetail(game) {
    const id = String(game?.event_id || game?.id || "");
    if (id && detailMap()[id]) return detailMap()[id];
    return Object.values(detailMap()).find((item) => item && String(item.event_id || "") === id) || null;
  }

  function gameById(eventId) {
    return resultsRows().find((game) => String(game.event_id || game.id || "") === String(eventId || "")) || null;
  }

  function sortedResults() {
    return resultsRows().slice().sort((a, b) => String(b.data_iso || "").localeCompare(String(a.data_iso || "")));
  }

  function emptyState(message, extra = "") {
    return `<div class="stats-empty"><strong>${escapeHtml(message)}</strong>${extra ? `<span>${escapeHtml(extra)}</span>` : ""}</div>`;
  }

  function playerRows(type) {
    if (!leadersValid()) return [];
    return type === "artilheiros" ? state.leaders.artilharia : state.leaders.assistencias;
  }

  function renderPlayers(type) {
    const target = type === "artilheiros" ? $("lista-artilharia") : $("lista-assistencias");
    const list = playerRows(type);
    const field = type === "artilheiros" ? "gols" : "assistencias";
    const unit = type === "artilheiros" ? "gols" : "assist.";
    if (!list.length) {
      target.innerHTML = emptyState("Ranking oficial ainda não disponível.", "Execute o workflow Atualizar Brasileirao (ESPN) e aguarde a coleta validada.");
      return;
    }
    const expanded = state.expanded[type];
    const shown = expanded ? list : list.slice(0, 5);
    const completenessKey = type === "artilheiros" ? "artilharia" : "assistencias";
    const completeness = state.leaders?.completude?.[completenessKey] || {};
    const totalGames = Number(completeness.total_jogos_declarado) || totalFinishedGames();
    const gamesRead = Number(completeness.jogos_lidos) || 0;
    const lineupGames = Number(completeness.jogos_com_escalacoes) || 0;
    const statusTone = gamesRead === totalGames && lineupGames === totalGames ? "" : " is-warning";
    const status = `Base de eventos: ${coverageLabel(gamesRead, totalGames)} · escalações: ${coverageLabel(lineupGames, totalGames)} · atualizado ${dateTimeCompactBR(state.leaders?.atualizado_em)}`;
    target.innerHTML = `<div class="stats-data-status${statusTone}">${escapeHtml(status)}</div><div class="stats-player-list">${shown.map((player, index) => {
      const rawGames = player.jogos;
      const games = rawGames === null || rawGames === undefined || rawGames === "" ? null : Number(rawGames);
      const hasGames = Number.isFinite(games) && games > 0;
      const value = Number(player[field] || 0);
      const gamesLabel = hasGames ? `${integer(games)} ${games === 1 ? "jogo" : "jogos"}` : "";
      const average = hasGames ? `${number(value / games, 2)} por jogo` : "";
      const meta = hasGames ? `${gamesLabel} · ${average}` : "";
      return `<article class="stats-player-row">
        <div class="stats-rank">${integer(player.posicao || index + 1)}</div>
        <div class="stats-player-main">
          <div class="stats-player-name">${escapeHtml(player.nome)}</div>
          ${clubIdentityLink(player.time, `${shield(player, "stats-mini-shield")}<span>${escapeHtml(player.time)}</span>`, "stats-player-club")}
          ${meta ? `<div class="stats-player-meta">${escapeHtml(meta)}</div>` : ""}
        </div>
        <div class="stats-player-value"><strong>${integer(value)}</strong><span>${unit}</span></div>
      </article>`;
    }).join("")}</div>${list.length > 5 ? `<button class="stats-expand-btn" type="button" data-expand-list="${type}">${expanded ? "Mostrar somente os 5 primeiros ↑" : `Ver todos (${list.length}) ↓`}</button>` : ""}`;
  }

  function clubOptions() {
    return tableRows().slice().sort((a, b) => String(a.time || "").localeCompare(String(b.time || ""), "pt-BR"));
  }

  function filteredGames() {
    const filter = normalize(state.clubFilter);
    return sortedResults().filter((game) => {
      if (!filter) return true;
      return normalize(game?.mandante?.nome) === filter || normalize(game?.visitante?.nome) === filter;
    });
  }

  function renderGameFilter() {
    const clubs = clubOptions();
    const selected = state.clubFilter;
    const info = selected ? teamInfo(selected) : null;
    const games = filteredGames();
    const detailed = statsCountForGames(games);
    const expectedGames = selected ? expectedClubGames(selected) : totalFinishedGames();
    const denominator = expectedGames || games.length;
    const gamesStatus = `${coverageLabel(games.length, denominator)} jogos listados · estatísticas: ${coverageLabel(detailed, denominator)} · atualizado ${dateTimeCompactBR(state.details?.gerado_em)}`;
    $("filtro-jogos").innerHTML = `<div class="stats-data-status${games.length === denominator && detailed === denominator ? "" : " is-warning"}">${escapeHtml(gamesStatus)}</div><div class="stats-game-filter">
      <div class="stats-filter-control">
        <label for="stats-club-filter">Clube</label>
        <select id="stats-club-filter">
          <option value="">Todos os clubes</option>
          ${clubs.map((club) => `<option value="${escapeAttr(club.time)}" ${normalize(club.time) === normalize(selected) ? "selected" : ""}>${escapeHtml(club.time)}</option>`).join("")}
        </select>
      </div>
      <div class="stats-filter-current">
        ${selected
          ? clubIdentityLink(selected, `${shield(info, "stats-filter-shield")}<div><strong>${escapeHtml(selected)}</strong><span>${coverageLabel(games.length, denominator)} jogos listados</span></div>`, "stats-filter-club-link")
          : `<span class="stats-filter-all">BR</span><div><strong>Todos os clubes</strong><span>${coverageLabel(games.length, denominator)} jogos listados</span></div>`}
        ${selected ? `<button type="button" data-clear-game-filter>Limpar</button>` : ""}
      </div>
    </div>`;
    const select = $("stats-club-filter");
    select?.addEventListener("change", () => {
      state.clubFilter = select.value || "";
      state.gamesLimit = 10;
      renderGameFilter();
      renderGames();
    });
    $("filtro-jogos").querySelector("[data-clear-game-filter]")?.addEventListener("click", () => {
      state.clubFilter = "";
      state.gamesLimit = 10;
      renderGameFilter();
      renderGames();
    });
  }

  function matchScore(game) {
    return `${integer(game.placar_mandante)} × ${integer(game.placar_visitante)}`;
  }

  function eventLine(goal) {
    const assists = Array.isArray(goal?.assistencias) && goal.assistencias.length
      ? ` · assistência: ${goal.assistencias.join(", ")}`
      : "";
    return `<li><span>⚽ ${escapeHtml(goal?.minuto || "")}</span><strong>${escapeHtml(goal?.jogador || "Gol")}</strong><small>${escapeHtml(goal?.time || "")}${escapeHtml(assists)}</small></li>`;
  }

  function cardLine(card) {
    const icon = card?.tipo === "vermelho" ? "🟥" : "🟨";
    return `<li><span>${icon} ${escapeHtml(card?.minuto || "")}</span><strong>${escapeHtml(card?.jogador || "Cartão")}</strong><small>${escapeHtml(card?.time || "")}</small></li>`;
  }

  function statisticRows(detail) {
    const stats = Array.isArray(detail?.stats) ? detail.stats : (Array.isArray(detail?.estatisticas) ? detail.estatisticas : []);
    if (!stats.length) return emptyState("Estatísticas avançadas não disponibilizadas para esta partida.");
    return `<div class="stats-match-stat-list">${stats.map((stat) => `<div class="stats-match-stat-row">
      <strong>${escapeHtml(stat.home ?? stat.mandante ?? "—")}</strong>
      <span>${escapeHtml(stat.nome || stat.label || "Estatística")}</span>
      <strong>${escapeHtml(stat.away ?? stat.visitante ?? "—")}</strong>
    </div>`).join("")}</div>`;
  }

  function gameCard(game) {
    const detail = gameDetail(game) || {};
    const home = game.mandante || teamInfo(detail.mandante);
    const away = game.visitante || teamInfo(detail.visitante);
    const crowd = Number(detail.publico);
    const paidCrowd = Number(detail.publico_pagante);
    const revenue = Number(detail.renda);
    const goals = uniqueEvents(detail.gols, "goal");
    const cards = uniqueEvents(detail.cartoes, "card");
    return `<details class="stats-game-card" data-game-id="${escapeAttr(game.event_id || game.id || "")}">
      <summary>
        <span class="stats-game-round">R${escapeHtml(game.rodada || detail.rodada || "—")}</span>
        <div class="stats-game-summary-main">
          <div class="stats-game-date">${escapeHtml(dateBR(game.data_iso || detail.data_iso))}</div>
          <div class="stats-game-teams">
            ${clubIdentityLink(teamName(home), `${shield(home, "stats-game-shield")}<span>${escapeHtml(teamName(home))}</span>`, "stats-game-team-link", true)}
            <b>${escapeHtml(matchScore(game))}</b>
            ${clubIdentityLink(teamName(away), `<span>${escapeHtml(teamName(away))}</span>${shield(away, "stats-game-shield")}`, "stats-game-team-link", true)}
          </div>
          <div class="stats-game-quick">${detail.estadio ? `📍 ${escapeHtml(detail.estadio)}` : ""}${Number.isFinite(crowd) && crowd > 0 ? ` · 👥 ${integer(crowd)}` : ""}</div>
        </div>
        <span class="stats-game-chevron">⌄</span>
      </summary>
      <div class="stats-game-body">
        <div class="stats-game-info-grid">
          <div><span>Estádio</span><strong>${escapeHtml(detail.estadio || game.estadio || "Não informado")}</strong></div>
          <div><span>Público presente</span><strong>${Number.isFinite(crowd) && crowd > 0 ? integer(crowd) : "Não informado"}</strong></div>
          ${Number.isFinite(paidCrowd) && paidCrowd > 0 ? `<div><span>Público pagante</span><strong>${integer(paidCrowd)}</strong></div>` : ""}
          ${Number.isFinite(revenue) && revenue > 0 ? `<div><span>Renda</span><strong>${escapeHtml(moneyBR(revenue))}</strong></div>` : ""}
          <div><span>Árbitro</span><strong>${escapeHtml(detail.arbitro || "Não informado")}</strong></div>
        </div>
        ${(goals.length || cards.length) ? `<div class="stats-match-events">
          ${goals.length ? `<section><h4>Gols</h4><ul>${goals.map(eventLine).join("")}</ul></section>` : ""}
          ${cards.length ? `<section><h4>Cartões</h4><ul>${cards.map(cardLine).join("")}</ul></section>` : ""}
        </div>` : ""}
        ${statisticRows(detail)}
        <div class="stats-source-note">Fonte: ESPN; público e dados adicionais podem ser complementados por fonte documental identificada quando ausentes. Nenhum campo é estimado.</div>
      </div>
    </details>`;
  }

  function renderGames() {
    const target = $("lista-jogos-estatisticas");
    const games = filteredGames();
    if (!games.length) {
      target.innerHTML = emptyState("Nenhuma partida encontrada para o filtro selecionado.");
      return;
    }
    const shown = games.slice(0, state.gamesLimit);
    target.innerHTML = `<div class="stats-games-list">${shown.map(gameCard).join("")}</div>${games.length > shown.length ? `<button type="button" class="stats-expand-btn" data-more-games>Mostrar mais ${Math.min(10, games.length - shown.length)} jogos ↓</button>` : ""}`;
    target.querySelector("[data-more-games]")?.addEventListener("click", () => {
      state.gamesLimit += 10;
      renderGames();
    });
  }

  function renderClubGoals() {
    const target = $("lista-gols-clube");
    const list = Array.isArray(state.competition?.gols_por_clube) ? state.competition.gols_por_clube : [];
    if (!list.length) {
      target.innerHTML = emptyState("Consolidado de gols por clube ainda não disponível.", "Aguarde a atualização automática dos dados.");
      return;
    }
    target.innerHTML = `<div class="stats-club-goals-list">${list.map((club, index) => {
      const markers = Array.isArray(club.marcadores) ? club.marcadores : [];
      const key = clubSlug(club.time);
      const expanded = Boolean(state.expandedClubGoals[key]);
      const shown = expanded ? markers : markers.slice(0, 5);
      const unknown = Number(club.gols_nao_individualizados || 0);
      const expectedGames = expectedClubGames(club.time);
      const gamesDenominator = expectedGames === null ? Number(club.jogos) : expectedGames;
      return `<details class="stats-club-goals-card">
        <summary>
          <span class="stats-rank">${integer(club.posicao || index + 1)}</span>
          <a class="stats-club-shield-link" href="${escapeAttr(clubHref(club.time))}" title="Abrir página de ${escapeAttr(club.time)}" aria-label="Abrir página de ${escapeAttr(club.time)}" onclick="event.stopPropagation()">${shield(club, "stats-club-shield")}</a>
          <div class="stats-club-goals-main"><a href="${escapeAttr(clubHref(club.time))}" onclick="event.stopPropagation()"><strong>${escapeHtml(club.time)}</strong></a><span>${coverageLabel(club.jogos, gamesDenominator)} jogos computados · média ${number(club.media_gols, 2)}</span></div>
          <div class="stats-club-goals-value"><strong>${integer(club.gols_pro)}</strong><span>gols</span></div>
          <span class="stats-game-chevron">⌄</span>
        </summary>
        <div class="stats-club-markers">
          <h4>Marcadores do clube</h4>
          ${markers.length ? `<div class="stats-marker-list">${shown.map((player) => `<div><span>${escapeHtml(player.nome)}</span><strong>${integer(player.gols)}</strong></div>`).join("")}${unknown > 0 ? `<div class="stats-marker-other"><span>Gols contra ou ainda sem autoria individualizada</span><strong>${integer(unknown)}</strong></div>` : ""}</div>${markers.length > 5 ? `<button class="stats-expand-btn stats-marker-expand" type="button" data-expand-club-goals="${escapeAttr(key)}">${expanded ? "Mostrar somente os 5 primeiros ↑" : `Ver todos (${markers.length}) ↓`}</button>` : ""}` : emptyState("Nenhum marcador individualizado na base consolidada.")}
          <div class="stats-club-balance"><span>Gols sofridos: <b>${integer(club.gols_contra)}</b></span><span>Saldo: <b>${integer(club.saldo)}</b></span></div>
        </div>
      </details>`;
    }).join("")}</div>`;
    target.querySelectorAll("[data-expand-club-goals]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = button.dataset.expandClubGoals || "";
        state.expandedClubGoals[key] = !state.expandedClubGoals[key];
        renderClubGoals();
        const card = target.querySelector(`[data-expand-club-goals="${key}"]`)?.closest("details");
        if (card) card.open = true;
      });
    });
  }

  function performanceCard(record) {
    if (!record) return "";
    const home = record.mandante || "?";
    const away = record.visitante || "?";
    const score = `${integer(record.placar_mandante)} × ${integer(record.placar_visitante)}`;
    return `<button class="stats-record-card" type="button" data-open-game="${escapeAttr(record.event_id || "")}">
      <span>${escapeHtml(record.categoria || "Destaque")}</span>
      <strong>${escapeHtml(home)} ${escapeHtml(score)} ${escapeHtml(away)}</strong>
      <small>Rodada ${escapeHtml(record.rodada || "—")} · ${escapeHtml(dateBR(record.data_iso))}</small>
    </button>`;
  }

  function sequenceRows() {
    const data = state.competition?.sequencias || {};
    const definitions = [
      ["vitorias", "Vitórias"],
      ["invencibilidade", "Invencibilidade"],
      ["derrotas", "Derrotas"],
      ["sem_vencer", "Sem vencer"],
    ];
    const rows = definitions.flatMap(([key, label]) => {
      const item = data[key] || {};
      return [
        { label: `Maior sequência de ${label.toLowerCase()}`, data: item.maior },
        { label: `Sequência atual de ${label.toLowerCase()}`, data: item.atual },
      ];
    });
    if (!rows.some((row) => row.data)) return emptyState("Sequências ainda não consolidadas.");
    return `<div class="stats-sequence-list">${rows.map((row) => `<div class="stats-sequence-row"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.data?.time || "—")}</strong><b>${integer(row.data?.quantidade)}</b></div>`).join("")}</div>`;
  }

  const PERFORMANCE_METRICS = [
    { key: "indice_final", label: "Índice geral", short: "Índice" },
    { key: "ataque", label: "Ataque", short: "Ataque" },
    { key: "defesa", label: "Defesa", short: "Defesa" },
    { key: "dominio", label: "Domínio", short: "Domínio" },
    { key: "eficiencia", label: "Eficiência", short: "Eficiência" },
    { key: "disciplina", label: "Disciplina", short: "Disciplina" },
  ];

  const ATTENDANCE_SCOPES = [
    { key: "todos", label: "Todos os jogos" },
    { key: "mandante", label: "Como mandante" },
    { key: "visitante", label: "Como visitante" },
  ];

  const ATTENDANCE_CLUB_SORTS = [
    { key: "average_desc", label: "Média — maior primeiro", short: "Média" },
    { key: "average_asc", label: "Média — menor primeiro", short: "Média" },
    { key: "total_desc", label: "Total de público", short: "Total" },
    { key: "max_desc", label: "Maior público", short: "Maior público" },
    { key: "informed_desc", label: "Jogos informados", short: "Jogos" },
    { key: "name_asc", label: "Clube — A a Z", short: "Média" },
  ];

  const ATTENDANCE_GAME_SORTS = [
    { key: "publico_desc", label: "Público — maior primeiro" },
    { key: "publico_asc", label: "Público — menor primeiro" },
    { key: "date_desc", label: "Mais recentes primeiro" },
    { key: "date_asc", label: "Mais antigos primeiro" },
  ];

  function performanceMetricConfig(key) {
    return PERFORMANCE_METRICS.find((item) => item.key === key) || PERFORMANCE_METRICS[0];
  }

  function performanceValue(club, key) {
    const raw = key === "indice_final" ? (club?.indice_final ?? club?.score) : club?.[key];
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }

  function sortedPerformanceRanking() {
    const source = Array.isArray(state.ranking?.ranking) ? state.ranking.ranking : [];
    const key = performanceMetricConfig(state.rankingMetric).key;
    return source.slice().sort((a, b) => {
      const metricDiff = performanceValue(b, key) - performanceValue(a, key);
      if (Math.abs(metricDiff) > 1e-9) return metricDiff;
      const indexDiff = performanceValue(b, "indice_final") - performanceValue(a, "indice_final");
      if (Math.abs(indexDiff) > 1e-9) return indexDiff;
      const originalA = Number(a?.pos ?? a?.pos_ranking) || 999;
      const originalB = Number(b?.pos ?? b?.pos_ranking) || 999;
      if (originalA !== originalB) return originalA - originalB;
      return String(a?.time || "").localeCompare(String(b?.time || ""), "pt-BR");
    });
  }

  function allClubNames() {
    const names = new Map();
    const add = (value) => {
      const name = String(value || "").trim();
      if (!name) return;
      const key = normalize(name);
      if (!names.has(key)) names.set(key, name);
    };
    (Array.isArray(state.ranking?.ranking) ? state.ranking.ranking : []).forEach((club) => add(club?.time));
    (Array.isArray(state.competition?.jogos) ? state.competition.jogos : []).forEach((game) => {
      add(game?.mandante);
      add(game?.visitante);
    });
    return Array.from(names.values()).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }

  function performanceFilterControls() {
    const metric = performanceMetricConfig(state.rankingMetric);
    return `<section class="stats-performance-tools" aria-label="Controles do Ranking de Desempenho">
      <div class="stats-performance-filter-head">
        <div><span>Ordenar o ranking por</span><strong>${escapeHtml(metric.label)}</strong></div>
        <button class="stats-compare-toggle${state.rankingCompareOpen ? " is-active" : ""}" type="button" data-ranking-compare-toggle aria-expanded="${state.rankingCompareOpen ? "true" : "false"}">⚖️ ${state.rankingCompareOpen ? "Fechar comparação" : "Comparar clubes"}</button>
      </div>
      <div class="stats-performance-filter" role="group" aria-label="Métrica usada para ordenar o ranking">
        ${PERFORMANCE_METRICS.map((item) => `<button type="button" class="stats-performance-filter-btn${item.key === metric.key ? " is-active" : ""}" data-ranking-metric="${escapeAttr(item.key)}" aria-pressed="${item.key === metric.key ? "true" : "false"}">${escapeHtml(item.label)}</button>`).join("")}
      </div>
    </section>`;
  }

  function rankingComparePanel(ranking) {
    if (!state.rankingCompareOpen) return "";
    const byName = new Map(ranking.map((club) => [normalize(club.time), club]));
    const selectedClubs = state.rankingCompare.map((name) => byName.get(normalize(name))).filter(Boolean);
    const selectedNames = new Set(state.rankingCompare.filter(Boolean));
    const selects = state.rankingCompare.map((selected, index) => {
      const placeholder = index === 2 ? "Terceiro clube (opcional)" : `Clube ${index + 1}`;
      const options = allClubNames().map((club) => {
        const disabled = club !== selected && selectedNames.has(club);
        return `<option value="${escapeAttr(club)}"${club === selected ? " selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(club)}</option>`;
      }).join("");
      return `<label><span>${escapeHtml(placeholder)}</span><select data-ranking-compare-slot="${index}"><option value="">${escapeHtml(placeholder)}</option>${options}</select></label>`;
    }).join("");

    let comparison = `<div class="stats-compare-empty"><strong>Selecione pelo menos dois clubes.</strong><span>O comparativo usa exatamente as notas publicadas no AF-Score.</span></div>`;
    if (selectedClubs.length >= 2) {
      const bestByMetric = Object.fromEntries(PERFORMANCE_METRICS.map((item) => [item.key, Math.max(...selectedClubs.map((club) => performanceValue(club, item.key)))]));
      comparison = `<div class="stats-compare-grid" style="--compare-count:${selectedClubs.length}">${selectedClubs.map((club) => `<article class="stats-compare-card">
        <div class="stats-compare-club">${shield(club, "stats-compare-shield")}<div><strong>${escapeHtml(club.time)}</strong><span>${integer(club.pontos)} pts · ${integer(club.pos_tabela)}º na tabela</span></div></div>
        <div class="stats-compare-metrics">${PERFORMANCE_METRICS.map((item) => {
          const value = performanceValue(club, item.key);
          const isBest = Math.abs(value - bestByMetric[item.key]) < 1e-9;
          return `<div class="stats-compare-metric${isBest ? " is-best" : ""}"><span>${escapeHtml(item.label)}</span><div><i style="width:${Math.max(0, Math.min(100, value)).toFixed(1)}%"></i></div><strong>${number(value, 1)}</strong></div>`;
        }).join("")}</div>
      </article>`).join("")}</div>`;
    }

    return `<section class="stats-compare-panel" aria-label="Comparação de clubes">
      <div class="stats-compare-selectors">${selects}</div>
      ${comparison}
      <p class="stats-source-note">Notas de 0 a 100. O destaque identifica o maior valor entre os clubes selecionados em cada dimensão.</p>
    </section>`;
  }

  function attendanceMatchesScope(game, club, scope) {
    if (!club) return true;
    const clubKey = normalize(club);
    const home = normalize(game?.mandante) === clubKey;
    const away = normalize(game?.visitante) === clubKey;
    if (scope === "mandante") return home;
    if (scope === "visitante") return away;
    return home || away;
  }

  function attendanceScopeKey() {
    return ATTENDANCE_SCOPES.some((item) => item.key === state.attendanceScope) ? state.attendanceScope : "todos";
  }

  function sortAttendanceGames(games) {
    const key = ATTENDANCE_GAME_SORTS.some((item) => item.key === state.attendanceGameSort) ? state.attendanceGameSort : "publico_desc";
    return games.slice().sort((a, b) => {
      if (key === "publico_asc") return Number(a.publico) - Number(b.publico) || String(a.data_iso || "").localeCompare(String(b.data_iso || ""));
      if (key === "date_desc") return String(b.data_iso || "").localeCompare(String(a.data_iso || "")) || Number(b.publico) - Number(a.publico);
      if (key === "date_asc") return String(a.data_iso || "").localeCompare(String(b.data_iso || "")) || Number(b.publico) - Number(a.publico);
      return Number(b.publico) - Number(a.publico) || String(b.data_iso || "").localeCompare(String(a.data_iso || ""));
    });
  }

  function attendanceFilteredData() {
    const club = state.attendanceClub;
    const scope = attendanceScopeKey();
    const allGames = Array.isArray(state.competition?.jogos) ? state.competition.jogos : [];
    const eligible = allGames.filter((game) => attendanceMatchesScope(game, club, scope));
    const informedRaw = eligible.filter((game) => Number.isFinite(Number(game?.publico)) && Number(game.publico) > 0);
    const games = sortAttendanceGames(informedRaw);
    const byPublic = informedRaw.slice().sort((a, b) => Number(b.publico) - Number(a.publico) || String(b.data_iso || "").localeCompare(String(a.data_iso || "")));
    const total = informedRaw.reduce((sum, game) => sum + Number(game.publico), 0);
    return {
      club,
      scope,
      games,
      total,
      average: informedRaw.length ? total / informedRaw.length : 0,
      max: byPublic[0] || null,
      min: byPublic.length ? byPublic[byPublic.length - 1] : null,
      informedCount: informedRaw.length,
      missingCount: Math.max(0, eligible.length - informedRaw.length),
    };
  }

  function attendanceClubRanking(scope) {
    const allGames = Array.isArray(state.competition?.jogos) ? state.competition.jogos : [];
    const rows = allClubNames().map((club) => {
      const eligible = allGames.filter((game) => attendanceMatchesScope(game, club, scope));
      const informed = eligible.filter((game) => Number.isFinite(Number(game?.publico)) && Number(game.publico) > 0);
      const total = informed.reduce((sum, game) => sum + Number(game.publico), 0);
      const max = informed.reduce((best, game) => !best || Number(game.publico) > Number(best.publico) ? game : best, null);
      return {
        club,
        total,
        average: informed.length ? total / informed.length : 0,
        max,
        informedCount: informed.length,
        missingCount: Math.max(0, eligible.length - informed.length),
      };
    }).filter((item) => item.informedCount > 0);

    const sortKey = ATTENDANCE_CLUB_SORTS.some((item) => item.key === state.attendanceClubSort) ? state.attendanceClubSort : "average_desc";
    return rows.sort((a, b) => {
      let diff = 0;
      if (sortKey === "average_asc") diff = a.average - b.average;
      else if (sortKey === "total_desc") diff = b.total - a.total;
      else if (sortKey === "max_desc") diff = Number(b.max?.publico || 0) - Number(a.max?.publico || 0);
      else if (sortKey === "informed_desc") diff = b.informedCount - a.informedCount;
      else if (sortKey === "name_asc") return a.club.localeCompare(b.club, "pt-BR");
      else diff = b.average - a.average;
      if (Math.abs(diff) > 1e-9) return diff;
      const averageDiff = b.average - a.average;
      if (Math.abs(averageDiff) > 1e-9) return averageDiff;
      if (b.total !== a.total) return b.total - a.total;
      return a.club.localeCompare(b.club, "pt-BR");
    });
  }

  function attendanceControls(data, clubRanking) {
    const selectedScope = ATTENDANCE_SCOPES.some((item) => item.key === data.scope) ? data.scope : "todos";
    const sorts = data.club ? ATTENDANCE_GAME_SORTS : ATTENDANCE_CLUB_SORTS;
    const selectedSort = data.club
      ? (ATTENDANCE_GAME_SORTS.some((item) => item.key === state.attendanceGameSort) ? state.attendanceGameSort : "publico_desc")
      : (ATTENDANCE_CLUB_SORTS.some((item) => item.key === state.attendanceClubSort) ? state.attendanceClubSort : "average_desc");
    const scopeLabel = ATTENDANCE_SCOPES.find((item) => item.key === selectedScope)?.label || "Todos os jogos";
    const contextTitle = data.club || "Ranking de clubes";
    const contextText = data.club
      ? `${scopeLabel} · ${integer(data.informedCount)} com público${data.missingCount ? ` · ${integer(data.missingCount)} sem dado` : ""}`
      : `${scopeLabel} · ${integer(clubRanking.length)} clubes com público`;
    return `<div class="stats-attendance-controls">
      <label><span>Clube</span><select data-attendance-club><option value="">Todos os clubes</option>${allClubNames().map((club) => `<option value="${escapeAttr(club)}"${club === data.club ? " selected" : ""}>${escapeHtml(club)}</option>`).join("")}</select></label>
      <label><span>Recorte</span><select data-attendance-scope>${ATTENDANCE_SCOPES.map((item) => `<option value="${escapeAttr(item.key)}"${item.key === selectedScope ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
      <label><span>Ordenar por</span><select data-attendance-sort>${sorts.map((item) => `<option value="${escapeAttr(item.key)}"${item.key === selectedSort ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
      <div class="stats-attendance-context"><strong>${escapeHtml(contextTitle)}</strong><span>${escapeHtml(contextText)}</span></div>
    </div>`;
  }

  function attendanceGameRow(game, index) {
    return `<button type="button" class="stats-attendance-row" data-open-game="${escapeAttr(game.event_id || "")}">
      <span>${integer(index + 1)}</span>
      <div><strong>${escapeHtml(game.mandante)} × ${escapeHtml(game.visitante)}</strong><small>R${escapeHtml(game.rodada || "—")} · ${escapeHtml(dateBR(game.data_iso))}</small></div>
      <b>${integer(game.publico)}</b>
    </button>`;
  }

  function attendanceClubPrimary(item) {
    const key = state.attendanceClubSort;
    if (key === "total_desc") return { value: integer(item.total), label: "total" };
    if (key === "max_desc") return { value: integer(item.max?.publico), label: "maior público" };
    if (key === "informed_desc") return { value: integer(item.informedCount), label: item.informedCount === 1 ? "jogo" : "jogos" };
    return { value: integer(Math.round(item.average)), label: "média" };
  }

  function attendanceClubRow(item, index) {
    const primary = attendanceClubPrimary(item);
    return `<button type="button" class="stats-attendance-club-row" data-attendance-select-club="${escapeAttr(item.club)}" aria-label="Ver jogos e público de ${escapeAttr(item.club)}">
      <span class="stats-attendance-club-rank">${integer(index + 1)}</span>
      <div class="stats-attendance-club-main">${shield(item.club, "stats-attendance-shield")}<div><strong>${escapeHtml(item.club)}</strong><small>${integer(item.informedCount)} ${item.informedCount === 1 ? "jogo com público" : "jogos com público"}${item.missingCount ? ` · ${integer(item.missingCount)} sem dado` : ""}</small></div></div>
      <div class="stats-attendance-club-secondary"><span>Total ${integer(item.total)}</span><span>Máx. ${integer(item.max?.publico)}</span></div>
      <div class="stats-attendance-club-primary"><strong>${primary.value}</strong><span>${escapeHtml(primary.label)}</span></div>
    </button>`;
  }

  function renderChampionship() {
    const target = $("campeonato-conteudo");
    const performance = state.competition?.performance_por_partida || {};
    const attendance = state.competition?.publico || {};
    const filteredAttendance = attendanceFilteredData();
    const clubRanking = filteredAttendance.club ? [] : attendanceClubRanking(filteredAttendance.scope);
    const ranking = filteredAttendance.club ? filteredAttendance.games : clubRanking;
    const attendanceShown = state.expanded.publico ? ranking : ranking.slice(0, 5);
    const performanceHtml = [
      performance.mais_gols_mandante,
      performance.mais_gols_visitante,
      performance.maior_margem_vitoria,
      performance.jogo_com_mais_gols,
    ].filter(Boolean).map(performanceCard).join("");

    target.innerHTML = `<div class="stats-champ-grid">
      <section class="panel"><div class="panel-inner"><div class="section-head"><div><div class="kicker">📈 Recordes</div><h2>Performance por partida</h2></div></div>${performanceHtml ? `<div class="stats-record-grid">${performanceHtml}</div>` : emptyState("Performance por partida ainda não consolidada.")}</div></section>
      <section class="panel"><div class="panel-inner"><div class="section-head"><div><div class="kicker">🔁 Momento</div><h2>Sequências</h2></div></div>${sequenceRows()}</div></section>
    </div>
    <section class="panel stats-attendance-panel"><div class="panel-inner">
      <div class="section-head"><div><div class="kicker">👥 Torcida</div><h2>Público</h2></div><span class="badge">Cobertura de público</span></div>
      ${(() => {
        const total = Number(state.competition?.resumo?.jogos_finalizados) || totalFinishedGames();
        const informed = Number(attendance.jogos_com_publico) || 0;
        const pending = Math.max(0, total - informed);
        return `<div class="stats-data-status${pending ? " is-warning" : ""}">Cobertura: ${coverageLabel(informed, total)} jogos · ${integer(pending)} ${pending === 1 ? "pendente" : "pendentes"} · atualizado ${escapeHtml(dateTimeCompactBR(state.competition?.atualizado_em))}</div>`;
      })()}
      ${attendanceControls(filteredAttendance, clubRanking)}
      <div class="stats-attendance-summary">
        <div><span>Maior público</span><strong>${filteredAttendance.max ? integer(filteredAttendance.max.publico) : "—"}</strong></div>
        <div><span>Menor público</span><strong>${filteredAttendance.min ? integer(filteredAttendance.min.publico) : "—"}</strong></div>
        <div><span>Média</span><strong>${filteredAttendance.informedCount ? integer(Math.round(filteredAttendance.average)) : "—"}</strong></div>
        <div><span>Total</span><strong>${filteredAttendance.informedCount ? integer(filteredAttendance.total) : "—"}</strong></div>
        <div><span>Jogos com público</span><strong>${integer(filteredAttendance.informedCount)}</strong></div>
      </div>
      ${attendanceShown.length ? `${filteredAttendance.club
        ? `<div class="stats-attendance-list">${attendanceShown.map(attendanceGameRow).join("")}</div>`
        : `<div class="stats-attendance-ranking-head"><div><strong>Ranking de clubes</strong><span>${escapeHtml(ATTENDANCE_SCOPES.find((item) => item.key === filteredAttendance.scope)?.label || "Todos os jogos")}</span></div><small>Selecione um clube para abrir os jogos</small></div><div class="stats-attendance-club-list">${attendanceShown.map(attendanceClubRow).join("")}</div>`}
        ${ranking.length > 5 ? `<button class="stats-expand-btn" type="button" data-expand-attendance>${state.expanded.publico ? "Mostrar somente os 5 primeiros ↑" : `Ver ranking completo (${ranking.length}) ↓`}</button>` : ""}` : emptyState(filteredAttendance.club ? "Nenhum jogo deste recorte possui público informado." : "Nenhum clube deste recorte possui público informado.")}
      <p class="stats-source-note">${escapeHtml(attendance.observacao || "Média calculada somente sobre partidas com público informado.")}${filteredAttendance.missingCount ? ` Neste recorte, ${integer(filteredAttendance.missingCount)} ${filteredAttendance.missingCount === 1 ? "partida ainda não possui" : "partidas ainda não possuem"} público informado e não ${filteredAttendance.missingCount === 1 ? "entra" : "entram"} nos cálculos.` : ""}</p>
    </div></section>`;
  }

  function metricBar(label, value, selected = false) {
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    return `<div class="stats-performance-metric${selected ? " is-selected" : ""}"><span>${escapeHtml(label)}</span><div><i style="width:${n.toFixed(1)}%"></i></div><strong>${number(n, 1)}</strong></div>`;
  }

  function renderRanking() {
    const target = $("ranking-desempenho");
    const ranking = sortedPerformanceRanking();
    if (!ranking.length) {
      target.innerHTML = emptyState("Ranking de desempenho ainda não disponível.");
      return;
    }
    const metric = performanceMetricConfig(state.rankingMetric);
    target.innerHTML = `${performanceFilterControls()}${rankingComparePanel(ranking)}<div class="stats-performance-list">${ranking.map((club, index) => `<article class="stats-performance-card">
      <div class="stats-performance-head">
        <span class="stats-rank">${integer(index + 1)}</span>
        <a class="stats-performance-club-link" href="${escapeAttr(clubHref(club.time))}" title="Abrir página de ${escapeAttr(club.time)}" aria-label="Abrir página de ${escapeAttr(club.time)}">${shield(club, "stats-performance-shield")}</a>
        <div><a class="stats-performance-name-link" href="${escapeAttr(clubHref(club.time))}"><strong>${escapeHtml(club.time)}</strong></a><span>${integer(club.pontos)} pts · ${integer(club.pos_tabela)}º na tabela · SG ${integer(club.sg)}${metric.key !== "indice_final" ? ` · Índice ${number(performanceValue(club, "indice_final"), 1)}` : ""}</span></div>
        <b>${number(performanceValue(club, metric.key), 1)}<small>${escapeHtml(metric.short)}</small></b>
      </div>
      <div class="stats-performance-bars">
        ${metricBar("Ataque", club.ataque, metric.key === "ataque")}
        ${metricBar("Defesa", club.defesa, metric.key === "defesa")}
        ${metricBar("Domínio", club.dominio, metric.key === "dominio")}
        ${metricBar("Eficiência", club.eficiencia, metric.key === "eficiencia")}
        ${metricBar("Disciplina", club.disciplina, metric.key === "disciplina")}
      </div>
      <p>${escapeHtml(club.justificativa || "Índice calculado pelo site.")}</p>
      ${rankingPerformanceHistoryDetails(club.time)}
    </article>`).join("")}</div>`;
  }

  // Explicação da célula via tooltip nativo do navegador: nenhum pixel a mais
  // no layout, e a profundidade fica a um gesto de distância para quem quiser
  // conferir. Prioriza a prova determinística sobre a contagem do Monte Carlo.
  function probabilityTooltip(detail) {
    if (!detail || typeof detail !== "object") return "";
    if (detail.impossivel_estruturalmente && detail.motivo_impossibilidade) {
      return `Impossível matematicamente — ${detail.motivo_impossibilidade}`;
    }
    if (detail.certo_estruturalmente && detail.motivo_certeza) {
      return `Garantido matematicamente — ${detail.motivo_certeza}`;
    }
    const ocorrencias = Number(detail.ocorrencias);
    const simulacoes = Number(detail.simulacoes);
    if (!Number.isFinite(ocorrencias) || !Number.isFinite(simulacoes) || simulacoes <= 0) return "";
    const partes = [`${number(ocorrencias, 0)} ocorrências em ${number(simulacoes, 0)} simulações`];
    if (detail.zero_observado) {
      partes.push("não apareceu nas simulações, mas ainda é matematicamente possível");
      const limite = Number(detail.limite_superior_95_regra_dos_tres_pct);
      if (Number.isFinite(limite) && limite > 0) {
        partes.push(`limite superior de 95%: ${String(limite).replace(".", ",")}%`);
      }
    }
    return partes.join(" · ");
  }

  function probabilityDisplayText(detail, value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const explicit = String(detail?.exibicao || "").replace(/\s/g, "");
    if (n === 0 && /^(0|0,0+)%$/.test(explicit)) return "0%";
    if (detail?.impossivel_estruturalmente === true || detail?.possivel_estruturalmente === false) return "0%";
    if (n >= 0 && n < 0.001) return "<0,001%";
    if (n >= 100) return detail?.certeza_estrutural === true ? "100%" : ">99,999%";
    if (n > 99.999) return ">99,999%";
    let precision = n < 0.1 ? 3 : n < 1 ? 2 : 1;
    while (precision < 3 && Number(n.toFixed(precision)) >= 100) precision += 1;
    return `${number(n, precision)}%`;
  }

  function probabilityFieldValue(club, field) {
    const p = club?.probabilidades_pct || {};
    if (Number.isFinite(Number(p[field]))) return Number(p[field]);
    if (field === "libertadores") return Number(p.libertadores_base);
    if (field === "sul_americana") return Number(p.sul_americana_base);
    if (field === "sem_competicao_continental") {
      const lib = Number(p.libertadores ?? p.libertadores_base);
      const sula = Number(p.sul_americana ?? p.sul_americana_base);
      return Number.isFinite(lib) && Number.isFinite(sula) ? Math.max(0, 100 - lib - sula) : NaN;
    }
    return Number(p[field]);
  }

  function probabilityFieldDetail(club, field) {
    const details = club?.probabilidades_detalhes || {};
    return details[field] || (field === "libertadores" ? details.libertadores_base : field === "sul_americana" ? details.sul_americana_base : null);
  }

  // Exibe a tríade exclusiva com a menor precisão que preserva todos os
  // destinos possíveis. O método dos maiores restos mantém a soma visual em
  // exatamente 100%, sem impor três casas a linhas que só precisam de uma.
  function continentalDisplayTriplet(club) {
    const fields = ["libertadores", "sul_americana", "sem_competicao_continental"];
    const raw = fields.map((field) => Math.max(0, Number(probabilityFieldValue(club, field)) || 0));
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    const normalized = rawTotal > 0 ? raw.map((value) => 100 * value / rawTotal) : [0, 0, 100];
    const possible = fields.map((field, index) => {
      const detail = probabilityFieldDetail(club, field);
      return normalized[index] > 0 || (detail?.impossivel_estruturalmente !== true && detail?.possivel_estruturalmente !== false);
    });
    let digits = 3;
    for (const candidate of [1, 2, 3]) {
      const quantum = 10 ** (-candidate);
      if (normalized.every((value, index) => !possible[index] || value >= quantum - 1e-12)) {
        digits = candidate;
        break;
      }
    }
    const factor = 10 ** digits;
    const scaled = normalized.map((value) => value * factor);
    const units = scaled.map((value, index) => possible[index] ? Math.max(1, Math.floor(value + 1e-9)) : 0);
    let difference = 100 * factor - units.reduce((sum, value) => sum + value, 0);
    while (difference !== 0) {
      const candidates = scaled.map((value, index) => ({
        index,
        remainder: value - Math.floor(value),
        removable: units[index] - (possible[index] ? 1 : 0),
      })).filter((item) => difference > 0 || item.removable > 0)
        .sort((a, b) => difference > 0 ? b.remainder - a.remainder : b.removable - a.removable);
      const target = candidates[0]?.index;
      if (target === undefined) break;
      units[target] += difference > 0 ? 1 : -1;
      difference += difference > 0 ? -1 : 1;
    }
    return Object.fromEntries(fields.map((field, index) => {
      const detail = probabilityFieldDetail(club, field);
      const impossible = detail?.impossivel_estruturalmente === true || detail?.possivel_estruturalmente === false;
      if (impossible && units[index] === 0) return [field, "0%"];
      if (units[index] === 100 * factor && possible.filter(Boolean).length === 1) return [field, "100%"];
      return [field, `${number(units[index] / factor, digits)}%`];
    }));
  }

  // ────────────────────────────────────────────────────────────────────
  // CLASSIFICAÇÃO CORRENTE NA TABELA DE PROBABILIDADES
  //
  // Posição, pontos e jogos são FATO CONSUMADO, não previsão. Ficavam presos
  // ao instante da simulação (pontos_atuais/jogos_atuais do AF-Previsão), o que
  // fazia a página exibir 44 pontos enquanto a Tabela já mostrava 47 — janela
  // que dura de um jogo terminar até o AF recalcular. Passam a vir do
  // tabela.json, que o auto-refresh mantém atualizado a cada 30 s.
  //
  // Percentuais, PROJ. e FAIXA continuam ancorados ao cálculo, porque são
  // saída da simulação: atualizá-los sem simular seria inventar número. A
  // frase de "último cálculo" declara essa idade ao leitor.
  // ────────────────────────────────────────────────────────────────────

  let standingsCache = { table: null, results: null, live: null, projection: null, mapa: new Map() };

  function canonicalLiveTeam(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const rows = Array.isArray(state.table?.tabela) ? state.table.tabela : [];
    const exact = rows.find((row) => normalize(row?.time || row?.clube) === normalize(raw));
    if (exact) return exact.time || exact.clube;

    const aliases = {
      "athletico paranaense": "Athletico-PR",
      "athletico": "Athletico-PR",
      "atletico paranaense": "Athletico-PR",
      "atletico mineiro": "Atlético-MG",
      "atletico mg": "Atlético-MG",
      "red bull bragantino": "Bragantino",
      "rb bragantino": "Bragantino",
      "vasco": "Vasco da Gama",
      "cr vasco da gama": "Vasco da Gama",
      "ec bahia": "Bahia",
      "ec vitoria": "Vitória",
      "sc internacional": "Internacional",
      "se palmeiras": "Palmeiras",
      "cr flamengo": "Flamengo",
      "clube do remo": "Remo",
      "sao paulo fc": "São Paulo",
      "santos fc": "Santos",
      "mirassol fc": "Mirassol",
      "coritiba fc": "Coritiba",
      "chapecoense sc": "Chapecoense",
      "sc corinthians paulista": "Corinthians",
      "gremio fbpa": "Grêmio",
      "botafogo rj": "Botafogo",
      "fluminense fc": "Fluminense",
      "cruzeiro ec": "Cruzeiro",
    };
    const key = normalize(raw);
    if (aliases[key]) return aliases[key];

    const tokens = [
      ["paranaense", "Athletico-PR"], ["athletico", "Athletico-PR"], ["mineiro", "Atlético-MG"],
      ["bragantino", "Bragantino"], ["chapecoense", "Chapecoense"], ["corinthians", "Corinthians"],
      ["coritiba", "Coritiba"], ["cruzeiro", "Cruzeiro"], ["flamengo", "Flamengo"],
      ["fluminense", "Fluminense"], ["gremio", "Grêmio"], ["internacional", "Internacional"],
      ["mirassol", "Mirassol"], ["palmeiras", "Palmeiras"], ["remo", "Remo"], ["santos", "Santos"],
      ["sao paulo", "São Paulo"], ["vasco", "Vasco da Gama"], ["botafogo", "Botafogo"],
      ["bahia", "Bahia"], ["vitoria", "Vitória"],
    ];
    for (const [token, canonical] of tokens) {
      if (` ${key} `.includes(` ${token} `) || key === token) return canonical;
    }
    return null;
  }

  function currentStandingsProjection() {
    const table = Array.isArray(state.table?.tabela) ? state.table.tabela : [];
    const results = Array.isArray(state.results?.resultados) ? state.results.resultados : [];
    const live = state.espnLive || {};
    if (
      standingsCache.table === table &&
      standingsCache.results === results &&
      standingsCache.live === live &&
      standingsCache.projection
    ) return standingsCache.projection;

    const engine = window.BRClassificacaoLive;
    const projection = engine
      ? engine.projectStandings({ table, results, liveMap: live, canonicalize: canonicalLiveTeam })
      : { tabela: table.map((row) => ({ ...row })), jogos: [] };
    const mapa = new Map();
    projection.tabela.forEach((row) => {
      const key = normalize(row?.time || row?.clube);
      if (key) mapa.set(key, row);
    });
    standingsCache = { table, results, live, projection, mapa };
    return projection;
  }

  function standingsIndex() {
    currentStandingsProjection();
    return standingsCache.mapa;
  }

  // Posição/pontos/jogos vêm da classificação factual (incluindo placar ao vivo).
  // Percentuais e projeções permanecem presos ao snapshot do AF-Previsão.
  function liveStanding(club) {
    const official = standingsIndex().get(normalize(club?.clube));
    const choose = (current, snapshot) => (Number.isFinite(Number(current)) ? Number(current) : snapshot);
    return {
      posicao: choose(official?.pos, club?.posicao_atual),
      pontos: choose(official?.pontos, club?.pontos_atuais),
      jogos: choose(official?.jogos, club?.jogos_atuais),
      aoVivo: official?._aoVivo === true,
      provisorioFinal: official?._provisorioFinal === true,
    };
  }

  function dataHojeBR() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function hojeEhTercaBR() {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(new Date());
    return day === "Tue";
  }

  function probabilityMovementSnapshot() {
    const table = Array.isArray(state.table?.tabela) ? state.table.tabela : [];
    if (!table.length) return null;
    const current = Object.fromEntries(table.map((row) => [row.time || row.clube, Number(row.pos)]));
    const today = dataHojeBR();
    let snapshot = null;
    try { snapshot = JSON.parse(localStorage.getItem("snapshot_tabela_v2") || "null"); } catch (_) {}
    if (!snapshot) {
      snapshot = { dataBase: today, posicoesBase: current };
      try { localStorage.setItem("snapshot_tabela_v2", JSON.stringify(snapshot)); } catch (_) {}
    } else if (hojeEhTercaBR() && snapshot.dataBase !== today) {
      snapshot = { dataBase: today, posicoesBase: current };
      try { localStorage.setItem("snapshot_tabela_v2", JSON.stringify(snapshot)); } catch (_) {}
    }
    return snapshot;
  }

  function probabilityMovementHtml(team, currentPosition) {
    if (hojeEhTercaBR()) return "";
    const snapshot = probabilityMovementSnapshot();
    const base = Number(snapshot?.posicoesBase?.[team]);
    const current = Number(currentPosition);
    if (!base || !current || base === current) return "";
    const diff = base - current;
    return diff > 0
      ? `<span class="probability-position-move is-up" title="Subiu ${diff} ${diff === 1 ? "posição" : "posições"}">▲${diff}</span>`
      : `<span class="probability-position-move is-down" title="Caiu ${-diff} ${-diff === 1 ? "posição" : "posições"}">▼${-diff}</span>`;
  }

  function probabilityStandingBadge(standing) {
    if (standing?.aoVivo) return '<span class="probability-standing-badge is-live">AO VIVO</span>';
    if (standing?.provisorioFinal) return '<span class="probability-standing-badge is-final">FINAL</span>';
    return "";
  }

  function probabilityClubRows() {
    return Array.isArray(state.probabilities?.clubes) ? state.probabilities.clubes : [];
  }

  function probabilityClubByName(name) {
    const key = normalize(name);
    return probabilityClubRows().find((club) => normalize(club?.clube) === key) || null;
  }

  function probabilityMetric(label, value, tone = "neutral", detail = null, help = "", displayOverride = "") {
    const raw = Number(value);
    const n = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
    const display = String(displayOverride || "").trim() || probabilityDisplayText(detail, raw);
    const impossible = detail?.impossivel_estruturalmente === true || detail?.possivel_estruturalmente === false;
    const residual = !impossible && (detail?.zero_observado || (Number.isFinite(raw) && raw < 0.001));
    const title = impossible
      ? String(detail?.motivo_impossibilidade || "Via estruturalmente indisponível para o clube.")
      : residual
        ? "Evento não é tratado como impossível: ficou abaixo da resolução visual de 0,001%."
        : help;
    return `<div class="probability-metric probability-tone-${escapeAttr(tone)}"${title ? ` title="${escapeAttr(title)}"` : ""}>
      <span>${escapeHtml(label)}${residual ? '<em class="probability-residual-mark" aria-label="Probabilidade residual">ⓘ</em>' : ""}</span>
      <strong>${escapeHtml(display)}</strong>
      <div aria-hidden="true"><i style="width:${n.toFixed(4)}%"></i></div>
    </div>`;
  }

  function probabilityHighlight(icon, label, item, tone, field) {
    const club = item?.clube || "Aguardando dados";
    const row = probabilityClubByName(club);
    const pct = Number.isFinite(Number(item?.probabilidade_pct)) ? Number(item.probabilidade_pct) : probabilityFieldValue(row, field);
    const detail = probabilityFieldDetail(row, field);
    const info = teamInfo(club);
    return `<a class="probability-highlight probability-tone-${escapeAttr(tone)}" href="${escapeAttr(clubHref(club))}" aria-label="Abrir página de ${escapeAttr(club)}">
      <div class="probability-highlight-label"><span>${escapeHtml(icon)}</span>${escapeHtml(label)}</div>
      <div class="probability-highlight-main">${shield(info, "probability-highlight-shield")}<strong>${escapeHtml(club)}</strong></div>
      <b>${escapeHtml(probabilityDisplayText(detail, pct))}</b>
    </a>`;
  }

  const projectedPositionsCache = new WeakMap();

  function projectedPointsMean(club) {
    const points = club?.pontos_projetados;
    const raw = points && typeof points === "object"
      ? points.media_estimada ?? points.media
      : club?.pontos_media_estimada ?? club?.pontos_medios ?? points;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  }

  function projectedCriterion(club, field) {
    const value = Number(club?.classificacao_projetada_criterios?.[field]);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  }

  function projectedMeanPosition(club) {
    const value = Number(
      club?.classificacao_projetada_criterios?.posicao_media_simulada
      ?? club?.posicao_projetada_media
      ?? club?.posicao_media_estimada
      ?? club?.posicao_projetada
    );
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }

  function projectedPositionsForRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return new Map();
    const cached = projectedPositionsCache.get(rows);
    if (cached) return cached;

    const published = rows.map((club) => Number(club?.posicao_classificacao_projetada));
    const publishedIsUnique = published.every((position) => Number.isInteger(position) && position >= 1 && position <= 20)
      && new Set(published).size === rows.length;
    const map = new Map();
    if (publishedIsUnique) {
      rows.forEach((club, index) => map.set(normalize(club?.clube), published[index]));
    } else {
      rows.slice().sort((a, b) => {
        for (const [aValue, bValue] of [
          [projectedPointsMean(a), projectedPointsMean(b)],
          [projectedCriterion(a, "vitorias_medias"), projectedCriterion(b, "vitorias_medias")],
          [projectedCriterion(a, "saldo_medio"), projectedCriterion(b, "saldo_medio")],
          [projectedCriterion(a, "gols_pro_medios"), projectedCriterion(b, "gols_pro_medios")],
        ]) {
          if (aValue !== bValue) return bValue - aValue;
        }
        const meanDelta = projectedMeanPosition(a) - projectedMeanPosition(b);
        if (meanDelta) return meanDelta;
        return String(a?.clube || "").localeCompare(String(b?.clube || ""), "pt-BR", { sensitivity: "base" });
      }).forEach((club, index) => map.set(normalize(club?.clube), index + 1));
    }
    projectedPositionsCache.set(rows, map);
    return map;
  }

  function projectedPositionAmong(club, rows) {
    const derived = projectedPositionsForRows(rows).get(normalize(club?.clube));
    if (Number.isFinite(derived)) return derived;
    const explicit = Number(club?.posicao_classificacao_projetada ?? club?.posicao_projetada);
    if (Number.isFinite(explicit)) return Math.max(1, Math.min(20, Math.round(explicit)));
    const mean = projectedMeanPosition(club);
    return Number.isFinite(mean) ? Math.max(1, Math.min(20, Math.round(mean))) : null;
  }

  function projectedPosition(club) {
    return projectedPositionAmong(club, probabilityClubRows());
  }

  function projectedPoints(club) {
    const points = club?.pontos_projetados || {};
    const value = Number(points.media ?? points.media_estimada);
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  function probabilityPositionRange(club) {
    const explicit = club?.faixa_posicao_80 || {};
    const best = Number(explicit.melhor);
    const worst = Number(explicit.pior);
    if (Number.isFinite(best) && Number.isFinite(worst)) {
      return { best: Math.min(best, worst), worst: Math.max(best, worst) };
    }
    const values = Array.isArray(club?.distribuicao_posicoes_pct) ? club.distribuicao_posicoes_pct : [];
    if (!values.length) return null;
    let cumulative = 0;
    let lower = null;
    let upper = null;
    values.forEach((value, index) => {
      cumulative += Math.max(0, Number(value) || 0);
      if (lower === null && cumulative >= 10) lower = index + 1;
      if (upper === null && cumulative >= 90) upper = index + 1;
    });
    return { best: lower || 1, worst: upper || 20 };
  }

  function probabilityProjectionMetric(label, value, tone = "position", help = "") {
    return `<div class="probability-metric probability-projection-metric probability-tone-${escapeAttr(tone)}"${help ? ` title="${escapeAttr(help)}"` : ""}>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "—")}</strong>
      <small>${escapeHtml(help)}</small>
    </div>`;
  }

  function probabilityTrendNote(club) {
    const trend = club?.tendencia_recente;
    if (!trend) return "";
    const games = Number(trend.jogos_considerados);
    const adjustment = Number(trend.ajuste_forca_pct);
    const label = String(trend.classificacao || "estável");
    const adjustmentText = Number.isFinite(adjustment) ? `${adjustment >= 0 ? "+" : ""}${number(adjustment, 1)}%` : "—";
    return `<p class="probability-trend-note"><span>Tendência recente</span><strong>${escapeHtml(label)}</strong><small>${Number.isFinite(games) ? `${integer(games)} jogos` : "janela recente"} · ajuste limitado ${escapeHtml(adjustmentText)}</small></p>`;
  }

  function probabilityHistoryClubRow(snapshot, clubName) {
    const rows = Array.isArray(snapshot?.clubes) ? snapshot.clubes : [];
    const row = rows.find((item) => normalize(item?.clube) === normalize(clubName));
    if (!row) return null;
    const pointsRaw = Number(row.pontos_projetados ?? row.pontos_media_estimada ?? row.pontos_medios);
    return {
      snapshot,
      row,
      position: projectedPositionAmong(row, rows),
      points: Number.isFinite(pointsRaw) ? Math.round(pointsRaw) : null,
    };
  }

  function probabilityClubContext(clubName) {
    const name = String(clubName || "").trim();
    return name ? `<b class="probability-club-context">${escapeHtml(name)}</b>` : "";
  }

  function performanceHistoryClubRows(clubName) {
    const snapshots = Array.isArray(state.rankingHistory?.snapshots) ? state.rankingHistory.snapshots : [];
    return snapshots
      .filter((snapshot) => snapshot?.destaque_interface || snapshot?.id === "atual")
      .map((snapshot) => {
        const item = (Array.isArray(snapshot?.ranking) ? snapshot.ranking : [])
          .find((row) => normalize(row?.time) === normalize(clubName));
        return item ? { snapshot, item } : null;
      })
      .filter(Boolean);
  }

  function performanceHistoryMovement(currentPosition, previousPosition) {
    if (previousPosition === null || previousPosition === undefined) {
      return '<span class="club-evolution-move is-same">• início</span>';
    }
    const current = Number(currentPosition);
    const previous = Number(previousPosition);
    if (!Number.isFinite(current) || !Number.isFinite(previous) || current === previous) {
      return '<span class="club-evolution-move is-same">• manteve</span>';
    }
    const delta = Math.abs(previous - current);
    return current < previous
      ? `<span class="club-evolution-move is-up">▲ ${integer(delta)}</span>`
      : `<span class="club-evolution-move is-down">▼ ${integer(delta)}</span>`;
  }

  function performanceHistoryClubHtml(clubName) {
    const rows = performanceHistoryClubRows(clubName);
    if (!rows.length) return "";
    const cards = rows.map(({ snapshot, item }, index) => {
      const previous = index > 0 ? rows[index - 1].item : null;
      const games = Number(item?.jogos);
      const label = snapshot?.id === "atual"
        ? `Atual${Number.isFinite(games) ? ` · ${integer(games)} jogos` : ""}`
        : snapshot?.nome || "Marco";
      return `<article class="club-evolution-card${snapshot?.id === "atual" ? " is-current" : ""}">
        <span>${escapeHtml(label)}</span>
        <strong>${integer(item?.pos)}º <i>·</i> ${number(item?.indice_final, 1)}</strong>
        <small>posição · AF-Score ${performanceHistoryMovement(item?.pos, previous?.pos)}</small>
      </article>`;
    }).join("");
    return `<section class="club-performance-history" aria-label="Evolução do Ranking de Desempenho de ${escapeAttr(clubName)}">
      <div class="club-evolution-head"><div><span>AF-Score ${probabilityClubContext(clubName)}</span><strong>Evolução do Ranking de Desempenho</strong></div><small>comparação após a mesma quantidade de jogos</small></div>
      <div class="club-evolution-strip">${cards}</div>
      <p>Os marcos fechados comparam os 20 clubes após exatamente 5, 10, 15 e, futuramente, mais jogos. Assim, partidas atrasadas não criam vantagem artificial.</p>
    </section>`;
  }

  function rankingPerformanceHistoryDetails(clubName) {
    const history = performanceHistoryClubHtml(clubName);
    if (!history) return "";
    return `<details class="ranking-history-details">
      <summary><span class="ranking-history-label is-closed">Ver evolução do ranking</span><span class="ranking-history-label is-open">Recolher evolução do ranking</span><i aria-hidden="true"></i></summary>
      <div class="ranking-history-content">${history}</div>
    </details>`;
  }

  function probabilityHistoryClubStateKey(snapshot, row) {
    const publishedKey = String(row?.hash_estado_clube || "").trim();
    if (publishedKey) return publishedKey;
    const games = Number(row?.jogos_atuais);
    const points = Number(row?.pontos_atuais);
    const position = Number(row?.posicao_atual);
    const clubRound = Number(row?.rodada_referencia_clube);
    if ([games, points, position].some(Number.isFinite)) {
      return [
        Number.isFinite(games) ? games : "—",
        Number.isFinite(points) ? points : "—",
        Number.isFinite(position) ? position : "—",
        Number.isFinite(clubRound) ? clubRound : "—",
      ].join("|");
    }
    return String(snapshot?.hash_estado_esportivo || snapshot?.hash_entrada || snapshot?.hash_snapshot || snapshot?.gerado_em || "");
  }

  function probabilityClubHistoryRows(clubName, limit = 12) {
    const snapshots = Array.isArray(state.probabilitiesHistory?.snapshots) ? state.probabilitiesHistory.snapshots : [];
    const rows = [];
    snapshots.forEach((snapshot) => {
      const entry = probabilityHistoryClubRow(snapshot, clubName);
      if (!entry) return;
      const key = probabilityHistoryClubStateKey(snapshot, entry.row);
      if (rows.length && rows[rows.length - 1].stateKey === key) return;
      rows.push({ ...entry, stateKey: key });
    });
    return rows.slice(-Math.max(1, Number(limit) || 12));
  }

  function probabilityHistoryReference(snapshot, row) {
    const clubRound = Number(row?.rodada_referencia_clube);
    if (Number.isFinite(clubRound) && clubRound > 0) return `R${integer(clubRound)}`;
    const globalRound = Number(snapshot?.rodada_referencia);
    if (Number.isFinite(globalRound) && globalRound > 0) return `R${integer(globalRound)}`;
    return dateBR(snapshot?.gerado_em);
  }

  function probabilityClubHistoryDetails(club) {
    const historyRows = probabilityClubHistoryRows(club?.clube, 10);
    const currentCalculatedAt = state.probabilities?.calculado_em || state.probabilities?.gerado_em || "";
    const currentEntry = club ? {
      snapshot: { gerado_em: currentCalculatedAt },
      row: {
        campeao_pct: probabilityFieldValue(club, "campeao"),
        libertadores_pct: probabilityFieldValue(club, "libertadores"),
        sul_americana_pct: probabilityFieldValue(club, "sul_americana"),
        rebaixamento_pct: probabilityFieldValue(club, "rebaixamento"),
      },
      position: projectedPosition(club),
      points: projectedPoints(club),
      isCurrent: true,
    } : null;
    const displayRows = currentEntry ? [...historyRows, currentEntry] : historyRows;
    const performanceHistory = performanceHistoryClubHtml(club?.clube);
    if (!displayRows.length && !performanceHistory) return "";
    const body = displayRows.map(({ snapshot, row, position, points, isCurrent }) => {
      const reference = isCurrent ? "ATUAL" : probabilityHistoryReference(snapshot, row);
      const title = probabilityDisplayText(isCurrent ? probabilityFieldDetail(club, "campeao") : null, Number(row?.campeao_pct));
      const lib = probabilityDisplayText(isCurrent ? probabilityFieldDetail(club, "libertadores") : null, probabilityHistoryValue(row, "libertadores_pct"));
      const sula = probabilityDisplayText(isCurrent ? probabilityFieldDetail(club, "sul_americana") : null, probabilityHistoryValue(row, "sul_americana_pct"));
      const relegation = probabilityDisplayText(isCurrent ? probabilityFieldDetail(club, "rebaixamento") : null, Number(row?.rebaixamento_pct));
      const referenceDetail = isCurrent ? "cálculo vigente" : dateBR(snapshot?.gerado_em);
      return `<tr${isCurrent ? ' class="is-current"' : ""}><th scope="row"${isCurrent && snapshot?.gerado_em ? ` title="Calculado em ${escapeAttr(dateTimeBR(snapshot.gerado_em))}"` : ""}><span>${escapeHtml(reference)}</span><small>${escapeHtml(referenceDetail)}</small></th><td>${position ? `${integer(position)}º` : "—"}</td><td>${points ?? "—"}</td><td>${escapeHtml(title)}</td><td>${escapeHtml(lib)}</td><td>${escapeHtml(sula)}</td><td>${escapeHtml(relegation)}</td></tr>`;
    }).join("");
    const forecastHistory = displayRows.length ? `<section class="club-forecast-history">
      <div class="club-evolution-head"><div><span>AF-Previsão ${probabilityClubContext(club?.clube)}</span><strong>Evolução da previsão</strong></div><small>${integer(historyRows.length)} ${historyRows.length === 1 ? "estado histórico" : "estados históricos"} + cálculo atual</small></div>
      <div class="probability-history-scroll"><table><thead><tr><th>Referência</th><th>Pos.</th><th>Pts</th><th>Título</th><th>Libertadores</th><th>Sul-Americana</th><th>Queda</th></tr></thead><tbody>${body}</tbody></table></div>
      <p>As linhas históricas avançam quando o clube conclui outra partida. A linha ATUAL acompanha o cálculo vigente e pode mudar quando jogos de outros clubes alteram a classificação projetada, sem criar um snapshot histórico artificial.</p>
    </section>` : "";
    return `<details class="probability-history-details">
      <summary>Evolução do clube <span>AF-Score + AF-Previsão ${probabilityClubContext(club?.clube)}</span></summary>
      <div class="club-evolution-content">${performanceHistory}${forecastHistory}</div>
    </details>`;
  }

  function probabilityPositionDistribution(club) {
    const values = Array.isArray(club?.distribuicao_posicoes_pct) ? club.distribuicao_posicoes_pct : [];
    if (!values.length) return emptyState("Distribuição de posições ainda não disponível.");
    const max = Math.max(...values.map((value) => Number(value) || 0), 0.0001);
    return `<div class="probability-position-grid">${values.map((value, index) => {
      const n = Math.max(0, Number(value) || 0);
      const relative = n <= 0 ? 0 : Math.max(1.5, (n / max) * 100);
      const position = index + 1;
      const zone = position === 1 ? "title" : position <= 5 ? "libertadores" : position <= 11 ? "sulamericana" : position >= 17 ? "relegation" : "neutral";
      const display = probabilityDisplayText(null, n);
      return `<div class="probability-position-cell probability-position-zone-${zone}" title="${position}º lugar: ${escapeAttr(display)}">
        <span>${position}º</span>
        <div aria-hidden="true"><i style="width:${relative.toFixed(2)}%"></i></div>
        <strong>${escapeHtml(display)}</strong>
      </div>`;
    }).join("")}</div>`;
  }

  function probabilityInlineDetailsRow(club) {
    const clubName = String(club?.clube || "").trim();
    if (!clubName) return "";
    const position = projectedPosition(club);
    const median = Number(club?.posicao_projetada_mediana);
    const medianText = Number.isFinite(median) && median > 0 ? `${integer(median)}º` : "—";
    const performanceHistory = performanceHistoryClubHtml(clubName);
    return `<tr class="probability-inline-row" data-probability-inline-row="${escapeAttr(clubSlug(clubName))}">
      <td colspan="11">
        <div class="probability-inline-viewport">
          <section class="probability-inline-panel" id="${escapeAttr(probabilityInlinePanelId(clubName))}" aria-label="Resumo estatístico de ${escapeAttr(clubName)}">
            <header class="probability-inline-head">
              <div><span>Resumo rápido</span><strong>${escapeHtml(clubName)}</strong></div>
              <div class="probability-inline-head-meta"><span>projeção: <b>${position ? `${integer(position)}º` : "—"}</b></span><i>•</i><span>mediana: <b>${escapeHtml(medianText)}</b></span></div>
            </header>
            <section class="probability-inline-distribution" aria-label="Distribuição das 20 posições de ${escapeAttr(clubName)}">
              <div class="probability-inline-section-title"><strong>Distribuição das 20 posições</strong><small>20 cenários de classificação</small></div>
              ${probabilityPositionDistribution(club)}
            </section>
            ${performanceHistory ? `<div class="probability-inline-evolution">${performanceHistory}</div>` : ""}
            <div class="probability-inline-actions">
              <a href="${escapeAttr(probabilityCardHref(clubName))}" data-probability-inline-more="${escapeAttr(clubName)}">Mais detalhes de ${escapeHtml(clubName)} ↓</a>
              <button type="button" data-probability-inline-close="${escapeAttr(clubName)}">Recolher ▲</button>
            </div>
          </section>
        </div>
      </td>
    </tr>`;
  }

  function probabilitySortRows(rows) {
    const sort = state.probabilitySort;
    const sorted = rows.slice();
    const probabilityKey = {
      campeao: "campeao",
      libertadores: "libertadores",
      sulamericana: "sul_americana",
      rebaixamento: "rebaixamento",
    }[sort];
    sorted.sort((a, b) => {
      if (sort === "classificacao") return (Number(liveStanding(a).posicao) || 99) - (Number(liveStanding(b).posicao) || 99);
      if (sort === "posicao") return (projectedPosition(a) || 99) - (projectedPosition(b) || 99);
      if (sort === "pontos") return (projectedPoints(b) || 0) - (projectedPoints(a) || 0);
      return probabilityFieldValue(b, probabilityKey) - probabilityFieldValue(a, probabilityKey);
    });
    return sorted;
  }

  const PROBABILITY_ROUTE_LABELS = {
    via_brasileirao: "Via Brasileirão",
    via_copa_do_brasil: "Via Copa do Brasil",
    via_titulo_libertadores: "Via título da Libertadores",
    via_titulo_sul_americana: "Via título da Sul-Americana",
    via_repasse: "Via repasse",
    campeao: "Campeão da Copa do Brasil",
    vice: "Vice da Copa do Brasil",
    vice_herda_vaga_direta: "Vice herdando vaga direta",
  };

  function probabilityTextNumber(text) {
    const match = String(text || "").replace(",", ".").match(/[0-9]+(?:\.[0-9]+)?/);
    return match ? Number(match[0]) : NaN;
  }

  function probabilityTextDigits(text) {
    const clean = String(text || "").replace(",", ".");
    const match = clean.match(/\.([0-9]+)/);
    return match ? Math.min(3, match[1].length) : 0;
  }

  function probabilityBreakdownDisplays(details, targetText) {
    const entries = Object.entries(details || {});
    if (!entries.length) return {};
    const target = Math.max(0, probabilityTextNumber(targetText) || 0);
    const raw = entries.map(([, detail]) => Math.max(0, Number(detail?.percentual_estimado) || 0));
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    const normalized = rawTotal > 0 ? raw.map((value) => target * value / rawTotal) : raw.map(() => 0);
    const possible = entries.map(([, detail], index) => normalized[index] > 0 || (detail?.impossivel_estruturalmente !== true && detail?.possivel_estruturalmente !== false));
    let digits = Math.max(1, probabilityTextDigits(targetText));
    for (let candidate = digits; candidate <= 3; candidate += 1) {
      const quantum = 10 ** (-candidate);
      if (normalized.every((value, index) => !possible[index] || value >= quantum - 1e-12)) {
        digits = candidate;
        break;
      }
      digits = candidate;
    }
    const factor = 10 ** digits;
    const scaled = normalized.map((value) => value * factor);
    const units = scaled.map((value, index) => value > 0 && possible[index] ? Math.max(1, Math.floor(value + 1e-9)) : 0);
    let difference = Math.round(target * factor) - units.reduce((sum, value) => sum + value, 0);
    while (difference !== 0) {
      const candidates = scaled.map((value, index) => ({
        index,
        remainder: value - Math.floor(value),
        removable: units[index] - (scaled[index] > 0 && possible[index] ? 1 : 0),
      })).filter((item) => difference > 0 ? scaled[item.index] > 0 : item.removable > 0)
        .sort((a, b) => difference > 0 ? b.remainder - a.remainder : b.removable - a.removable);
      const index = candidates[0]?.index;
      if (index === undefined) break;
      units[index] += difference > 0 ? 1 : -1;
      difference += difference > 0 ? -1 : 1;
    }
    return Object.fromEntries(entries.map(([key, detail], index) => {
      const impossible = detail?.impossivel_estruturalmente === true || detail?.possivel_estruturalmente === false;
      if (impossible) return [key, "0%"];
      if (units[index] === 0) return [key, probabilityDisplayText(detail, raw[index])];
      return [key, `${number(units[index] / factor, digits)}%`];
    }));
  }

  function probabilityRouteRow(key, detail, tone, displayOverride = "") {
    const n = Math.max(0, Math.min(100, Number(detail?.percentual_estimado) || 0));
    return `<div class="probability-route-row probability-route-${escapeAttr(tone)}">
      <span>${escapeHtml(PROBABILITY_ROUTE_LABELS[key] || key)}</span>
      <div aria-hidden="true"><i style="width:${n.toFixed(4)}%"></i></div>
      <strong>${escapeHtml(String(displayOverride || "").trim() || probabilityDisplayText(detail, n))}</strong>
    </div>`;
  }

  function probabilityQualificationRoutes(club) {
    const decomposition = club?.decomposicao_chances;
    if (!decomposition?.libertadores || !decomposition?.sul_americana) return "";
    const lib = decomposition.libertadores;
    const sula = decomposition.sul_americana;
    const libRoutes = lib.vias || {};
    const sulaRoutes = sula.vias || {};
    const cupSubroutes = lib.subvias_copa_do_brasil || {};
    const continental = continentalDisplayTriplet(club);
    const libDisplays = probabilityBreakdownDisplays(libRoutes, continental.libertadores);
    const sulaDisplays = probabilityBreakdownDisplays(sulaRoutes, continental.sul_americana);
    const cupTarget = libDisplays.via_copa_do_brasil || probabilityDisplayText(libRoutes.via_copa_do_brasil, Number(libRoutes.via_copa_do_brasil?.percentual_estimado));
    const cupDisplays = probabilityBreakdownDisplays(cupSubroutes, cupTarget);
    const cupRows = Object.entries(cupSubroutes).map(([key, detail]) => probabilityRouteRow(key, detail, "cup", cupDisplays[key])).join("");
    return `<details class="probability-route-details">
      <summary>Como se formam as chances continentais? <span>vias exclusivas e auditáveis ${probabilityClubContext(club?.clube)}</span></summary>
      <div class="probability-route-columns">
        <section>
          <div class="probability-route-head"><span>Libertadores consolidada</span><strong>${escapeHtml(continental.libertadores)}</strong></div>
          <div class="probability-route-list">${Object.entries(libRoutes).map(([key, detail]) => probabilityRouteRow(key, detail, "libertadores", libDisplays[key])).join("")}</div>
          ${cupRows ? `<details class="probability-cup-subroutes"><summary>Detalhar a via Copa do Brasil</summary><div>${cupRows}</div></details>` : ""}
        </section>
        <section>
          <div class="probability-route-head"><span>Sul-Americana consolidada</span><strong>${escapeHtml(continental.sul_americana)}</strong></div>
          <div class="probability-route-list">${Object.entries(sulaRoutes).map(([key, detail]) => probabilityRouteRow(key, detail, "sulamericana", sulaDisplays[key])).join("")}</div>
          <p>As seis vagas são destinadas aos melhores clubes ainda não classificados à Libertadores em cada universo simulado.</p>
        </section>
      </div>
      <p class="probability-route-note"><strong>Fechamento continental:</strong> Libertadores ${escapeHtml(continental.libertadores)} + Sul-Americana ${escapeHtml(continental.sul_americana)} + sem competição continental ${escapeHtml(continental.sem_competicao_continental)} = 100%. Cada simulação atribui apenas uma via de Libertadores ao clube; os caminhos não duplicam cenários.</p>
    </details>`;
  }

  function probabilityClubCard(club, order) {
    const points = club?.pontos_projetados || {};
    const info = teamInfo(club?.clube);
    const titleValue = probabilityFieldValue(club, "campeao");
    const libValue = probabilityFieldValue(club, "libertadores");
    const sulaValue = probabilityFieldValue(club, "sul_americana");
    const relegationValue = probabilityFieldValue(club, "rebaixamento");
    const position = projectedPosition(club);
    const projected = projectedPoints(club);
    const range = probabilityPositionRange(club);
    const rangeText = range ? `${integer(range.best)}º–${integer(range.worst)}º` : "—";
    const continental = continentalDisplayTriplet(club);
    const current = liveStanding(club);
    const currentPosition = integer(current.posicao);
    const currentPoints = integer(current.pontos);
    const currentGames = integer(current.jogos);
    return `<article class="probability-club-card" id="${escapeAttr(probabilityCardId(club?.clube))}" data-probability-club="${escapeAttr(clubSlug(club?.clube))}">
      <div class="probability-club-head">
        <span class="probability-order">${integer(order)}</span>
        <a class="probability-club-link" href="${escapeAttr(clubHref(club?.clube))}" aria-label="Abrir página de ${escapeAttr(club?.clube)}">${shield(info, "probability-club-shield")}</a>
        <div class="probability-club-title">
          <a href="${escapeAttr(clubHref(club?.clube))}"><strong>${escapeHtml(club?.clube)}</strong></a>
          <div class="probability-current-standing" aria-label="Situação atual: ${escapeAttr(currentPoints)} pontos, ${escapeAttr(currentPosition)}º lugar, ${escapeAttr(currentGames)} jogos">
            <span class="probability-current-label">Agora</span>
            <strong>${currentPoints} <em>pts</em></strong>
            <b>${currentPosition}º lugar</b>
            <b>${currentGames} jogos</b>
          </div>
        </div>
        <div class="probability-points">
          <span>Projeção final</span>
          <strong>${projected ?? "—"} <em>pts</em></strong>
          <small>após 38 jogos · faixa de 80%: ${integer(points.percentil_10)}–${integer(points.percentil_90)}</small>
        </div>
      </div>
      <div class="probability-metric-grid">
        ${probabilityMetric("Campeão", titleValue, "title", probabilityFieldDetail(club, "campeao"))}
        ${probabilityProjectionMetric("Posição projetada", position ? `${integer(position)}º` : "—", "position", "Posição única na classificação projetada, ordenada pela pontuação final média das simulações.")}
        ${probabilityProjectionMetric("Faixa provável", rangeText, "range", "Faixa central de 80% das posições simuladas.")}
        ${probabilityMetric("Libertadores", libValue, "libertadores", probabilityFieldDetail(club, "libertadores"), "Chance consolidada por Brasileirão, copas, títulos continentais e repasses.", continental.libertadores)}
        ${probabilityMetric("Sul-Americana", sulaValue, "sulamericana", probabilityFieldDetail(club, "sul_americana"), "Chance consolidada após a alocação de todas as vagas de Libertadores.", continental.sul_americana)}
        ${probabilityMetric("Rebaixamento", relegationValue, "relegation", probabilityFieldDetail(club, "rebaixamento"))}
      </div>
      ${probabilityTrendNote(club)}
      ${probabilityQualificationRoutes(club)}
      <details class="probability-position-details">
        <summary>Distribuição das 20 posições <span>projeção: ${position ? `${integer(position)}º` : "—"} · mediana: ${integer(club?.posicao_projetada_mediana)}º ${probabilityClubContext(club?.clube)}</span></summary>
        ${probabilityPositionDistribution(club)}
      </details>
      ${probabilityClubHistoryDetails(club)}
    </article>`;
  }


  function renderProbabilityStatus() {
    const target = $("probabilidades-status");
    if (!target) return;
    const data = state.probabilities;
    if (!data || data.status !== "ok") {
      target.innerHTML = emptyState("Probabilidades ainda não disponíveis.", "Execute o workflow Atualizar Brasileirao (ESPN) após subir os arquivos do AF-Previsão.");
      return;
    }
    const base = data.base_corrente || {};
    const sim = data.simulacao || {};
    const integrated = data.integracao_continental || {};
    const competitions = Array.isArray(integrated.competicoes) ? integrated.competicoes.length : 0;
    target.innerHTML = `<div class="probability-status-grid">
      <div><span>Modelo</span><strong>${escapeHtml(data.versao_modelo || "AF-Previsão")}</strong></div>
      <div><span>Último cálculo</span><strong>${escapeHtml(dateTimeBR(data.calculado_em || data.gerado_em))}</strong></div>
      <div><span>Campeonato</span><strong>${integer(base.partidas_concluidas)} concluídas · ${integer(base.partidas_restantes)} restantes</strong></div>
      <div><span>Universos integrados</span><strong>2.000.000 simulações${competitions ? ` · ${integer(competitions)} copas` : ""}</strong></div>
    </div>`;
  }

  function renderProbabilityHighlights() {
    const target = $("probabilidades-destaques");
    if (!target) return;
    const highlights = state.probabilities?.destaques;
    if (!highlights) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = `<div class="probability-highlight-grid">
      ${probabilityHighlight("🏆", "Maior chance de título", highlights.maior_chance_titulo, "title", "campeao")}
      ${probabilityHighlight("🌎", "Maior chance de Libertadores", highlights.maior_chance_libertadores, "libertadores", "libertadores")}
      ${probabilityHighlight("🟦", "Maior chance de Sul-Americana", highlights.maior_chance_sul_americana, "sulamericana", "sul_americana")}
      ${probabilityHighlight("🔻", "Maior risco de rebaixamento", highlights.maior_risco_rebaixamento, "relegation", "rebaixamento")}
    </div>`;
  }


  function pointsThresholdCell(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `<strong>${integer(n)}</strong><small>pts</small>` : `<span aria-label="nível não atingido">—</span>`;
  }

  function pointsThresholdRows(rows) {
    return rows.map((row) => `<tr>
      <th scope="row">${escapeHtml(row.rotulo || `${number(row.probabilidade_pct, 1)}%`)}</th>
      <td>${pointsThresholdCell(row.titulo)}</td>
      <td>${pointsThresholdCell(row.libertadores)}</td>
      <td>${pointsThresholdCell(row.sul_americana_ou_melhor)}</td>
      <td>${pointsThresholdCell(row.permanencia)}</td>
    </tr>`).join("");
  }

  function renderPointsThresholds() {
    const target = $("probabilidades-por-pontuacao");
    if (!target) return;
    const data = state.pointsThresholds;
    const rows = Array.isArray(data?.niveis) ? data.niveis : [];
    if (!data || data.status !== "ok" || !rows.length) {
      target.innerHTML = `<div class="probability-points-empty">Aguardando a próxima atualização íntegra do AF-Previsão.</div>`;
      return;
    }
    const mainLevels = new Set([50, 70, 80, 90, 95, 99, 99.9]);
    const mainRows = rows.filter((row) => mainLevels.has(Number(row.probabilidade_pct)));
    const extraRows = rows.filter((row) => !mainLevels.has(Number(row.probabilidade_pct)));
    const tableHead = `<thead><tr>
      <th scope="col">Chance</th>
      <th scope="col"><span>🏆</span> Título</th>
      <th scope="col"><span>🌎</span> Libertadores</th>
      <th scope="col"><span>🟦</span> Sul-Americana+</th>
      <th scope="col"><span>🛡️</span> Permanência</th>
    </tr></thead>`;
    target.innerHTML = `<div class="probability-points-scroll" tabindex="0" aria-label="Tabela de pontos necessários por objetivo">
      <table class="probability-points-table">${tableHead}<tbody>${pointsThresholdRows(mainRows)}</tbody></table>
    </div>
    ${extraRows.length ? `<details class="probability-points-more"><summary>Ver níveis detalhados <span>60%, 97%, 99,5% e 100% simulados</span></summary><div class="probability-points-scroll" tabindex="0"><table class="probability-points-table probability-points-table-extra">${tableHead}<tbody>${pointsThresholdRows(extraRows)}</tbody></table></div></details>` : ""}
    <div class="probability-points-notes">
      <p><strong>Sul-Americana+:</strong> significa alcançar ao menos uma vaga continental, seja na Sul-Americana ou na Libertadores.</p>
      <p><strong>100% nos cenários:</strong> ocorreu em todos os universos simulados daquela faixa; não representa impossibilidade matemática do cenário contrário.</p>
      <p>Atualizado em ${escapeHtml(dateTimeBR(data.gerado_em))} · ${integer(data.simulacoes)} simulações.</p>
    </div>`;
  }

  function renderProbabilityControls() {
    // Card "Ordenar tabela por / Compare os 20 clubes" removido a pedido:
    // poluía o layout. A tabela de probabilidades usa ordenação fixa por
    // classificação atual. Mantida a função vazia para não quebrar chamadas.
    const target = $("probabilidades-controles");
    if (target) target.innerHTML = "";
  }

  function probabilityComparisonRow(club) {
    const info = teamInfo(club?.clube);
    const position = projectedPosition(club);
    const range = probabilityPositionRange(club);
    const rangeText = range ? `${integer(range.best)}º–${integer(range.worst)}º` : "—";
    const atual = liveStanding(club);
    const continental = continentalDisplayTriplet(club);
    const noContinentalDetail = probabilityFieldDetail(club, "sem_competicao_continental");
    const noContinentalRaw = probabilityFieldValue(club, "sem_competicao_continental");
    const noContinentalTooltip = probabilityTooltip(noContinentalDetail)
      || `Complemento calculado antes do arredondamento conjunto: ${number(noContinentalRaw, 5)}%`;
    const movement = probabilityMovementHtml(club?.clube, atual.posicao);
    const badge = probabilityStandingBadge(atual);
    const inlineOpen = normalize(state.probabilityInlineClub) === normalize(club?.clube);
    const rowClass = `${atual.aoVivo ? " is-live-standing" : (atual.provisorioFinal ? " is-final-standing" : "")}${inlineOpen ? " is-inline-open" : ""}`;
    return `<tr class="${rowClass.trim()}" data-probability-table-club="${escapeAttr(clubSlug(club?.clube))}">
      <td class="probability-table-position"><span>${integer(atual.posicao)}</span>${movement}</td>
      <th scope="row" class="probability-table-club"><button type="button" class="probability-table-club-toggle" data-probability-inline-toggle="${escapeAttr(club?.clube)}" aria-expanded="${inlineOpen ? "true" : "false"}" aria-controls="${escapeAttr(probabilityInlinePanelId(club?.clube))}" aria-label="${inlineOpen ? "Recolher" : "Abrir"} resumo de ${escapeAttr(club?.clube)}">${shield(info, "probability-table-shield")}<strong>${escapeHtml(club?.clube)}</strong>${badge}<span class="probability-table-toggle-caret" aria-hidden="true">${inlineOpen ? "▴" : "▾"}</span></button></th>
      <td class="probability-table-number"><strong>${integer(atual.pontos)}</strong></td>
      <td class="probability-table-number">${integer(atual.jogos)}</td>
      <td class="probability-table-percent probability-cell-title" title="${escapeAttr(probabilityTooltip(probabilityFieldDetail(club, "campeao")))}">${escapeHtml(probabilityDisplayText(probabilityFieldDetail(club, "campeao"), probabilityFieldValue(club, "campeao")))}</td>
      <td class="probability-table-percent probability-cell-lib" title="${escapeAttr(probabilityTooltip(probabilityFieldDetail(club, "libertadores")))}">${escapeHtml(continental.libertadores)}</td>
      <td class="probability-table-percent probability-cell-sula" title="${escapeAttr(probabilityTooltip(probabilityFieldDetail(club, "sul_americana")))}">${escapeHtml(continental.sul_americana)}</td>
      <td class="probability-table-percent probability-cell-none" title="${escapeAttr(noContinentalTooltip)}">${escapeHtml(continental.sem_competicao_continental)}</td>
      <td class="probability-table-percent probability-cell-drop" title="${escapeAttr(probabilityTooltip(probabilityFieldDetail(club, "rebaixamento")))}">${escapeHtml(probabilityDisplayText(probabilityFieldDetail(club, "rebaixamento"), probabilityFieldValue(club, "rebaixamento")))}</td>
      <td class="probability-table-projection"><strong>${position ? `${integer(position)}º` : "—"}</strong></td>
      <td class="probability-table-range">${escapeHtml(rangeText)}</td>
    </tr>`;
  }

  // Horário do snapshot probabilístico. Não mistura atualização esportiva factual
  // com o momento em que o Monte Carlo realmente foi recalculado.
  function probabilityCalculationAt() {
    for (const value of [
      state.probabilities?.calculado_em,
      state.probabilities?.gerado_em,
      state.probabilitiesAudit?.gerado_em,
    ]) {
      if (!value) continue;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
  }

  function probabilityCalculationLabel() {
    const latest = probabilityCalculationAt();
    if (!latest) return "Último cálculo de probabilidades indisponível";
    const date = latest.toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
    });
    const time = latest.toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const base = Number(state.probabilities?.base_corrente?.partidas_concluidas) || 0;
    const current = totalFinishedGames() || base;
    const coverage = base && current ? ` · base: ${coverageLabel(base, current)} jogos concluídos` : "";
    return `Calculadas em ${date} ${time} BRT${coverage}`;
  }

  function probabilitySportsState() {
    const projection = currentStandingsProjection();
    const live = projection.jogos.some((game) => String(game?.estado || "").toLowerCase() === "in");
    if (live) return "live";
    const finalPending = projection.jogos.some((game) => String(game?.estado || "").toLowerCase() === "post");
    if (finalPending) return "pending";

    // Também detecta a janela em que tabela/resultados já foram publicados,
    // mas o AF-Previsão ainda carrega pontos/jogos do snapshot anterior.
    const behind = probabilityClubRows().some((club) => {
      const current = liveStanding(club);
      return Number(current.pontos) !== Number(club?.pontos_atuais) || Number(current.jogos) !== Number(club?.jogos_atuais);
    });
    return behind ? "pending" : "synced";
  }

  function probabilitySyncNotice() {
    const status = probabilitySportsState();
    if (status === "live") {
      return `<div class="probability-sync-notice is-live" role="status">
        <span class="probability-sync-dot" aria-hidden="true"></span>
        <div><strong>CLASSIFICAÇÃO AO VIVO</strong><p>Pontos, jogos e posições consideram os placares em andamento. Os percentuais, a projeção final e a faixa permanecem no último cálculo do AF-Previsão.</p></div>
      </div>`;
    }
    if (status === "pending") {
      return `<div class="probability-sync-notice is-pending" role="status">
        <span class="probability-sync-dot" aria-hidden="true"></span>
        <div><strong>RESULTADOS ATUALIZADOS · PROBABILIDADES EM ATUALIZAÇÃO</strong><p>A classificação já reflete os resultados disponíveis; os percentuais serão substituídos somente quando a nova simulação íntegra for publicada.</p></div>
      </div>`;
    }
    return "";
  }


  function renderProbabilityRanking() {
    const target = $("probabilidades-ranking");
    if (!target) return;
    const previousShell = target.querySelector(".probability-table-shell");
    const previousScrollLeft = previousShell ? previousShell.scrollLeft : 0;
    const rows = probabilitySortRows(probabilityClubRows());
    if (!rows.length) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = `<section class="probability-ranking-section probability-comparison-section" aria-label="Probabilidades">
      <div class="probability-section-head">
        <div><div class="kicker">Probabilidades</div></div>
        <div class="probability-head-aside"><small>${escapeHtml(probabilityCalculationLabel())}</small></div>
      </div>
      ${probabilitySyncNotice()}
      <p class="probability-table-hint">↔ No celular, arraste a tabela para ver todas as probabilidades e projeções.</p>
      <div class="probability-table-shell">
        <table class="probability-comparison-table">
          <thead><tr><th>Pos.</th><th>Time</th><th>Pts</th><th>J</th><th>Campeão</th><th>Libertadores</th><th>Sul-Americana</th><th>Sem continental</th><th>Rebaixamento</th><th title="Posição única na classificação projetada por pontos finais médios">Proj.</th><th>Faixa</th></tr></thead>
          <tbody>${rows.map((club) => {
            const row = probabilityComparisonRow(club);
            const inline = normalize(state.probabilityInlineClub) === normalize(club?.clube) ? probabilityInlineDetailsRow(club) : "";
            return row + inline;
          }).join("")}</tbody>
        </table>
      </div>
      <p class="probability-continental-note"><strong>Destino continental:</strong> Libertadores + Sul-Americana + sem competição continental = <strong>100%</strong> em cada clube. Os três valores são arredondados em conjunto e usam de uma a três casas conforme a precisão necessária; uma possibilidade válida abaixo da resolução recebe o piso visual de 0,001%, compensado no maior destino. Rebaixamento é um risco independente, pois uma vaga conquistada por copa pode coexistir com queda.</p>
    </section>`;
    const shell = target.querySelector(".probability-table-shell");
    if (shell && previousScrollLeft) shell.scrollLeft = previousScrollLeft;
  }

  function renderProbabilityDetails() {
    const target = $("probabilidades-detalhes");
    if (!target) return;
    const rows = probabilitySortRows(probabilityClubRows());
    target.innerHTML = rows.length ? `<div class="probability-club-list">${rows.map((club, index) => probabilityClubCard(club, index + 1)).join("")}</div>` : "";
  }

  const PROBABILITY_HISTORY_METRICS = {
    campeao_pct: { label: "Título", detail: "campeao" },
    libertadores_pct: { label: "Libertadores", detail: "libertadores" },
    sul_americana_pct: { label: "Sul-Americana", detail: "sul_americana" },
    rebaixamento_pct: { label: "Rebaixamento", detail: "rebaixamento" },
  };

  function probabilityHistoryValue(row, metric) {
    const value = Number(row?.[metric]);
    if (Number.isFinite(value)) return value;
    if (metric === "libertadores_pct") return Number(row?.libertadores_base_pct);
    if (metric === "sul_americana_pct") return Number(row?.sul_americana_base_pct);
    return value;
  }

  function renderProbabilityEvolution() {
    const target = $("probabilidades-evolucao");
    if (!target) return;
    const snapshots = Array.isArray(state.probabilitiesHistory?.snapshots) ? state.probabilitiesHistory.snapshots : [];
    if (!snapshots.length) {
      target.innerHTML = `<section class="probability-evolution-section"><div class="probability-section-head"><div><div class="kicker">Histórico versionado</div><h3>Evolução das probabilidades</h3></div><span>0 snapshots</span></div><div class="probability-evolution-empty"><strong>O histórico ainda não começou.</strong><p>Quando o primeiro estado íntegro for publicado, esta área passará a guardar a evolução sem criar registros artificiais a cada execução.</p></div></section>`;
      return;
    }
    const latest = snapshots[snapshots.length - 1];
    const latestClubs = Array.isArray(latest?.clubes) ? latest.clubes : [];
    const clubNames = latestClubs.map((row) => row?.clube).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));
    if (!state.probabilityHistoryClub || !clubNames.includes(state.probabilityHistoryClub)) {
      const leader = latestClubs.slice().sort((a, b) => probabilityHistoryValue(b, "campeao_pct") - probabilityHistoryValue(a, "campeao_pct"))[0];
      state.probabilityHistoryClub = leader?.clube || clubNames[0] || "";
    }
    if (!PROBABILITY_HISTORY_METRICS[state.probabilityHistoryMetric]) state.probabilityHistoryMetric = "campeao_pct";
    const metric = PROBABILITY_HISTORY_METRICS[state.probabilityHistoryMetric];
    const historyRows = probabilityClubHistoryRows(state.probabilityHistoryClub, 12)
      .map(({ snapshot, row }) => ({
        snapshot,
        club: row,
        value: probabilityHistoryValue(row, state.probabilityHistoryMetric),
      }))
      .filter((row) => Number.isFinite(row.value));
    const max = Math.max(...historyRows.map((row) => row.value), 0.0001);
    const rowsHtml = historyRows.map(({ snapshot, club, value }) => {
      const detailKey = metric.detail;
      const explicit = String(club?.exibicao?.[detailKey] || "").trim();
      const display = probabilityDisplayText(explicit ? { exibicao: explicit } : null, value);
      const relative = value <= 0 ? 0 : Math.max(2, (value / max) * 100);
      return `<div class="probability-evolution-row"><time>${escapeHtml(dateTimeBR(snapshot?.gerado_em))}</time><div><i style="width:${relative.toFixed(2)}%"></i></div><strong>${escapeHtml(display)}</strong></div>`;
    }).join("");
    target.innerHTML = `<section class="probability-evolution-section">
      <div class="probability-section-head"><div><div class="kicker">Histórico versionado</div><h3>Evolução das probabilidades</h3></div><span>${integer(historyRows.length)} ${historyRows.length === 1 ? "estado do clube" : "estados do clube"}</span></div>
      <div class="probability-evolution-controls">
        <label><span>Clube</span><select data-probability-history-club>${clubNames.map((name) => `<option value="${escapeAttr(name)}"${name === state.probabilityHistoryClub ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>
        <label><span>Evento</span><select data-probability-history-metric>${Object.entries(PROBABILITY_HISTORY_METRICS).map(([key, item]) => `<option value="${key}"${key === state.probabilityHistoryMetric ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
      </div>
      <div class="probability-evolution-caption"><strong>${escapeHtml(state.probabilityHistoryClub)}</strong><span>${escapeHtml(metric.label)} · uma referência por partida concluída do clube</span></div>
      ${historyRows.length ? `<div class="probability-evolution-list">${rowsHtml}</div>` : `<div class="probability-evolution-empty"><strong>Sem série suficiente para esta combinação.</strong></div>`}
    </section>`;
  }

  function renderProbabilityAudit() {
    const target = $("probabilidades-auditoria-metodo");
    if (!target) return;
    const data = state.probabilities || {};
    const audit = state.probabilitiesAudit || {};
    const models = state.probabilityModelsAudit || {};
    const winner = models?.selecao_modelo?.vencedor || {};
    const metrics = winner?.ranking?.[0]?.metricas || winner?.metricas || models?.selecao_modelo?.ranking?.[0]?.metricas || {};
    const sim = audit?.simulacao || data?.simulacao || {};
    const base = models?.base || {};
    const integrated = data?.integracao_continental || {};
    const margin = Number(sim?.convergencia?.margem_95_maxima_pontos_percentuais ?? sim?.margem_95_maxima_pontos_percentuais ?? data?.simulacao?.margem_95_maxima_pontos_percentuais);
    const threshold = Number(integrated?.limiar_exibicao_percentual ?? 0.001);
    const competitions = Array.isArray(integrated?.competicoes) ? integrated.competicoes.length : 0;
    const trend = data?.metodologia_resumida?.tendencia_recente || audit?.tendencia_recente?.configuracao || {};
    const trendWindow = Number(trend?.janela_jogos);
    const trendWeight = Number(trend?.peso_no_modelo);
    const trendLimit = Number(trend?.limite_ajuste_taxa_partida_pct);
    target.innerHTML = `<article><span>Base histórica</span><strong>${integer(base.partidas || 1140)} partidas</strong><small>${Array.isArray(base.temporadas) ? base.temporadas.join(" · ") : "2023 · 2024 · 2025"}</small></article>
      <article><span>Validação temporal</span><strong>${integer(metrics.partidas || 760)} previsões</strong><small>integralmente fora da amostra</small></article>
      <article><span>Log Loss</span><strong>${number(metrics.log_loss, 4)}</strong><small>menor é melhor</small></article>
      <article><span>Brier multiclasse</span><strong>${number(metrics.brier_multiclasse, 4)}</strong><small>menor é melhor</small></article>
      <article><span>Monte Carlo</span><strong>${integer(sim.quantidade || data?.simulacao?.quantidade)}</strong><small>semente ${integer(sim.semente || data?.simulacao?.semente)}</small></article>
      <article><span>Margem numérica</span><strong>${Number.isFinite(margin) ? `±${number(margin, 3)} p.p.` : "—"}</strong><small>pior caso aproximado, 95%</small></article>
      <article><span>Forma recente</span><strong>${Number.isFinite(trendWindow) ? `${integer(trendWindow)} jogos` : "Aguardando"}</strong><small>${Number.isFinite(trendWeight) ? `${number(trendWeight * 100, 0)}% de peso` : "peso controlado"}${Number.isFinite(trendLimit) ? ` · limite ±${number(trendLimit, 0)}%` : ""}</small></article>
      <article><span>Resolução visual</span><strong>&lt;${number(threshold, 3)}%</strong><small>zero observado não vira impossibilidade</small></article>
      <article><span>Histórico público</span><strong>${integer(state.probabilitiesHistory?.total_snapshots ?? state.probabilityEvaluation?.cobertura?.snapshots)}</strong><small>${state.probabilityEvaluation?.integridade_historico?.encadeado ? "cadeia SHA-256 íntegra" : "encadeamento após a próxima atualização"}</small></article>`;
  }

  function renderProbabilityEvaluation() {
    const target = $("probabilidades-avaliacao-final");
    if (!target) return;
    const data = state.probabilityEvaluation || {};
    const ready = data.publicar_na_interface === true && data.avaliacao_final?.agregado;
    target.hidden = !ready;
    if (!ready) {
      target.innerHTML = "";
      return;
    }
    const aggregate = data.avaliacao_final.agregado || {};
    const position = aggregate.posicao || {};
    const points = aggregate.pontos || {};
    const events = aggregate.eventos || {};
    const snapshots = Number(aggregate.snapshots_avaliados || data.cobertura?.snapshots);
    const eventCards = [
      ["Título", events.campeao],
      ["Libertadores", events.libertadores],
      ["Sul-Americana", events.sul_americana],
      ["Rebaixamento", events.rebaixamento],
    ].map(([label, metric]) => `<article><span>${escapeHtml(label)}</span><strong>${number(metric?.brier, 4)}</strong><small>Brier · Log Loss ${number(metric?.log_loss, 4)}</small></article>`).join("");
    target.innerHTML = `<section class="probability-final-evaluation" aria-labelledby="titulo-avaliacao-af">
      <div class="probability-section-head"><div><div class="kicker">Avaliação pós-campeonato</div><h3 id="titulo-avaliacao-af">Avaliação do AF-Previsão 2026</h3></div><span>${integer(snapshots)} ${snapshots === 1 ? "snapshot" : "snapshots"}</span></div>
      <p>As previsões registradas durante a temporada foram comparadas com a classificação e as vagas efetivamente observadas. A avaliação só é publicada depois da conclusão do Brasileirão e das competições que alteram as vagas continentais.</p>
      <div class="probability-final-evaluation-summary">
        <article><span>Erro médio de posição</span><strong>${number(position.mae_posicoes, 2)}</strong><small>posições por clube e snapshot</small></article>
        <article><span>Erro médio de pontos</span><strong>${number(points.mae_pontos, 2)}</strong><small>pontos por clube e snapshot</small></article>
        <article><span>RPS das posições</span><strong>${number(position.rps_posicao, 4)}</strong><small>menor é melhor</small></article>
      </div>
      <details class="probability-final-evaluation-details"><summary>Ver métricas probabilísticas <span>Brier e Log Loss</span></summary><div class="probability-final-evaluation-events">${eventCards}</div><p>O Brier Score mede a distância entre a probabilidade publicada e o desfecho observado. O Log Loss pune previsões excessivamente confiantes que terminam erradas. Em ambos, valores menores indicam melhor desempenho.</p></details>
    </section>`;
  }

  function renderProbabilities() {
    renderProbabilityStatus();
    renderProbabilityHighlights();
    renderPointsThresholds();
    renderProbabilityControls();
    renderProbabilityRanking();
    renderProbabilityDetails();
    renderProbabilityAudit();
    renderProbabilityEvaluation();
  }

  function activateTab(tab, updateHash = true) {
    state.tab = tab;
    qsa("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    qsa("[data-view]").forEach((view) => {
      const active = view.dataset.view === tab;
      view.classList.toggle("active", active);
      view.hidden = !active;
    });
    if (updateHash) history.replaceState(null, "", `#${tab}`);
    if (tab === "jogos") {
      renderGameFilter();
      renderGames();
    } else if (tab === "campeonato") {
      renderChampionship();
    } else if (tab === "probabilidades") {
      renderProbabilities();
    } else if (tab === "desempenho") {
      renderRanking();
    }
  }

  function openGame(eventId) {
    const game = gameById(eventId);
    if (!game) return;
    state.clubFilter = "";
    state.gamesLimit = Math.max(10, sortedResults().findIndex((row) => String(row.event_id || row.id || "") === String(eventId)) + 1);
    activateTab("jogos");
    requestAnimationFrame(() => {
      const safeId = String(eventId).replace(/[^a-zA-Z0-9_-]/g, "");
      const element = document.querySelector(`[data-game-id="${safeId}"]`);
      if (element) {
        element.open = true;
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  function bindEvents() {
    qsa("[data-tab]").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tab)));
    document.addEventListener("change", (event) => {
      const clubSelect = event.target.closest("[data-probability-history-club]");
      if (clubSelect) {
        state.probabilityHistoryClub = clubSelect.value;
        renderProbabilityEvolution();
        return;
      }
      const metricSelect = event.target.closest("[data-probability-history-metric]");
      if (metricSelect) {
        state.probabilityHistoryMetric = metricSelect.value;
        renderProbabilityEvolution();
        return;
      }
      const rankingCompare = event.target.closest("[data-ranking-compare-slot]");
      if (rankingCompare) {
        const slot = Number(rankingCompare.dataset.rankingCompareSlot);
        if (Number.isInteger(slot) && slot >= 0 && slot < state.rankingCompare.length) {
          state.rankingCompare[slot] = rankingCompare.value;
          renderRanking();
        }
        return;
      }
      const attendanceClub = event.target.closest("[data-attendance-club]");
      if (attendanceClub) {
        state.attendanceClub = attendanceClub.value;
        state.expanded.publico = false;
        renderChampionship();
        return;
      }
      const attendanceScope = event.target.closest("[data-attendance-scope]");
      if (attendanceScope) {
        state.attendanceScope = ATTENDANCE_SCOPES.some((item) => item.key === attendanceScope.value) ? attendanceScope.value : "todos";
        state.expanded.publico = false;
        renderChampionship();
        return;
      }
      const attendanceSort = event.target.closest("[data-attendance-sort]");
      if (attendanceSort) {
        if (state.attendanceClub) {
          state.attendanceGameSort = ATTENDANCE_GAME_SORTS.some((item) => item.key === attendanceSort.value) ? attendanceSort.value : "publico_desc";
        } else {
          state.attendanceClubSort = ATTENDANCE_CLUB_SORTS.some((item) => item.key === attendanceSort.value) ? attendanceSort.value : "average_desc";
        }
        state.expanded.publico = false;
        renderChampionship();
      }
    });
    document.addEventListener("click", (event) => {
      const expand = event.target.closest("[data-expand-list]");
      if (expand) {
        const type = expand.dataset.expandList;
        state.expanded[type] = !state.expanded[type];
        renderPlayers(type);
        return;
      }
      const attendanceClubRow = event.target.closest("[data-attendance-select-club]");
      if (attendanceClubRow) {
        state.attendanceClub = attendanceClubRow.dataset.attendanceSelectClub || "";
        state.expanded.publico = false;
        renderChampionship();
        return;
      }
      const attendance = event.target.closest("[data-expand-attendance]");
      if (attendance) {
        state.expanded.publico = !state.expanded.publico;
        renderChampionship();
        return;
      }
      const rankingMetric = event.target.closest("[data-ranking-metric]");
      if (rankingMetric) {
        state.rankingMetric = performanceMetricConfig(rankingMetric.dataset.rankingMetric).key;
        renderRanking();
        return;
      }
      const compareToggle = event.target.closest("[data-ranking-compare-toggle]");
      if (compareToggle) {
        state.rankingCompareOpen = !state.rankingCompareOpen;
        if (state.rankingCompareOpen && state.rankingCompare.filter(Boolean).length < 2) {
          const first = sortedPerformanceRanking().slice(0, 2).map((club) => club.time);
          state.rankingCompare = [first[0] || "", first[1] || "", ""];
        }
        renderRanking();
        return;
      }
      const probabilityInlineToggle = event.target.closest("[data-probability-inline-toggle]");
      if (probabilityInlineToggle) {
        event.preventDefault();
        const club = probabilityInlineToggle.dataset.probabilityInlineToggle || "";
        state.probabilityInlineClub = normalize(state.probabilityInlineClub) === normalize(club) ? "" : club;
        renderProbabilityRanking();
        return;
      }
      const probabilityInlineClose = event.target.closest("[data-probability-inline-close]");
      if (probabilityInlineClose) {
        event.preventDefault();
        const club = probabilityInlineClose.dataset.probabilityInlineClose || state.probabilityInlineClub || "";
        state.probabilityInlineClub = "";
        renderProbabilityRanking();
        requestAnimationFrame(() => {
          const toggle = qsa("[data-probability-inline-toggle]").find((item) => normalize(item.dataset.probabilityInlineToggle) === normalize(club));
          toggle?.focus({ preventScroll: true });
          toggle?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        });
        return;
      }
      const probabilityInlineMore = event.target.closest("[data-probability-inline-more]");
      if (probabilityInlineMore) {
        event.preventDefault();
        const club = probabilityInlineMore.dataset.probabilityInlineMore || "";
        const cardId = probabilityCardId(club);
        history.replaceState(null, "", `#${cardId}`);
        document.getElementById(cardId)?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const probabilityMethod = event.target.closest("[data-probability-method]");
      if (probabilityMethod) {
        event.preventDefault();
        history.replaceState(null, "", "#metodologia-probabilidades");
        $("metodologia-probabilidades")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const probabilityTop = event.target.closest("[data-probability-top]");
      if (probabilityTop) {
        event.preventDefault();
        history.replaceState(null, "", "#probabilidades");
        $("topo-probabilidades")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const game = event.target.closest("[data-open-game]");
      if (game) openGame(game.dataset.openGame);
    });
  }

  function renderAll() {
    renderPlayers("artilheiros");
    renderPlayers("assistencias");
    renderClubGoals();
    renderRanking();
    renderProbabilities();
    renderChampionship();
    renderGameFilter();
    renderGames();
    activateTab(state.tab, false);
  }

  // ────────────────────────────────────────────────────────────────────
  // CARGA DE DADOS E ATUALIZAÇÃO AUTOMÁTICA
  //
  // O conjunto completo pesa ~5,8 MB (jogos-detalhes.json sozinho tem 2,8 MB).
  // Rebaixar tudo a cada 30 s consumiria ~700 MB/hora por aba aberta, então a
  // verificação periódica lê apenas duas sentinelas leves e só recarrega o
  // conjunto quando elas indicam que os dados realmente mudaram:
  //   • status-atualizacao.json  → snapshot_hash cobre tabela, resultados,
  //     jogos e espn_eventos (o estado esportivo);
  //   • auditoria-probabilidades.json → gerado_em e hash_entrada cobrem o
  //     modelo AF-Previsão, que o snapshot_hash não alcança.
  // ────────────────────────────────────────────────────────────────────

  function assinaturaDados(statusPartidas, auditoriaProbabilidades, auditoriaContinental) {
    const s = statusPartidas || {};
    const a = auditoriaProbabilidades || {};
    const c = auditoriaContinental || {};
    return [
      s.snapshot_hash || "",
      s.ultimo_snapshot_valido || "",
      s.ultimo_sucesso || "",
      a.hash_entrada || "",
      a.gerado_em || "",
      c.hash_estado_depois || "",
      c.gerado_em || "",
    ].join("|");
  }

  async function carregarDados() {
    const [leaders, competition, details, ranking, rankingHistory, table, results, schedule, audit, probabilities, probabilitiesAudit, probabilitiesHistory, probabilityModelsAudit, probabilityEvaluation, pointsThresholds, updateStatus, continentalAudit] = await Promise.all([
      fetchJson(FILES.leaders, { status: "aguardando_workflow", artilharia: [], assistencias: [] }),
      fetchJson(FILES.competition, { resumo: {}, performance_por_partida: {}, sequencias: {}, publico: {}, gols_por_clube: [], jogos: [] }),
      fetchJson(FILES.details, { jogos: {} }),
      fetchJson(FILES.ranking, { ranking: [] }),
      fetchJson(FILES.rankingHistory, { total_snapshots: 0, snapshots: [] }),
      fetchJson(FILES.table, { tabela: [] }),
      fetchJson(FILES.results, { resultados: [] }),
      fetchJson(FILES.schedule, { jogos: [] }),
      fetchJson(FILES.audit, { status: "aguardando_workflow" }),
      fetchJson(FILES.probabilities, { status: "aguardando_workflow", clubes: [], partidas_restantes: [] }),
      fetchJson(FILES.probabilitiesAudit, { status: "aguardando_workflow" }),
      fetchJson(FILES.probabilitiesHistory, { total_snapshots: 0, snapshots: [] }),
      fetchJson(FILES.probabilityModelsAudit, { status: "aguardando_workflow" }),
      fetchJson(FILES.probabilityEvaluation, { status: "aguardando_primeira_execucao", publicar_na_interface: false }),
      fetchJson(FILES.pointsThresholds, { status: "aguardando_workflow", niveis: [] }),
      fetchJson(FILES.updateStatus, {}),
      fetchJson(FILES.continentalAudit, { status: "aguardando_workflow", competicoes: [] }),
    ]);

    state.leaders = leaders;
    state.competition = competition;
    state.details = details;
    state.ranking = ranking;
    state.rankingHistory = rankingHistory;
    state.table = table;
    state.results = results;
    state.schedule = schedule;
    state.audit = audit;
    state.probabilities = probabilities;
    state.probabilitiesAudit = probabilitiesAudit;
    state.probabilitiesHistory = probabilitiesHistory;
    state.probabilityModelsAudit = probabilityModelsAudit;
    state.probabilityEvaluation = probabilityEvaluation;
    state.pointsThresholds = pointsThresholds;
    state.updateStatus = updateStatus;
    state.continentalAudit = continentalAudit;

    // A assinatura é semeada com os mesmos bytes que acabaram de ser aplicados
    // na tela, e não numa leitura posterior. Sem isso, uma publicação ocorrida
    // entre a carga e a primeira verificação passaria despercebida.
    refreshState.assinatura = assinaturaDados(updateStatus, probabilitiesAudit, continentalAudit);
  }

  async function verificarAtualizacao() {
    if (refreshState.ocupado || document.hidden) return;
    refreshState.ocupado = true;
    try {
      const [statusPartidas, auditoriaProbabilidades, auditoriaContinental] = await Promise.all([
        fetchJson(FILES.updateStatus, null),
        fetchJson(FILES.probabilitiesAudit, null),
        fetchJson(FILES.continentalAudit, null),
      ]);
      // Falha de rede devolve null nas sentinelas: nada a comparar, tenta de novo depois.
      if (!statusPartidas && !auditoriaProbabilidades && !auditoriaContinental) return;

      const nova = assinaturaDados(statusPartidas, auditoriaProbabilidades, auditoriaContinental);
      if (!refreshState.assinatura || nova === refreshState.assinatura) return;

      // Dados mudaram de fato. Preserva a rolagem porque renderAll() reescreve
      // o conteúdo dos painéis e a altura da página pode variar.
      const rolagem = window.scrollY;
      await carregarDados();
      renderAll();
      window.scrollTo(0, rolagem);
    } catch (error) {
      console.warn("Estatísticas: atualização automática indisponível agora:", error);
    } finally {
      refreshState.ocupado = false;
      clearTimeout(refreshState.timer);
      refreshState.timer = setTimeout(verificarAtualizacao, REFRESH_MS);
    }
  }

  function armarAtualizacaoAutomatica() {
    clearTimeout(refreshState.timer);
    refreshState.timer = setTimeout(verificarAtualizacao, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      clearTimeout(refreshState.timer);
      verificarAtualizacao();
    });
  }

  function liveSignature(liveMap) {
    return Object.values(liveMap || {})
      .map((game) => [game.eventId || "", game.estado || "", game.placarMandante ?? "", game.placarVisitante ?? "", game.status || ""].join(":"))
      .sort()
      .join("|");
  }

  function liveWindowActive() {
    const engine = window.BRClassificacaoLive;
    if (!engine) return false;
    return engine.isWindowActive(
      Array.isArray(state.schedule?.jogos) ? state.schedule.jogos : [],
      state.espnLive || {},
      new Date(),
      20,
      150,
    );
  }

  async function refreshLiveStandings(options = {}) {
    const engine = window.BRClassificacaoLive;
    if (!engine || liveRefreshState.ocupado || document.hidden) return false;
    if (!options.force && !liveWindowActive()) return false;
    liveRefreshState.ocupado = true;
    try {
      const live = await engine.fetchScoreboard({ canonicalize: canonicalLiveTeam });
      const signature = liveSignature(live);
      const changed = signature !== liveRefreshState.assinatura;
      state.espnLive = live;
      state.espnLiveFetchedAt = new Date();
      state.espnLiveError = null;
      liveRefreshState.assinatura = signature;
      standingsCache.live = null;
      if (changed && options.render !== false) {
        renderProbabilityRanking();
        renderProbabilityDetails();
      }
      return changed;
    } catch (error) {
      // Falha momentânea da ESPN não apaga o último estado ao vivo válido.
      state.espnLiveError = String(error?.message || error || "falha ao consultar ESPN");
      console.warn("Estatísticas: classificação ao vivo temporariamente indisponível:", error);
      return false;
    } finally {
      liveRefreshState.ocupado = false;
    }
  }

  function armLiveRefresh() {
    clearTimeout(liveRefreshState.timer);
    const tick = async () => {
      if (!document.hidden && liveWindowActive()) await refreshLiveStandings();
      clearTimeout(liveRefreshState.timer);
      liveRefreshState.timer = setTimeout(tick, REFRESH_MS);
    };
    liveRefreshState.timer = setTimeout(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      clearTimeout(liveRefreshState.timer);
      refreshLiveStandings({ force: liveWindowActive() }).finally(() => {
        liveRefreshState.timer = setTimeout(tick, REFRESH_MS);
      });
    });
  }

  async function load() {
    bindEvents();
    const hashTab = location.hash.replace(/^#/, "");
    const openProbabilityMethod = hashTab === "metodologia-probabilidades";
    const abrirMetodologia = hashTab === "metodologia-ranking";
    if (openProbabilityMethod) state.tab = "probabilidades";
    else if (abrirMetodologia) state.tab = "desempenho";
    else if (["artilheiros", "jogos", "assistencias", "gols-clube", "campeonato", "probabilidades", "desempenho"].includes(hashTab)) state.tab = hashTab;

    await carregarDados();
    if (liveWindowActive()) await refreshLiveStandings({ force: true, render: false });
    renderAll();
    if (openProbabilityMethod) {
      requestAnimationFrame(() => $("metodologia-probabilidades")?.scrollIntoView({ behavior: "auto", block: "start" }));
    }
    if (abrirMetodologia) requestAnimationFrame(() => document.getElementById("metodologia-ranking")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    if (hashTab.startsWith("probabilidade-")) {
      requestAnimationFrame(() => document.getElementById(hashTab)?.scrollIntoView({ behavior: "auto", block: "start" }));
    }
    armarAtualizacaoAutomatica();
    armLiveRefresh();
  }

  document.addEventListener("DOMContentLoaded", load);
})();
