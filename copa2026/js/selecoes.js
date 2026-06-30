/* =========================================================================
   selecoes.js — Aba SELEÇÕES
   Lê dados/selecoes.json (países/grupos/iso2), dados/paises.json (curiosidades)
   e dados/elencos.json (elenco + fotos, gerado por buscar_selecoes.py).
   Degrada com elegância: sem elencos.json populado, mostra silhuetas.
   ========================================================================= */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  }
  function flagUrl(iso2, w) {
    if (!iso2) return "";
    return "https://flagcdn.com/w" + (w || 80) + "/" + String(iso2).toLowerCase() + ".png";
  }
  function silhueta() {
    return '<span class="sel-face sel-face-ph" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="58%" height="58%"><path fill="currentColor" d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-4.4 0-9 2.2-9 6v2h18v-2c0-3.8-4.6-6-9-6Z"/></svg>' +
      '</span>';
  }

  var SEL = [], PAISES = {}, ELENCOS = {};

  function cardHTML(s) {
    var pa = PAISES[s.id] || {};
    var copas = pa.copas ? '<span class="sel-card-copas" title="Títulos mundiais">' + "★".repeat(Math.min(pa.copas, 5)) + "</span>" : "";
    return '<button class="sel-card" type="button" data-id="' + esc(s.id) + '">' +
      '<img class="sel-flag" src="' + flagUrl(s.iso2, 80) + '" alt="" loading="lazy" width="48" height="32">' +
      '<span class="sel-card-nome">' + esc(s.nome) + "</span>" +
      '<span class="sel-card-meta">Grupo ' + esc(s.grupo || "?") + copas + "</span>" +
      "</button>";
  }

  function renderLista() {
    var el = $("#sel-scroller");
    el.innerHTML = SEL.length ? SEL.map(cardHTML).join("") : '<div class="sel-vazio">Não foi possível carregar as seleções.</div>';
  }

  function squadHTML(id) {
    var lista = (ELENCOS.times && ELENCOS.times[id]) || [];
    if (!lista.length) {
      return '<div class="sel-squad-vazio">Elenco em breve — atualiza automaticamente a partir da ESPN.</div>';
    }
    lista = lista.slice().sort(function (a, b) {
      var na = parseInt(a.num, 10), nb = parseInt(b.num, 10);
      if (isNaN(na)) na = 999; if (isNaN(nb)) nb = 999;
      return na - nb || String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    });
    return '<div class="sel-squad">' + lista.map(function (p) {
      var face = p.foto ? '<span class="sel-face"><img src="' + esc(p.foto) + '" alt="" loading="lazy"></span>' : silhueta();
      var sub = [p.pos, p.num].filter(Boolean).join(" · ");
      return '<div class="sel-player">' + face +
        '<span class="sel-player-nome">' + esc(p.nome || "—") + "</span>" +
        (sub ? '<span class="sel-player-pos">' + esc(sub) + "</span>" : "") +
        "</div>";
    }).join("") + "</div>";
  }

  function fact(label, val) {
    return val ? '<div class="sel-fact"><span>' + esc(label) + "</span><b>" + esc(val) + "</b></div>" : "";
  }

  function abreFicha(id) {
    var s = SEL.find(function (x) { return x.id === id; });
    if (!s) return;
    var pa = PAISES[id] || {};
    var trofeus = pa.copas ? '<div class="sel-det-copas"><span class="sel-det-trofeus" title="Títulos mundiais">' +
      "🏆".repeat(Math.min(pa.copas, 5)) + " <small>" + pa.copas + (pa.copas > 1 ? " títulos mundiais" : " título mundial") + "</small></span></div>" : "";
    var html =
      '<button class="sel-voltar" type="button">‹ Todas as seleções</button>' +
      '<div class="sel-det-head">' +
        '<img class="sel-det-flag" src="' + flagUrl(s.iso2, 160) + '" alt="Bandeira: ' + esc(s.nome) + '" width="72" height="48">' +
        '<div class="sel-det-id"><div class="sel-det-nome">' + esc(s.nome) + "</div>" +
          (pa.apelido ? '<div class="sel-det-apelido">"' + esc(pa.apelido) + '"</div>' : "") + "</div>" +
        '<div class="sel-det-grupo">Grupo ' + esc(s.grupo || "?") + "</div>" +
      "</div>" +
      trofeus +
      '<div class="sel-facts">' +
        fact("Capital", pa.capital) +
        fact("População", pa.populacao) +
        fact("Língua", pa.lingua) +
        fact("Continente", pa.continente) +
      "</div>" +
      (pa.curiosidade ? '<div class="sel-curio"><b>Você sabia?</b> ' + esc(pa.curiosidade) + "</div>" : "") +
      '<div class="sel-squad-head">Convocados</div>' +
      squadHTML(id);
    var det = $("#sel-detalhe");
    det.innerHTML = html; det.hidden = false;
    $("#sel-scroller").hidden = true; $("#sel-hint").hidden = true;
    if (window.history && history.replaceState) { try { history.replaceState(null, "", "#" + id); } catch (e) {} }
    window.scrollTo(0, 0);
  }

  function voltar() {
    var det = $("#sel-detalhe"); det.hidden = true; det.innerHTML = "";
    $("#sel-scroller").hidden = false; $("#sel-hint").hidden = false;
    if (window.history && history.replaceState) { try { history.replaceState(null, "", location.pathname); } catch (e) {} }
  }

  function ligar() {
    $("#sel-scroller").addEventListener("click", function (e) {
      var b = e.target.closest(".sel-card"); if (b) abreFicha(b.getAttribute("data-id"));
    });
    $("#sel-detalhe").addEventListener("click", function (e) {
      if (e.target.closest(".sel-voltar")) voltar();
    });
    window.addEventListener("hashchange", function () {
      var h = (location.hash || "").replace("#", "").toUpperCase();
      if (h && SEL.find(function (x) { return x.id === h; })) abreFicha(h); else voltar();
    });
  }

  function getJSON(u) {
    return fetch(u).then(function (r) { if (!r.ok) throw 0; return r.json(); }).catch(function () { return null; });
  }

  Promise.all([getJSON("dados/selecoes.json"), getJSON("dados/paises.json"), getJSON("dados/elencos.json")])
    .then(function (res) {
      var sj = res[0] || {}, pj = res[1] || {}, ej = res[2] || {};
      SEL = ((sj.selecoes) || []).map(function (s) { return { id: s.id, nome: s.nome, grupo: s.grupo, iso2: s.iso2 }; });
      SEL.sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome), "pt-BR"); });
      PAISES = (pj.paises) || {};
      ELENCOS = ej || {};
      if (!SEL.length) { $("#sel-scroller").innerHTML = '<div class="sel-vazio">Não foi possível carregar as seleções.</div>'; return; }
      ligar(); renderLista();
      var h = (location.hash || "").replace("#", "").toUpperCase();
      if (h && SEL.find(function (x) { return x.id === h; })) abreFicha(h);
    });
})();
