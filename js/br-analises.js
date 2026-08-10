(() => {
  "use strict";

  let modalAtual = null;
  let focoAnterior = null;
  let overflowAnterior = "";

  function fecharVideo() {
    if (!modalAtual) return;
    const iframe = modalAtual.querySelector("iframe");
    if (iframe) iframe.src = "about:blank";
    modalAtual.remove();
    modalAtual = null;
    document.body.style.overflow = overflowAnterior;
    if (focoAnterior && document.body.contains(focoAnterior)) focoAnterior.focus();
    focoAnterior = null;
  }

  function controlarTeclado(evento) {
    if (!modalAtual) return;
    if (evento.key === "Escape") {
      fecharVideo();
      return;
    }
    if (evento.key !== "Tab") return;
    const focaveis = [...modalAtual.querySelectorAll('button,iframe,[href],[tabindex]:not([tabindex="-1"])')]
      .filter((elemento) => !elemento.hasAttribute("disabled"));
    if (!focaveis.length) return;
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (evento.shiftKey && document.activeElement === primeiro) {
      evento.preventDefault();
      ultimo.focus();
    } else if (!evento.shiftKey && document.activeElement === ultimo) {
      evento.preventDefault();
      primeiro.focus();
    }
  }

  function fonteEhCaze(value) {
    const raw = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return raw.includes("cazetv") || raw.includes("caze tv");
  }

  function abrirVideo(botao) {
    const videoId = String(botao.dataset.videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return;
    if (fonteEhCaze(botao.dataset.videoSource)) {
      window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, "_blank", "noopener,noreferrer");
      return;
    }
    fecharVideo();

    focoAnterior = botao;
    overflowAnterior = document.body.style.overflow;
    const titulo = String(botao.dataset.videoTitle || "Melhores momentos").trim();
    const fonte = String(botao.dataset.videoSource || "YouTube").trim();
    const modal = document.createElement("div");
    modal.className = "analysis-media-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "analysis-media-title");
    modal.innerHTML = `<section class="analysis-media-card">
      <header class="analysis-media-header">
        <strong id="analysis-media-title"></strong>
        <button type="button" class="analysis-media-close" aria-label="Fechar vídeo">×</button>
      </header>
      <div class="analysis-media-frame"><iframe loading="eager"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>
      <footer class="analysis-media-footer"></footer>
    </section>`;
    modal.querySelector("#analysis-media-title").textContent = titulo;
    modal.querySelector(".analysis-media-footer").textContent = `Vídeo publicado por ${fonte} e reproduzido no Fórmula do Gol.`;
    const iframe = modal.querySelector("iframe");
    iframe.title = titulo;
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0&playsinline=1`;
    modal.addEventListener("click", (evento) => {
      if (evento.target === modal || evento.target.closest(".analysis-media-close")) fecharVideo();
    });

    modalAtual = modal;
    document.body.style.overflow = "hidden";
    document.body.appendChild(modal);
    modal.querySelector(".analysis-media-close").focus();
  }


  function abrirVideoInline(botao) {
    const videoId = String(botao.dataset.videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    if (fonteEhCaze(botao.dataset.videoSource)) {
      window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, "_blank", "noopener,noreferrer");
      return;
    }
    const titulo = String(botao.dataset.videoTitle || "Melhores momentos").trim();
    const fonte = String(botao.dataset.videoSource || "YouTube oficial").trim();
    const container = botao.closest(".analysis-cup-leg");
    if (!container) return;
    const previous = container.querySelector(".analysis-cup-video-inline");
    if (previous) previous.remove();
    botao.hidden = true;

    const frame = document.createElement("div");
    frame.className = "analysis-cup-video-inline";
    frame.innerHTML = `<div class="analysis-cup-video-inline-head">
      <span>▶ Melhores momentos</span>
      <button type="button" class="analysis-cup-video-inline-close" aria-label="Fechar melhores momentos">×</button>
    </div>
    <div class="analysis-cup-video-inline-frame"><iframe loading="eager"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>
    <small class="analysis-cup-video-inline-source"></small>`;
    const iframe = frame.querySelector("iframe");
    iframe.title = titulo;
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0&playsinline=1`;
    frame.querySelector(".analysis-cup-video-inline-source").textContent = `Vídeo oficial: ${fonte}`;
    frame.querySelector(".analysis-cup-video-inline-close").addEventListener("click", () => {
      iframe.src = "about:blank";
      frame.remove();
      botao.hidden = false;
      botao.focus();
    });
    container.appendChild(frame);
    frame.querySelector(".analysis-cup-video-inline-close").focus();
  }

  function alternarEstatisticas(botao) {
    const id = botao.getAttribute("aria-controls");
    const painel = id ? document.getElementById(id) : null;
    if (!painel) return;
    const abrir = painel.hidden;
    painel.hidden = !abrir;
    botao.setAttribute("aria-expanded", String(abrir));
    botao.textContent = `${abrir ? "▾" : "▸"} Estatísticas do jogo`;
  }

  document.addEventListener("click", (evento) => {
    const botaoInline = evento.target.closest(".analysis-inline-video");
    if (botaoInline) {
      abrirVideoInline(botaoInline);
      return;
    }
    const botaoVideo = evento.target.closest(".analysis-video");
    if (botaoVideo) {
      abrirVideo(botaoVideo);
      return;
    }
    const botaoEstatisticas = evento.target.closest(".analysis-stats-toggle");
    if (botaoEstatisticas) alternarEstatisticas(botaoEstatisticas);
  });
  document.addEventListener("keydown", controlarTeclado);
})();
