(() => {
  "use strict";

  const RETURN_KEY = "br:clube:retorno:v1";
  const RESTORE_KEY = "br:clube:restaurar:v1";
  const MAX_AGE_MS = 6 * 60 * 60 * 1000;

  function safeJson(raw) {
    try { return JSON.parse(raw || "null"); } catch (_) { return null; }
  }

  function storageGet(key) {
    try { return sessionStorage.getItem(key); } catch (_) { return null; }
  }

  function storageSet(key, value) {
    try { sessionStorage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function storageRemove(key) {
    try { sessionStorage.removeItem(key); } catch (_) {}
  }

  function normalizePath(pathname) {
    const path = String(pathname || "/").replace(/\/+/g, "/");
    if (path.endsWith("/index.html")) return path.slice(0, -"index.html".length);
    return path || "/";
  }

  function samePage(a, b) {
    try {
      const ua = new URL(a, location.href);
      const ub = new URL(b, location.href);
      return ua.origin === ub.origin &&
        normalizePath(ua.pathname) === normalizePath(ub.pathname) &&
        ua.search === ub.search;
    } catch (_) {
      return false;
    }
  }

  function sourceInfo(href) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      const path = normalizePath(url.pathname).toLowerCase();
      if (path.endsWith("/aovivo.html")) return { label: "Ao vivo", view: "aovivo" };
      if (path.endsWith("/clubes.html")) return null;
      if (path === "/" || path.endsWith("/")) {
        const view = String(url.searchParams.get("view") || "jogos").toLowerCase();
        if (view === "resultados") return { label: "Resultados", view };
        if (view === "jogos") return { label: "Jogos", view };
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function validContext(ctx) {
    return Boolean(ctx && ctx.href && ctx.label && Number.isFinite(Number(ctx.ts)) && Date.now() - Number(ctx.ts) <= MAX_AGE_MS);
  }

  function readContext() {
    const stored = safeJson(storageGet(RETURN_KEY));
    if (validContext(stored)) return stored;
    storageRemove(RETURN_KEY);

    const info = sourceInfo(document.referrer);
    if (!info) return null;
    return {
      href: document.referrer,
      scrollY: 0,
      label: info.label,
      view: info.view,
      historyLength: Math.max(1, history.length - 1),
      targetHash: location.hash || "",
      ts: Date.now(),
      fallback: true
    };
  }

  function isClubDetailLink(anchor) {
    if (!anchor || !anchor.href) return false;
    try {
      const url = new URL(anchor.href, location.href);
      return url.origin === location.origin &&
        normalizePath(url.pathname).toLowerCase().endsWith("/clubes.html") &&
        Boolean(url.hash && url.hash !== "#");
    } catch (_) {
      return false;
    }
  }

  function captureClubNavigation(event) {
    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;

    let url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return; }
    const isClubPage = normalizePath(url.pathname).toLowerCase().endsWith("/clubes.html");
    if (!isClubPage) return;

    if (!url.hash || url.hash === "#") {
      storageRemove(RETURN_KEY);
      return;
    }
    if (!isClubDetailLink(anchor)) return;

    const info = sourceInfo(location.href);
    if (!info) return;
    const ctx = {
      href: location.href,
      scrollY: Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0)),
      label: info.label,
      view: info.view,
      historyLength: history.length,
      targetHash: url.hash,
      ts: Date.now()
    };
    storageSet(RETURN_KEY, JSON.stringify(ctx));
  }

  function restoreScrollWhenReady() {
    const ctx = safeJson(storageGet(RESTORE_KEY));
    if (!validContext(ctx) || !samePage(ctx.href, location.href)) return;
    storageRemove(RESTORE_KEY);

    const targetY = Math.max(0, Number(ctx.scrollY) || 0);
    let stopped = false;
    let observer = null;
    const timers = [];

    const stop = () => {
      stopped = true;
      if (observer) observer.disconnect();
      timers.forEach(clearTimeout);
      window.removeEventListener("wheel", stop, true);
      window.removeEventListener("touchstart", stop, true);
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("keydown", stop, true);
      try { history.scrollRestoration = "auto"; } catch (_) {}
    };

    const apply = () => {
      if (stopped) return;
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(targetY, maxY), left: 0, behavior: "auto" });
    };

    try { history.scrollRestoration = "manual"; } catch (_) {}
    [0, 60, 160, 320, 600, 1000, 1600, 2400, 3600].forEach((delay) => {
      timers.push(window.setTimeout(apply, delay));
    });

    if (document.body && "MutationObserver" in window) {
      observer = new MutationObserver(apply);
      observer.observe(document.body, { childList: true, subtree: true, attributes: false });
    }

    window.addEventListener("wheel", stop, true);
    window.addEventListener("touchstart", stop, true);
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("keydown", stop, true);
    timers.push(window.setTimeout(() => {
      apply();
      stop();
      try { history.scrollRestoration = "auto"; } catch (_) {}
    }, 4500));
  }

  function setupReturnButton() {
    if (!normalizePath(location.pathname).toLowerCase().endsWith("/clubes.html") || !location.hash) return;
    const wrapper = document.getElementById("detalhe-wrapper");
    if (!wrapper) return;
    const ctx = readContext();
    if (!ctx) return;

    let bar = document.getElementById("clube-retorno-origem");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "clube-retorno-origem";
      bar.className = "club-return-bar";
      wrapper.insertBefore(bar, wrapper.firstChild);
    }

    bar.innerHTML = `
      <button type="button" class="club-return-button" aria-label="Voltar para ${ctx.label}">
        <span class="club-return-arrow" aria-hidden="true">←</span>
        <span>Voltar para <strong>${ctx.label}</strong></span>
      </button>
      <span class="club-return-hint">Retorna ao ponto onde o clube foi aberto.</span>`;

    const button = bar.querySelector("button");
    button.addEventListener("click", () => {
      const restore = { ...ctx, ts: Date.now() };
      storageSet(RESTORE_KEY, JSON.stringify(restore));
      storageRemove(RETURN_KEY);

      const depth = Math.round(history.length - Number(ctx.historyLength || history.length));
      const currentHref = location.href;
      if (!ctx.fallback && depth >= 1 && depth <= 12) {
        history.go(-depth);
        window.setTimeout(() => {
          if (location.href === currentHref) location.href = ctx.href;
        }, 1200);
      } else {
        location.href = ctx.href;
      }
    });
  }

  document.addEventListener("click", captureClubNavigation, true);
  window.addEventListener("pageshow", restoreScrollWhenReady);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupReturnButton();
      restoreScrollWhenReady();
    }, { once: true });
  } else {
    setupReturnButton();
    restoreScrollWhenReady();
  }
})();
