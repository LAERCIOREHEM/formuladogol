
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
  var ROSTOS = {};
  var JOGOS = [];
  var RANKING_DESEMPENHO = { ranking: [] };
  var ABA = "artilheiros";
  var FILTRO = "TODAS";
  var FASE = "TODAS";
  var SITUACAO_RANK = "TODAS";
  var MIN_JOGOS_RANK = 1;
  var ORDEM_RANK = "indice_final";
  var DIRECAO_RANK = "desc";
  var LIVE_REFRESH_MS = 30000;
  var LIVE_TIMER = null;
  var LIVE_TICKING = false;
  var LIVE_ULTIMA_ATUALIZACAO = "";

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

  function normNome(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }
  var PAL_AVATAR = ["#3b5bdb", "#2f9e44", "#e8590c", "#9c36b5", "#1098ad", "#c2255c", "#0c8599", "#5c7cfa"];
  function corAvatar(nome) {
    var s = normNome(nome), h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return PAL_AVATAR[h % PAL_AVATAR.length];
  }
  function iniciaisArt(nome) {
    var t = normNome(nome).split(" ").filter(Boolean);
    if (!t.length) return "?";
    if (t.length >= 2) return (t[0][0] + t[t.length - 1][0]).toUpperCase();
    return t[0].slice(0, 2).toUpperCase();
  }
  function avatarArt(nome) {
    return '<span class="stat-face stat-face-ini" style="background:' + corAvatar(nome) + '" aria-hidden="true">' +
      esc(iniciaisArt(nome)) + "</span>";
  }
  function faceArtilheiro(equipe, nome) {
    var mapa = ROSTOS && ROSTOS.mapa;
    if (mapa && equipe && nome) {
      var foto = mapa[String(equipe).toUpperCase() + "|" + normNome(nome)];
      if (foto) return '<span class="stat-face"><img src="' + esc(foto) + '" alt="" loading="lazy"></span>';
    }
    return avatarArt(nome);
  }

  function siglaSelecao(valor) {
    if (!valor) return "";
    if (window.COPA_TIMES && COPA_TIMES.sigla) {
      return COPA_TIMES.sigla(valor) || "";
    }
    return /^[A-Z]{3}$/.test(String(valor || "")) ? String(valor).toUpperCase() : "";
  }
  function todasSiglas() {
    var mapa = {};
    if (DADOS) {
      ["artilheiros", "assistencias", "cartoes", "por_selecao"].forEach(function (k) {
        (DADOS[k] || []).forEach(function (x) {
          var eq = siglaSelecao(x.equipe);
          if (eq) mapa[eq] = true;
        });
      });
    }
    ((RANKING_DESEMPENHO && RANKING_DESEMPENHO.ranking) || []).forEach(function (x) {
      var eq = siglaSelecao(x.equipe);
      if (eq) mapa[eq] = true;
    });
    (JOGOS || []).forEach(function (j) {
      var home = j.home && siglaSelecao(j.home.sigla);
      var away = j.away && siglaSelecao(j.away.sigla);
      if (home) mapa[home] = true;
      if (away) mapa[away] = true;
    });
    return Object.keys(mapa).sort(function (a, b) {
      return nomeSelecao(a).localeCompare(nomeSelecao(b), "pt-BR");
    });
  }
  function normalizarItemEquipe(item) {
    var novo = Object.assign({}, item || {});
    novo.equipe = siglaSelecao(novo.equipe);
    return novo;
  }
  function completarGolsPorSelecao(lista) {
    var mapa = {};
    (lista || []).forEach(function (item) {
      var x = normalizarItemEquipe(item);
      if (!x.equipe) return;
      mapa[x.equipe] = Object.assign({ gols: 0, assistencias: 0, amarelos: 0, vermelhos: 0, jogos: 0, media_gols: 0 }, x);
    });
    todasSiglas().forEach(function (eq) {
      if (!mapa[eq]) mapa[eq] = { equipe: eq, gols: 0, assistencias: 0, amarelos: 0, vermelhos: 0, jogos: 0, media_gols: 0 };
    });
    return Object.keys(mapa).map(function (eq) { return mapa[eq]; });
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
    if (ABA === "assistencias") return (DADOS.assistencias || []).map(normalizarItemEquipe).filter(function (x) { return !!x.equipe; });
    if (ABA === "gols_selecao") {
      return completarGolsPorSelecao(DADOS.por_selecao || []).filter(function (x) { return !!x.equipe; }).sort(function (a, b) {
        return (b.gols || 0) - (a.gols || 0) || (b.media_gols || 0) - (a.media_gols || 0) || nomeSelecao(a.equipe).localeCompare(nomeSelecao(b.equipe), "pt-BR");
      });
    }
    if (ABA === "jogos") return JOGOS.slice();
    if (ABA === "desempenho") return ((RANKING_DESEMPENHO && RANKING_DESEMPENHO.ranking) || []).slice();
    return (DADOS.artilheiros || []).map(normalizarItemEquipe).filter(function (x) { return !!x.equipe; });
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
    var lista = completarGolsPorSelecao(DADOS.por_selecao || []).sort(function (a, b) {
      return (b.gols || 0) - (a.gols || 0) || (b.media_gols || 0) - (a.media_gols || 0) || nomeSelecao(a.equipe).localeCompare(nomeSelecao(b.equipe), "pt-BR");
    });
    return lista.find(function (x) { return (x.gols || 0) > 0; }) || lista[0];
  }
  function renderResumo() {
    var gols = (DADOS.artilheiros || [])[0];
    var ass = (DADOS.assistencias || [])[0];
    var ataque = melhorAtaque();
    var topRank = ((RANKING_DESEMPENHO && RANKING_DESEMPENHO.ranking) || [])[0];
    var cards = [
      { tit: "Artilheiro", item: gols, val: gols ? gols.gols : 0, suf: "gols", ico: "⚽", tipo: "jogador" },
      { tit: "Garçom", item: ass, val: ass ? ass.assistencias : 0, suf: "assist.", ico: "🎯", tipo: "jogador" },
      { tit: "Melhor ataque", item: ataque, val: ataque ? ataque.gols : 0, suf: "gols", ico: "🥅", tipo: "selecao" },
      { tit: "Ranking", item: topRank, val: topRank ? topRank.indice_final : 0, suf: "pts", ico: "⚡", tipo: "ranking" }
    ];
    $("#stats-resumo").innerHTML = cards.map(function (c) {
      if (!c.item) return '<div class="stat-res-card"><div class="stat-res-ico">' + c.ico + '</div><div><b>' + c.tit + '</b><span>Aguardando dados</span></div></div>';
      var nome = c.tipo === "selecao" ? nomeSelecao(c.item.equipe) : (c.tipo === "ranking" ? nomeSelecao(c.item.equipe) : c.item.nome);
      var detalhe = c.tipo === "selecao"
        ? (flag(c.item.equipe) + esc(c.item.equipe || "") + ' · ' + c.val + ' ' + esc(c.suf))
        : (c.tipo === "ranking" ? (flag(c.item.equipe) + esc(c.item.equipe || "") + ' · índice ' + esc(c.val)) : (flag(c.item.equipe) + esc(nomeSelecao(c.item.equipe)) + ' · ' + c.val + ' ' + esc(c.suf)));
      return '<div class="stat-res-card' + (c.tipo === "ranking" ? ' stat-res-card-rank' : '') + '">' +
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
    return map[slug] || "";
  }
  function faseConhecida(slug) {
    return !!faseLabel(slug);
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
  function numPlacar(v) {
    if (v == null || v === "") return null;
    var n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
    return isNaN(n) ? null : n;
  }
  function placarPenaltiCompetidor(c) {
    var vals = [
      c && c.shootoutScore,
      c && c.shootoutDisplayScore,
      c && c.penaltyScore,
      c && c.penalties,
      c && c.shootout
    ];
    for (var i = 0; i < vals.length; i++) {
      var n = numPlacar(vals[i]);
      if (n != null) return n;
    }
    return null;
  }
  function vencedorPorPenaltis(home, away, penHome, penAway) {
    if (home && home.winner) return teamSigla(home);
    if (away && away.winner) return teamSigla(away);
    if (penHome != null && penAway != null) {
      if (penHome > penAway) return teamSigla(home);
      if (penAway > penHome) return teamSigla(away);
    }
    return "";
  }
  function linhaPenaltisJogo(j) {
    if (!j || j.state !== "post" || j.penA == null || j.penB == null) return "";
    var vencedor = j.vencedor ? nomeSelecao(j.vencedor) : "";
    return '<div class="stat-jogo-pen">pênaltis ' + esc(j.penA) + '-' + esc(j.penB) +
      (vencedor ? ' · <b>' + esc(vencedor) + '</b> venceu' : '') +
    '</div>';
  }
  function normalizarJogo(ev) {
    var comp = compOf(ev), st = ((comp.status || {}).type || {}), home = teamOf(ev, 'home'), away = teamOf(ev, 'away');
    var penHome = placarPenaltiCompetidor(home), penAway = placarPenaltiCompetidor(away);
    return {
      id: String(ev.id || ''),
      date: ev.date || '',
      fase: (ev.season && ev.season.slug) || '',
      fase_nome: faseLabel((ev.season && ev.season.slug) || ''),
      state: st.state || '',
      shortDetail: st.shortDetail || '',
      home: { sigla: teamSigla(home), nome: teamNome(home), score: home.score != null ? String(home.score) : '' },
      away: { sigla: teamSigla(away), nome: teamNome(away), score: away.score != null ? String(away.score) : '' },
      penA: penHome,
      penB: penAway,
      vencedor: vencedorPorPenaltis(home, away, penHome, penAway),
      venue: venueOf(ev)
    };
  }
  function statusBadge(j) {
    if (j.state === 'in') return '<span class="stat-jogo-badge live">Ao vivo' + (j.shortDetail ? ' · ' + esc(j.shortDetail) : '') + '</span>';
    if (j.state === 'pre') return '<span class="stat-jogo-badge pre">Agendado</span>';
    var extra = (j.penA != null && j.penB != null) || (j.shortDetail && /pen/i.test(j.shortDetail)) ? ' (pên.)' : '';
    return '<span class="stat-jogo-badge">Encerrado' + extra + '</span>';
  }
  function renderFiltro() {
    var sel = $("#stat-selecao");
    var equipes = {};
    ["artilheiros", "assistencias", "cartoes", "por_selecao"].forEach(function (k) {
      (DADOS[k] || []).forEach(function (x) {
        var eq = siglaSelecao(x.equipe);
        if (eq) equipes[eq] = true;
      });
    });
    ((RANKING_DESEMPENHO && RANKING_DESEMPENHO.ranking) || []).forEach(function (x) {
      var eq = siglaSelecao(x.equipe);
      if (eq) equipes[eq] = true;
    });
    (JOGOS || []).forEach(function (j) {
      var home = j.home && siglaSelecao(j.home.sigla);
      var away = j.away && siglaSelecao(j.away.sigla);
      if (home) equipes[home] = true;
      if (away) equipes[away] = true;
    });
    var lista = Object.keys(equipes).sort(function (a, b) { return nomeSelecao(a).localeCompare(nomeSelecao(b), "pt-BR"); });
    var valoresValidos = { TODAS: true };
    lista.forEach(function (s) { valoresValidos[s] = true; });
    if (!valoresValidos[FILTRO]) FILTRO = "TODAS";
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
        if (j.fase && faseConhecida(j.fase) && !seen[j.fase]) { seen[j.fase] = true; fases.push(j.fase); }
      });
      fases.sort(function (a, b) { return faseOrder(a) - faseOrder(b); });
      if (FASE !== "TODAS" && !faseConhecida(FASE)) FASE = "TODAS";
      faseSel.innerHTML = '<option value="TODAS">Todas as fases</option>' + fases.map(function (f) {
        return '<option value="' + esc(f) + '">' + esc(faseLabel(f)) + '</option>';
      }).join('');
      faseSel.value = FASE;
      faseSel.onchange = function () { FASE = faseSel.value; renderLista(); };
    }
    if (faseWrap) faseWrap.hidden = ABA !== 'jogos';

    var situacaoWrap = $("#stat-situacao-wrap"), situacaoSel = $("#stat-situacao");
    var minWrap = $("#stat-min-jogos-wrap"), minSel = $("#stat-min-jogos");
    var ordemWrap = $("#stat-ordem-wrap"), ordemSel = $("#stat-ordem");
    var dirWrap = $("#stat-direcao-wrap"), dirSel = $("#stat-direcao");
    var rankAtivo = ABA === "desempenho";
    if (situacaoWrap) situacaoWrap.hidden = !rankAtivo;
    if (minWrap) minWrap.hidden = !rankAtivo;
    if (ordemWrap) ordemWrap.hidden = !rankAtivo;
    if (dirWrap) dirWrap.hidden = !rankAtivo;
    if (situacaoSel) {
      situacaoSel.value = SITUACAO_RANK;
      situacaoSel.onchange = function () { SITUACAO_RANK = situacaoSel.value || "TODAS"; renderLista(); };
    }
    if (minSel) {
      minSel.value = String(MIN_JOGOS_RANK || 1);
      minSel.onchange = function () { MIN_JOGOS_RANK = parseInt(minSel.value || "1", 10) || 1; renderLista(); };
    }
    if (ordemSel) {
      ordemSel.value = ORDEM_RANK;
      ordemSel.onchange = function () { ORDEM_RANK = ordemSel.value || "indice_final"; renderLista(); };
    }
    if (dirSel) {
      dirSel.value = DIRECAO_RANK;
      dirSel.onchange = function () { DIRECAO_RANK = dirSel.value || "desc"; renderLista(); };
    }
  }

  function marcadoresDaSelecao(item) {
    var eq = item && item.equipe;
    var lista = ((DADOS && DADOS.artilheiros) || [])
      .map(normalizarItemEquipe)
      .filter(function (x) { return x.equipe === eq && (x.gols || 0) > 0; })
      .sort(function (a, b) {
        return (b.gols || 0) - (a.gols || 0) || String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
      });

    var totalMarcadores = lista.reduce(function (acc, x) { return acc + (x.gols || 0); }, 0);
    var golsRestantes = Math.max(0, (item.gols || 0) - totalMarcadores);

    var htmlItens = lista.map(function (x) {
      var qtd = x.gols || 0;
      return '<div class="stat-goal-item">' +
        '<div class="stat-goal-player">' +
          '<strong>' + esc(x.nome || "—") + '</strong>' +
          '<span>' + flag(x.equipe) + esc(nomeSelecao(x.equipe)) + '</span>' +
        '</div>' +
        '<div class="stat-goal-num"><b>' + qtd + '</b><small>' + esc(rotuloValor(qtd)) + '</small></div>' +
      '</div>';
    });

    if (golsRestantes > 0) {
      htmlItens.push('<div class="stat-goal-item stat-goal-item-extra">' +
        '<div class="stat-goal-player">' +
          '<strong>Gol contra a favor</strong>' +
          '<span>Diferença entre o total da seleção e os artilheiros identificados no feed</span>' +
        '</div>' +
        '<div class="stat-goal-num"><b>' + golsRestantes + '</b><small>' + (golsRestantes === 1 ? "gol" : "gols") + '</small></div>' +
      '</div>');
    }

    if (!htmlItens.length) {
      htmlItens.push('<div class="stat-goals-empty">Ainda não há marcadores individuais identificados para esta seleção.</div>');
    }

    return '<details class="stat-goals-toggle">' +
      '<summary class="stat-goals-summary">' +
        '<span class="stat-goals-summary-closed">⚽ Ver marcadores dos gols</span>' +
        '<span class="stat-goals-summary-open">⚽ Ocultar marcadores dos gols</span>' +
      '</summary>' +
      '<div class="stat-goals-body">' + htmlItens.join("") + '</div>' +
    '</details>';
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
        marcadoresDaSelecao(item) +
      '</article>';
    }
    var meta = '<span class="stat-muted">' + (item.jogos && item.jogos.length ? item.jogos.length : 1) + ' jogo' + ((item.jogos || []).length > 1 ? 's' : '') + '</span>';
    return '<article class="stat-row">' +
      '<div class="stat-pos">' + (idx + 1) + 'º</div>' +
      faceArtilheiro(item.equipe, item.nome) +
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
    if (ABA === "desempenho") {
      var campo = ORDEM_RANK || "indice_final";
      var dir = DIRECAO_RANK === "asc" ? 1 : -1;
      return (arr || []).filter(function (x) {
        var eq = siglaSelecao(x.equipe);
        var okTime = (FILTRO === "TODAS") || eq === FILTRO;
        var okSit = (SITUACAO_RANK === "TODAS") || String(x.situacao || "") === SITUACAO_RANK;
        var okJogos = (x.jogos || 0) >= (MIN_JOGOS_RANK || 1);
        return okTime && okSit && okJogos;
      }).sort(function (a, b) {
        var av = a[campo], bv = b[campo];
        if (av == null && bv == null) return (a.nome || "").localeCompare(b.nome || "", "pt-BR");
        if (av == null) return 1;
        if (bv == null) return -1;
        return (Number(av) - Number(bv)) * dir || (a.nome || "").localeCompare(b.nome || "", "pt-BR");
      });
    }
    if (FILTRO === 'TODAS') return arr;
    return arr.filter(function (x) { return x.equipe === FILTRO; });
  }
  function fmtRankNum(v, casas) {
    if (v == null || v === "" || isNaN(Number(v))) return "—";
    return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas || 0, maximumFractionDigits: casas || 0 });
  }
  function fmtRankDec(v) {
    if (v == null || v === "" || isNaN(Number(v))) return "—";
    return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  function desempenhoCard(item, idx) {
    var pos = item.posicao || (idx + 1);
    var situ = item.situacao || "Em disputa";
    var situCls = situ === "Eliminada" ? "elim" : (situ === "Classificada" ? "class" : "disp");
    var posse = fmtRankDec(item.posse_media);
    var fin = fmtRankDec(item.finalizacoes_jogo);
    var chgol = fmtRankDec(item.chutes_gol_jogo);
    var gols = fmtRankDec(item.gols_jogo);
    return '<article class="rank-card' + (idx === 0 ? ' rank-top' : '') + '">' +
      '<div class="rank-head">' +
        '<div class="rank-pos rank-pos-' + Math.min(Number(pos) || 0, 3) + '">' + esc(pos) + 'º</div>' +
        '<div class="rank-team">' + flag(item.equipe) + '<div><strong>' + esc(nomeSelecao(item.equipe)) + '</strong><span>' + esc(item.equipe || "—") + ' · ' + esc(item.jogos || 0) + ' jogo' + ((item.jogos || 0) === 1 ? '' : 's') + '</span></div></div>' +
        '<div class="rank-score"><b>' + fmtRankDec(item.indice_final) + '</b><small>índice</small></div>' +
      '</div>' +
      '<div class="rank-bars">' +
        rankBar("Ataque", item.ataque) +
        rankBar("Domínio", item.dominio) +
        rankBar("Defesa", item.defesa) +
        rankBar("Eficiência", item.eficiencia) +
      '</div>' +
      '<div class="rank-mini">' +
        '<span>Posse <b>' + posse + '%</b></span>' +
        '<span>Fin./jogo <b>' + fin + '</b></span>' +
        '<span>Chutes gol <b>' + chgol + '</b></span>' +
        '<span>Gols/jogo <b>' + gols + '</b></span>' +
      '</div>' +
      '<details class="rank-details">' +
        '<summary>Ver metodologia e detalhes ▾</summary>' +
        '<div class="rank-detail-grid">' +
          '<span>Ataque <b>' + fmtRankDec(item.ataque) + '</b></span>' +
          '<span>Domínio <b>' + fmtRankDec(item.dominio) + '</b></span>' +
          '<span>Defesa <b>' + fmtRankDec(item.defesa) + '</b></span>' +
          '<span>Eficiência <b>' + fmtRankDec(item.eficiencia) + '</b></span>' +
          '<span>Disciplina <b>' + fmtRankDec(item.disciplina) + '</b></span>' +
          '<span>Gols pró <b>' + esc(item.gols_pro == null ? "—" : item.gols_pro) + '</b></span>' +
          '<span>Gols contra <b>' + esc(item.gols_contra == null ? "—" : item.gols_contra) + '</b></span>' +
          '<span>Jogos c/ stats <b>' + esc(item.jogos_com_estatisticas || 0) + '</b></span>' +
        '</div>' +
        '<p>Índice próprio do site: médias por jogo, normalização pelo torneio, corte de extremos e ajuste para amostras pequenas. Situação não entra no cálculo.</p>' +
      '</details>' +
      '<div class="rank-foot"><span class="rank-situacao ' + situCls + '">' + esc(situ) + '</span><span>Ranking de Desempenho · não oficial</span></div>' +
    '</article>';
  }
  function rankBar(label, val) {
    var n = Math.max(0, Math.min(100, Number(val || 0)));
    return '<div class="rank-bar"><span><b>' + esc(label) + '</b><em>' + fmtRankDec(val) + '</em></span><i><u style="width:' + n.toFixed(1) + '%"></u></i></div>';
  }
  function desempenhoMetodoHTML() {
    var d = RANKING_DESEMPENHO || {};
    var top = ((d.ranking || [])[0]) || null;
    var atual = d.atualizado_em ? fmtData(d.atualizado_em) : "aguardando atualização";
    var pesos = d.pesos || {};
    var obs = (d.observacoes || []).slice(0, 3).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("");
    var topHtml = top
      ? '<div class="rank-metodo-top">' + flag(top.equipe) + '<span>Líder atual</span><b>' + esc(nomeSelecao(top.equipe)) + '</b><em>' + fmtRankDec(top.indice_final) + '</em></div>'
      : '';
    return '<section class="rank-metodo">' +
      '<div class="rank-metodo-head">' +
        '<div><b>Ranking de Desempenho</b><p>Índice próprio do site, de 0 a 100, calculado pelo workflow e leve no navegador.</p></div>' +
        topHtml +
      '</div>' +
      '<div class="rank-pesos">' +
        '<span>Ataque <b>' + esc(pesos.ataque || "35%") + '</b></span>' +
        '<span>Domínio <b>' + esc(pesos.dominio || "25%") + '</b></span>' +
        '<span>Defesa <b>' + esc(pesos.defesa || "25%") + '</b></span>' +
        '<span>Eficiência <b>' + esc(pesos.eficiencia || "10%") + '</b></span>' +
        '<span>Disciplina <b>' + esc(pesos.disciplina || "5%") + '</b></span>' +
      '</div>' +
      '<div class="rank-update">Atualizado pelo workflow: <b>' + esc(atual) + '</b></div>' +
      (obs ? '<details class="rank-metodo-details"><summary>Como o índice é calculado ▾</summary><ul>' + obs + '</ul></details>' : '') +
    '</section>';
  }

  function jogoCard(j) {
    var bloco = (window.COPA_JOGO_STATS && COPA_JOGO_STATS.bloco)
      ? COPA_JOGO_STATS.bloco({ eventId: j.id, homeId: j.home.sigla, awayId: j.away.sigla, homeName: j.home.nome, awayName: j.away.nome, live: j.state === "in" })
      : '<div class="stat-jogo-hint">Estatísticas detalhadas indisponíveis neste navegador.</div>';
    var placar = j.state === 'pre' ? '×' : (esc(j.home.score || '0') + ' × ' + esc(j.away.score || '0'));
    return '<article class="stat-jogo-card">' +
      '<div class="stat-jogo-top"><span class="stat-jogo-fase">' + esc(j.fase_nome) + '</span>' + statusBadge(j) + '</div>' +
      '<div class="stat-jogo-linha">' +
        '<div class="stat-jogo-lado">' + teamFlag({team:{abbreviation:j.home.sigla}}) + '<span>' + esc(j.home.nome) + '</span></div>' +
        '<div class="stat-jogo-meio"><div class="stat-jogo-placar">' + placar + '</div><div class="stat-jogo-data">' + fmtJogo(j.date) + '</div></div>' +
        '<div class="stat-jogo-lado dir"><span>' + esc(j.away.nome) + '</span>' + teamFlag({team:{abbreviation:j.away.sigla}}) + '</div>' +
      '</div>' +
      linhaPenaltisJogo(j) +
      (j.venue ? '<div class="stat-jogo-venue">' + esc(j.venue) + '</div>' : '') +
      bloco +
    '</article>';
  }
  function idsJstatsAbertos() {
    return $$("#stats-lista [data-jstats].open").map(function (el) { return el.getAttribute("data-jstats"); }).filter(Boolean);
  }
  function restaurarJstatsAbertos(ids) {
    if (!ids || !ids.length || !window.COPA_JOGO_STATS) return;
    ids.forEach(function (id) {
      var host = $("#stats-lista [data-jstats='" + String(id).replace(/'/g, "\\'") + "']");
      if (!host) return;
      var btn = host.querySelector("[data-jstats-btn]");
      host.classList.add("open");
      host.dataset.loaded = "1";
      if (btn) btn.innerHTML = "📊 Ocultar estatísticas ▴";
      if (COPA_JOGO_STATS.refreshHost) COPA_JOGO_STATS.refreshHost(host);
    });
  }
  function jogosAoVivoVisiveis(arr) {
    return (arr || []).filter(function (j) { return j && j.state === "in"; });
  }
  function atualizarStatusLive(arr) {
    var box = $("#stats-live-status");
    if (!box) return;
    var lives = (ABA === "jogos") ? jogosAoVivoVisiveis(arr || []) : [];
    if (!lives.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    var ult = LIVE_ULTIMA_ATUALIZACAO ? (" · última: <b>" + esc(LIVE_ULTIMA_ATUALIZACAO) + "</b>") : "";
    box.innerHTML = "🔴 Atualizando ao vivo a cada 30s" + ult;
  }
  function pararMonitorAoVivo() {
    if (LIVE_TIMER) {
      clearInterval(LIVE_TIMER);
      LIVE_TIMER = null;
    }
  }
  function iniciarMonitorAoVivo(arr) {
    var lives = jogosAoVivoVisiveis(arr || []);
    atualizarStatusLive(arr);
    if (ABA !== "jogos" || !lives.length) {
      pararMonitorAoVivo();
      return;
    }
    if (LIVE_TIMER) return;
    LIVE_TIMER = setInterval(atualizarJogosAoVivo, LIVE_REFRESH_MS);
  }
  async function atualizarJogosAoVivo() {
    if (LIVE_TICKING || ABA !== "jogos" || document.hidden) return;
    LIVE_TICKING = true;
    try {
      var r = await fetch(API_SCOREBOARD + "&_=" + Date.now());
      if (r.ok) {
        var j = await r.json();
        var novos = (j.events || []).map(normalizarJogo);
        if (novos.length) JOGOS = novos;
      }
      LIVE_ULTIMA_ATUALIZACAO = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      renderLista();
    } catch (e) {
      LIVE_ULTIMA_ATUALIZACAO = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      atualizarStatusLive(filtrar(listaDaAba()));
      if (window.COPA_JOGO_STATS && COPA_JOGO_STATS.refreshLive) COPA_JOGO_STATS.refreshLive($("#stats-lista"));
    } finally {
      LIVE_TICKING = false;
    }
  }

  function renderLista() {
    $$(".stat-tab").forEach(function (b) { b.classList.toggle("ativa", b.dataset.aba === ABA); });
    renderFiltro();
    var arr = filtrar(listaDaAba());
    var titulo = ABA === 'assistencias' ? 'Assistências' : (ABA === 'gols_selecao' ? 'Gols por seleção' : (ABA === 'jogos' ? 'Estatísticas por jogo' : (ABA === 'desempenho' ? 'Ranking de Desempenho' : 'Artilheiros')));
    $("#stats-titulo-lista").textContent = titulo;

    if (ABA === "desempenho") {
      pararMonitorAoVivo();
      atualizarStatusLive([]);
      $("#stats-contagem").textContent = arr.length ? (arr.length + " seleç" + (arr.length === 1 ? "ão" : "ões") + " · " + (SITUACAO_RANK === "TODAS" ? "todas" : SITUACAO_RANK.toLowerCase()) + " · " + (MIN_JOGOS_RANK || 1) + "+ jogos") : "sem dados";
      if (!arr.length) {
        $("#stats-lista").innerHTML = '<div class="stat-vazio">Nenhuma seleção encontrada para este filtro no Ranking de Desempenho.</div>';
        return;
      }
      $("#stats-lista").innerHTML = arr.map(desempenhoCard).join("");
      return;
    }

    if (ABA === 'jogos') {
      $("#stats-contagem").textContent = arr.length ? (arr.length + ' ' + (arr.length > 1 ? 'jogos' : 'jogo')) : 'sem jogos';
      if (!arr.length) {
        $("#stats-lista").innerHTML = '<div class="stat-vazio">Ainda não há partidas encerradas ou ao vivo para este filtro. Quando houver, o raio-x por jogo aparecerá aqui.</div>';
        iniciarMonitorAoVivo(arr);
        return;
      }
      arr.sort(function (a, b) { return new Date(b.date).getTime() - new Date(a.date).getTime(); });
      var abertos = idsJstatsAbertos();
      $("#stats-lista").innerHTML = arr.map(jogoCard).join('');
      if (window.COPA_JOGO_STATS && COPA_JOGO_STATS.bind) COPA_JOGO_STATS.bind($("#stats-lista"));
      restaurarJstatsAbertos(abertos);
      iniciarMonitorAoVivo(arr);
      return;
    }

    pararMonitorAoVivo();
    atualizarStatusLive([]);
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
        try { b.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }); } catch (e) {}
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

    var rostosReq = fetch('dados/rostos.json?v=' + Date.now()).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function () { return {}; });

    var rankingReq = fetch('dados/ranking-desempenho.json?v=' + Date.now()).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function () { return { ranking: [] }; });

    var ambos = await Promise.all([dadosReq, jogosReq, rostosReq, rankingReq]);
    DADOS = ambos[0] || DADOS;
    JOGOS = ambos[1] || [];
    ROSTOS = ambos[2] || {};
    RANKING_DESEMPENHO = ambos[3] || { ranking: [] };
    renderTudo();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pararMonitorAoVivo();
    else if (ABA === "jogos") renderLista();
  });
  document.addEventListener('DOMContentLoaded', function () {
    initTabs();
    carregar();
  });
})();
