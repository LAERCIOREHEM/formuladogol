/* =========================================================================
   feedback.js — Canal anônimo de sugestões do site Copa 2026
   Salva em Supabase na tabela public.feedback_site.
   Não expõe e-mail, telefone ou rede social do organizador.
   ========================================================================= */
(function () {
  "use strict";
  const CFG = window.COPA_CFG || { url: "", key: "" };
  const STORAGE_KEY = "copa2026_feedback_visitante";
  const MAX_MSG = 1200;
  function $(s) { return document.querySelector(s); }
  function visitanteId() {
    try {
      let id = localStorage.getItem(STORAGE_KEY);
      if (!id) { id = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(STORAGE_KEY, id); }
      return id;
    } catch (e) { return "sem_localstorage"; }
  }
  function injectCSS() {
    if ($("#feedback-style")) return;
    const st = document.createElement("style");
    st.id = "feedback-style";
    st.textContent = `
      .fb-modal{position:fixed;inset:0;z-index:9998;background:rgba(2,8,23,.78);display:flex;align-items:center;justify-content:center;padding:16px}
      .fb-box{width:min(560px,96vw);background:#071b33;color:#fff;border:1px solid rgba(244,197,66,.32);border-radius:22px;box-shadow:0 24px 80px rgba(0,0,0,.55);padding:18px}
      .fb-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;border-bottom:1px solid rgba(255,255,255,.10);padding-bottom:12px;margin-bottom:12px}
      .fb-head h3{margin:0;color:#f4c542;font-family:Anton,Archivo,sans-serif;letter-spacing:.4px;font-size:25px}.fb-head p{margin:5px 0 0;color:#b9c7da;font-size:13px;line-height:1.35}
      .fb-close{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#fff;border-radius:999px;padding:7px 11px;font-weight:900;cursor:pointer}
      .fb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:10px}.fb-type{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.055);border-radius:14px;padding:9px 10px;cursor:pointer;font-weight:900;color:#e8eef8;font-size:13px;text-align:center}.fb-type.on{background:rgba(244,197,66,.18);border-color:rgba(244,197,66,.48);color:#fff}
      .fb-box label{display:block;color:#b9c7da;font-size:12px;text-transform:uppercase;font-weight:900;letter-spacing:.7px;margin:11px 0 6px}
      .fb-box textarea,.fb-box input{width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#fff;border-radius:14px;padding:11px;font:inherit;outline:none}.fb-box textarea{min-height:150px;resize:vertical;line-height:1.35}.fb-box textarea:focus,.fb-box input:focus{border-color:rgba(244,197,66,.58);box-shadow:0 0 0 3px rgba(244,197,66,.10)}
      .fb-muted{font-size:12px;color:#b9c7da;line-height:1.4;margin:8px 0 0}.fb-count{float:right;color:#b9c7da;font-size:12px;margin-top:5px}.fb-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}.fb-send{border:0;background:#f4c542;color:#13213c;border-radius:999px;padding:10px 14px;font-weight:900;cursor:pointer}.fb-send:disabled{opacity:.6;cursor:not-allowed}.fb-secondary{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#fff;border-radius:999px;padding:10px 14px;font-weight:900;cursor:pointer}.fb-status{min-height:20px;font-size:13px;margin-top:10px;color:#b9c7da}.fb-ok{color:#6ef0a0}.fb-err{color:#ffb3ad}.fb-hp{position:absolute;left:-9999px;opacity:0;pointer-events:none}
      @media(max-width:560px){.fb-box{padding:15px;border-radius:18px}.fb-grid{grid-template-columns:1fr}.fb-head h3{font-size:22px}.fb-actions{justify-content:stretch}.fb-actions button{width:100%}}
    `;
    document.head.appendChild(st);
  }
  function modalHTML() {
    return `<div class="fb-modal" role="dialog" aria-modal="true" aria-labelledby="fb-title"><div class="fb-box"><div class="fb-head"><div><h3 id="fb-title">💬 Sugestões</h3><p>Encontrou erro, teve uma ideia ou quer mandar uma crítica? Escreva aqui. Não precisa se identificar.</p></div><button type="button" class="fb-close" aria-label="Fechar">Fechar</button></div><div class="fb-grid" data-fb-types><button type="button" class="fb-type on" data-tipo="Sugestão">💡 Sugestão</button><button type="button" class="fb-type" data-tipo="Erro no site">🐞 Erro no site</button><button type="button" class="fb-type" data-tipo="Elogio">👏 Elogio</button><button type="button" class="fb-type" data-tipo="Crítica">📝 Crítica</button></div><label for="fb-msg">Mensagem</label><textarea id="fb-msg" maxlength="${MAX_MSG}" placeholder="Digite sua mensagem..."></textarea><span class="fb-count"><span id="fb-count">0</span>/${MAX_MSG}</span><label for="fb-nome">Assinar como, se quiser</label><input id="fb-nome" maxlength="80" placeholder="Opcional: nome, apelido ou deixe em branco"><input class="fb-hp" id="fb-site" autocomplete="off" tabindex="-1" aria-hidden="true"><p class="fb-muted">Canal anônimo: nenhum e-mail, telefone ou rede social do organizador é exibido. A página de origem é salva para ajudar a entender o contexto.</p><div class="fb-status" id="fb-status"></div><div class="fb-actions"><button type="button" class="fb-secondary" data-fb-cancel>Cancelar</button><button type="button" class="fb-send" data-fb-send>Enviar mensagem</button></div></div></div>`;
  }
  function abrirFeedback() {
    injectCSS(); document.querySelectorAll(".fb-modal").forEach(x => x.remove());
    const wrap = document.createElement("div"); wrap.innerHTML = modalHTML(); const modal = wrap.firstElementChild; document.body.appendChild(modal);
    let tipo = "Sugestão"; const msg = $("#fb-msg"), count = $("#fb-count"), status = $("#fb-status"), send = modal.querySelector("[data-fb-send]");
    const close = () => modal.remove(); modal.querySelector(".fb-close").onclick = close; modal.querySelector("[data-fb-cancel]").onclick = close; modal.onclick = e => { if (e.target === modal) close(); };
    modal.querySelectorAll(".fb-type").forEach(b => b.onclick = () => { modal.querySelectorAll(".fb-type").forEach(x => x.classList.remove("on")); b.classList.add("on"); tipo = b.dataset.tipo || "Sugestão"; });
    msg.oninput = () => { count.textContent = String(msg.value.length); }; setTimeout(() => msg.focus(), 80);
    send.onclick = async () => {
      const texto = (msg.value || "").trim(); const assinatura = ($("#fb-nome").value || "").trim(); const hp = ($("#fb-site").value || "").trim(); status.className = "fb-status"; status.textContent = "";
      if (hp) { status.classList.add("fb-err"); status.textContent = "Não foi possível enviar."; return; }
      if (texto.length < 8) { status.classList.add("fb-err"); status.textContent = "Escreva uma mensagem um pouco mais completa."; return; }
      if (!CFG.url || !CFG.key) { status.classList.add("fb-err"); status.textContent = "Envio indisponível neste ambiente."; return; }
      send.disabled = true; send.textContent = "Enviando...";
      try {
        const payload = { tipo, mensagem: texto.slice(0, MAX_MSG), assinatura: assinatura || null, pagina: location.pathname + location.search, visitante_id: visitanteId(), user_agent: navigator.userAgent || null };
        const r = await fetch(`${CFG.url}/rest/v1/feedback_site`, { method: "POST", headers: { "Content-Type": "application/json", "apikey": CFG.key, "Authorization": "Bearer " + CFG.key, "Prefer": "return=minimal" }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error(await r.text()); status.classList.add("fb-ok"); status.textContent = "✅ Mensagem enviada. Obrigado por ajudar a melhorar o site!"; send.textContent = "Enviado ✓"; setTimeout(close, 1100);
      } catch (e) { status.classList.add("fb-err"); status.textContent = "Não consegui enviar agora. Tente novamente em instantes."; send.disabled = false; send.textContent = "Enviar mensagem"; }
    };
  }
  function iniciar() { document.querySelectorAll("[data-feedback], .js-feedback").forEach(a => { if (a.dataset.fbReady) return; a.dataset.fbReady = "1"; a.addEventListener("click", e => { e.preventDefault(); abrirFeedback(); }); }); }
  document.addEventListener("DOMContentLoaded", iniciar);
})();
