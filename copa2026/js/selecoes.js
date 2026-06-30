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

  function flagEmoji(iso2) {
    iso2 = String(iso2 || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2)) return "🌎";
    return iso2.replace(/./g, function (c) {
      return String.fromCodePoint(127397 + c.charCodeAt(0));
    });
  }
  var PAL_AVATAR = ["#3b5bdb", "#2f9e44", "#e8590c", "#9c36b5", "#1098ad", "#c2255c", "#0c8599", "#5c7cfa"];
  function corAvatar(nome) {
    var s = norm(nome), h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return PAL_AVATAR[h % PAL_AVATAR.length];
  }
  function iniciais(nome) {
    var t = norm(nome).split(" ").filter(Boolean);
    if (!t.length) return "?";
    if (t.length >= 2) return (t[0][0] + t[t.length - 1][0]).toUpperCase();
    return t[0].slice(0, 2).toUpperCase();
  }
  function avatar(nome) {
    return '<span class="sel-face sel-face-ini" style="background:' + corAvatar(nome) + '" aria-hidden="true">' +
      esc(iniciais(nome)) + "</span>";
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


  function menuPaisHTML(s) {
    return '<option value="' + esc(s.id) + '">' +
      esc(flagEmoji(s.iso2) + " " + s.nome + " (" + s.id + ")") +
    '</option>';
  }

  function renderMenuPaises() {
    var el = $("#sel-menu-paises");
    if (!el) return;
    el.innerHTML = '<option value="">🌎 Escolha uma seleção</option>' +
      (SEL.length ? SEL.map(menuPaisHTML).join("") : '<option value="">Não foi possível carregar os países</option>');
  }

  function marcaPaisAtivo(id) {
    var el = $("#sel-menu-paises");
    if (!el) return;
    el.value = id || "";
  }

  function renderLista() {
    var el = $("#sel-scroller");
    el.innerHTML = SEL.length ? SEL.map(cardHTML).join("") : '<div class="sel-vazio">Não foi possível carregar as seleções.</div>';
  }

  function pluralJogadores(n) {
    return n === 1 ? "1 jogador" : n + " jogadores";
  }

  function squadHTML(id) {
    var lista = (ELENCOS.times && ELENCOS.times[id]) || [];
    if (!lista.length) {
      return '<details class="sel-squad-box">' +
        '<summary class="sel-squad-toggle"><span>👥 Ver convocados</span><small>elenco em breve</small></summary>' +
        '<div class="sel-squad-vazio">Elenco em breve — atualiza automaticamente a partir da ESPN.</div>' +
      '</details>';
    }
    lista = lista.slice().sort(function (a, b) {
      var na = parseInt(a.num, 10), nb = parseInt(b.num, 10);
      if (isNaN(na)) na = 999; if (isNaN(nb)) nb = 999;
      return na - nb || String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    });
    return '<details class="sel-squad-box">' +
      '<summary class="sel-squad-toggle">' +
        '<span class="sel-squad-closed">👥 Ver convocados</span>' +
        '<span class="sel-squad-open">👥 Ocultar convocados</span>' +
        '<small>' + esc(pluralJogadores(lista.length)) + '</small>' +
      '</summary>' +
      '<div class="sel-squad">' + lista.map(function (p) {
        var face = p.foto ? '<span class="sel-face"><img src="' + esc(p.foto) + '" alt="" loading="lazy"></span>' : avatar(p.nome);
        var sub = [p.pos, p.num].filter(Boolean).join(" · ");
        return '<div class="sel-player">' + face +
          '<span class="sel-player-nome">' + esc(p.nome || "—") + "</span>" +
          (sub ? '<span class="sel-player-pos">' + esc(sub) + "</span>" : "") +
          "</div>";
      }).join("") + "</div>" +
    "</details>";
  }

  function fact(label, val) {
    return val ? '<div class="sel-fact"><span>' + esc(label) + "</span><b>" + esc(val) + "</b></div>" : "";
  }

  function abreFicha(id) {
    var s = SEL.find(function (x) { return x.id === id; });
    if (!s) return;
    marcaPaisAtivo(id);
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
    marcaPaisAtivo("");
    $("#sel-scroller").hidden = false; $("#sel-hint").hidden = false;
    if (window.history && history.replaceState) { try { history.replaceState(null, "", location.pathname); } catch (e) {} }
  }

  function ligar() {
    $("#sel-scroller").addEventListener("click", function (e) {
      var b = e.target.closest(".sel-card"); if (b) abreFicha(b.getAttribute("data-id"));
    });
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-creditos]")) { e.preventDefault(); mostrarCreditos(); }
    });
    var menu = $("#sel-menu-paises");
    if (menu) {
      menu.addEventListener("change", function () {
        if (menu.value) abreFicha(menu.value);
      });
    }
    $("#sel-detalhe").addEventListener("click", function (e) {
      if (e.target.closest(".sel-voltar")) voltar();
    });
    window.addEventListener("hashchange", function () {
      var h = (location.hash || "").replace("#", "").toUpperCase();
      if (h && SEL.find(function (x) { return x.id === h; })) abreFicha(h); else voltar();
    });
  }

  var CRED_CARREGADO = false;
  function mostrarCreditos() {
    var box = document.getElementById("sel-creditos");
    if (!box) return;
    if (box.hidden) { box.hidden = false; } else { box.hidden = true; return; }
    if (CRED_CARREGADO) return;
    CRED_CARREGADO = true;
    box.innerHTML = '<div class="sel-cred-tit">Créditos das imagens</div><div class="sel-cred-load">Carregando…</div>';
    getJSON("dados/rostos_creditos.json").then(function (cj) {
      var itens = (cj && cj.creditos) || [];
      var html = '<div class="sel-cred-tit">Créditos das imagens</div>';
      html += '<p class="sel-cred-intro">Fotos: ESPN, Wikipedia e Wikimedia Commons quando disponíveis; quando não há fonte segura, exibimos um avatar com as iniciais.</p>';
      if (itens.length) {
        html += '<ul class="sel-cred-lista">' + itens.map(function (c) {
          var aut = c.autor ? esc(c.autor) : (c.fonte || "");
          var lic = c.licenca ? " — " + esc(c.licenca) : "";
          return "<li><b>" + esc(c.nome || "") + "</b> (" + esc(c.selecao || "") + "): " + aut + lic + "</li>";
        }).join("") + "</ul>";
      } else {
        html += '<p class="sel-cred-intro">Ainda não há imagens licenciadas registradas (o robô preenche ao rodar).</p>';
      }
      box.innerHTML = html;
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
      renderMenuPaises(); ligar(); renderLista();
      var h = (location.hash || "").replace("#", "").toUpperCase();
      if (h && SEL.find(function (x) { return x.id === h; })) abreFicha(h);
    });
})();
