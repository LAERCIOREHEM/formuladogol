/* =========================================================================
   estatisticas.js — Artilheiros, assistências e gols por seleção da Copa 2026
   Consome dados/estatisticas.json gerado por buscar_estatisticas.py.
   Não mexe em palpites, pontos, engine nem regras do bolão.
   ========================================================================= */
(function () {
  "use strict";

  var DADOS = null;
  var ABA = "artilheiros";
  var FILTRO = "TODAS";
  var SELECOES = [];

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>'"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c];
    });
  }

  function nomeSelecao(sigla) {
    if (window.COPA_TIMES && COPA_TIMES.nome) return COPA_TIMES.nome(sigla);
    return sigla || "—";
  }

  function flag(sigla) {
    if (!sigla) return "";
    var src = window.COPA_TIMES && COPA_TIMES.flag ? COPA_TIMES.flag(sigla, 80) : "";
    return src ? '<img class="stat-flag" src="' + esc(src) + '" alt="" loading="lazy">' : "";
  }

  function siglaSelecao(valor) {
    if (!valor) return "";
    if (window.COPA_TIMES && COPA_TIMES.sigla) return COPA_TIMES.sigla(valor) || valor;
    return valor;
  }

  function todasSiglas() {
    var mapa = {};
    (SELECOES || []).forEach(function (s) {
      if (s && s.id) mapa[s.id] = true;
    });
    if (DADOS) {
      ["artilheiros", "assistencias", "cartoes", "por_selecao"].forEach(function (k) {
        (DADOS[k] || []).forEach(function (x) {
          var eq = siglaSelecao(x.equipe);
          if (eq) mapa[eq] = true;
        });
      });
    }
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

  function listaDaAba() {
    if (!DADOS) return [];
    if (ABA === "assistencias") return (DADOS.assistencias || []).map(normalizarItemEquipe);
    if (ABA === "gols_selecao") {
      return completarGolsPorSelecao(DADOS.por_selecao || []).sort(function (a, b) {
        return (b.gols || 0) - (a.gols || 0) || (b.media_gols || 0) - (a.media_gols || 0) || nomeSelecao(a.equipe).localeCompare(nomeSelecao(b.equipe), "pt-BR");
      });
    }
    return (DADOS.artilheiros || []).map(normalizarItemEquipe);
  }

  function valorPrincipal(item) {
    if (ABA === "assistencias") return item.assistencias || 0;
    return item.gols || 0;
  }

  function rotuloValor(v) {
    if (ABA === "assistencias") return v === 1 ? "assistência" : "assistências";
    return v === 1 ? "gol" : "gols";
  }

  function filtrar(arr) {
    if (FILTRO === "TODAS") return arr;
    return arr.filter(function (x) { return x.equipe === FILTRO; });
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
    var cards = [
      { tit: "Artilheiro", item: gols, val: gols ? gols.gols : 0, suf: "gols", ico: "⚽", tipo: "jogador" },
      { tit: "Garçom", item: ass, val: ass ? ass.assistencias : 0, suf: "assist.", ico: "🎯", tipo: "jogador" },
      { tit: "Melhor ataque", item: ataque, val: ataque ? ataque.gols : 0, suf: "gols", ico: "🥅", tipo: "selecao" }
    ];
    $("#stats-resumo").innerHTML = cards.map(function (c) {
      if (!c.item) {
        return '<div class="stat-res-card"><div class="stat-res-ico">' + c.ico + '</div><div><b>' + c.tit + '</b><span>Aguardando dados</span></div></div>';
      }
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

  function renderFiltro() {
    var sel = $("#stat-selecao");
    var lista = todasSiglas();
    sel.innerHTML = '<option value="TODAS">Todas as seleções</option>' + lista.map(function (s) {
      return '<option value="' + esc(s) + '">' + esc(nomeSelecao(s)) + '</option>';
    }).join("");
    sel.value = FILTRO;
    sel.onchange = function () { FILTRO = sel.value; renderLista(); };
  }

  function detalheCartoes(x) {
    var a = x.amarelos || 0, v = x.vermelhos || 0;
    var partes = [];
    if (a) partes.push('<span class="stat-cardtag amarelo">' + a + ' amarelo' + (a > 1 ? 's' : '') + '</span>');
    if (v) partes.push('<span class="stat-cardtag vermelho">' + v + ' vermelho' + (v > 1 ? 's' : '') + '</span>');
    return partes.join(" ") || '<span class="stat-muted">—</span>';
  }

  function row(item, idx) {
    var val = valorPrincipal(item);
    if (ABA === "gols_selecao") {
      var jogos = item.jogos || item.partidas || 0;
      var media = item.media_gols || (jogos ? (val / jogos) : 0);
      var metaSel = jogos
        ? '<span class="stat-muted">' + jogos + ' jogo' + (jogos > 1 ? 's' : '') + ' · média ' + media.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + '</span>'
        : '<span class="stat-muted">gols marcados pela seleção</span>';
      return '<article class="stat-row stat-row-selecao">' +
        '<div class="stat-pos">' + (idx + 1) + 'º</div>' +
        '<div class="stat-player">' +
          '<strong>' + esc(nomeSelecao(item.equipe)) + '</strong>' +
          '<span>' + flag(item.equipe) + esc(item.equipe || "—") + '</span>' +
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
        '<strong>' + esc(item.nome || "—") + '</strong>' +
        '<span>' + flag(item.equipe) + esc(nomeSelecao(item.equipe)) + '</span>' +
        '<div class="stat-mobile-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="stat-meta">' + meta + '</div>' +
      '<div class="stat-num"><b>' + val + '</b><small>' + esc(rotuloValor(val)) + '</small></div>' +
    '</article>';
  }

  function renderLista() {
    $$(".stat-tab").forEach(function (b) { b.classList.toggle("ativa", b.dataset.aba === ABA); });
    var arr = filtrar(listaDaAba());
    var titulo = ABA === "assistencias" ? "Assistências" : (ABA === "gols_selecao" ? "Gols por seleção" : "Artilheiros");
    $("#stats-titulo-lista").textContent = titulo;
    $("#stats-contagem").textContent = arr.length
      ? (arr.length + " " + (ABA === "gols_selecao" ? (arr.length > 1 ? "seleções" : "seleção") : (arr.length > 1 ? "jogadores" : "jogador")))
      : "sem dados";
    if (!arr.length) {
      $("#stats-lista").innerHTML = '<div class="stat-vazio">Ainda não há dados disponíveis para esta aba. A ESPN pode levar alguns minutos para disponibilizar gols e assistências no feed.</div>';
      return;
    }
    $("#stats-lista").innerHTML = arr.map(row).join("");
  }

  function initTabs() {
    $$(".stat-tab").forEach(function (b) {
      b.onclick = function () {
        ABA = b.dataset.aba || "artilheiros";
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
    try {
      if (window.COPA_TIMES && COPA_TIMES.carregar) await COPA_TIMES.carregar();
    } catch (e) {}
    try {
      var rs = await fetch("dados/selecoes.json?v=" + Date.now());
      if (rs.ok) {
        var js = await rs.json();
        SELECOES = js.selecoes || [];
      }
    } catch (e) {}
    try {
      var r = await fetch("dados/estatisticas.json?v=" + Date.now());
      if (!r.ok) throw new Error("HTTP " + r.status);
      DADOS = await r.json();
      renderTudo();
    } catch (e) {
      $("#stats-lista").innerHTML = '<div class="stat-vazio erro">Não consegui carregar dados/estatisticas.json agora. Tente atualizar a página em instantes.</div>';
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTabs();
    carregar();
  });
})();
