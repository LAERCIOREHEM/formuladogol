/* ==========================================================================
   br-feedback.js — Canal de sugestões do Brasileirão 2026
   Usa a mesma tabela public.feedback_site já adotada no site da Copa.
   Não exibe e-mail, telefone ou rede social do administrador.
   ========================================================================== */
(function () {
  "use strict";

  const STORAGE_KEY = "brasileirao2026_feedback_visitante";
  const MAX_MSG = 1200;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function config() {
    const cfg = window.BR_CFG && window.BR_CFG.supabase ? window.BR_CFG.supabase : {};
    return {
      url: String(cfg.url || "").replace(/\/$/, ""),
      key: String(cfg.key || "")
    };
  }

  function visitanteId() {
    try {
      let id = localStorage.getItem(STORAGE_KEY);
      if (!id) {
        id = "br_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(STORAGE_KEY, id);
      }
      return id;
    } catch (_) {
      return "sem_localstorage";
    }
  }

  function injectCSS() {
    if (document.getElementById("br-feedback-style")) return;
    const style = document.createElement("style");
    style.id = "br-feedback-style";
    style.textContent = `
      .brfb-modal{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(2,8,14,.80);overflow-y:auto}
      .brfb-box{width:min(540px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow-y:auto;padding:16px;border:1px solid rgba(163,230,53,.28);border-radius:19px;background:linear-gradient(145deg,#0a1820,#07140f);color:#eef6fb;box-shadow:0 22px 70px rgba(0,0,0,.58)}
      .brfb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:10px;margin-bottom:11px;border-bottom:1px solid rgba(148,163,184,.15)}
      .brfb-head h3{margin:0;color:#eaffad;font-size:21px;line-height:1.1}.brfb-head p{margin:6px 0 0;color:#aebdca;font-size:13px;line-height:1.35}
      .brfb-close{border:1px solid rgba(148,163,184,.20);border-radius:999px;background:rgba(255,255,255,.06);color:#eef6fb;padding:7px 11px;font:inherit;font-weight:900;cursor:pointer}
      .brfb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:10px}
      .brfb-type{min-height:42px;padding:8px;border:1px solid rgba(148,163,184,.16);border-radius:13px;background:rgba(255,255,255,.045);color:#dde8ef;font:inherit;font-size:12.5px;font-weight:900;cursor:pointer}
      .brfb-type.on{border-color:rgba(163,230,53,.48);background:rgba(163,230,53,.14);color:#f4ffce}
      .brfb-box label{display:block;margin:9px 0 5px;color:#aebdca;font-size:11px;font-weight:900;letter-spacing:.65px;text-transform:uppercase}
      .brfb-box textarea,.brfb-box input{width:100%;box-sizing:border-box;border:1px solid rgba(148,163,184,.18);border-radius:13px;background:rgba(255,255,255,.055);color:#fff;padding:10px;font:inherit;outline:none}
      .brfb-box textarea{min-height:105px;resize:vertical;line-height:1.35}.brfb-box textarea:focus,.brfb-box input:focus{border-color:rgba(96,165,250,.58);box-shadow:0 0 0 3px rgba(96,165,250,.11)}
      .brfb-count{float:right;margin-top:4px;color:#8fa0ad;font-size:11px}.brfb-muted{margin:8px 0 0;color:#9aabb8;font-size:11.5px;line-height:1.35}
      .brfb-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:11px}.brfb-actions button{min-height:42px;border-radius:999px;font:inherit;font-weight:950;cursor:pointer}
      .brfb-cancel{border:1px solid rgba(148,163,184,.18);background:rgba(255,255,255,.055);color:#eef6fb}.brfb-send{border:0;background:linear-gradient(135deg,#bef264,#a3e635);color:#132009}.brfb-send:disabled{opacity:.62;cursor:not-allowed}
      .brfb-status{min-height:20px;margin-top:8px;font-size:12px;color:#aebdca}.brfb-ok{color:#86efac}.brfb-err{color:#fca5a5}.brfb-hp{position:absolute!important;left:-9999px!important;opacity:0!important;pointer-events:none!important}
      @media(max-width:560px){.brfb-modal{align-items:flex-start;padding:8px;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom))}.brfb-box{width:calc(100vw - 16px);max-height:calc(100dvh - 16px);padding:13px;border-radius:16px}.brfb-head h3{font-size:19px}.brfb-head p{font-size:12px}.brfb-grid{gap:6px}.brfb-type{min-height:40px;font-size:12px}.brfb-box textarea{min-height:92px}.brfb-muted{font-size:11px}}
      @media(max-width:360px){.brfb-grid{grid-template-columns:1fr}.brfb-actions{grid-template-columns:1fr}.brfb-muted{display:none}}
    `;
    document.head.appendChild(style);
  }

  function modalHTML() {
    return `
      <div class="brfb-modal" role="dialog" aria-modal="true" aria-labelledby="brfb-title">
        <div class="brfb-box">
          <div class="brfb-head">
            <div>
              <h3 id="brfb-title">💬 Sugestões</h3>
              <p>Envie uma correção, sugestão, pedido de crédito ou solicitação de remoção. Não é necessário se identificar.</p>
            </div>
            <button type="button" class="brfb-close" aria-label="Fechar">Fechar</button>
          </div>
          <div class="brfb-grid" data-brfb-types>
            <button type="button" class="brfb-type on" data-tipo="Sugestão">💡 Sugestão</button>
            <button type="button" class="brfb-type" data-tipo="Erro no site">🐞 Erro no site</button>
            <button type="button" class="brfb-type" data-tipo="Correção de dados">📊 Correção de dados</button>
            <button type="button" class="brfb-type" data-tipo="Crédito ou remoção">⚖️ Crédito ou remoção</button>
          </div>
          <label for="brfb-msg">Mensagem</label>
          <textarea id="brfb-msg" maxlength="${MAX_MSG}" placeholder="Descreva o pedido e, se possível, informe a página ou o conteúdo relacionado."></textarea>
          <span class="brfb-count"><span id="brfb-count">0</span>/${MAX_MSG}</span>
          <label for="brfb-nome">Assinar como, se quiser</label>
          <input id="brfb-nome" maxlength="80" placeholder="Opcional: nome, apelido ou deixe em branco">
          <input class="brfb-hp" id="brfb-site" autocomplete="off" tabindex="-1" aria-hidden="true">
          <p class="brfb-muted">A página de origem é registrada apenas para contextualizar a mensagem.</p>
          <div class="brfb-status" id="brfb-status" role="status" aria-live="polite"></div>
          <div class="brfb-actions">
            <button type="button" class="brfb-cancel" data-brfb-cancel>Cancelar</button>
            <button type="button" class="brfb-send" data-brfb-send>Enviar mensagem</button>
          </div>
        </div>
      </div>`;
  }

  function abrirFeedback() {
    injectCSS();
    document.querySelectorAll(".brfb-modal").forEach((node) => node.remove());

    const wrapper = document.createElement("div");
    wrapper.innerHTML = modalHTML();
    const modal = wrapper.firstElementChild;
    document.body.appendChild(modal);

    let tipo = "Sugestão";
    const msg = $("#brfb-msg", modal);
    const count = $("#brfb-count", modal);
    const status = $("#brfb-status", modal);
    const send = $("[data-brfb-send]", modal);
    const close = () => modal.remove();

    $(".brfb-close", modal).addEventListener("click", close);
    $("[data-brfb-cancel]", modal).addEventListener("click", close);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    document.addEventListener("keydown", function esc(event) {
      if (event.key === "Escape" && document.body.contains(modal)) {
        close();
        document.removeEventListener("keydown", esc);
      }
    });

    modal.querySelectorAll(".brfb-type").forEach((button) => {
      button.addEventListener("click", () => {
        modal.querySelectorAll(".brfb-type").forEach((item) => item.classList.remove("on"));
        button.classList.add("on");
        tipo = button.dataset.tipo || "Sugestão";
      });
    });

    msg.addEventListener("input", () => {
      count.textContent = String(msg.value.length);
    });
    setTimeout(() => msg.focus(), 80);

    send.addEventListener("click", async () => {
      const texto = String(msg.value || "").trim();
      const assinatura = String($("#brfb-nome", modal).value || "").trim();
      const honeypot = String($("#brfb-site", modal).value || "").trim();
      const cfg = config();

      status.className = "brfb-status";
      status.textContent = "";

      if (honeypot) {
        status.classList.add("brfb-err");
        status.textContent = "Não foi possível enviar.";
        return;
      }
      if (texto.length < 8) {
        status.classList.add("brfb-err");
        status.textContent = "Escreva uma mensagem um pouco mais completa.";
        return;
      }
      if (!cfg.url || !cfg.key) {
        status.classList.add("brfb-err");
        status.textContent = "Envio indisponível neste ambiente.";
        return;
      }

      send.disabled = true;
      send.textContent = "Enviando...";
      try {
        const payload = {
          tipo: tipo,
          mensagem: texto.slice(0, MAX_MSG),
          assinatura: assinatura || null,
          pagina: location.pathname + location.search,
          visitante_id: visitanteId(),
          user_agent: navigator.userAgent || null
        };
        const response = await fetch(cfg.url + "/rest/v1/feedback_site", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": cfg.key,
            "Authorization": "Bearer " + cfg.key,
            "Prefer": "return=minimal"
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(await response.text());
        status.classList.add("brfb-ok");
        status.textContent = "✅ Mensagem enviada. Obrigado por ajudar a melhorar o site!";
        send.textContent = "Enviado ✓";
        setTimeout(close, 1200);
      } catch (error) {
        console.error("Falha ao enviar sugestão:", error);
        status.classList.add("brfb-err");
        status.textContent = "Não consegui enviar agora. Tente novamente em instantes.";
        send.disabled = false;
        send.textContent = "Enviar mensagem";
      }
    });
  }

  function iniciar() {
    document.querySelectorAll("[data-feedback]").forEach((button) => {
      if (button.dataset.brfbReady) return;
      button.dataset.brfbReady = "1";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        abrirFeedback();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
