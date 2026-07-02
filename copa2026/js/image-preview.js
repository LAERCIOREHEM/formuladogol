/* =========================================================================
   image-preview.js — lightbox simples e reutilizável
   Abre foto ampliada em cards com data-image-preview.
   Funciona por clique/toque, com ESC, botão fechar e clique no fundo.
   ========================================================================= */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var modal = null;
  var ultimoFoco = null;

  function criarModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "copa-img-preview";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Visualização ampliada da imagem");
    modal.innerHTML =
      '<div class="copa-img-preview-backdrop" data-preview-close></div>' +
      '<div class="copa-img-preview-card" role="document">' +
        '<button class="copa-img-preview-close" type="button" data-preview-close aria-label="Fechar imagem ampliada">×</button>' +
        '<div class="copa-img-preview-media"><img alt="" loading="eager"></div>' +
        '<div class="copa-img-preview-caption" hidden>' +
          '<strong></strong>' +
          '<span></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-preview-close]")) fechar();
    });
    return modal;
  }

  function abrir(el) {
    var src = el.getAttribute("data-image-preview") || "";
    if (!src) return;
    var m = criarModal();
    var img = m.querySelector("img");
    var cap = m.querySelector(".copa-img-preview-caption");
    var tit = m.querySelector(".copa-img-preview-caption strong");
    var sub = m.querySelector(".copa-img-preview-caption span");
    var title = el.getAttribute("data-preview-title") || el.getAttribute("aria-label") || "";
    var subtitle = el.getAttribute("data-preview-subtitle") || "";

    ultimoFoco = document.activeElement;
    img.src = src;
    img.alt = title ? ("Imagem ampliada: " + title) : "Imagem ampliada";
    tit.innerHTML = esc(title);
    sub.innerHTML = esc(subtitle);
    cap.hidden = !(title || subtitle);
    m.hidden = false;
    document.documentElement.classList.add("copa-preview-open");
    window.setTimeout(function () { m.classList.add("ativo"); }, 10);
    var btn = m.querySelector(".copa-img-preview-close");
    if (btn) btn.focus({ preventScroll: true });
  }

  function fechar() {
    if (!modal || modal.hidden) return;
    modal.classList.remove("ativo");
    document.documentElement.classList.remove("copa-preview-open");
    window.setTimeout(function () {
      if (!modal.classList.contains("ativo")) {
        modal.hidden = true;
        var img = modal.querySelector("img");
        if (img) img.removeAttribute("src");
      }
    }, 180);
    if (ultimoFoco && ultimoFoco.focus) {
      try { ultimoFoco.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-image-preview]");
    if (!el) return;
    if (ev.target.closest("a, button, select, input, textarea")) return;
    ev.preventDefault();
    abrir(el);
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") fechar();
    if ((ev.key === "Enter" || ev.key === " ") && document.activeElement) {
      var el = document.activeElement.closest && document.activeElement.closest("[data-image-preview]");
      if (el) { ev.preventDefault(); abrir(el); }
    }
  });
})();
