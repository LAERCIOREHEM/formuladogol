(function () {
  "use strict";

  const ARQUIVOS = {
    estatisticas: "dados-br/estatisticas.json",
    ranking: "dados-br/ranking-desempenho.json",
    jogadores: "dados-br/jogadores.json",
    tabela: "tabela.json",
    resultados: "resultados.json",
  };

  const state = {
    estatisticas: null,
    ranking: null,
    jogadores: null,
    tabela: null,
    resultados: null,
    filtro: "",
  };

  const $ = (id) => document.getElementById(id);
  const cacheBust = () => `v=${Date.now()}`;

  function normalizarNome(nome) {
    return String(nome || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function escudoFallback(nome) {
    const iniciais = String(nome || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?";
    return `<span class="escudo-fallback" aria-hidden="true">${escapeHtml(iniciais)}</span>`;
  }

  function imgEscudo(time, cls = "escudo-inline") {
    if (!time) return "";
    const nome = typeof time === "string" ? time : (time.time || time.nome || "");
    const escudo = typeof time === "object" ? (time.escudo || "") : "";
    if (!escudo) return escudoFallback(nome);
    return `<img class="${cls}" src="${escapeAttr(escudo)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
  }

  function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  }

  function escapeAttr(v) {
    return escapeHtml(v).replace(/`/g, "&#96;");
  }

  async function fetchJson(url, fallback = null) {
    const sep = url.includes("?") ? "&" : "?";
    try {
      const resp = await fetch(`${url}${sep}${cacheBust()}`, { cache: "no-store" });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      return await resp.json();
    } catch (err) {
      console.warn("Falha ao carregar", url, err);
      if (fallback !== null) return fallback;
      throw err;
    }
  }

  function dataHoraBR(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function numero(n, sufixo = "") {
    if (n === null || n === undefined || n === "") return "—";
    const val = Number(n);
    if (!Number.isFinite(val)) return String(n);
    return `${val.toLocaleString("pt-BR")}${sufixo}`;
  }

  function clubeLista() {
    const clubes = (state.estatisticas?.clubes || []).slice();
    if (clubes.length) return clubes;
    return (state.tabela?.tabela || []).map((t) => ({
      time: t.time,
      escudo: t.escudo || "",
      sigla: t.sigla || "",
      pos: t.pos,
      pontos: t.pontos,
      jogos: t.jogos,
      gp: t.gp,
      gc: t.gc,
      sg: t.sg,
      aproveitamento: t.aproveitamento,
      forma_ultimos5: [],
    }));
  }

  function timeSelecionado(item) {
    if (!state.filtro) return true;
    const time = item?.time || item?.clube || item?.nome || item?.equipe || "";
    return normalizarNome(time) === normalizarNome(state.filtro);
  }

  function filtrarPorClube(lista) {
    if (!state.filtro) return lista || [];
    return (lista || []).filter(timeSelecionado);
  }

  function resumoCard(label, value, sub) {
    return `<div class="summary-card"><div class="summary-label">${escapeHtml(label)}</div><div class="summary-value">${value || "—"}</div><div class="summary-sub">${escapeHtml(sub || "")}</div></div>`;
  }

  function renderResumo() {
    const e = state.estatisticas || {};
    const resumo = e.resumo || {};
    const ataque = resumo.melhor_ataque || (e.melhor_ataque || [])[0] || {};
    const defesa = resumo.melhor_defesa || (e.melhor_defesa || [])[0] || {};
    const alta = resumo.time_em_alta || (state.ranking?.ranking || [])[0] || {};
    const lider = resumo.lider_geral || (clubeLista().find((c) => Number(c.pos) === 1) || clubeLista()[0] || {});
    const artilharia = listaArtilharia();
    const assistencias = listaAssistencias();
    const participacoes = state.jogadores?.participacoes_gol || [];
    const artilheiro = artilharia[0] || {};
    const garcom = assistencias[0] || {};
    const destaquePart = participacoes[0] || {};

    const cards = [
      resumoCard("Líder", escapeHtml(lider.time || "—"), `${numero(lider.pontos)} pts · ${numero(lider.aproveitamento, "%")}`),
      resumoCard("Melhor ataque", escapeHtml(ataque.time || "—"), `${numero(ataque.gp)} gols pró`),
      resumoCard("Melhor defesa", escapeHtml(defesa.time || "—"), `${numero(defesa.gc)} gols contra`),
      resumoCard("Time em alta", escapeHtml(alta.time || "—"), `${numero(alta.score)} pts no índice`),
      resumoCard("Artilheiro", escapeHtml(artilheiro.nome || "em coleta"), artilheiro.time ? `${artilheiro.time} · ${numero(artilheiro.gols)} gols` : "aguardando summaries ESPN"),
      resumoCard("Garçom", escapeHtml(garcom.nome || "em coleta"), garcom.time ? `${garcom.time} · ${numero(garcom.assistencias)} assist.` : "aguardando summaries ESPN"),
    ];
    $("cards-resumo").innerHTML = cards.join("");

    const atualizado = e.atualizado_em || state.ranking?.atualizado_em || state.tabela?.atualizado_em;
    const eventos = state.jogadores?.total_summaries_processados || e.eventos_processados?.length || e.total_eventos_processados || 0;
    $("meta-line").innerHTML = [
      `<span class="meta-pill">Atualizado: ${escapeHtml(dataHoraBR(atualizado))}</span>`,
      `<span class="meta-pill">Fonte: ${escapeHtml(e.fonte || "JSON local")}</span>`,
      `<span class="meta-pill">Eventos detalhados: ${numero(eventos)}</span>`,
    ].join("");
  }

  function renderChips() {
    const clubes = clubeLista().slice().sort((a, b) => normalizarNome(a.time).localeCompare(normalizarNome(b.time)));
    const atual = state.filtro ? clubes.find((c) => normalizarNome(c.time) === normalizarNome(state.filtro)) : null;
    const descricao = atual
      ? `${numero(atual.pontos)} pts · ${numero(atual.jogos)} jogos · SG ${numero(atual.sg)} · ${numero(atual.aproveitamento, "%")}`
      : "Mostrando artilharia, assistências, ataque/defesa e desempenho de todos os clubes.";

    const options = [`<option value="" ${!state.filtro ? "selected" : ""}>Todos os clubes</option>`]
      .concat(clubes.map((c) => `<option value="${escapeAttr(c.time)}" ${normalizarNome(c.time) === normalizarNome(state.filtro) ? "selected" : ""}>${escapeHtml(c.time)}</option>`))
      .join("");

    const currentShield = atual
      ? imgEscudo(atual, "stats-filter-shield-img")
      : `<span class="stats-filter-fallback">BR</span>`;

    $("club-chips").innerHTML = `
      <div class="stats-filter-panel">
        <div class="stats-filter-select-card">
          <label class="stats-filter-label" for="select-filtro-estatisticas">Selecionar clube</label>
          <select id="select-filtro-estatisticas" class="stats-filter-select">${options}</select>
        </div>
        <div class="stats-filter-current-card">
          <div class="stats-filter-team">
            ${currentShield}
            <div>
              <div class="stats-filter-title">${escapeHtml(atual?.time || "Todos os clubes")}</div>
              <div class="stats-filter-note">${escapeHtml(descricao)}</div>
            </div>
          </div>
          ${state.filtro ? `<button class="btn secondary stats-filter-clear" type="button" data-clear="1">Limpar</button>` : ""}
        </div>
      </div>
      <div class="stats-mini-strip" aria-label="Atalhos rápidos de clubes">
        <button class="stats-mini-club ${!state.filtro ? "active" : ""}" type="button" data-time="" title="Todos">BR</button>
        ${clubes.map((c) => `<button class="stats-mini-club ${normalizarNome(c.time) === normalizarNome(state.filtro) ? "active" : ""}" type="button" data-time="${escapeAttr(c.time)}" title="${escapeAttr(c.time)}">${imgEscudo(c)}</button>`).join("")}
      </div>
    `;

    const select = $("select-filtro-estatisticas");
    if (select) {
      select.addEventListener("change", () => {
        state.filtro = select.value || "";
        renderTudo();
      });
    }
    $("club-chips").querySelectorAll("[data-time]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filtro = btn.getAttribute("data-time") || "";
        renderTudo();
      });
    });
    $("club-chips").querySelector("[data-clear]")?.addEventListener("click", () => {
      state.filtro = "";
      renderTudo();
    });

    const limpar = $("btn-limpar-filtro");
    if (limpar) {
      limpar.textContent = state.filtro ? "Limpar filtro" : "Todos";
      limpar.disabled = !state.filtro;
    }
  }

  function listaArtilharia() {
    return state.jogadores?.artilharia?.length ? state.jogadores.artilharia : (state.estatisticas?.artilharia || []);
  }

  function listaAssistencias() {
    return state.jogadores?.assistencias?.length ? state.jogadores.assistencias : (state.estatisticas?.garcons || []);
  }

  function playerFoto(p) {
    const foto = p?.foto || p?.headshot || "";
    if (foto) {
      return `<img class="player-photo" src="${escapeAttr(foto)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'player-photo-fallback',textContent:'${escapeAttr(iniciaisPessoa(p?.nome || '?'))}'}))">`;
    }
    return `<span class="player-photo-fallback" aria-hidden="true">${escapeHtml(iniciaisPessoa(p?.nome || "?"))}</span>`;
  }

  function iniciaisPessoa(nome) {
    return String(nome || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?";
  }

  function renderListaJogadores(id, lista, tipo) {
    const filtrada = filtrarPorClube(lista || []);
    const fonte = state.jogadores?.fonte || state.estatisticas?.fonte || "ESPN";
    if (!filtrada.length) {
      const msg = tipo === "gols"
        ? "Artilharia sem jogadores publicados ainda. Rode o workflow Atualizar Brasileirao (ESPN): ele busca o summary de cada jogo encerrado e preenche este ranking automaticamente quando a ESPN entregar os eventos de gol."
        : "Assistências sem jogadores publicados ainda. O robô da Execução 8 procura assistências nos summaries da ESPN; quando a fonte não informa, a página mantém aviso claro e não inventa dados.";
      $(id).innerHTML = `<div class="empty-state"><strong>${tipo === "gols" ? "Coleta de artilharia" : "Coleta de assistências"}</strong><br>${escapeHtml(msg)}<br><span class="mini-source">Fonte configurada: ${escapeHtml(fonte)}</span></div>`;
      return;
    }
    $(id).innerHTML = `<div class="stat-list player-stat-list">${filtrada.slice(0, 25).map((p, i) => {
      const valor = tipo === "gols" ? p.gols : p.assistencias;
      return `<div class="player-row rich">
        <div class="player-rank">${i + 1}</div>
        ${playerFoto(p)}
        <div class="player-main">
          <div class="player-name">${escapeHtml(p.nome || p.name || "—")}</div>
          <div class="player-sub">${imgEscudo(p)}<span>${escapeHtml(p.time || "—")}</span>${p.eventos ? `<span>${numero(p.eventos)} jogo(s) com participação</span>` : ""}${p.athlete_id ? `<span>ID ESPN ${escapeHtml(p.athlete_id)}</span>` : ""}</div>
        </div>
        <div class="player-value">${numero(valor)}<small>${tipo === "gols" ? "gols" : "assist."}</small></div>
      </div>`;
    }).join("")}</div>`;
  }

  function formaHtml(forma) {
    const f = Array.isArray(forma) ? forma : [];
    if (!f.length) return `<span class="forma"><span class="meta-pill">sem dados</span></span>`;
    return `<span class="forma">${f.slice(-5).map((x) => {
      const l = String(x || "").toUpperCase()[0];
      const cls = l === "V" ? "v" : l === "E" ? "e" : "d";
      return `<span class="form-dot ${cls}">${escapeHtml(l)}</span>`;
    }).join("")}</span>`;
  }

  function renderRankingDesempenho() {
    const ranking = filtrarPorClube(state.ranking?.ranking || state.estatisticas?.ranking_desempenho || []);
    if (!ranking.length) {
      $("ranking-desempenho").innerHTML = `<div class="empty-state">Ranking de desempenho ainda não gerado. Rode o workflow do Brasileirão ou o script <strong>scripts/gerar_estatisticas_brasileirao.py</strong>.</div>`;
      return;
    }
    $("ranking-desempenho").innerHTML = ranking.slice(0, state.filtro ? 20 : 10).map((c) => `
      <div class="club-row">
        <div class="club-rank">${numero(c.pos)}</div>
        <div class="club-main">
          <div class="club-name">${imgEscudo(c)} ${escapeHtml(c.time)}</div>
          <div class="club-sub">${formaHtml(c.forma_ultimos5 || c.forma)}<span>${numero(c.pontos)} pts</span><span>${numero(c.aproveitamento, "%")}</span><span>SG ${numero(c.sg)}</span></div>
          <div class="justificativa">${escapeHtml(c.justificativa || "Índice pondera tabela, aproveitamento, saldo e forma recente.")}</div>
        </div>
        <div class="club-score">${numero(c.score)}<small>índice</small></div>
      </div>
    `).join("");
  }

  function renderAtaqueDefesa() {
    const e = state.estatisticas || {};
    const ataque = filtrarPorClube(e.melhor_ataque || clubeLista().slice().sort((a, b) => Number(b.gp || 0) - Number(a.gp || 0)));
    const defesa = filtrarPorClube(e.melhor_defesa || clubeLista().slice().sort((a, b) => Number(a.gc || 0) - Number(b.gc || 0)));
    const linhas = (titulo, lista, campo, sufixo) => `
      <h3>${titulo}</h3>
      <table class="table-mini"><thead><tr><th>Time</th><th>J</th><th class="num">${sufixo}</th><th class="num">Média</th></tr></thead><tbody>
        ${lista.slice(0, 8).map((c) => {
          const jogos = Number(c.jogos || 0);
          const val = Number(c[campo] || 0);
          return `<tr><td>${imgEscudo(c)} ${escapeHtml(c.time)}</td><td>${numero(jogos)}</td><td class="num">${numero(val)}</td><td class="num">${jogos ? (val / jogos).toFixed(2).replace(".", ",") : "—"}</td></tr>`;
        }).join("")}
      </tbody></table>`;
    $("ataque-defesa").innerHTML = `${linhas("Melhor ataque", ataque, "gp", "GP")}${linhas("Melhor defesa", defesa, "gc", "GC")}`;
  }

  function renderClubesDetalhes() {
    const clubes = filtrarPorClube(clubeLista());
    if (!clubes.length) {
      $("clubes-detalhes").innerHTML = `<div class="empty-state">Nenhum clube encontrado para o filtro atual.</div>`;
      return;
    }
    $("clubes-detalhes").innerHTML = clubes.map((c) => {
      const mand = c.mandante || {};
      const vis = c.visitante || {};
      const seq = c.sequencia?.texto || "sequência em apuração";
      return `<article class="club-detail">
        <div class="club-detail-head">${imgEscudo(c, "escudo-inline")}<div><div class="club-detail-title">${escapeHtml(c.time)}</div><div class="club-sub">${formaHtml(c.forma_ultimos5)} <span>${escapeHtml(seq)}</span></div></div></div>
        <div class="metrics-grid">
          <div class="metric"><strong>${numero(c.pos)}º</strong><span>posição</span></div>
          <div class="metric"><strong>${numero(c.pontos)}</strong><span>pontos</span></div>
          <div class="metric"><strong>${numero(c.aproveitamento, "%")}</strong><span>aproveit.</span></div>
          <div class="metric"><strong>${numero(c.sg)}</strong><span>saldo</span></div>
          <div class="metric"><strong>${numero(mand.aproveitamento, "%")}</strong><span>casa</span></div>
          <div class="metric"><strong>${numero(vis.aproveitamento, "%")}</strong><span>fora</span></div>
          <div class="metric"><strong>${numero(c.gp)}</strong><span>gols pró</span></div>
          <div class="metric"><strong>${numero(c.gc)}</strong><span>gols contra</span></div>
        </div>
      </article>`;
    }).join("");
  }

  function renderAvisos() {
    const avisos = [].concat(state.estatisticas?.avisos || [], state.jogadores?.avisos || []);
    if (!avisos.length) {
      $("avisos-panel").hidden = true;
      return;
    }
    $("avisos-panel").hidden = false;
    $("avisos").innerHTML = avisos.map((a) => `<div class="aviso">${escapeHtml(a)}</div>`).join("");
  }

  function renderTudo() {
    renderResumo();
    renderChips();
    renderListaJogadores("lista-artilharia", listaArtilharia(), "gols");
    renderListaJogadores("lista-garcons", listaAssistencias(), "assistencias");
    renderRankingDesempenho();
    renderAtaqueDefesa();
    renderClubesDetalhes();
    renderAvisos();
  }

  function configurarBotoes() {
    $("btn-limpar-filtro").addEventListener("click", () => {
      state.filtro = "";
      renderTudo();
    });
    document.querySelectorAll("a[data-anchor]").forEach((a) => {
      a.addEventListener("click", (ev) => {
        const anchor = a.getAttribute("data-anchor");
        if (!anchor) return;
        ev.preventDefault();
        const mapa = { rank: "rank", tabela: "tabela", resultados: "resultados" };
        sessionStorage.setItem("brViewInicial", mapa[anchor] || anchor);
        location.href = "./?brasileirao=1";
      });
    });
  }

  async function carregar() {
    configurarBotoes();
    try {
      const [estatisticas, ranking, jogadores, tabela, resultados] = await Promise.all([
        fetchJson(ARQUIVOS.estatisticas, { clubes: [], artilharia: [], garcons: [], avisos: ["dados-br/estatisticas.json ainda não foi publicado."] }),
        fetchJson(ARQUIVOS.ranking, { ranking: [] }),
        fetchJson(ARQUIVOS.jogadores, { artilharia: [], assistencias: [], participacoes_gol: [], avisos: ["dados-br/jogadores.json ainda não foi publicado."] }),
        fetchJson(ARQUIVOS.tabela, { tabela: [] }),
        fetchJson(ARQUIVOS.resultados, { resultados: [] }),
      ]);
      state.estatisticas = estatisticas;
      state.ranking = ranking;
      state.jogadores = jogadores;
      state.tabela = tabela;
      state.resultados = resultados;
      renderTudo();
    } catch (err) {
      console.error(err);
      $("meta-line").innerHTML = `<span class="meta-pill">Erro ao carregar estatísticas</span>`;
      $("cards-resumo").innerHTML = `<div class="empty-state">Não foi possível carregar os JSONs de estatísticas. Confira se os arquivos da Execução 4 foram enviados e se o workflow do Brasileirão rodou.</div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", carregar);
})();
