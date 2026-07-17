(function () {
  "use strict";

  const FILES = {
    leaders: "dados-br/lideres-jogadores.json",
    competition: "dados-br/estatisticas-competicao.json",
    details: "dados-br/jogos-detalhes.json",
    ranking: "dados-br/ranking-desempenho.json",
    table: "tabela.json",
    results: "resultados.json",
    audit: "dados-br/auditoria-estatisticas.json",
  };

  const state = {
    leaders: null,
    competition: null,
    details: null,
    ranking: null,
    table: null,
    results: null,
    audit: null,
    tab: "artilheiros",
    expanded: { artilheiros: false, assistencias: false, publico: false },
    expandedClubGoals: {},
    clubFilter: "",
    gamesLimit: 10,
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
    tableRows().forEach((team) => map.set(normalize(team.time), team));
    resultsRows().forEach((game) => {
      [game.mandante, game.visitante].forEach((team) => {
        if (team?.nome && !map.has(normalize(team.nome))) map.set(normalize(team.nome), team);
      });
    });
    return map;
  }

  function teamInfo(name) {
    return teamMap().get(normalize(name)) || { time: name || "", nome: name || "", escudo: "", sigla: "" };
  }

  function teamName(obj) {
    return String(obj?.time || obj?.nome || obj || "");
  }

  function initials(name) {
    return String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";
  }

  function shield(obj, cls = "stats-shield") {
    const name = teamName(obj);
    const src = typeof obj === "object" ? String(obj?.escudo || "") : String(teamInfo(name)?.escudo || "");
    if (!src) return `<span class="stats-shield-fallback ${escapeAttr(cls)}">${escapeHtml(initials(name))}</span>`;
    return `<img class="${escapeAttr(cls)}" src="${escapeAttr(src)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
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

  function summaryCard(icon, label, primary, secondary, team) {
    const logo = team ? shield(team, "summary-shield") : `<span class="summary-icon">${icon}</span>`;
    return `<article class="stats-summary-card">
      <div class="stats-summary-label">${logo}<span>${escapeHtml(label)}</span></div>
      <div class="stats-summary-primary">${escapeHtml(primary || "Aguardando dados")}</div>
      <div class="stats-summary-secondary">${escapeHtml(secondary || "")}</div>
    </article>`;
  }

  function renderSummary() {
    const scorer = leadersValid() ? state.leaders.artilharia[0] : null;
    const assistant = leadersValid() ? state.leaders.assistencias[0] : null;
    const attacks = Array.isArray(state.competition?.gols_por_clube) && state.competition.gols_por_clube.length
      ? state.competition.gols_por_clube
      : tableRows().slice().sort((a, b) => Number(b.gp || 0) - Number(a.gp || 0));
    const attack = attacks[0] || null;
    const rank = Array.isArray(state.ranking?.ranking) ? state.ranking.ranking[0] : null;

    $("cards-resumo").innerHTML = [
      summaryCard("⚽", "Artilheiro", scorer?.nome, scorer ? `${scorer.time} · ${integer(scorer.gols)} gols` : "Ranking oficial ainda não atualizado", scorer),
      summaryCard("🎯", "Garçom", assistant?.nome, assistant ? `${assistant.time} · ${integer(assistant.assistencias)} assist.` : "Ranking oficial ainda não atualizado", assistant),
      summaryCard("🥅", "Melhor ataque", attack?.time, attack ? `${integer(attack.gols_pro ?? attack.gp)} gols` : "Aguardando consolidado", attack),
      summaryCard("⚡", "Ranking", rank?.time, rank ? `Índice ${number(rank.indice_final ?? rank.score, 1)}` : "Aguardando ranking", rank),
    ].join("");
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
    target.innerHTML = `<div class="stats-player-list">${shown.map((player, index) => {
      const games = Number(player.jogos);
      const value = Number(player[field] || 0);
      const average = Number.isFinite(games) && games > 0 ? `${number(value / games, 2)} por jogo` : "Jogos não informados";
      return `<article class="stats-player-row">
        <div class="stats-rank">${integer(player.posicao || index + 1)}</div>
        <div class="stats-avatar">${escapeHtml(initials(player.nome))}</div>
        <div class="stats-player-main">
          <div class="stats-player-name">${escapeHtml(player.nome)}</div>
          <div class="stats-player-club">${shield(player, "stats-mini-shield")}<span>${escapeHtml(player.time)}</span></div>
          <div class="stats-player-meta">${Number.isFinite(games) ? `${integer(games)} jogos · ` : ""}${escapeHtml(average)}</div>
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
    $("filtro-jogos").innerHTML = `<div class="stats-game-filter">
      <div class="stats-filter-control">
        <label for="stats-club-filter">Clube</label>
        <select id="stats-club-filter">
          <option value="">Todos os clubes</option>
          ${clubs.map((club) => `<option value="${escapeAttr(club.time)}" ${normalize(club.time) === normalize(selected) ? "selected" : ""}>${escapeHtml(club.time)}</option>`).join("")}
        </select>
      </div>
      <div class="stats-filter-current">
        ${selected ? shield(info, "stats-filter-shield") : `<span class="stats-filter-all">BR</span>`}
        <div><strong>${escapeHtml(selected || "Todos os clubes")}</strong><span>${integer(games.length)} partida(s) encontrada(s)</span></div>
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
    const goals = uniqueEvents(detail.gols, "goal");
    const cards = uniqueEvents(detail.cartoes, "card");
    return `<details class="stats-game-card" data-game-id="${escapeAttr(game.event_id || game.id || "")}">
      <summary>
        <span class="stats-game-round">R${escapeHtml(game.rodada || detail.rodada || "—")}</span>
        <div class="stats-game-summary-main">
          <div class="stats-game-date">${escapeHtml(dateBR(game.data_iso || detail.data_iso))}</div>
          <div class="stats-game-teams">
            <span>${shield(home, "stats-game-shield")} ${escapeHtml(teamName(home))}</span>
            <b>${escapeHtml(matchScore(game))}</b>
            <span>${escapeHtml(teamName(away))} ${shield(away, "stats-game-shield")}</span>
          </div>
          <div class="stats-game-quick">${detail.estadio ? `📍 ${escapeHtml(detail.estadio)}` : ""}${Number.isFinite(crowd) && crowd > 0 ? ` · 👥 ${integer(crowd)}` : ""}</div>
        </div>
        <span class="stats-game-chevron">⌄</span>
      </summary>
      <div class="stats-game-body">
        <div class="stats-game-info-grid">
          <div><span>Estádio</span><strong>${escapeHtml(detail.estadio || game.estadio || "Não informado")}</strong></div>
          <div><span>Público</span><strong>${Number.isFinite(crowd) && crowd > 0 ? integer(crowd) : "Não informado"}</strong></div>
          <div><span>Árbitro</span><strong>${escapeHtml(detail.arbitro || "Não informado")}</strong></div>
        </div>
        ${(goals.length || cards.length) ? `<div class="stats-match-events">
          ${goals.length ? `<section><h4>Gols</h4><ul>${goals.map(eventLine).join("")}</ul></section>` : ""}
          ${cards.length ? `<section><h4>Cartões</h4><ul>${cards.map(cardLine).join("")}</ul></section>` : ""}
        </div>` : ""}
        ${statisticRows(detail)}
        <div class="stats-source-note">Fonte: ESPN; público complementado por fonte documental quando ausente. Nenhum campo é estimado.</div>
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
      return `<details class="stats-club-goals-card">
        <summary>
          <span class="stats-rank">${integer(club.posicao || index + 1)}</span>
          <a class="stats-club-shield-link" href="${escapeAttr(clubHref(club.time))}" title="Abrir página de ${escapeAttr(club.time)}" aria-label="Abrir página de ${escapeAttr(club.time)}" onclick="event.stopPropagation()">${shield(club, "stats-club-shield")}</a>
          <div class="stats-club-goals-main"><a href="${escapeAttr(clubHref(club.time))}" onclick="event.stopPropagation()"><strong>${escapeHtml(club.time)}</strong></a><span>${integer(club.jogos)} jogos · média ${number(club.media_gols, 2)}</span></div>
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

  function attendanceGameRow(game, index) {
    return `<button type="button" class="stats-attendance-row" data-open-game="${escapeAttr(game.event_id || "")}">
      <span>${integer(index + 1)}</span>
      <div><strong>${escapeHtml(game.mandante)} × ${escapeHtml(game.visitante)}</strong><small>R${escapeHtml(game.rodada || "—")} · ${escapeHtml(dateBR(game.data_iso))}</small></div>
      <b>${integer(game.publico)}</b>
    </button>`;
  }

  function renderChampionship() {
    const target = $("campeonato-conteudo");
    const performance = state.competition?.performance_por_partida || {};
    const attendance = state.competition?.publico || {};
    const ranking = Array.isArray(attendance.ranking) ? attendance.ranking : [];
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
      <div class="section-head"><div><div class="kicker">👥 Torcida</div><h2>Público</h2></div><span class="badge">Jogos com dado oficial</span></div>
      <div class="stats-attendance-summary">
        <div><span>Maior público</span><strong>${integer(attendance.maior_publico?.publico)}</strong></div>
        <div><span>Menor público</span><strong>${integer(attendance.menor_publico?.publico)}</strong></div>
        <div><span>Média</span><strong>${integer(attendance.media_publico)}</strong></div>
        <div><span>Total</span><strong>${integer(attendance.total_publico)}</strong></div>
        <div><span>Jogos informados</span><strong>${integer(attendance.jogos_com_publico)}</strong></div>
      </div>
      ${attendanceShown.length ? `<div class="stats-attendance-list">${attendanceShown.map(attendanceGameRow).join("")}</div>${ranking.length > 5 ? `<button class="stats-expand-btn" type="button" data-expand-attendance>${state.expanded.publico ? "Mostrar somente os 5 maiores ↑" : `Ver todos os públicos (${ranking.length}) ↓`}</button>` : ""}` : emptyState("As fontes consultadas ainda não disponibilizaram público para os jogos processados.")}
      <p class="stats-source-note">${escapeHtml(attendance.observacao || "Média calculada somente sobre partidas com público informado.")}</p>
    </div></section>`;
  }

  function metricBar(label, value) {
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    return `<div class="stats-performance-metric"><span>${escapeHtml(label)}</span><div><i style="width:${n.toFixed(1)}%"></i></div><strong>${number(n, 1)}</strong></div>`;
  }

  function renderRanking() {
    const target = $("ranking-desempenho");
    const ranking = Array.isArray(state.ranking?.ranking) ? state.ranking.ranking : [];
    if (!ranking.length) {
      target.innerHTML = emptyState("Ranking de desempenho ainda não disponível.");
      return;
    }
    target.innerHTML = `<div class="stats-performance-list">${ranking.map((club, index) => `<article class="stats-performance-card">
      <div class="stats-performance-head">
        <span class="stats-rank">${integer(club.pos || club.pos_ranking || index + 1)}</span>
        <a class="stats-performance-club-link" href="${escapeAttr(clubHref(club.time))}" title="Abrir página de ${escapeAttr(club.time)}" aria-label="Abrir página de ${escapeAttr(club.time)}">${shield(club, "stats-performance-shield")}</a>
        <div><a class="stats-performance-name-link" href="${escapeAttr(clubHref(club.time))}"><strong>${escapeHtml(club.time)}</strong></a><span>${integer(club.pontos)} pts · ${integer(club.pos_tabela)}º na tabela · SG ${integer(club.sg)}</span></div>
        <b>${number(club.indice_final ?? club.score, 1)}<small>índice</small></b>
      </div>
      <div class="stats-performance-bars">
        ${metricBar("Ataque", club.ataque)}
        ${metricBar("Defesa", club.defesa)}
        ${metricBar("Domínio", club.dominio)}
        ${metricBar("Eficiência", club.eficiencia)}
        ${metricBar("Disciplina", club.disciplina)}
      </div>
      <p>${escapeHtml(club.justificativa || "Índice calculado pelo site.")}</p>
    </article>`).join("")}</div>`;
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
    document.addEventListener("click", (event) => {
      const expand = event.target.closest("[data-expand-list]");
      if (expand) {
        const type = expand.dataset.expandList;
        state.expanded[type] = !state.expanded[type];
        renderPlayers(type);
        return;
      }
      const attendance = event.target.closest("[data-expand-attendance]");
      if (attendance) {
        state.expanded.publico = !state.expanded.publico;
        renderChampionship();
        return;
      }
      const game = event.target.closest("[data-open-game]");
      if (game) openGame(game.dataset.openGame);
    });
  }

  function renderAll() {
    renderSummary();
    renderPlayers("artilheiros");
    renderPlayers("assistencias");
    renderClubGoals();
    renderRanking();
    renderChampionship();
    renderGameFilter();
    renderGames();
    activateTab(state.tab, false);
  }

  async function load() {
    bindEvents();
    const hashTab = location.hash.replace(/^#/, "");
    const abrirMetodologia = hashTab === "metodologia-ranking";
    if (abrirMetodologia) state.tab = "desempenho";
    else if (["artilheiros", "jogos", "assistencias", "gols-clube", "campeonato", "desempenho"].includes(hashTab)) state.tab = hashTab;

    const [leaders, competition, details, ranking, table, results, audit] = await Promise.all([
      fetchJson(FILES.leaders, { status: "aguardando_workflow", artilharia: [], assistencias: [] }),
      fetchJson(FILES.competition, { resumo: {}, performance_por_partida: {}, sequencias: {}, publico: {}, gols_por_clube: [], jogos: [] }),
      fetchJson(FILES.details, { jogos: {} }),
      fetchJson(FILES.ranking, { ranking: [] }),
      fetchJson(FILES.table, { tabela: [] }),
      fetchJson(FILES.results, { resultados: [] }),
      fetchJson(FILES.audit, { status: "aguardando_workflow" }),
    ]);

    state.leaders = leaders;
    state.competition = competition;
    state.details = details;
    state.ranking = ranking;
    state.table = table;
    state.results = results;
    state.audit = audit;
    renderAll();
    if (abrirMetodologia) requestAnimationFrame(() => document.getElementById("metodologia-ranking")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  document.addEventListener("DOMContentLoaded", load);
})();
