/* =========================================================================
   aniversarios.js — Pop-up/banner de aniversário no módulo da Copa
   Reaproveita o membros.json do Brasileirão (um nível acima: ../membros.json).
   Mostra o pop-up 1x por dia por dispositivo e um banner permanente no topo.
   Independente do resto do site — só precisa ser incluído na página.
   ========================================================================= */
(function () {
  "use strict";
  var KEY_POPUP = "copa_popup_aniv_data";

  function hojeBrasilia() {
    var fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
    var o = {}; fmt.formatToParts(new Date()).forEach(function (p) { if (p.type !== "literal") o[p.type] = p.value; });
    return { dia: parseInt(o.day, 10), mes: parseInt(o.month, 10), chave: o.year + "-" + o.month + "-" + o.day };
  }

  function linkWhats(nome) {
    return "https://wa.me/?text=" + encodeURIComponent("Parabéns, " + nome + "! Tudo de bom no seu dia! 🎂");
  }

  function aniversariantesDeHoje(membros) {
    var h = hojeBrasilia();
    return (membros || []).filter(function (p) {
      return p.aniversario && p.aniversario.dia === h.dia && p.aniversario.mes === h.mes;
    });
  }

  function renderBanner(aniv) {
    var old = document.getElementById("banner-aniv-copa"); if (old) old.remove();
    if (!aniv.length) return;
    var div = document.createElement("div");
    div.id = "banner-aniv-copa";
    div.className = "banner-aniv-copa";
    var html = '<span style="font-size:18px">🎂</span>';
    if (aniv.length === 1) {
      html += "<span>Hoje é aniversário de <strong>" + aniv[0].nome + "</strong></span>";
      html += '<a href="' + linkWhats(aniv[0].nome) + '" target="_blank" rel="noopener" class="bac-link">Parabenizar 📱</a>';
    } else {
      html += "<span>Hoje fazem aniversário: <strong>" + aniv.map(function (p) { return p.nome; }).join(", ") + "</strong></span>";
      html += '<button class="bac-link" id="bac-vertodos">Ver todos</button>';
    }
    div.innerHTML = html;
    document.body.insertBefore(div, document.body.firstChild);
    var vt = document.getElementById("bac-vertodos");
    if (vt) vt.onclick = function () { mostrarPopup(aniv, true); };
  }

  function mostrarPopup(aniv, forcado) {
    if (!aniv.length) return;
    var h = hojeBrasilia();
    if (!forcado && localStorage.getItem(KEY_POPUP) === h.chave) return; // já mostrou hoje
    var cartoes = aniv.map(function (p) {
      return '<div class="bac-card"><div class="bac-nome">' + p.nome + "</div>" +
        '<a href="' + linkWhats(p.nome) + '" target="_blank" rel="noopener" class="bac-btn">📱 Mandar parabéns no WhatsApp</a></div>';
    }).join("");
    var modal = document.createElement("div");
    modal.className = "bac-backdrop";
    modal.innerHTML = '<div class="bac-modal"><div style="font-size:46px">🎂</div>' +
      '<h2 style="margin:6px 0 14px">Hoje é aniversário!</h2>' + cartoes +
      '<button class="bac-fechar" id="bac-fechar">Fechar</button></div>';
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    document.getElementById("bac-fechar").onclick = function () { modal.remove(); };
    if (!forcado) localStorage.setItem(KEY_POPUP, h.chave);
  }

  function init() {
    // membros.json fica na raiz do site (um nível acima do módulo copa2026/)
    fetch("../membros.json?t=" + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var aniv = aniversariantesDeHoje((data && data.membros) || []);
        if (!aniv.length) return;
        renderBanner(aniv);
        mostrarPopup(aniv, false);
      })
      .catch(function () { /* silencioso: sem internet ou arquivo, não atrapalha a Copa */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
