/* =========================================================================
   palcos.js — Aba SEDES (Palcos da Copa 26)
   Lê dados/palcos.json (16 estádios + países-sede, curados) e, se existirem,
   as fotos locais em img/palcos/{id}.jpg (baixadas por buscar_fotos_palcos.py).
   Sem foto, o card degrada para um "hero" estilizado — nada quebra.
   ========================================================================= */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function flagUrl(iso2, w) {
    return "https://flagcdn.com/w" + (w || 40) + "/" + String(iso2 || "").toLowerCase() + ".png";
  }

  var DADOS = { paises: [], estadios: [] };
  var FILTRO = "";

  var COR_PAIS = { USA: "#3b5bdb", MEX: "#2f9e44", CAN: "#c92a2a" };

  function cardPais(p) {
    return '<div class="pal-pais">' +
      '<img class="pal-pais-flag" src="' + flagUrl(p.iso2, 80) + '" alt="" loading="lazy" width="44" height="30">' +
      '<div class="pal-pais-nome">' + esc(p.nome) + "</div>" +
      '<div class="pal-pais-meta">' + p.estadios + (p.estadios > 1 ? " estádios" : " estádio") + " · " + p.jogos + " jogos</div>" +
      (p.nota ? '<div class="pal-pais-nota">' + esc(p.nota) + "</div>" : "") +
      "</div>";
  }

  function heroEstadio(e) {
    var cor = COR_PAIS[e.pais] || "#3b5bdb";
    var foto = "img/palcos/" + esc(e.id) + ".jpg";
    return '<div class="pal-card-foto" style="--pc:' + cor + '">' +
      '<img src="' + foto + '" alt="' + esc(e.nomeReal) + '" loading="lazy" ' +
      'onerror="this.parentNode.classList.add(\'sem-img\');this.remove()">' +
      '<span class="pal-card-ini" aria-hidden="true">🏟️</span>' +
      '<img class="pal-card-flag" src="' + flagUrl(e.iso2, 40) + '" alt="" loading="lazy" width="22" height="15">' +
      (e.destaque ? '<span class="pal-card-dest">' + esc(e.destaque) + "</span>" : "") +
      "</div>";
  }

  function cardEstadio(e) {
    return '<article class="pal-card" data-pais="' + esc(e.pais) + '">' +
      heroEstadio(e) +
      '<div class="pal-card-corpo">' +
        '<div class="pal-card-nome">' + esc(e.nomeFifa) + "</div>" +
        '<div class="pal-card-real">' + esc(e.nomeReal) + "</div>" +
        '<div class="pal-card-cid">📍 ' + esc(e.cidade) + "</div>" +
        '<div class="pal-card-chips">' +
          '<span class="pal-mini">🏟️ ' + esc(e.capacidade) + "</span>" +
          '<span class="pal-mini">⚽ ' + e.jogos + " jogos</span>" +
        "</div>" +
        (e.curiosidade ? '<div class="pal-card-curio">' + esc(e.curiosidade) + "</div>" : "") +
      "</div>" +
      "</article>";
  }

  function renderPaises() {
    var el = $("#pal-paises");
    if (el) el.innerHTML = (DADOS.paises || []).map(cardPais).join("");
  }

  function renderGrid() {
    var arr = (DADOS.estadios || []).filter(function (e) { return !FILTRO || e.pais === FILTRO; });
    var el = $("#pal-grid");
    el.innerHTML = arr.length ? arr.map(cardEstadio).join("") : '<div class="pal-vazio">Não foi possível carregar os palcos.</div>';
  }

  function ligar() {
    var filtro = $("#pal-filtro");
    if (filtro) {
      filtro.addEventListener("click", function (ev) {
        var b = ev.target.closest(".pal-chip");
        if (!b) return;
        FILTRO = b.getAttribute("data-pais") || "";
        filtro.querySelectorAll(".pal-chip").forEach(function (c) { c.classList.remove("ativo"); });
        b.classList.add("ativo");
        renderGrid();
      });
    }
    document.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-creditos-palcos]")) { ev.preventDefault(); mostrarCreditos(); }
    });
  }

  var CRED_OK = false;
  function mostrarCreditos() {
    var box = $("#pal-creditos");
    if (!box) return;
    if (box.hidden) { box.hidden = false; } else { box.hidden = true; return; }
    if (CRED_OK) return;
    CRED_OK = true;
    box.innerHTML = '<div class="sel-cred-tit">Créditos das imagens</div><div class="sel-cred-load">Carregando…</div>';
    getJSON("dados/palcos_creditos.json").then(function (cj) {
      var itens = (cj && cj.creditos) || [];
      var html = '<div class="sel-cred-tit">Créditos das imagens</div>' +
        '<p class="sel-cred-intro">Fotos dos estádios via Wikipedia/Wikimedia Commons, com autor e licença abaixo quando exigido. Mascotes e bola: imagens oficiais FIFA/adidas, exibidas a título editorial (ver aviso legal na página).</p>';
      if (itens.length) {
        html += '<ul class="sel-cred-lista">' + itens.map(function (c) {
          var aut = c.autor ? esc(c.autor) : (c.fonte || "Wikimedia Commons");
          var lic = c.licenca ? " — " + esc(c.licenca) : "";
          return "<li><b>" + esc(c.nome || "") + "</b>: " + aut + lic + "</li>";
        }).join("") + "</ul>";
      } else {
        html += '<p class="sel-cred-intro">Créditos serão listados aqui quando as fotos forem baixadas (buscar_fotos_palcos.py).</p>';
      }
      box.innerHTML = html;
    });
  }

  function getJSON(u) {
    return fetch(u).then(function (r) { if (!r.ok) throw 0; return r.json(); }).catch(function () { return null; });
  }

  getJSON("dados/palcos.json").then(function (pj) {
    DADOS = pj || DADOS;
    if (!(DADOS.estadios || []).length) {
      $("#pal-grid").innerHTML = '<div class="pal-vazio">Não foi possível carregar os palcos.</div>';
      return;
    }
    renderPaises(); ligar(); renderGrid();
  });
})();
