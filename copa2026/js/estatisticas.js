/* =========================================================================
   estatisticas.js — Artilheiros, assistências e cartões da Copa 2026
   Consome dados/estatisticas.json gerado por buscar_estatisticas.py.
   Não mexe em palpites, pontos, engine nem regras do bolão.
   ========================================================================= */
(function () {
  "use strict";

  var DADOS = null;
  var ABA = "artilheiros";
  var FILTRO = "TODAS";

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
    if (ABA === "assistencias") return DADOS.assistencias || [];
    if (ABA === "cartoes") return DADOS.cartoes || [];
    return DADOS.artilheiros || [];
  }

  function valorPrincipal(item) {
    if (ABA === "assistencias") return item.assistencias || 0;
    if (ABA === "cartoes") return (item.vermelhos || 0) + (item.amarelos || 0);
    return item.gols || 0;
  }

  function rotuloValor(v) {
    if (ABA === "assistencias") return v === 1 ? "assistência" : "assistências";
    if (ABA === "cartoes") return v === 1 ? "cartão" : "cartões";
    return v === 1 ? "gol" : "gols";
  }

  function filtrar(arr) {
    if (FILTRO === "TODAS") return arr;
    return arr.filter(function (x) { return x.equipe === FILTRO; });
  }

  function renderResumo() {
    var gols = (DADOS.artilheiros || [])[0];
    var ass = (DADOS.assistencias || [])[0];
    var car = (DADOS.cartoes || [])[0];
    var cards = [
      { tit: "Artilheiro", item: gols, val: gols ? gols.gols : 0, suf: "gols", ico: "⚽" },
      { tit: "Garçom", item: ass, val: ass ? ass.assistencias : 0, suf: "assist.", ico: "🎯" },
      { tit: "Cartões", item: car, val: car ? ((car.amarelos || 0) + (car.vermelhos || 0)) : 0, suf: "cartões", ico: "🟥" }
    ];
    $("#stats-resumo").innerHTML = cards.map(function (c) {
      if (!c.item) {
        return '<div class="stat-res-card"><div class="stat-res-ico">' + c.ico + '</div><div><b>' + c.tit + '</b><span>Aguardando dados</span></div></div>';
      }
      return '<div class="stat-res-card">' +
        '<div class="stat-res-ico">' + c.ico + '</div>' +
        '<div class="stat-res-info"><b>' + esc(c.tit) + '</b>' +
        '<strong>' + esc(c.item.nome) + '</strong>' +
        '<span>' + flag(c.item.equipe) + esc(nomeSelecao(c.item.equipe)) + ' · ' + c.val + ' ' + esc(c.suf) + '</span></div>' +
      '</div>';
    }).join("");
  }

  function renderFiltro() {
    var sel = $("#stat-selecao");
    var equipes = {};
    ["artilheiros", "assistencias", "cartoes"].forEach(function (k) {
      (DADOS[k] || []).forEach(function (x) { if (x.equipe) equipes[x.equipe] = true; });
    });
    var lista = Object.keys(equipes).sort(function (a, b) { return nomeSelecao(a).localeCompare(nomeSelecao(b), "pt-BR"); });
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
    var meta = ABA === "cartoes"
      ? detalheCartoes(item)
      : '<span class="stat-muted">' + (item.jogos && item.jogos.length ? item.jogos.length : 1) + ' jogo' + ((item.jogos || []).length > 1 ? 's' : '') + '</span>';
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
    var titulo = ABA === "assistencias" ? "Assistências" : (ABA === "cartoes" ? "Cartões" : "Artilheiros");
    $("#stats-titulo-lista").textContent = titulo;
    $("#stats-contagem").textContent = arr.length ? (arr.length + " jogador" + (arr.length > 1 ? "es" : "")) : "sem dados";
    if (!arr.length) {
      $("#stats-lista").innerHTML = '<div class="stat-vazio">Ainda não há dados disponíveis para esta aba. A ESPN pode levar alguns minutos para disponibilizar gols, assistências e cartões no feed.</div>';
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
