
/* =========================================================================
   estatisticas.js — Artilheiros, assistências, gols por seleção e por jogo
   Copa 2026 — Fase 2 do módulo de estatísticas.
   - Mantém as 3 abas já existentes
   - Adiciona a aba "Por jogo" com raio-x das partidas
   - Reaproveita COPA_JOGO_STATS (já validado na fase 1)
   ========================================================================= */
(function () {
  "use strict";

  var API_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200";
  var DADOS = { atualizado_em: null, jogos_processados: 0, artilheiros: [], assistencias: [], por_selecao: [] };
  var JOGOS = [];
  var ABA = "artilheiros";
  var FILTRO = "TODAS";
  var FASE = "TODAS";

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>'"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c];
    });
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function nomeSelecao(sigla) {
    if (window.COPA_TIMES && COPA_TIMES.nome) return COPA_TIMES.nome(sigla);
    return sigla || "—";
  }
  function flag(sigla) {
    if (!sigla) return "";
    var src = window.COPA_TIMES && COPA_TIMES.flag ? COPA_TIMES.flag(sigla, 80) : "";
    return src ? '<img class="stat-flag" src="' + esc(src) + '" alt="" loading="lazy">' : "";
  }
  function fmtData(iso) {
    if (!iso) return "Ainda não atualizado";
    try {
      return new Date(iso).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
    } catch (e) { return iso; }
  }
  function fmtJogo(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }) +
        '<span class="stat-jogo-sep">•</span>' +
        d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return iso; }
  }
  function listaDaAba() {
    if (ABA === "assistencias") return DADOS.assistencias || [];
    if (ABA === "gols_selecao") {
      return (DADOS.por_selecao || []).slice().sort(function (a, b) {
        return (b.gols || 0) - (a.gols || 0) || (b.media_gols || 0) - (a.media_gols || 0) || nomeSelecao(a.equipe).localeCompare(nomeSelecao(b.equipe), "pt-BR");
      });
    }
    if (ABA === "jogos") return JOGOS.slice();
    return DADOS.artilheiros || [];
  }
  function valorPrincipal(item) {
    if (ABA === "assistencias") return item.assistencias || 0;
    return item.gols || 0;
  }
  function rotuloValor(v) {
    if (ABA === "assistencias") return v === 1 ? "assistência" : "assistências";
    return v === 1 ? "gol" : "gols";
  }
  function melhorAtaque() {
    var lista = (DADOS.por_selecao || []).slice().sort(function (a, b) {
      return (b.gols || 0) - (a.gols || 0) || (b.media_gols || 0) - (a.media_gols || 0) || nomeSelecao(a.equipe).localeCompare(nomeSelecao(b.equipe), "pt-BR");
    });
    return lista[0];
  }
  function renderResumo() {
    var gols = (DADOS.artilheiros || [])[0];
    var ass = (DADOS.assistencias || [])[0];
    var ataque = melhorAtaque();
    var cards = [
      { tit: "Artilheiro", item: gols, val: gols ? gols.gols : 0, suf: "gols", ico: "⚽", tipo: "jogador" },
      { tit: "Garçom", item: ass, val: ass ? ass.assistencias : 0, suf: "assist.", ico: "🎯", tipo: "jogador" },
      { tit: "Melhor ataque", item: ataque, val: ataque ? ataque.gols : 0, suf: "gols", ico: "🥅", tipo: "selecao" }
    ];
    $("#stats-resumo").innerHTML = cards.map(function (c) {
      if (!c.item) return '<div class="stat-res-card"><div class="stat-res-ico">' + c.ico + '</div><div><b>' + c.tit + '</b><span>Aguardando dados</span></div></div>';
      var nome = c.tipo === "selecao" ? nomeSelecao(c.item.equipe) : c.item.nome;
      var detalhe = c.tipo === "selecao"
        ? (flag(c.item.equipe) + esc(c.item.equipe || "") + ' · ' + c.val + ' ' + esc(c.suf))
        : (flag(c.item.equipe) + esc(nomeSelecao(c.item.equipe)) + ' · ' + c.val + ' ' + esc(c.suf));
      return '<div class="stat-res-card">' +
        '<div class="stat-res-ico">' + c.ico + '</div>' +
        '<div class="stat-res-info"><b>' + esc(c.tit) + '</b>' +
        '<strong>' + esc(nome) + '</strong>' +
        '<span>' + detalhe + '</span></div>' +
      '</div>';
    }).join("");
  }
  function faseLabel(slug) {
    var map = {
      "group-stage": "Fase de grupos",
      "round-of-32": "Segunda fase",
      "round-of-16": "Oitavas",
      "quarterfinals": "Quartas",
      "semifinals": "Semifinal",
      "third-place": "Disputa de 3º",
      "final": "Final"
    };
    return map[slug] || "Copa do Mundo";
  }
  function faseOrder(slug) {
    var order = { "group-stage": 1, "round-of-32": 2, "round-of-16": 3, "quarterfinals": 4, "semifinals": 5, "third-place": 6, "final": 7 };
    return order[slug] || 99;
  }
  function compOf(ev) { return (ev && ev.competitions && ev.competitions[0]) || {}; }
  function teamOf(ev, side) {
    var cs = compOf(ev).competitors || [];
    return cs.filter(function (c) { return c.homeAway === side; })[0] || (side === "home" ? cs[0] : cs[1]) || {};
  }
  function teamSigla(c) { return (c.team && (c.team.abbreviation || c.team.shortDisplayName || c.team.displayName)) || ""; }
  function teamNome(c) { return nomeSelecao(teamSigla(c)); }
  function teamFlag(c) {
    var src = window.COPA_TIMES && COPA_TIMES.flag ? COPA_TIMES.flag(teamSigla(c), 80) : "";
    return src ? '<img src="' + esc(src) + '" alt="" loading="lazy">' : "";
  }
  function venueOf(ev) {
    var v = compOf(ev).venue;
    return v ? (v.fullName + (v.address && v.address.city ? ' · ' + v.address.city : '')) : '';
  }
  function normalizarJogo(ev) {
    var comp = compOf(ev), st = ((comp.status || {}).type || {}), home = teamOf(ev, 'home'), away = teamOf(ev, 'away');
    return {
      id: String(ev.id || ''),
      date: ev.date || '',
      fase: (ev.season && ev.season.slug) || '',
      fase_nome: faseLabel((ev.season && ev.season.slug) || ''),
      state: st.state || '',
      shortDetail: st.shortDetail || '',
      home: { sigla: teamSigla(home), nome: teamNome(home), score: home.score != null ? String(home.score) : '' },
      away: { sigla: teamSigla(away), nome: teamNome(away), score: away.score != null ? String(away.score) : '' },
      venue: venueOf(ev)
    };
  }
  function statusBadge(j) {
    if (j.state === 'in') return '<span class="stat-jogo-badge live">Ao vivo' + (j.shortDetail ? ' · ' + esc(j.shortDetail) : '') + '</span>';
    if (j.state === 'pre') return '<span class="stat-jogo-badge pre">Agendado</span>';
    var extra = j.shortDetail && /pen/i.test(j.shortDetail) ? ' (pên.)' : '';
    return '<span class="stat-jogo-badge">Encerrado' + extra + '</span>';
  }
  function renderFiltro() {
    var sel = $("#stat-selecao");
    var equipes = {};
    ["artilheiros", "assistencias", "cartoes", "por_selecao"].forEach(function (k) {
      (DADOS[k] || []).forEach(function (x) { if (x.equipe) equipes[x.equipe] = true; });
    });
    (JOGOS || []).forEach(function (j) {
      if (j.home && j.home.sigla) equipes[j.home.sigla] = true;
      if (j.away && j.away.sigla) equipes[j.away.sigla] = true;
    });
    var lista = Object.keys(equipes).sort(function (a, b) { return nomeSelecao(a).localeCompare(nomeSelecao(b), "pt-BR"); });
    sel.innerHTML = '<option value="TODAS">Todas as seleções</option>' + lista.map(function (s) {
      return '<option value="' + esc(s) + '">' + esc(nomeSelecao(s)) + '</option>';
    }).join('');
    sel.value = FILTRO;
    sel.onchange = function () { FILTRO = sel.value; renderLista(); };

    var faseWrap = $("#stat-fase-wrap"), faseSel = $("#stat-fase");
    if (faseSel) {
      var fases = [];
      var seen = {};
      (JOGOS || []).forEach(function (j) {
        if (j.fase && !seen[j.fase]) { seen[j.fase] = true; fases.push(j.fase); }
      });
      fases.sort(function (a, b) { return faseOrder(a) - faseOrder(b); });
      faseSel.innerHTML = '<option value="TODAS">Todas as fases</option>' + fases.map(function (f) {
        return '<option value="' + esc(f) + '">' + esc(faseLabel(f)) + '</option>';
      }).join('');
      faseSel.value = FASE;
      faseSel.onchange = function () { FASE = faseSel.value; renderLista(); };
    }
    if (faseWrap) faseWrap.hidden = ABA !== 'jogos';
  }
  function row(item, idx) {
    var val = valorPrincipal(item);
    if (ABA === 'gols_selecao') {
      var jogos = item.jogos || item.partidas || 0;
      var media = item.media_gols || (jogos ? (val / jogos) : 0);
      var metaSel = jogos
        ? '<span class="stat-muted">' + jogos + ' jogo' + (jogos > 1 ? 's' : '') + ' · média ' + media.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '</span>'
        : '<span class="stat-muted">gols marcados pela seleção</span>';
      return '<article class="stat-row stat-row-selecao">' +
        '<div class="stat-pos">' + (idx + 1) + 'º</div>' +
        '<div class="stat-player">' +
          '<strong>' + esc(nomeSelecao(item.equipe)) + '</strong>' +
          '<span>' + flag(item.equipe) + esc(item.equipe || '—') + '</span>' +
          '<div class="stat-mobile-meta">' + metaSel + '</div>' +
        '</div>' +
        '<div class="stat-meta">' + metaSel + '</div>' +
        '<div class="stat-num"><b>' + val + '</b><small>' + esc(rotuloValor(val)) + '</small></div>' +
      '</article>';
    }
    var meta = '<span class="stat-muted">' + (item.jogos && item.jogos.length ? item.jogos.length : 1) + ' jogo' + ((item.jogos || []).length > 1 ? 's' : '') + '</span>';
    return '<article class="stat-row">' +
      '<div class="stat-pos">' + (idx + 1) + 'º</div>' +
      '<div class="stat-player">' +
        '<strong>' + esc(item.nome || '—') + '</strong>' +
        '<span>' + flag(item.equipe) + esc(nomeSelecao(item.equipe)) + '</span>' +
        '<div class="stat-mobile-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="stat-meta">' + meta + '</div>' +
      '<div class="stat-num"><b>' + val + '</b><small>' + esc(rotuloValor(val)) + '</small></div>' +
    '</article>';
  }
  function filtrar(arr) {
    if (ABA === 'jogos') {
      return arr.filter(function (j) {
        var okTime = (FILTRO === 'TODAS') || (j.home && j.home.sigla === FILTRO) || (j.away && j.away.sigla === FILTRO);
        var okFase = (FASE === 'TODAS') || (j.fase === FASE);
        var okStatus = j.state === 'post' || j.state === 'in';
        return okTime && okFase && okStatus;
      });
    }
    if (FILTRO === 'TODAS') return arr;
    return arr.filter(function (x) { return x.equipe === FILTRO; });
  }
  function jogoCard(j) {
    var bloco = (window.COPA_JOGO_STATS && COPA_JOGO_STATS.bloco)
      ? COPA_JOGO_STATS.bloco({ eventId: j.id, homeId: j.home.sigla, awayId: j.away.sigla, homeName: j.home.nome, awayName: j.away.nome })
      : '<div class="stat-jogo-hint">Estatísticas detalhadas indisponíveis neste navegador.</div>';
    var placar = j.state === 'pre' ? '×' : (esc(j.home.score || '0') + ' × ' + esc(j.away.score || '0'));
    return '<article class="stat-jogo-card">' +
      '<div class="stat-jogo-top"><span class="stat-jogo-fase">' + esc(j.fase_nome) + '</span>' + statusBadge(j) + '</div>' +
      '<div class="stat-jogo-linha">' +
        '<div class="stat-jogo-lado">' + teamFlag({team:{abbreviation:j.home.sigla}}) + '<span>' + esc(j.home.nome) + '</span></div>' +
        '<div class="stat-jogo-meio"><div class="stat-jogo-placar">' + placar + '</div><div class="stat-jogo-data">' + fmtJogo(j.date) + '</div></div>' +
        '<div class="stat-jogo-lado dir"><span>' + esc(j.away.nome) + '</span>' + teamFlag({team:{abbreviation:j.away.sigla}}) + '</div>' +
      '</div>' +
      (j.venue ? '<div class="stat-jogo-venue">' + esc(j.venue) + '</div>' : '') +
      bloco +
    '</article>';
  }
  function renderLista() {
    $$(".stat-tab").forEach(function (b) { b.classList.toggle("ativa", b.dataset.aba === ABA); });
    renderFiltro();
    var arr = filtrar(listaDaAba());
    var titulo = ABA === 'assistencias' ? 'Assistências' : (ABA === 'gols_selecao' ? 'Gols por seleção' : (ABA === 'jogos' ? 'Estatísticas por jogo' : 'Artilheiros'));
    $("#stats-titulo-lista").textContent = titulo;

    if (ABA === 'jogos') {
      $("#stats-contagem").textContent = arr.length ? (arr.length + ' ' + (arr.length > 1 ? 'jogos' : 'jogo')) : 'sem jogos';
      if (!arr.length) {
        $("#stats-lista").innerHTML = '<div class="stat-vazio">Ainda não há partidas encerradas ou ao vivo para este filtro. Quando houver, o raio-x por jogo aparecerá aqui.</div>';
        return;
      }
      arr.sort(function (a, b) { return new Date(b.date).getTime() - new Date(a.date).getTime(); });
      $("#stats-lista").innerHTML = arr.map(jogoCard).join('');
      if (window.COPA_JOGO_STATS && COPA_JOGO_STATS.bind) COPA_JOGO_STATS.bind($("#stats-lista"));
      return;
    }

    $("#stats-contagem").textContent = arr.length
      ? (arr.length + ' ' + (ABA === 'gols_selecao' ? (arr.length > 1 ? 'seleções' : 'seleção') : (arr.length > 1 ? 'jogadores' : 'jogador')))
      : 'sem dados';
    if (!arr.length) {
      $("#stats-lista").innerHTML = '<div class="stat-vazio">Ainda não há dados disponíveis para esta aba. A ESPN pode levar alguns minutos para disponibilizar gols e assistências no feed.</div>';
      return;
    }
    $("#stats-lista").innerHTML = arr.map(row).join('');
  }
  function initTabs() {
    $$(".stat-tab").forEach(function (b) {
      b.onclick = function () {
        ABA = b.dataset.aba || 'artilheiros';
        renderLista();
      };
    });
  }
  function renderTudo() {
    $("#stat-atualizado").textContent = fmtData(DADOS.atualizado_em);
    $("#stat-processados").textContent = String(DADOS.jogos_processados || 0);
    renderResumo();
    renderFiltro();
    renderLista();
  }
  async function carregar() {
    try { if (window.COPA_TIMES && COPA_TIMES.carregar) await COPA_TIMES.carregar(); } catch (e) {}

    var dadosReq = fetch('dados/estatisticas.json?v=' + Date.now()).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function () {
      return { atualizado_em: null, jogos_processados: 0, artilheiros: [], assistencias: [], por_selecao: [] };
    });

    var jogosReq = fetch(API_SCOREBOARD + '&_=' + Date.now()).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      return (j.events || []).map(normalizarJogo);
    }).catch(function () { return []; });

    var ambos = await Promise.all([dadosReq, jogosReq]);
    DADOS = ambos[0] || DADOS;
    JOGOS = ambos[1] || [];
    renderTudo();
  }
  document.addEventListener('DOMContentLoaded', function () {
    initTabs();
    carregar();
  });
})();
