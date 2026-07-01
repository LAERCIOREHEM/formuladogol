/* =========================================================================
   avisos-site.js — Toast de novidade exibido apenas na página principal.
   Busca o aviso ativo no Supabase, mostra uma única vez por ID e não interfere
   nos blocos de jogos/placar que atualizam automaticamente.
   ========================================================================= */
(function () {
  "use strict";

  if (window.__copaAvisoSiteIniciado) return;
  window.__copaAvisoSiteIniciado = true;

  const CFG = window.COPA_CFG || { url: "", key: "" };
  const STORAGE_PREFIX = "copa_aviso_site_visto_";
  const DEFAULT_DELAY_MS = 1000;
  const FADE_MS = 520;

  function isPaginaPrincipal() {
    const path = String(location.pathname || "").replace(/\/+$/, "");
    return /\/copa2026\/index\.html$/i.test(path) || /\/copa2026$/i.test(path) || /\/copa2026\/index$/i.test(path);
  }

  function rpc(fn, body) {
    return fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": CFG.key,
        "Authorization": "Bearer " + CFG.key
      },
      body: JSON.stringify(body || {})
    }).then(async r => {
      if (!r.ok) throw new Error("RPC " + fn + " HTTP " + r.status);
      return r.json();
    });
  }

  function idSeguro(id) {
    return String(id || "")
      .trim()
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90);
  }

  function visto(id) {
    try { return localStorage.getItem(STORAGE_PREFIX + idSeguro(id)) === "1"; }
    catch (e) { return false; }
  }

  function marcarVisto(id) {
    try { localStorage.setItem(STORAGE_PREFIX + idSeguro(id), "1"); }
    catch (e) {}
  }

  function dentroDaJanela(aviso) {
    const agora = Date.now();
    const ini = aviso && aviso.data_inicio ? new Date(aviso.data_inicio).getTime() : NaN;
    const fim = aviso && aviso.data_fim ? new Date(aviso.data_fim).getTime() : NaN;
    if (!Number.isNaN(ini) && agora < ini) return false;
    if (!Number.isNaN(fim) && agora > fim) return false;
    return true;
  }

  function limparTexto(txt, limite) {
    return String(txt || "").replace(/\s+/g, " ").trim().slice(0, limite);
  }

  function normalizarAviso(raw) {
    const aviso = raw && typeof raw === "object" ? raw : null;
    if (!aviso || aviso.ativo !== true) return null;
    const id = idSeguro(aviso.id || aviso.id_aviso || "");
    const titulo = limparTexto(aviso.titulo || "🚀 Novidades no site", 80);
    const mensagem = limparTexto(aviso.mensagem || "", 420);
    const tempo = Math.min(15, Math.max(5, parseInt(aviso.tempo_segundos || aviso.tempo || 9, 10) || 9));
    if (!id || !mensagem) return null;
    return {
      id,
      titulo,
      mensagem,
      tempo_segundos: tempo,
      data_inicio: aviso.data_inicio || null,
      data_fim: aviso.data_fim || null
    };
  }

  function criarToast(aviso) {
    if (window.__copaAvisoSiteMostrado || document.getElementById("copa-aviso-site")) return;
    window.__copaAvisoSiteMostrado = true;
    marcarVisto(aviso.id);

    const el = document.createElement("aside");
    el.id = "copa-aviso-site";
    el.className = "copa-aviso-site";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");

    const corpo = document.createElement("div");
    corpo.className = "copa-aviso-corpo";

    const titulo = document.createElement("div");
    titulo.className = "copa-aviso-titulo";
    titulo.textContent = aviso.titulo;

    const msg = document.createElement("div");
    msg.className = "copa-aviso-msg";
    msg.textContent = aviso.mensagem;

    const fechar = document.createElement("button");
    fechar.type = "button";
    fechar.className = "copa-aviso-fechar";
    fechar.textContent = "Fechar";
    fechar.setAttribute("aria-label", "Fechar aviso de novidade");

    corpo.append(titulo, msg);
    el.append(corpo, fechar);
    document.body.appendChild(el);

    let fechado = false;
    function fecharToast() {
      if (fechado) return;
      fechado = true;
      el.classList.remove("visivel");
      el.classList.add("saindo");
      setTimeout(() => { if (el && el.parentNode) el.parentNode.removeChild(el); }, FADE_MS);
    }

    fechar.addEventListener("click", fecharToast);
    requestAnimationFrame(() => el.classList.add("visivel"));
    setTimeout(fecharToast, aviso.tempo_segundos * 1000);
  }

  async function iniciar() {
    if (!isPaginaPrincipal()) return;
    if (!CFG.url || !CFG.key) return;
    try {
      const aviso = normalizarAviso(await rpc("copa_aviso_site", {}));
      if (!aviso || !dentroDaJanela(aviso) || visto(aviso.id)) return;
      setTimeout(() => criarToast(aviso), DEFAULT_DELAY_MS);
    } catch (e) {
      // Falha silenciosa: aviso não pode quebrar a página principal.
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
