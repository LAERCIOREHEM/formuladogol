/* =========================================================================
   app.js — Interface do Bolão Copa 2026
   Se js/config.js tiver URL+key do Supabase, opera ONLINE (multiusuário,
   ranking, transparência, trava no servidor). Sem config, cai no modo LOCAL
   (localStorage) para testes. Lógica de chave/pontuação: engine.js e pontuacao.js.
   ========================================================================= */
(function () {
  "use strict";

  const CFG = window.COPA_CFG || { url: "", key: "" };
  const ONLINE = !!(CFG.url && CFG.key);
  const API_ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const JANELAS_ESPN = [
    "20260611-20260627", "20260628-20260703", "20260704-20260707",
    "20260709-20260711", "20260714-20260715", "20260718-20260718", "20260719-20260719"
  ];
  const ESPN_OVR = {};
  const VIRADA_SIMULADO = new Date("2026-06-28T02:00:00-03:00");

  const FASES = [
    { id: "grupos", nome: "Grupos" }, { id: "r32", nome: "2ª fase" },
    { id: "oitavas", nome: "Oitavas" }, { id: "quartas", nome: "Quartas" },
    { id: "semifinais", nome: "Semis" }, { id: "final", nome: "Final" }
  ];

  let DADOS = {}, USER = null, P = null, derivado = null;
  let FINALIZADO = false, FINALIZADO_EM = null;
  const TRAVA_MS = Date.parse("2026-06-11T03:00:00Z"); // 10/06 23h59 Brasília
  let faseAtual = "grupos", grupoAberto = null, saveTimer = null;
  let atualizarFeedbackFase = null;
  let oficialTimer = null;
  let OFICIAL_CARREGANDO = false;

  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

  function eficienciaPct(r) {
    const a = Number(r && r.atuais);
    const p = Number(r && r.perdidos);
    if (!Number.isFinite(a) || !Number.isFinite(p)) return "…";
    const decidido = a + p;
    if (decidido <= 0) return "—";
    return (a / decidido * 100).toLocaleString("pt-BR", { minimumFractionDigits:1, maximumFractionDigits:1 }) + "%";
  }

  function bandeira(id) {
    const iso = DADOS.isoDe[id];
    if (!iso) return "";
    return `<img class="flag" src="https://flagcdn.com/w40/${iso}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  }

  // pula para o próximo campo de placar disponível (ignora os desabilitados)
  function focarProximo(inp) {
    const ins = Array.from(document.querySelectorAll('#conteudo-fase input:not([disabled])'));
    const i = ins.indexOf(inp);
    if (i > -1 && i < ins.length - 1) ins[i + 1].focus();
  }

  // ---------- Supabase ----------
  async function rpc(fn, body) {
    const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": CFG.key, "Authorization": "Bearer " + CFG.key },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error("RPC " + fn + " HTTP " + r.status + ": " + (await r.text()));
    return r.json();
  }

  async function init() {
    try {
      const [s, e, t, pm, fp] = await Promise.all([
        fetch("dados/selecoes.json").then(r => r.json()),
        fetch("dados/estrutura_mata_mata.json").then(r => r.json()),
        fetch("dados/terceiros_map.json").then(r => r.json()),
        fetch("dados/palpites_mata.json").then(r => r.json()).catch(() => ({ apostadores: {} })),
        fetch("dados/fairplay.json?t=" + Date.now()).then(r => r.json()).catch(() => ({ fairplay: {} }))
      ]);
      DADOS.selecoes = s.selecoes; DADOS.estrutura = e; DADOS.terceirosMap = t;
      DADOS.palpitesMata = (pm && pm.apostadores) || {};
      DADOS.fairplay = (fp && fp.fairplay) || {};
      DADOS.nomeDe = {}; DADOS.isoDe = {};
      s.selecoes.forEach(x => { DADOS.nomeDe[x.id] = x.nome; DADOS.isoDe[x.id] = x.iso2; });
      carregarOficialAtual(true); // assíncrono: alimenta pontuação/✓/✗ sem travar o login
      if (!oficialTimer) oficialTimer = setInterval(function(){ carregarOficialAtual(false); }, 120000); // espelha a atualização do Bolão
    } catch (err) {
      $("#tela-login").innerHTML = '<div class="cartao-login"><h2>Erro ao carregar dados</h2>' +
        '<p class="prazo">Abra o módulo por um servidor (ex.: <code>python -m http.server</code>) ' +
        'ou pelo GitHub Pages — o navegador bloqueia leitura de JSON via file://.</p></div>';
      return;
    }
    eventos(); restaurarSessao();
  }

  function eventos() {
    $("#btn-entrar").onclick = entrar;
    $("#btn-sair").onclick = sair;
    const bc = $("#btn-comprovante"); if (bc) bc.onclick = gerarComprovante;
    const baudit = $("#btn-auditoria-geral"); if (baudit) baudit.onclick = auditarRankingGeral;
    const bf = $("#btn-finalizar"); if (bf) bf.onclick = finalizarPalpite;
    $("#popup-ok").onclick = () => $("#popup").classList.add("oculto");
    document.querySelectorAll(".aba").forEach(b => b.onclick = () => trocarTela(b.dataset.tela, b));
    const ba = $("#btn-alterar-palpite");
    if (ba) ba.onclick = () => trocarTela("palpite", document.querySelector('.aba[data-tela="palpite"]'));
  }
  // ---------- Finalizar (lacre individual) ----------
  async function carregarSituacao() {
    FINALIZADO = false; FINALIZADO_EM = null;
    if (!ONLINE) return;
    try {
      const st = await rpc("copa_minha_situacao", { p_nome: USER.nome, p_pin: USER.pin });
      if (st && st.finalizado) { FINALIZADO = true; FINALIZADO_EM = st.finalizado_em || null; }
    } catch (e) {} // função ainda não criada no banco -> segue sem lacre
  }
  function aplicarLacre() {
    const tp = $("#tela-palpite");
    const posTrava = Date.now() > TRAVA_MS;
    if (!tp || (!FINALIZADO && !posTrava)) return;
    tp.classList.add("lacrado");
    const bf = $("#btn-finalizar"); if (bf) bf.style.display = "none";
    if (!$("#banner-lacre")) {
      const b = document.createElement("div");
      b.id = "banner-lacre"; b.className = "banner-lacre";
      if (FINALIZADO) {
        const quando = FINALIZADO_EM ? new Date(FINALIZADO_EM).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
        b.innerHTML = `🔒 <b>Palpite finalizado${quando ? " em " + quando : ""}</b> — lacrado. Você pode navegar pelos seus palpites, mas nada pode ser alterado. Use <b>📄 Comprovante</b> quando quiser.`;
      } else {
        b.innerHTML = `🔒 <b>Palpites travados em 10/06 às 23h59</b> — a Copa começou! Navegue pelos seus palpites à vontade (nada pode ser alterado) e baixe seu <b>📄 Comprovante</b>. Os palpites de todos estão na página <b>Palpites</b>.`;
      }
      tp.insertBefore(b, tp.firstChild);
    }
  }
  async function finalizarPalpite() {
    if (!USER || !P) { popup("Entre com seu nome e PIN primeiro."); return; }
    if (!ONLINE) { popup("Finalização só funciona no site publicado (online)."); return; }
    if (FINALIZADO) { popup("Seu palpite já está finalizado."); return; }
    const certeza = confirm(
      "FINALIZAR PALPITE?\n\n" +
      "Ao confirmar:\n" +
      "• Seu palpite fica LACRADO — não poderá mais ser alterado, nem antes do prazo.\n" +
      "• O comprovante definitivo será gerado automaticamente.\n\n" +
      "Essa ação não pode ser desfeita. Confirmar?");
    if (!certeza) return;
    try {
      const res = await rpc("copa_finalizar", { p_nome: USER.nome, p_pin: USER.pin });
      if (res === "OK") {
        FINALIZADO = true; FINALIZADO_EM = new Date().toISOString();
        aplicarLacre();
        await gerarComprovante();
      } else if (res === "JA_FINALIZADO") {
        FINALIZADO = true; aplicarLacre(); popup("Seu palpite já estava finalizado.");
      } else if (res === "SEM_PALPITE") {
        popup("Você ainda não tem palpite salvo para finalizar. Preencha e aguarde o \"Salvo\" aparecer.");
      } else {
        popup("Não consegui finalizar (verifique o PIN e tente de novo).");
      }
    } catch (e) {
      popup("A finalização ainda não está ativa no servidor ou houve falha de conexão. Tente novamente.");
    }
  }

  // Palpite CANÔNICO de mata-mata do usuário logado (lista auditada, fiel ao que ele cravou
  // que avança em cada fase). Independe da posição no chaveamento — por isso NÃO muda quando
  // o critério de desempate da FIFA reordena os grupos. Busca por nome (sem diferenciar maiúsc.).
  function meuCanonico() {
    const pm = DADOS.palpitesMata || {};
    if (!USER || !USER.nome) return null;
    if (pm[USER.nome]) return pm[USER.nome];
    // casa o nome ignorando MAIÚSC/minúsc E acentos (ex.: "Léo" == "LEO", "Marcão" == "MARCAO"),
    // pra nenhum apostador ficar sem a lista auditada por uma diferença de grafia.
    const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    const alvo = norm(USER.nome);
    const k = Object.keys(pm).find(n => norm(n) === alvo);
    return k ? pm[k] : null;
  }

  // ---------- Comprovante com impressão digital (hash) ----------
  function canonical(o) {
    if (o === null || typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(canonical).join(",") + "]";
    return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  async function sha256hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function gerarComprovante() {
    if (!USER || !P) { popup("Entre com seu nome e PIN primeiro."); return; }
    const agora = new Date();
    const dataBR = agora.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const TRAVA = new Date("2026-06-11T03:00:00Z"); // 10/06 23h59 Brasília (~)
    const hash = await sha256hex(canonical({ g: P.placaresGrupos || {}, m: P.placaresMata || {} }));

    const sig = {}; (DADOS.selecoes || []).forEach(x => sig[x.id] = x.id);
    const jogos = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes);
    const porGrupo = {};
    jogos.forEach(j => {
      const g = P.placaresGrupos[j.jogo_id];
      const linha = `${j.a} ${g && g.ga != null ? g.ga : "?"} x ${g && g.gb != null ? g.gb : "?"} ${j.b}`;
      (porGrupo[j.grupo] = porGrupo[j.grupo] || []).push(linha);
    });
    let txt = "";
    txt += "==============================================\n";
    txt += " COMPROVANTE DE PALPITE — BOLÃO COPA 2026\n";
    txt += " Brasileirão Almoço · brasileirao2026almoco.com.br\n";
    txt += "==============================================\n";
    txt += `Participante: ${USER.nome}\n`;
    txt += `Gerado em: ${dataBR} (horário de Brasília)\n`;
    if (FINALIZADO) {
      const fq = FINALIZADO_EM ? new Date(FINALIZADO_EM).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : dataBR;
      txt += `Situação: FINALIZADO pelo participante em ${fq} — lacrado, sem alteração possível.\n`;
    } else {
      txt += (agora < TRAVA
        ? "Situação: ANTES da trava — palpites ainda podiam ser alterados até 10/06 23h59.\n           Gere novamente após a trava para ter o comprovante definitivo.\n"
        : "Situação: APÓS a trava de 10/06 23h59 — palpites bloqueados para alteração.\n");
    }
    txt += "\n----- FASE DE GRUPOS (72 jogos) -----\n";
    Object.keys(porGrupo).sort().forEach(g => { txt += `\nGrupo ${g}\n  ` + porGrupo[g].join("\n  ") + "\n"; });

    let d = null;
    try {
      const arr = Object.keys(P.placaresGrupos).map(id => ({ jogo_id: id, ga: P.placaresGrupos[id].ga, gb: P.placaresGrupos[id].gb }));
      d = COPA_ENGINE.derivar(DADOS.selecoes, arr, P.placaresMata, DADOS.estrutura, DADOS.terceirosMap);
    } catch (e) {}
    // Para as SELEÇÕES que avançam em cada fase, prioriza a lista CANÔNICA auditada
    // (fiel ao que o participante cravou). Ela não depende da posição no chaveamento,
    // por isso não é afetada pela correção do critério de desempate da FIFA.
    const can = meuCanonico();
    const mm = can ? {
      classificados32: can.classificados32, avancam_oitavas: can.avancam_oitavas,
      avancam_quartas: can.avancam_quartas, semifinalistas: can.semifinalistas,
      finalistas: can.finalistas, campeao: can.campeao, vice: can.vice,
      terceiro: can.terceiro, quarto: can.quarto
    } : d;
    if (mm && mm.campeao) {
      txt += "\n----- MATA-MATA (seleções que avançam) -----\n";
      txt += `Classificados (32): ${(mm.classificados32 || []).join(", ")}\n`;
      txt += `Oitavas (16): ${(mm.avancam_oitavas || []).join(", ")}\n`;
      txt += `Quartas (8): ${(mm.avancam_quartas || []).join(", ")}\n`;
      txt += `Semifinal (4): ${(mm.semifinalistas || []).join(", ")}\n`;
      txt += `Final (2): ${(mm.finalistas || []).join(", ")}\n`;
      txt += `CAMPEÃO: ${mm.campeao} | Vice: ${mm.vice} | 3º: ${mm.terceiro} | 4º: ${mm.quarto}\n`;
      txt += "(No mata-mata o que vale é QUEM avança, não o placar. As seleções acima são\n";
      txt += " as que você cravou — registradas e auditadas com a impressão digital abaixo.)\n";
    } else {
      txt += "\n(Palpite ainda incompleto — chave do mata-mata não fechada.)\n";
    }
    txt += "\n----- IMPRESSÃO DIGITAL (SHA-256) -----\n";
    txt += hash + "\n\n";
    txt += "Como conferir: após a revelação (11/06), a página \"Palpites\" mostra a\n";
    txt += "impressão digital calculada direto do banco para cada participante.\n";
    txt += "Se ela for IGUAL à deste comprovante, seu palpite não foi alterado por\n";
    txt += "ninguém — nem pelo administrador. Qualquer mudança de 1 gol em 1 jogo\n";
    txt += "gera uma impressão completamente diferente.\n";

    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `comprovante-copa2026-${USER.nome.replace(/\s+/g, "_")}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    popup("Comprovante baixado! Guarde o arquivo (ou mande no seu próprio WhatsApp). A impressão digital nele permite conferir depois que nada foi alterado.");
  }

  function popup(msg) { $("#popup-texto").textContent = msg; $("#popup").classList.remove("oculto"); }
  function palpiteVazio() { return { placaresGrupos: {}, placaresMata: {}, status: "rascunho" }; }
  function getRoster() { try { return JSON.parse(localStorage.getItem("copa2026_roster") || "[]"); } catch (e) { return []; } }
  function chaveUser(nome) { return "copa2026_user_" + nome.trim().toLowerCase(); }
  function mostrarErro(m) { const e = $("#login-erro"); e.textContent = m; e.classList.remove("oculto"); }

  // ---------- login ----------
  async function entrar() {
    const nome = $("#in-nome").value.trim();
    const pin = $("#in-pin").value.trim();
    $("#login-erro").classList.add("oculto");
    if (nome.length < 2) return mostrarErro("Informe seu nome.");
    if (!/^\d{6}$/.test(pin)) return mostrarErro("O PIN deve ter 6 dígitos numéricos.");

    if (ONLINE) {
      $("#btn-entrar").disabled = true; $("#btn-entrar").textContent = "Entrando...";
      try {
        const res = await rpc("copa_login", { p_nome: nome, p_pin: pin });
        if (!res || !res.ok) {
          return mostrarErro(res && res.motivo === "PIN"
            ? "PIN incorreto para este nome." : "Nome não cadastrado. Fale com o organizador.");
        }
        USER = { nome: res.nome, pin };
        let pl = null; try { pl = await rpc("copa_meu_palpite", { p_nome: nome, p_pin: pin }); } catch (e) {}
        P = pl || palpiteVazio();
        await carregarSituacao();
      } catch (e) {
        return mostrarErro("Não consegui falar com o servidor. Tente de novo.");
      } finally {
        $("#btn-entrar").disabled = false; $("#btn-entrar").textContent = "Entrar";
      }
    } else {
      const roster = getRoster();
      if (roster.length) {
        const reg = roster.find(r => r.nome.trim().toLowerCase() === nome.toLowerCase());
        if (!reg) return mostrarErro("Nome não cadastrado. Fale com o organizador.");
        if (reg.pin !== pin) return mostrarErro("PIN incorreto para este nome.");
        USER = { nome: reg.nome, pin };
      } else { USER = { nome, pin }; }
      const salvo = localStorage.getItem(chaveUser(USER.nome));
      P = (salvo && JSON.parse(salvo).palpite) || palpiteVazio();
    }
    localStorage.setItem("copa2026_sessao", JSON.stringify(USER));
    localStorage.setItem("copa2026_login", JSON.stringify(USER)); // lembra neste aparelho
    abrirApp();
  }

  async function restaurarSessao() {
    const ses = localStorage.getItem("copa2026_sessao");
    if (ses) {
      USER = JSON.parse(ses);
      if (ONLINE) {
        let pl = null; try { pl = await rpc("copa_meu_palpite", { p_nome: USER.nome, p_pin: USER.pin }); } catch (e) {}
        P = pl || palpiteVazio();
        await carregarSituacao();
      } else {
        const salvo = localStorage.getItem(chaveUser(USER.nome));
        P = (salvo && JSON.parse(salvo).palpite) || palpiteVazio();
      }
      abrirApp();
      return;
    }
    // login salvo neste aparelho: entra sozinho (até clicar em Sair)
    const lembrado = localStorage.getItem("copa2026_login");
    if (lembrado) {
      try {
        const u = JSON.parse(lembrado);
        $("#in-nome").value = u.nome;
        $("#in-pin").value = u.pin;
        entrar();
      } catch (e) {}
    }
  }

  function abrirApp() {
    $("#tela-login").classList.add("oculto");
    $("#topo-usuario").classList.remove("oculto");
    $("#usuario-nome").textContent = "Olá, " + USER.nome;
    trocarTela("palpite");
    aplicarLacre();
  }
  function sair() {
    localStorage.removeItem("copa2026_sessao");
    localStorage.removeItem("copa2026_login");
    USER = null; P = null; derivado = null;
    $("#topo-usuario").classList.add("oculto");
    document.querySelectorAll(".tela").forEach(t => t.classList.add("oculto"));
    $("#tela-login").classList.remove("oculto");
    $("#in-nome").value = ""; $("#in-pin").value = "";
  }

  function marcaSalvo() {
    const agora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    $("#salvo-texto").textContent = "Salvo às " + agora;
  }
  function derivadoResumo() {
    recomputar();
    return { campeao: derivado.campeao, vice: derivado.vice, terceiro: derivado.terceiro, quarto: derivado.quarto, chave: derivado.chave, preenchidos: totalPreenchidos() };
  }
  function persistir() {
    if (FINALIZADO) { $("#salvo-texto").textContent = "🔒 Finalizado — palpite lacrado."; return; }
    if (Date.now() > TRAVA_MS) { $("#salvo-texto").textContent = "🔒 Palpites travados (10/06 23h59)."; return; }
    if (ONLINE) {
      $("#salvo-texto").textContent = "Salvando...";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const res = await rpc("copa_salvar", { p_nome: USER.nome, p_pin: USER.pin, p_payload: P, p_derivado: derivadoResumo() });
          if (res === "OK") marcaSalvo();
          else if (res === "TRAVADO") $("#salvo-texto").textContent = "Prazo encerrado — palpites travados.";
          else if (res === "FINALIZADO") { FINALIZADO = true; aplicarLacre(); $("#salvo-texto").textContent = "🔒 Finalizado — palpite lacrado."; }
          else $("#salvo-texto").textContent = "Não salvou (verifique o PIN).";
        } catch (e) { $("#salvo-texto").textContent = "Sem conexão — salvo será reenviado ao editar."; }
      }, 800);
    } else {
      localStorage.setItem(chaveUser(USER.nome), JSON.stringify({ pin: USER.pin, palpite: P }));
      marcaSalvo();
    }
  }

  function trocarTela(qual) {
    document.querySelectorAll(".tela").forEach(t => t.classList.add("oculto"));
    $("#tela-palpite").classList.remove("oculto");
    renderPalpite();
  }

  function recomputar() {
    const arr = Object.keys(P.placaresGrupos).map(id => ({ jogo_id: id, ga: P.placaresGrupos[id].ga, gb: P.placaresGrupos[id].gb }));
    derivado = COPA_ENGINE.derivar(DADOS.selecoes, arr, P.placaresMata, DADOS.estrutura, DADOS.terceirosMap);
  }
  function totalPreenchidos() {
    let n = Object.values(P.placaresGrupos).filter(p => p.ga != null && p.gb != null).length;
    [...DADOS.estrutura.r32, ...DADOS.estrutura.arvore].forEach(m => {
      const p = P.placaresMata[m.id]; if (p && p.a != null && p.b != null && p.a !== p.b) n++;
    });
    return n;
  }
  function renderPalpite() {
    recomputar(); atualizarProgresso(); renderEtapas();
    if (faseAtual === "grupos") renderGrupos(); else renderFaseMata(faseAtual);
  }
  function gruposCompletos() {
    return COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes).every(j => {
      const p = P.placaresGrupos[j.jogo_id]; return p && p.ga != null && p.gb != null;
    });
  }
  function renderEtapas() {
    const cont = $("#etapas"); cont.innerHTML = "";
    const liberadas = gruposCompletos();
    FASES.forEach(f => {
      const e = el("div", "etapa", f.nome);
      if (f.id === faseAtual) e.classList.add("atual");
      if (f.id === "grupos" && liberadas) e.classList.add("ok");
      if (f.id !== "grupos" && !liberadas) e.classList.add("travada");
      e.onclick = () => {
        if (f.id !== "grupos" && !liberadas) return popup("Preencha todos os 72 jogos dos grupos primeiro.");
        faseAtual = f.id; grupoAberto = null; renderPalpite();
      };
      cont.appendChild(e);
    });
  }
  function renderGrupos() {
    const c = $("#conteudo-fase"); c.innerHTML = "";
    if (grupoAberto) return renderGrupoDetalhe(grupoAberto);
    const grupos = [...new Set(DADOS.selecoes.map(s => s.grupo))].sort();
    const jogos = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes);
    const grid = el("div", "grid-grupos");
    grupos.forEach(g => {
      const jg = jogos.filter(j => j.grupo === g);
      const feitos = jg.filter(j => { const p = P.placaresGrupos[j.jogo_id]; return p && p.ga != null && p.gb != null; }).length;
      const card = el("div", "card-grupo" + (feitos === 6 ? " completo" : ""));
      card.innerHTML = `<h3>Grupo ${g}</h3><div class="estado">${feitos === 6 ? "Completo ✓" : feitos + " de 6 jogos"}</div>`;
      card.onclick = () => { grupoAberto = g; renderGrupos(); };
      grid.appendChild(card);
    });
    c.appendChild(grid);
    if (gruposCompletos()) {
      const acoes = el("div", "acoes");
      const btn = el("button", "btn-primario", "Avançar para a 2ª fase →");
      btn.onclick = () => { faseAtual = "r32"; renderPalpite(); };
      acoes.appendChild(btn); c.appendChild(acoes);
    }
  }
  function renderGrupoDetalhe(g) {
    const c = $("#conteudo-fase"); c.innerHTML = "";
    c.appendChild(el("div", "titulo-fase", "Grupo " + g));
    const jogos = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes).filter(j => j.grupo === g);
    const lista = el("div", "lista-jogos");
    jogos.forEach(j => lista.appendChild(cardJogoGrupo(j)));
    c.appendChild(lista); c.appendChild(boxClassificacao(g));
    const acoes = el("div", "acoes");
    const voltar = el("button", "btn-sec", "← Grupos");
    voltar.onclick = () => { grupoAberto = null; renderGrupos(); };
    acoes.appendChild(voltar); c.appendChild(acoes);
  }
  function cardJogoGrupo(j) {
    const p = P.placaresGrupos[j.jogo_id] || {};
    const card = el("div", "jogo");
    card.innerHTML =
      `<div class="time">${bandeira(j.a)}<div><div>${DADOS.nomeDe[j.a]}</div><div class="sigla">${j.a}</div></div></div>` +
      `<div class="placar"><input data-k="ga" inputmode="numeric" maxlength="1" value="${p.ga ?? ""}">` +
      `<span class="x">×</span>` +
      `<input data-k="gb" inputmode="numeric" maxlength="1" value="${p.gb ?? ""}"></div>` +
      `<div class="time dir"><div><div>${DADOS.nomeDe[j.b]}</div><div class="sigla">${j.b}</div></div>${bandeira(j.b)}</div>`;
    card.querySelectorAll("input").forEach(inp => {
      inp.oninput = () => {
        inp.value = inp.value.replace(/[^0-9]/g, "").slice(0, 1);
        const ga = card.querySelector('[data-k="ga"]').value, gb = card.querySelector('[data-k="gb"]').value;
        P.placaresGrupos[j.jogo_id] = { ga: ga === "" ? null : +ga, gb: gb === "" ? null : +gb };
        persistir(); atualizarClassificacao(j.grupo); atualizarProgresso(); renderEtapas();
        if (inp.value !== "") focarProximo(inp);
      };
    });
    return card;
  }
  function boxClassificacao(g) {
    const box = el("div", "classif"); box.id = "classif-" + g;
    box.innerHTML = "<h4>Classificação prevista</h4><ol></ol>";
    preencherClassif(box, g); return box;
  }
  function atualizarClassificacao(g) { const box = $("#classif-" + g); if (box) preencherClassif(box, g); }
  function preencherClassif(box, g) {
    recomputar();
    const ol = box.querySelector("ol"); ol.innerHTML = "";
    (derivado.classificacao[g] || []).forEach((t, i) => {
      const li = el("li", i < 2 ? "passa" : "");
      li.innerHTML = `<span>${bandeira(t.id)} ${DADOS.nomeDe[t.id]}</span><span>${t.pts} pts · ${t.sg >= 0 ? "+" : ""}${t.sg}</span>`;
      ol.appendChild(li);
    });
  }
  function atualizarProgresso() {
    const tot = totalPreenchidos();
    $("#barra-fill").style.width = (tot / 104 * 100) + "%";
    $("#progresso-texto").textContent = tot + " de 104 jogos preenchidos";
  }

  function modoSimulado() { return Date.now() < VIRADA_SIMULADO.getTime(); }
  function normESPN(ab) { return ESPN_OVR[ab] || ab; }
  function ymdEventoBR(iso) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"America/Sao_Paulo", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date(iso));
      const get = t => (parts.find(p => p.type === t) || {}).value || "";
      return `${get("year")}${get("month")}${get("day")}`;
    } catch (e) { return ""; }
  }
  function phaseOf(ev) {
    const comp = ev && ev.competitions && ev.competitions[0] ? ev.competitions[0] : {};
    const raw = [
      ev && ev.season && ev.season.slug,
      ev && ev.name,
      ev && ev.shortName,
      comp.name,
      comp.shortName,
      comp.note,
      comp.notes
    ].filter(Boolean).join(" ").toLowerCase();
    if (/group/.test(raw)) return "group-stage";
    if (/third|3rd|bronze|terceiro/.test(raw)) return "third-place";
    if (/round[-\s_]*of[-\s_]*32|round32|\br32\b|\b32\b/.test(raw)) return "round-of-32";
    if (/round[-\s_]*of[-\s_]*16|round16|\br16\b|\b16\b|oitava|octav/.test(raw)) return "round-of-16";
    if (/quarter|quartas|quarterfinal/.test(raw)) return "quarterfinals";
    if (/semi|semifinal/.test(raw)) return "semifinals";
    if (/final/.test(raw)) return "final";
    const d = ymdEventoBR(ev && ev.date);
    if (d >= "20260611" && d <= "20260627") return "group-stage";
    if (d >= "20260628" && d <= "20260703") return "round-of-32";
    if (d >= "20260704" && d <= "20260707") return "round-of-16";
    if (d >= "20260709" && d <= "20260711") return "quarterfinals";
    if (d >= "20260714" && d <= "20260715") return "semifinals";
    if (d === "20260718") return "third-place";
    if (d === "20260719") return "final";
    return "";
  }
  function isPost(ev) { return !!(ev && ev.competitions && ev.competitions[0] && ev.competitions[0].status && ev.competitions[0].status.type && ev.competitions[0].status.type.state === "post"); }
  function faseComecou(events, slug) {
    return (events || []).some(e => phaseOf(e) === slug && e.competitions && e.competitions[0] && e.competitions[0].status && e.competitions[0].status.type && e.competitions[0].status.type.state !== "pre");
  }
  function teamsOf(ev) {
    try {
      return (ev.competitions[0].competitors || [])
        .map(c => normESPN((c.team || {}).abbreviation))
        .filter(t => DADOS.nomeDe && DADOS.nomeDe[t]);
    } catch (e) { return []; }
  }
  function winLoseOf(ev) {
    try {
      const cs = ev.competitions[0].competitors || [];
      const w = cs.find(c => c.winner), l = cs.find(c => !c.winner);
      const W = w ? normESPN((w.team || {}).abbreviation) : null;
      const L = l ? normESPN((l.team || {}).abbreviation) : null;
      return { w: (W && DADOS.nomeDe[W]) ? W : null, l: (L && DADOS.nomeDe[L]) ? L : null };
    } catch (e) { return { w: null, l: null }; }
  }
  function buildOficial(events) {
    const o = { decididos: {} };
    const JOGOS = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes || []);
    const GRUPOS = [...new Set(JOGOS.map(j => j.grupo))].sort();
    const slugTeams = slug => [...new Set((events || []).filter(e => phaseOf(e) === slug).flatMap(teamsOf))];
    const postCount = slug => (events || []).filter(e => phaseOf(e) === slug && isPost(e)).length;
    const faseCompletaOficial = {
      r32: postCount("round-of-32") >= 16,
      oitavas: postCount("round-of-16") >= 8,
      quartas: postCount("quarterfinals") >= 4,
      semis: postCount("semifinals") >= 2,
      final: postCount("final") >= 1
    };
    const addUnico = (arr, id) => { if (id && arr.indexOf(id) === -1) arr.push(id); };

    const r32 = slugTeams("round-of-32");
    o._apurarMata = {
      oitavas: faseComecou(events, "round-of-32"),
      quartas: faseComecou(events, "round-of-16"),
      semis: faseComecou(events, "quarterfinals"),
      final: faseComecou(events, "semifinals")
    };
    o.avancam_oitavas = slugTeams("round-of-16");
    o.avancam_quartas = slugTeams("quarterfinals");
    o.semifinalistas = slugTeams("semifinals");
    o.finalistas = slugTeams("final");

    const semiLosers = [];
    (events || []).filter(e => phaseOf(e) !== "group-stage" && isPost(e)).forEach(ev => {
      const wl = winLoseOf(ev);
      if (!wl.w) return;
      const ph = phaseOf(ev);
      if (ph === "round-of-32") addUnico(o.avancam_oitavas, wl.w);
      else if (ph === "round-of-16") addUnico(o.avancam_quartas, wl.w);
      else if (ph === "quarterfinals") addUnico(o.semifinalistas, wl.w);
      else if (ph === "semifinals") {
        addUnico(o.finalistas, wl.w);
        if (wl.l) addUnico(semiLosers, wl.l);
      }
    });
    o._semiLosers = semiLosers;

    const realG = [];
    (events || []).filter(e => phaseOf(e) === "group-stage" && isPost(e)).forEach(ev => {
      try {
        const cs = ev.competitions[0].competitors || [];
        const home = cs.find(c => c.homeAway === "home") || cs[0], away = cs.find(c => c.homeAway === "away") || cs[1];
        if (!home || !away) return;
        const hId = normESPN(home.team.abbreviation), aId = normESPN(away.team.abbreviation);
        const j = JOGOS.find(x => (x.a === hId && x.b === aId) || (x.a === aId && x.b === hId));
        if (!j) return;
        const hs = parseInt(home.score || "0", 10), as = parseInt(away.score || "0", 10);
        realG.push({ jogo_id: j.jogo_id, ga: j.a === hId ? hs : as, gb: j.a === hId ? as : hs, homeId:hId, awayId:aId });
      } catch (e) {}
    });

    const completos = {}; GRUPOS.forEach(g => completos[g] = realG.filter(p => p.jogo_id.startsWith("G_" + g + "_")).length === 6);
    const todosGrupos = GRUPOS.length && GRUPOS.every(g => completos[g]);
    if (realG.length) {
      let dg = null;
      try { dg = COPA_ENGINE.derivar(DADOS.selecoes, realG, {}, DADOS.estrutura, DADOS.terceirosMap, DADOS.fairplay || {}); } catch (e) {}
      if (dg) {
        o.classificacao = {};
        GRUPOS.forEach(g => { if (completos[g]) o.classificacao[g] = dg.classificacao[g]; });
        if (todosGrupos) { o.classificados32 = dg.classificados32; o.melhores_terceiros = dg.melhores_terceiros; }
        else if (modoSimulado()) {
          o.classificacao = {};
          GRUPOS.forEach(g => { if (dg.classificacao[g]) o.classificacao[g] = dg.classificacao[g]; });
          o.classificados32 = dg.classificados32;
          o.melhores_terceiros = dg.melhores_terceiros;
          o._simulado = true;
        }
      }
    }
    if (r32.length === 32) o.classificados32 = r32;

    const fin = (events || []).find(e => phaseOf(e) === "final" && isPost(e));
    if (fin) { const wl = winLoseOf(fin); o.campeao = wl.w; o.vice = wl.l; o.decididos.campeao = true; o.decididos.vice = true; }
    const ter = (events || []).find(e => phaseOf(e) === "third-place" && isPost(e));
    if (ter) { const wl = winLoseOf(ter); o.terceiro = wl.w; o.quarto = wl.l; o.decididos.terceiro = true; o.decididos.quarto = true; }

    const elim = new Set();
    (events || []).forEach(ev => {
      if (phaseOf(ev) !== "group-stage" && isPost(ev)) {
        const wl = winLoseOf(ev); if (wl.l) elim.add(wl.l);
      }
    });
    if ((todosGrupos || o._simulado) && o.classificados32) {
      const passou = new Set(o.classificados32);
      (DADOS.selecoes || []).forEach(s => { if (!passou.has(s.id)) elim.add(s.id); });
    }

    // Auditoria igual à aba Bolão: fase encerrada define quem continua vivo.
    function eliminarQuemNaoAvancou(origem, destino, completa) {
      if (!completa || !origem || !origem.length || !destino || !destino.length) return;
      const ok = new Set(destino);
      origem.forEach(id => { if (id && !ok.has(id)) elim.add(id); });
    }
    eliminarQuemNaoAvancou(o.classificados32 || [], o.avancam_oitavas || [], faseCompletaOficial.r32);
    eliminarQuemNaoAvancou(o.avancam_oitavas || [], o.avancam_quartas || [], faseCompletaOficial.oitavas);
    eliminarQuemNaoAvancou(o.avancam_quartas || [], o.semifinalistas || [], faseCompletaOficial.quartas);
    eliminarQuemNaoAvancou(o.semifinalistas || [], o.finalistas || [], faseCompletaOficial.semis);
    if (faseCompletaOficial.final && o.finalistas && o.campeao) {
      o.finalistas.forEach(id => { if (id && id !== o.campeao) elim.add(id); });
    }

    o._faseCompleta = faseCompletaOficial;
    o.eliminados = [...elim];
    o._realGrupos = {}; realG.forEach(x => o._realGrupos[x.jogo_id] = { ga:x.ga, gb:x.gb, homeId:x.homeId, awayId:x.awayId });
    o._meta = { todosGrupos, segundaFase: !!(o.classificados32 && o.classificados32.length), nGruposCompletos: GRUPOS.filter(g => completos[g]).length, simulado: !!o._simulado };
    return o;
  }

async function carregarOficialAtual(force) {
    if (OFICIAL_CARREGANDO && !force) return;
    OFICIAL_CARREGANDO = true;
    try {
      const stamp = Date.now();
      const lotes = await Promise.all(JANELAS_ESPN.map(d =>
        fetch(`${API_ESPN}?dates=${d}&limit=120&_=${stamp}`)
          .then(r => r.json())
          .catch(() => ({ events: [] }))
      ));
      const vistos = new Set(); const events = [];
      lotes.forEach(l => (l.events || []).forEach(ev => {
        const id = String(ev.id || (ev.competitions && ev.competitions[0] && ev.competitions[0].id) || "");
        if (!id || vistos.has(id)) return;
        vistos.add(id); events.push(ev);
      }));
      DADOS.oficial = buildOficial(events);
      const tela = document.querySelector("#tela-palpite:not(.oculto)");
      if (tela && faseAtual !== "grupos") renderPalpite();
    } catch (e) {
      // Não apaga o último oficial válido; evita voltar a zero se uma atualização falhar.
      if (!DADOS.oficial) DADOS.oficial = null;
    } finally {
      OFICIAL_CARREGANDO = false;
    }
  }
  function statusPalpiteFase(id, fase) {
    const o = DADOS.oficial;
    if (!o || !id) return "pend";
    const classificados32 = o.classificados32 || [];
    const eliminados = o.eliminados || [];

    // 2ª fase/16-avos: aqui o acerto é efetivamente ter entrado entre os 32.
    if (fase === "r32") {
      if (classificados32.length) return classificados32.indexOf(id) !== -1 ? "ok" : "err";
      if (eliminados.indexOf(id) !== -1) return "err";
      return "pend";
    }

    // Oitavas em diante: NÃO compara com a lista projetada da ESPN/chaveamento.
    // A pergunta é: esta seleção que eu cravei para avançar ainda está viva?
    // Só sai do páreo quando não classificou para os 32 ou quando foi eliminada em campo.
    if (classificados32.length && classificados32.indexOf(id) === -1) return "err";
    if (eliminados.indexOf(id) !== -1) return "err";
    if (classificados32.length && classificados32.indexOf(id) !== -1) return "ok";
    return "pend";
  }
  function marcadorStatus(id, fase) {
    const st = statusPalpiteFase(id, fase);
    if (st === "ok") return `<span class="cn-status cn-ok" title="Ainda vivo / batendo com a situação atual">✓</span>`;
    if (st === "err") return `<span class="cn-status cn-err" title="Hoje está fora / não confirma este palpite">×</span>`;
    return "";
  }

  // Painel READ-ONLY com as SELEÇÕES que avançam nesta fase, conforme o palpite canônico
  // auditado. Só aparece depois da trava (palpite lacrado), pra não atrapalhar a digitação.
  // É a fonte fiel de "quem passa" — independente das posições do chaveamento.
  function painelCanonicoFase(fase) {
    const can = meuCanonico();
    if (!can) return null;
    const travado = FINALIZADO || Date.now() > TRAVA_MS;
    if (!travado) return null;
    const mapa = {
      r32: ["Seleções nos 16-avos (32)", can.classificados32],
      oitavas: ["Avançam às Oitavas (16)", can.avancam_oitavas],
      quartas: ["Avançam às Quartas (8)", can.avancam_quartas],
      semifinais: ["Semifinalistas (4)", can.semifinalistas],
      final: ["Finalistas (2)", can.finalistas]
    };
    const cfg = mapa[fase];
    if (!cfg || !cfg[1] || !cfg[1].length) return null;
    const [rot, lista] = cfg;
    const itensStatus = lista.map(id => {
      const nome = (DADOS.nomeDe && DADOS.nomeDe[id]) ? DADOS.nomeDe[id] : id;
      const st = statusPalpiteFase(id, fase);
      return { id, nome, st };
    });
    const noPareo = itensStatus.filter(item => item.st === "ok");
    const fora = itensStatus.filter(item => item.st === "err");
    const indef = itensStatus.filter(item => item.st !== "ok" && item.st !== "err");
    const resumoPill = `<span class="cn-resumo-inline"><span>📊 ${noPareo.length} no páreo</span><span>·</span><span>${fora.length} fora</span>${indef.length ? `<span>·</span><span>${indef.length} indef.</span>` : ""}</span>`;
    const chip = item => `<span class="cn-chip cn-chip-${item.st}">${bandeira(item.id)}<span>${item.nome}</span>${marcadorStatus(item.id, fase)}</span>`;
    const vazio = texto => `<span class="cn-vazio">${texto}</span>`;
    const secao = (classe, icone, titulo, itens, vazioTxt) => `
      <div class="cn-grupo-status cn-grupo-${classe}">
        <div class="cn-grupo-tit">${icone} ${titulo} (${itens.length})</div>
        <div class="cn-chips cn-chips-status">${itens.length ? itens.map(chip).join("") : vazio(vazioTxt)}</div>
      </div>`;

    const box = el("div", "canon-fase");
    box.innerHTML = `<div class="cn-tit"><span>✅ Seu palpite (seleções que avançam) — ${rot}</span>${resumoPill}</div>
      <div class="cn-grupos-status">
        ${secao("ok", "✅", "Ainda no páreo", noPareo, "Nenhuma seleção no páreo neste momento.")}
        ${secao("err", "❌", "Fora do páreo", fora, "Nenhuma seleção fora do páreo neste momento.")}
        ${indef.length ? secao("pend", "⏳", "Ainda sem definição", indef, "") : ""}
      </div>
      <div class="cn-nota">No mata-mata vale <b>quem você cravou que avança</b>, não o placar nem a posição no chaveamento. ✓ = ainda no páreo · × = fora do páreo.</div>`;
    return box;
  }

  // ---------- mata-mata ----------
  function renderFaseMata(fase) {
    const c = $("#conteudo-fase"); c.innerHTML = ""; recomputar();
    if (fase === "r32" && derivado.faltaMapa) c.appendChild(avisoAnexoC(derivado.chave));
    c.appendChild(el("div", "titulo-fase", FASES.find(f => f.id === fase).nome));
    const painelCan = painelCanonicoFase(fase);
    if (painelCan) c.appendChild(painelCan);

    // Depois da TRAVA (ou palpite finalizado) o mata-mata vira READ-ONLY e é exibido
    // SOMENTE como as seleções que avançam (painel canônico auditado), NUNCA os
    // confrontos propagados por posição — que mostravam a seleção errada (ex.:
    // "Argentina × Arábia" / "México × Espanha") porque o desempate da FIFA reordenou
    // os grupos e o slot "2H" passou a apontar pra outra seleção. A supressão NÃO
    // depende mais de achar o canônico: travou, não mostra confronto-fantasma.
    const travadoRO = (FINALIZADO || Date.now() > TRAVA_MS);
    // Salvaguarda: travado mas sem lista auditada localizada pelo nome → avisa em vez
    // de exibir o chaveamento enganoso (não deve ocorrer; os 24 têm lista com hash).
    if (travadoRO && !painelCan && !meuCanonico()) {
      c.appendChild(el("div", "aviso-anexo",
        "Seu palpite de mata-mata auditado não foi localizado pelo nome de login. " +
        "Fale com o administrador para conferir o cadastro — nada foi alterado no banco."));
    }
    let jogos;
    if (fase === "final") {
      jogos = [{ id: "M104", rot: "🏆 Disputa do Título" }, { id: "M103", rot: "Disputa do 3º Lugar" }]
        .map(d => { const t = derivado.timeDe[d.id] || {}; return { id: d.id, a: t.a, b: t.b, rot: d.rot }; });
    } else {
      jogos = jogosDaFase(fase);
    }

    const alertasEl = el("div"); alertasEl.id = "fase-alertas";
    if (!travadoRO) {
      c.appendChild(alertasEl);
      const lista = el("div", "lista-jogos");
      jogos.forEach(m => {
        if (m.rot) lista.appendChild(el("div", "rotulo-jogo", m.rot));
        lista.appendChild(cardJogoMata(m));
      });
      c.appendChild(lista);
    }
    if (fase === "final") c.appendChild(blocoRevisao());
    const acoes = el("div", "acoes");
    const idx = FASES.findIndex(f => f.id === fase);
    if (idx > 0) { const a = el("button", "btn-sec", "← " + FASES[idx - 1].nome); a.onclick = () => { faseAtual = FASES[idx - 1].id; renderPalpite(); }; acoes.appendChild(a); }
    let pbtn = null;
    if (idx < FASES.length - 1) { pbtn = el("button", "btn-primario"); acoes.appendChild(pbtn); }

    // alerta + botão de avançar atualizam AO VIVO a cada dígito (sem re-render, preserva o foco)
    atualizarFeedbackFase = function () {
      if (travadoRO) {
        if (pbtn) {
          pbtn.textContent = FASES[idx + 1].nome + " →";
          pbtn.classList.remove("desabilitado"); pbtn.disabled = false;
          pbtn.onclick = () => { faseAtual = FASES[idx + 1].id; renderPalpite(); };
        }
        return;
      }
      let emp = 0, agu = 0, res = 0;
      jogos.forEach(m => {
        const p = P.placaresMata[m.id] || {};
        if (!m.a || !m.b) { agu++; return; }
        if (p.a == null || p.b == null) return;
        if (p.a === p.b) { emp++; return; }
        res++;
      });
      let h = "";
      if (emp > 0) h += '<div class="aviso-anexo erro-box">⚠ <b>' + emp + ' confronto(s) empatado(s)</b> nesta fase — empate não avança. Defina um vencedor em cada um.</div>';
      if (agu > 0) h += '<div class="aviso-anexo">Há <b>' + agu + ' confronto(s) "aguardando"</b>: o vencedor da fase anterior ainda não foi definido. Volte uma fase e resolva.</div>';
      alertasEl.innerHTML = h;
      if (pbtn) {
        const faltam = jogos.length - res;
        if (faltam > 0) {
          pbtn.textContent = "Defina o vencedor de " + faltam + " confronto(s) para avançar";
          pbtn.classList.add("desabilitado"); pbtn.disabled = true; pbtn.onclick = null;
        } else {
          pbtn.textContent = FASES[idx + 1].nome + " →";
          pbtn.classList.remove("desabilitado"); pbtn.disabled = false;
          pbtn.onclick = () => { faseAtual = FASES[idx + 1].id; renderPalpite(); };
        }
      }
    };
    atualizarFeedbackFase();
    if (fase === "final" && !FINALIZADO && Date.now() <= TRAVA_MS) {
      const concluir = el("button", "btn-primario", "Concluir meu palpite ✓");
      concluir.onclick = () => {
        persistir();
        const faltam = 104 - totalPreenchidos();
        if (faltam > 0) { popup("Ainda faltam " + faltam + " jogo(s) para concluir. Verifique se há empates no mata-mata — eles não contam até você definir um vencedor."); return; }
        popup("Palpite completo! 🎉 Está salvo e lacrado. Boa sorte — acompanhe tudo nas páginas Ao vivo, Resultados e Classificação!");
      };
      acoes.appendChild(concluir);
    }
    c.appendChild(acoes);
  }
  function jogosDaFase(fase) {
    if (fase === "r32") return derivado.r32.map(m => ({ id: m.id, a: m.a, b: m.b }));
    return DADOS.estrutura.arvore.filter(m => m.fase === fase || (fase === "final" && m.fase === "terceiro"))
      .map(m => ({ id: m.id, a: derivado.timeDe[m.id].a, b: derivado.timeDe[m.id].b, fase: m.fase }));
  }
  function cardJogoMata(m) {
    const p = P.placaresMata[m.id] || {};
    const wrap = el("div"); const card = el("div", "jogo");
    const nomeA = m.a ? DADOS.nomeDe[m.a] : "—", nomeB = m.b ? DADOS.nomeDe[m.b] : "—";
    card.innerHTML =
      `<div class="time">${m.a ? bandeira(m.a) : ""}<div><div>${nomeA}</div><div class="sigla">${m.a || "aguardando"}</div></div></div>` +
      `<div class="placar"><input data-k="a" inputmode="numeric" maxlength="1" value="${p.a ?? ""}" ${m.a ? "" : "disabled"}>` +
      `<span class="x">×</span>` +
      `<input data-k="b" inputmode="numeric" maxlength="1" value="${p.b ?? ""}" ${m.b ? "" : "disabled"}></div>` +
      `<div class="time dir"><div><div>${nomeB}</div><div class="sigla">${m.b || "aguardando"}</div></div>${m.b ? bandeira(m.b) : ""}</div>`;
    const venc = el("div", "vencedor");
    wrap.appendChild(card); wrap.appendChild(venc);
    pintarCard(card, venc, m, P.placaresMata[m.id] || {});
    card.querySelectorAll("input").forEach(inp => {
      inp.oninput = () => {
        inp.value = inp.value.replace(/[^0-9]/g, "").slice(0, 1);
        const a = card.querySelector('[data-k="a"]').value, b = card.querySelector('[data-k="b"]').value;
        const va = a === "" ? null : +a, vb = b === "" ? null : +b;
        P.placaresMata[m.id] = { a: va, b: vb };
        persistir();
        if (va != null && vb != null && va === vb) popup("No mata-mata não pode haver empate. Defina um vencedor — quem empata não avança e trava a próxima fase.");
        pintarCard(card, venc, m, { a: va, b: vb });
        atualizarProgresso(); renderEtapas();
        if (atualizarFeedbackFase) atualizarFeedbackFase();
        if (inp.value !== "" && va !== vb) focarProximo(inp);
      };
    });
    return wrap;
  }
  // pinta o estado do confronto: vencedor, empate inválido (vermelho) ou vazio
  function pintarCard(card, elv, m, p) {
    const cheio = p && p.a != null && p.b != null;
    const empate = cheio && p.a === p.b && m.a && m.b;
    card.classList.toggle("empate", !!empate);
    if (empate) {
      elv.className = "vencedor erro";
      elv.innerHTML = "⚠ Empate não vale — defina um vencedor (senão a próxima fase fica travada)";
      return;
    }
    elv.className = "vencedor";
    if (cheio && p.a !== p.b && m.a && m.b) {
      const w = p.a > p.b ? m.a : m.b;
      elv.innerHTML = "Vencedor: " + bandeira(w) + " " + DADOS.nomeDe[w];
    } else elv.textContent = "";
  }
  function avisoAnexoC(chave) {
    return el("div", "aviso-anexo",
      `<b>Atenção:</b> a combinação de terceiros (grupos <b>${chave}</b>) não está na tabela do Anexo C. ` +
      `Com o arquivo completo isso não deve acontecer — confira o <code>terceiros_map.json</code>.`);
  }

  function nomeTime(id) {
    return (DADOS.nomeDe && DADOS.nomeDe[id]) || id || "—";
  }
  function interPts(a, b) {
    const sb = new Set(b || []);
    return (a || []).filter(x => sb.has(x));
  }
  function fasePontuacaoAtiva(key, o) {
    const ap = (o && o._apurarMata) || {};
    if (key === "classificados32" || key === "melhores_terceiros") return true;
    if (key === "avancam_oitavas") return !!ap.oitavas;
    if (key === "avancam_quartas") return !!ap.quartas;
    if (key === "semifinalistas") return !!ap.semis;
    if (key === "finalistas") return !!ap.final;
    return true;
  }
  function linhaExtratoMP(label, pts, tipo) {
    const sinal = pts > 0 ? "+" : "";
    return `<div class="mp-ex-row ${tipo || ""}"><span>${label}</span><b>${sinal}${pts}</b></div>`;
  }
  function extratoPontuacaoMeuPalpite(p, o, r) {
    if (!o || !o._meta) {
      return '<div class="mp-extrato"><div class="mp-ex-sec">Carregando resultados oficiais…</div><div class="mp-ex-row"><span>A pontuação será recalculada assim que o feed de resultados carregar.</span><b>—</b></div></div>';
    }
    const PTS = COPA_PONTUACAO.PESOS;
    const det = COPA_PONTUACAO.calcularAtuais(p, o);
    const eliminados = new Set(o.eliminados || []);
    const classificados = new Set(o.classificados32 || []);
    const linhasOk = [];
    const linhasNo = [];

    function ok(label, pts) { if (pts) linhasOk.push(linhaExtratoMP(label, pts, "ok")); }
    function no(label, pts) { if (pts) linhasNo.push(linhaExtratoMP(label, -pts, "err")); }

    const nClassif = interPts(p.classificados32, o.classificados32 || []).length;
    ok(`${nClassif} seleções entre as 32 classificadas (×${PTS.classificado32})`, nClassif * PTS.classificado32);

    const nTer = interPts(p.melhores_terceiros, o.melhores_terceiros || []).length;
    ok(`${nTer} melhores terceiros (×${PTS.melhorTerceiro})`, nTer * PTS.melhorTerceiro);

    const oc = o.classificacao || {};
    let a1 = 0, a2 = 0, a3 = 0, a4 = 0, e1 = 0, e2 = 0, e3 = 0, e4 = 0;
    Object.keys(oc).forEach(g => {
      const pg = (p.classificacao || {})[g];
      if (!pg) return;
      if (pg[0] && oc[g][0]) { if (pg[0].id === oc[g][0].id) a1++; else e1++; }
      if (pg[1] && oc[g][1]) { if (pg[1].id === oc[g][1].id) a2++; else e2++; }
      if (pg[2] && oc[g][2]) { if (pg[2].id === oc[g][2].id) a3++; else e3++; }
      if (pg[3] && oc[g][3]) { if (pg[3].id === oc[g][3].id) a4++; else e4++; }
    });
    ok(`${a1} campeões de grupo certos (×${PTS.campGrupo})`, a1 * PTS.campGrupo);
    ok(`${a2} vices de grupo certos (×${PTS.viceGrupo})`, a2 * PTS.viceGrupo);
    ok(`${a3} terceiros de grupo certos (×${PTS.terGrupo})`, a3 * PTS.terGrupo);
    ok(`${a4} quartos de grupo certos (×${PTS.ultGrupo})`, a4 * PTS.ultGrupo);

    const nOit = interPts(p.avancam_oitavas, o.avancam_oitavas || []).length;
    const nQua = interPts(p.avancam_quartas, o.avancam_quartas || []).length;
    const nSemi = interPts(p.semifinalistas, o.semifinalistas || []).length;
    const nFin = interPts(p.finalistas, o.finalistas || []).length;
    ok(`${nOit} seleções nas oitavas (×${PTS.oitavas})`, nOit * PTS.oitavas);
    ok(`${nQua} seleções nas quartas (×${PTS.quartas})`, nQua * PTS.quartas);
    ok(`${nSemi} semifinalistas (×${PTS.semi})`, nSemi * PTS.semi);
    ok(`${nFin} finalistas (×${PTS.final})`, nFin * PTS.final);
    ok(`Campeão certo`, det.campeao || 0);
    ok(`Vice certo`, det.vice || 0);
    ok(`3º lugar certo`, det.terceiro || 0);
    ok(`4º lugar certo`, det.quarto || 0);

    const fora32 = (p.classificados32 || []).filter(id => o.classificados32 && o.classificados32.length && !classificados.has(id));
    no(`${fora32.length} seleções fora das 32 (×${PTS.classificado32})${fora32.length ? ": " + fora32.map(nomeTime).join(", ") : ""}`, fora32.length * PTS.classificado32);

    const mtSet = new Set(o.melhores_terceiros || []);
    const mtErr = (p.melhores_terceiros || []).filter(id => o.melhores_terceiros && o.melhores_terceiros.length && !mtSet.has(id));
    no(`${mtErr.length} melhores terceiros errados (×${PTS.melhorTerceiro})`, mtErr.length * PTS.melhorTerceiro);

    no(`${e1} campeões de grupo errados (×${PTS.campGrupo})`, e1 * PTS.campGrupo);
    no(`${e2} vices de grupo errados (×${PTS.viceGrupo})`, e2 * PTS.viceGrupo);
    no(`${e3} terceiros de grupo errados (×${PTS.terGrupo})`, e3 * PTS.terGrupo);
    no(`${e4} quartos de grupo errados (×${PTS.ultGrupo})`, e4 * PTS.ultGrupo);

    function perdMata(key, oficiais, peso, rotulo) {
      if (!fasePontuacaoAtiva(key, o)) return;
      const conf = new Set(oficiais || []);
      const ids = (p[key] || []).filter(id => eliminados.has(id) && !conf.has(id));
      if (ids.length) no(`${ids.length} ${rotulo} (×${peso}): ${ids.map(nomeTime).join(", ")}`, ids.length * peso);
    }
    perdMata("avancam_oitavas", o.avancam_oitavas, PTS.oitavas, "seleções não avançaram às oitavas");
    perdMata("avancam_quartas", o.avancam_quartas, PTS.quartas, "seleções não avançaram às quartas");
    perdMata("semifinalistas", o.semifinalistas, PTS.semi, "semifinalistas perdidos");
    perdMata("finalistas", o.finalistas, PTS.final, "finalistas perdidos");

    if (o.decididos && o.decididos.campeao && p.campeao && p.campeao !== o.campeao) no(`Campeão errado: ${nomeTime(p.campeao)}`, PTS.campeao);
    if (o.decididos && o.decididos.vice && p.vice && p.vice !== o.vice) no(`Vice errado: ${nomeTime(p.vice)}`, PTS.vice);
    if (o.decididos && o.decididos.terceiro && p.terceiro && p.terceiro !== o.terceiro) no(`3º lugar errado: ${nomeTime(p.terceiro)}`, PTS.terceiro);
    if (o.decididos && o.decididos.quarto && p.quarto && p.quarto !== o.quarto) no(`4º lugar errado: ${nomeTime(p.quarto)}`, PTS.quarto);

    const okHTML = linhasOk.length ? linhasOk.join("") : linhaExtratoMP("Ainda sem pontos conquistados", 0, "");
    const noHTML = linhasNo.length ? linhasNo.join("") : linhaExtratoMP("Nenhum ponto perdido até agora", 0, "");

    return `<div class="mp-extrato">
      <div class="mp-ex-sec">✅ Conquistados (${r.atuais} pts)</div>${okHTML}
      <div class="mp-ex-sec">❌ Perdidos (${r.perdidos} pts)</div>${noHTML}
      <div class="mp-ex-sec">⏳ Ainda possíveis: <b>${r.possiveis} pts</b> · Eficiência: <b>${eficienciaPct(r)}</b></div>
      <div class="mp-ex-nota">Espelhado da aba Bolão: mesmo motor, mesmos pesos e mesma leitura dos resultados oficiais.</div>
    </div>`;
  }

  function blocoRevisao() {
    recomputar();
    const box = el("div", "revisao");
    box.innerHTML = "<h4 style='margin-bottom:10px;color:var(--cinza);font-size:13px;letter-spacing:1px;text-transform:uppercase'>Revisão do palpite</h4>";

    // Campeão/Vice/3º/4º: usa a lista CANÔNICA auditada quando disponível.
    const can = meuCanonico();
    const pod = can
      ? { campeao: can.campeao, vice: can.vice, terceiro: can.terceiro, quarto: can.quarto }
      : { campeao: derivado.campeao, vice: derivado.vice, terceiro: derivado.terceiro, quarto: derivado.quarto };
    [["Campeão", pod.campeao], ["Vice", pod.vice], ["3º lugar", pod.terceiro], ["4º lugar", pod.quarto]].forEach(([l, id]) => {
      box.appendChild(el("div", "linha", `<span>${l}</span><b>${id ? bandeira(id) + " " + (DADOS.nomeDe[id] || id) : "—"}</b>`));
    });

    const dPont = aplicarMataCanonico(JSON.parse(JSON.stringify(derivado || {})), USER && USER.nome ? USER.nome : "");
    const teto = COPA_PONTUACAO.teto(dPont);
    const oficial = DADOS.oficial || null;
    const r = oficial
      ? COPA_PONTUACAO.calcular(dPont, oficial)
      : { atuais:"…", perdidos:"…", possiveis:teto, teto:teto };
    if (!oficial) carregarOficialAtual(true);

    const eficiencia = eficienciaPct(r);
    const pb = el("div", "pontos-box mp-pontos-box");
    pb.innerHTML =
      `<div class="pt"><div class="n">${r.atuais}</div><div class="l">Pontos atuais</div></div>` +
      `<div class="pt"><div class="n">${r.perdidos}</div><div class="l">Perdidos</div></div>` +
      `<div class="pt"><div class="n">${r.possiveis}</div><div class="l">Ainda possíveis</div></div>` +
      `<div class="pt"><div class="n">${eficiencia}</div><div class="l">Eficiência</div></div>`;
    box.appendChild(pb);

    const nota = oficial
      ? "Pontuação espelhada da aba Bolão. Eficiência = conquistados ÷ (conquistados + perdidos)."
      : "Carregando resultados oficiais para espelhar a pontuação da aba Bolão…";
    box.appendChild(el("div", "linha", `<span style='color:var(--cinza);font-size:13px'>${nota}</span><span></span>`));

    const btn = el("button", "vermais mp-vermais", "Ver extrato dos pontos ▾");
    const ext = el("div", "extbox mp-extbox");
    ext.style.display = "none";
    ext.innerHTML = extratoPontuacaoMeuPalpite(dPont, oficial, r);
    btn.onclick = () => {
      const aberto = ext.style.display === "none";
      ext.style.display = aberto ? "block" : "none";
      btn.innerHTML = aberto ? "Ocultar extrato ▴" : "Ver extrato dos pontos ▾";
    };
    box.appendChild(btn);
    box.appendChild(ext);

    return box;
  }

  // ---------- Auditoria geral do ranking ----------
  function escHTML(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }
  function normNomeAud(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  }
  function canonicoPorNome(nome) {
    const pm = DADOS.palpitesMata || {};
    if (pm[nome]) return pm[nome];
    const alvo = normNomeAud(nome);
    const k = Object.keys(pm).find(n => normNomeAud(n) === alvo);
    return k ? pm[k] : null;
  }
  function aplicarMataCanonico(d, nome) {
    const pm = canonicoPorNome(nome);
    if (!d || !pm) return d;
    d.classificados32  = pm.classificados32  || d.classificados32;
    d.avancam_oitavas  = pm.avancam_oitavas  || d.avancam_oitavas;
    d.avancam_quartas  = pm.avancam_quartas  || d.avancam_quartas;
    d.semifinalistas   = pm.semifinalistas   || d.semifinalistas;
    d.finalistas       = pm.finalistas       || d.finalistas;
    d.campeao  = pm.campeao  || d.campeao;
    d.vice     = pm.vice     || d.vice;
    d.terceiro = pm.terceiro || d.terceiro;
    d.quarto   = pm.quarto   || d.quarto;
    return d;
  }
  function interAud(a, b) {
    const sb = new Set(b || []);
    return (a || []).filter(x => sb.has(x));
  }
  function faseAtivaAud(key, o) {
    const ap = (o && o._apurarMata) || {};
    if (key === "classificados32" || key === "melhores_terceiros") return true;
    if (key === "avancam_oitavas") return !!ap.oitavas;
    if (key === "avancam_quartas") return !!ap.quartas;
    if (key === "semifinalistas") return !!ap.semis;
    if (key === "finalistas") return !!ap.final;
    return true;
  }
  function statusItemAud(id, key, o) {
    const conf = new Set((o && o[key]) || []);
    const elim = (o && o.eliminados) || [];
    if (conf.has(id)) return "ok";
    // Categorias de grupo ficam congeladas quando o resultado oficial delas existe.
    // Portanto, se não bateu com a lista oficial, é perdido — não fica pendente.
    if (key === "classificados32" && o && o.classificados32 && o.classificados32.length && !conf.has(id)) return "no";
    if (key === "melhores_terceiros" && o && o.melhores_terceiros && o.melhores_terceiros.length && !conf.has(id)) return "no";
    if (faseAtivaAud(key, o) && elim.indexOf(id) !== -1) return "no";
    return "pend";
  }
  function rotStatusAud(st) {
    return st === "ok" ? "✅ confirmou" : (st === "no" ? "❌ perdeu" : "🟡 possível");
  }
  function chipAud(id, st, extra) {
    const nm = (DADOS.nomeDe && DADOS.nomeDe[id]) || id || "—";
    return `<span class="aud-chip ${st}">${bandeira(id)} ${escHTML(id)} <small>${extra ? escHTML(extra) : rotStatusAud(st)}</small></span>`;
  }
  function linhaPonto(txt, val) {
    return `<div class="aud-line"><span>${txt}</span><b>${val > 0 ? "+" : ""}${val}</b></div>`;
  }
  async function buscarEventosOficiaisAuditoria() {
    const lotes = await Promise.all(JANELAS_ESPN.map(d => fetch(`${API_ESPN}?dates=${d}&limit=120&_=${Date.now()}`).then(r => r.json()).catch(() => ({ events: [] }))));
    const vistos = new Set(), events = [];
    lotes.forEach(l => (l.events || []).forEach(ev => {
      const id = String(ev.id || (ev.competitions && ev.competitions[0] && ev.competitions[0].id) || "");
      if (!id || vistos.has(id)) return;
      vistos.add(id); events.push(ev);
    }));
    return events;
  }
  function cravadosAuditoria(pg, real) {
    let n = 0;
    for (const id in (real || {})) {
      const a = pg && pg[id];
      if (a && Number(a.ga) === Number(real[id].ga) && Number(a.gb) === Number(real[id].gb)) n++;
    }
    return n;
  }
  function derivarPalpiteAuditoria(row) {
    const pl = row.payload || {};
    const g = Object.keys(pl.placaresGrupos || {}).map(id => ({
      jogo_id: id,
      ga: pl.placaresGrupos[id].ga,
      gb: pl.placaresGrupos[id].gb
    }));
    // ATENÇÃO: aqui precisa espelhar o ranking principal.
    // O palpite lacrado do participante NÃO usa fair play oficial na derivação.
    // Fair play só é usado para montar o resultado oficial atual.
    let d = COPA_ENGINE.derivar(DADOS.selecoes, g, pl.placaresMata || {}, DADOS.estrutura, DADOS.terceirosMap);
    d = aplicarMataCanonico(d, row.nome);
    return { d, pg: pl.placaresGrupos || {}, payload: pl };
  }
  function estatListaAud(key, peso, d, o) {
    const ids = (d && d[key]) || [];
    let ok = [], no = [], pend = [];
    ids.forEach(id => {
      const st = statusItemAud(id, key, o);
      if (st === "ok") ok.push(id);
      else if (st === "no") no.push(id);
      else pend.push(id);
    });
    const ativo = faseAtivaAud(key, o);
    return {
      ids, ok, no, pend, ativo, peso,
      ganhos: ok.length * peso,
      perdidos: ativo ? no.length * peso : 0,
      possiveis: pend.length * peso + (!ativo ? no.length * peso : 0)
    };
  }
  function posicoesGrupoAud(d, o) {
    const pesos = [COPA_PONTUACAO.PESOS.campGrupo, COPA_PONTUACAO.PESOS.viceGrupo, COPA_PONTUACAO.PESOS.terGrupo, COPA_PONTUACAO.PESOS.ultGrupo];
    const labs = ["1º colocado do grupo", "2º colocado do grupo", "3º colocado do grupo", "4º colocado do grupo"];
    const out = labs.map((lab, i) => ({ lab, peso: pesos[i], ok:0, no:0, pend:0, ganhos:0, perdidos:0 }));
    const oc = (o && o.classificacao) || {};
    const pc = (d && d.classificacao) || {};
    Object.keys(pc).sort().forEach(g => {
      for (let i=0;i<4;i++) {
        const pick = pc[g] && pc[g][i] && pc[g][i].id;
        const real = oc[g] && oc[g][i] && oc[g][i].id;
        if (!pick) continue;
        if (!real) out[i].pend++;
        else if (pick === real) { out[i].ok++; out[i].ganhos += pesos[i]; }
        else { out[i].no++; out[i].perdidos += pesos[i]; }
      }
    });
    return out;
  }
  function detalhesAuditoria(row, d, pg, payload, r, oficial, hash, cr) {
    const P = COPA_PONTUACAO.PESOS;
    const s32 = estatListaAud("classificados32", P.classificado32, d, oficial);
    const mt = estatListaAud("melhores_terceiros", P.melhorTerceiro, d, oficial);
    const oit = estatListaAud("avancam_oitavas", P.oitavas, d, oficial);
    const qua = estatListaAud("avancam_quartas", P.quartas, d, oficial);
    const sem = estatListaAud("semifinalistas", P.semi, d, oficial);
    const fin = estatListaAud("finalistas", P.final, d, oficial);
    const pos = posicoesGrupoAud(d, oficial);

    const grupos = {};
    const jogos = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes || []);
    jogos.forEach(j => {
      const p = pg[j.jogo_id] || {};
      const linha = `${j.a} ${p.ga != null ? p.ga : "?"}x${p.gb != null ? p.gb : "?"} ${j.b}`;
      (grupos[j.grupo] = grupos[j.grupo] || { jogos:[], apostada:[], real:[] }).jogos.push(linha);
    });
    Object.keys(grupos).forEach(g => {
      grupos[g].apostada = ((d.classificacao || {})[g] || []).map(x => x.id);
      grupos[g].real = ((oficial.classificacao || {})[g] || []).map(x => x.id);
    });

    const ganhosDetalhados = s32.ganhos + mt.ganhos + pos.reduce((a,x)=>a+x.ganhos,0) + oit.ganhos + qua.ganhos + sem.ganhos + fin.ganhos;
    const perdidosDetalhados = s32.perdidos + mt.perdidos + pos.reduce((a,x)=>a+x.perdidos,0) + oit.perdidos + qua.perdidos + sem.perdidos + fin.perdidos;
    return { row, d, pg, payload, r, oficial, hash, cr, s32, mt, oit, qua, sem, fin, pos, grupos, ganhosDetalhados, perdidosDetalhados };
  }
  function pontuacaoGrupoHTML(det) {
    const posG = det.pos.reduce((a,x) => a + x.ganhos, 0);
    const posP = det.pos.reduce((a,x) => a + x.perdidos, 0);
    const ganho = det.s32.ganhos + det.mt.ganhos + posG;
    const perdido = det.s32.perdidos + det.mt.perdidos + posP;
    const linhasGanhos = [
      linhaPonto(`Classificados entre as 32: ${det.s32.ok.length} × ${det.s32.peso}`, det.s32.ganhos),
      ...det.pos.map(x => linhaPonto(`${x.lab}: ${x.ok} × ${x.peso}`, x.ganhos)),
      linhaPonto(`Melhores terceiros: ${det.mt.ok.length} × ${det.mt.peso}`, det.mt.ganhos)
    ].join("");
    const linhasPerdidos = [
      linhaPonto(`Não entraram nas 32: ${det.s32.no.length} × ${det.s32.peso}`, -det.s32.perdidos),
      ...det.pos.map(x => linhaPonto(`${x.lab} errados: ${x.no} × ${x.peso}`, -x.perdidos)),
      linhaPonto(`Melhores terceiros errados: ${det.mt.no.length} × ${det.mt.peso}`, -det.mt.perdidos)
    ].join("");
    return `<div class="aud-grid">
      <div class="aud-card"><h5>✅ Pontos ganhos na fase de grupos</h5>${linhasGanhos}<div class="aud-line"><span><b>Total grupos ganho</b></span><b>+${ganho}</b></div></div>
      <div class="aud-card"><h5>❌ Pontos perdidos na fase de grupos</h5>${linhasPerdidos}<div class="aud-line"><span><b>Total grupos perdido</b></span><b>-${perdido}</b></div></div>
    </div>`;
  }
  function faseMataHTML(label, st) {
    const chips = st.ids.map(id => chipAud(id, statusItemAud(id, label.key, st.oficial))).join("");
    return `<div class="aud-card">
      <h5>${escHTML(label.nome)} — peso ${label.peso}</h5>
      <div class="aud-line"><span>Confirmados</span><b>+${st.ganhos}</b></div>
      <div class="aud-line"><span>Perdidos nesta fase ${st.ativo ? "" : "(fase ainda fechada)"}</span><b>${st.perdidos ? "-" + st.perdidos : "0"}</b></div>
      <div class="aud-line"><span>Ainda possíveis</span><b>${st.possiveis}</b></div>
      <div class="aud-chipwrap" style="margin-top:8px">${chips || "<span class='aud-chip pend'>—</span>"}</div>
    </div>`;
  }
  function mataHTML(det) {
    const fases = [
      { key:"avancam_oitavas", nome:"Oitavas", peso:COPA_PONTUACAO.PESOS.oitavas, stat:det.oit },
      { key:"avancam_quartas", nome:"Quartas", peso:COPA_PONTUACAO.PESOS.quartas, stat:det.qua },
      { key:"semifinalistas", nome:"Semifinal", peso:COPA_PONTUACAO.PESOS.semi, stat:det.sem },
      { key:"finalistas", nome:"Finalistas", peso:COPA_PONTUACAO.PESOS.final, stat:det.fin }
    ].map(f => {
      f.stat.oficial = det.oficial; f.stat.key = f.key;
      return faseMataHTML(f, f.stat);
    }).join("");
    const pod = [["Campeão", det.d.campeao, COPA_PONTUACAO.PESOS.campeao, "campeao"], ["Vice", det.d.vice, COPA_PONTUACAO.PESOS.vice, "vice"], ["3º lugar", det.d.terceiro, COPA_PONTUACAO.PESOS.terceiro, "terceiro"], ["4º lugar", det.d.quarto, COPA_PONTUACAO.PESOS.quarto, "quarto"]];
    const podHTML = pod.map(([lab,id,peso,key]) => {
      let st = "pend", val = 0, txt = "aguardando definição oficial";
      if (det.oficial.decididos && det.oficial.decididos[key]) {
        st = det.oficial[key] === id ? "ok" : "no";
        val = st === "ok" ? peso : -peso;
        txt = st === "ok" ? `+${peso}` : `-${peso}`;
      }
      return `<div class="aud-line"><span>${lab}: ${bandeira(id)} ${escHTML(id || "—")}</span><b>${txt}</b></div>`;
    }).join("");
    return `<div class="aud-grid">${fases}</div><div class="aud-card" style="margin-top:12px"><h5>🏆 Pódio apostado</h5>${podHTML}<div class="auditoria-nota">Pódio é debitado/confirmado quando a posição oficial for decidida.</div></div>`;
  }
  function gruposHTML(det) {
    const body = Object.keys(det.grupos).sort().map(g => {
      const x = det.grupos[g];
      const plac = x.jogos.map(j => `<div class="aud-placar">${escHTML(j)}</div>`).join("");
      const ap = x.apostada.map((id,i) => `<li>${i+1}º ${bandeira(id)} ${escHTML(id)}</li>`).join("");
      const real = x.real.length ? x.real.map((id,i) => `<li>${i+1}º ${bandeira(id)} ${escHTML(id)}</li>`).join("") : "<li>grupo ainda não fechado</li>";
      return `<details><summary>Grupo ${escHTML(g)} — placares e classificação</summary>
        <div class="aud-placares">${plac}</div>
        <div class="aud-classif"><div><b>Classificação apostada</b><ol>${ap}</ol></div><div><b>Classificação oficial atual</b><ol>${real}</ol></div></div>
      </details>`;
    }).join("");
    return `<div class="aud-accordion">${body}</div>`;
  }
  function listaSelecoesHTML(titulo, st, key, oficial) {
    const chips = st.ids.map(id => chipAud(id, statusItemAud(id, key, oficial))).join("");
    return `<div class="aud-card"><h5>${escHTML(titulo)}</h5><div class="aud-chipwrap">${chips}</div></div>`;
  }
  function detalheParticipanteHTML(item) {
    const det = item.det;
    const totalGruposGanhos = det.s32.ganhos + det.mt.ganhos + det.pos.reduce((a,x)=>a+x.ganhos,0);
    const totalMataGanhos = det.oit.ganhos + det.qua.ganhos + det.sem.ganhos + det.fin.ganhos;
    const totalGruposPerdidos = det.s32.perdidos + det.mt.perdidos + det.pos.reduce((a,x)=>a+x.perdidos,0);
    const totalMataPerdidos = det.oit.perdidos + det.qua.perdidos + det.sem.perdidos + det.fin.perdidos;
    const diffGanhos = item.atuais - det.ganhosDetalhados;
    const diffPerdidos = item.perdidos - det.perdidosDetalhados;
    const notaConsistencia = (diffGanhos || diffPerdidos)
      ? `<div class="auditoria-nota auditoria-erro">Atenção: total do motor = ${item.atuais}/${item.perdidos}, detalhamento visual = ${det.ganhosDetalhados}/${det.perdidosDetalhados}. Esta linha precisa ser investigada.</div>`
      : `<div class="auditoria-nota">Conferência interna OK: o dossiê abaixo soma exatamente os mesmos números do ranking.</div>`;
    return `<div class="aud-det-top">
      <div><h4>${escHTML(item.nome)} — dossiê da auditoria</h4><div class="hash">Hash calculado: ${escHTML(item.hash)}</div></div>
      <div class="auditoria-actions" style="margin-top:0"><button type="button" data-baixar-dossie="${item.idx}">Baixar dossiê TXT</button></div>
    </div>
    <div class="aud-mini">
      <div class="aud-card"><b>${item.atuais}</b><span>conquistados</span></div>
      <div class="aud-card"><b>${item.perdidos}</b><span>perdidos</span></div>
      <div class="aud-card"><b>${item.possiveis}</b><span>possíveis</span></div>
      <div class="aud-card"><b>${eficienciaPct(item)}</b><span>eficiência</span></div>
    </div>${notaConsistencia}
    <div class="aud-section-title">1. Extrato dos pontos</div>
    <div class="aud-grid">
      <div class="aud-card"><h5>Resumo conquistado</h5>${linhaPonto("Fase de grupos", totalGruposGanhos)}${linhaPonto("Mata-mata já apurado", totalMataGanhos)}${linhaPonto("Pódio/títulos definidos", item.atuais - totalGruposGanhos - totalMataGanhos)}<div class="aud-line"><span><b>Total conquistado</b></span><b>+${item.atuais}</b></div></div>
      <div class="aud-card"><h5>Resumo perdido</h5>${linhaPonto("Fase de grupos", -totalGruposPerdidos)}${linhaPonto("Mata-mata fase a fase", -totalMataPerdidos)}${linhaPonto("Pódio/títulos definidos", -(item.perdidos - totalGruposPerdidos - totalMataPerdidos))}<div class="aud-line"><span><b>Total perdido</b></span><b>-${item.perdidos}</b></div></div>
    </div>
    ${pontuacaoGrupoHTML(det)}
    <div class="aud-section-title">2. Fase de grupos — placares e classificações</div>
    ${gruposHTML(det)}
    <div class="aud-section-title">3. Seleções classificadas e melhores terceiros</div>
    <div class="aud-grid">${listaSelecoesHTML("32 seleções apostadas", det.s32, "classificados32", det.oficial)}${listaSelecoesHTML("Melhores terceiros apostados", det.mt, "melhores_terceiros", det.oficial)}</div>
    <div class="aud-section-title">4. Mata-mata — 16, 8, 4, 2 e pódio</div>
    ${mataHTML(det)}`;
  }
  function dossieTXT(item) {
    const det = item.det;
    const lines = [
      `DOSSIÊ DE AUDITORIA — ${item.nome}`,
      `Hash calculado: ${item.hash}`,
      `Conquistados=${item.atuais} | Perdidos=${item.perdidos} | Possíveis=${item.possiveis} | Eficiência=${eficienciaPct(item)} | Teto técnico=${item.teto}`,
      "",
      "PLACARES DA FASE DE GRUPOS"
    ];
    Object.keys(det.grupos).sort().forEach(g => {
      lines.push(`Grupo ${g}`);
      det.grupos[g].jogos.forEach(j => lines.push("  " + j));
      lines.push("  Classificação apostada: " + det.grupos[g].apostada.join(", "));
      lines.push("  Classificação oficial: " + (det.grupos[g].real.join(", ") || "grupo ainda não fechado"));
    });
    lines.push("", "MATA-MATA APOSTADO");
    lines.push("32: " + (det.d.classificados32 || []).join(", "));
    lines.push("Oitavas: " + (det.d.avancam_oitavas || []).join(", "));
    lines.push("Quartas: " + (det.d.avancam_quartas || []).join(", "));
    lines.push("Semifinal: " + (det.d.semifinalistas || []).join(", "));
    lines.push("Final: " + (det.d.finalistas || []).join(", "));
    lines.push(`Pódio: 1º ${det.d.campeao || "-"} | 2º ${det.d.vice || "-"} | 3º ${det.d.terceiro || "-"} | 4º ${det.d.quarto || "-"}`);
    lines.push("", "EXTRATO");
    lines.push(`32 classificados: +${det.s32.ganhos} / -${det.s32.perdidos}`);
    lines.push(`Melhores terceiros: +${det.mt.ganhos} / -${det.mt.perdidos}`);
    det.pos.forEach(x => lines.push(`${x.lab}: +${x.ganhos} / -${x.perdidos}`));
    lines.push(`Oitavas: +${det.oit.ganhos} / -${det.oit.perdidos} / possíveis ${det.oit.possiveis}`);
    lines.push(`Quartas: +${det.qua.ganhos} / -${det.qua.perdidos} / possíveis ${det.qua.possiveis}`);
    lines.push(`Semifinal: +${det.sem.ganhos} / -${det.sem.perdidos} / possíveis ${det.sem.possiveis}`);
    lines.push(`Finalistas: +${det.fin.ganhos} / -${det.fin.perdidos} / possíveis ${det.fin.possiveis}`);
    return lines.join("\n");
  }
  function baixarTextoAuditoria(nome, texto) {
    const blob = new Blob([texto], { type:"text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }
  function abrirModalAuditoria(html, textoDownload, lista) {
    document.querySelectorAll(".auditoria-modal").forEach(x => x.remove());
    const modal = document.createElement("div");
    modal.className = "auditoria-modal";
    modal.innerHTML = `<div class="auditoria-box">
      <div class="auditoria-head">
        <div><h3>🧾 Auditoria geral do ranking</h3><p>Recalcula todos os participantes diretamente das apostas lacradas no banco, abre dossiê individual e extratifica os pontos.</p></div>
        <button class="auditoria-close" type="button">Fechar</button>
      </div>
      ${html}
      <div id="auditoria-detalhe" class="auditoria-detalhe" style="display:none"></div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector(".auditoria-close").onclick = () => modal.remove();
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    const down = modal.querySelector("[data-baixar-auditoria]");
    if (down) down.onclick = () => baixarTextoAuditoria("auditoria-ranking-copa2026.txt", textoDownload || "Auditoria indisponível.");
    const copy = modal.querySelector("[data-copiar-auditoria]");
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(textoDownload || ""); copy.textContent = "Copiado ✓"; }
      catch(e) { copy.textContent = "Não copiou"; }
    };
    modal.querySelectorAll("[data-det-aud]").forEach(btn => {
      btn.onclick = () => {
        const item = lista[Number(btn.dataset.detAud)];
        const box = modal.querySelector("#auditoria-detalhe");
        box.style.display = "block";
        box.innerHTML = detalheParticipanteHTML(item);
        const bd = box.querySelector("[data-baixar-dossie]");
        if (bd) bd.onclick = () => baixarTextoAuditoria(`auditoria-${item.nome.replace(/\s+/g,"-").toLowerCase()}.txt`, dossieTXT(item));
        box.scrollIntoView({ behavior:"smooth", block:"start" });
      };
    });
  }
  async function auditarRankingGeral() {
    if (!USER) return popup("Entre no bolão para acessar a auditoria geral.");
    if (!ONLINE) return popup("A auditoria geral consulta o banco lacrado e só funciona no site publicado.");
    const btn = $("#btn-auditoria-geral");
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Auditando..."; }
    try {
      const [rows, events] = await Promise.all([rpc("copa_revelados", {}), buscarEventosOficiaisAuditoria()]);
      const oficial = buildOficial(events);
      DADOS.oficial = oficial;
      const lista = [], problemas = [];
      for (const row of (rows || [])) {
        try {
          const { d, pg, payload } = derivarPalpiteAuditoria(row);
          const r = COPA_PONTUACAO.calcular(d, oficial);
          const hash = await sha256hex(canonical({ g: payload.placaresGrupos || {}, m: payload.placaresMata || {} }));
          const cr = cravadosAuditoria(pg, oficial._realGrupos || {});
          const item = { nome: row.nome, hash, atuais:r.atuais, perdidos:r.perdidos, possiveis:r.possiveis, teto:r.teto, cr };
          item.det = detalhesAuditoria(row, d, pg, payload, r, oficial, hash, cr);
          lista.push(item);
        } catch (e) {
          problemas.push({ nome: row && row.nome ? row.nome : "sem nome", erro: e.message || String(e) });
        }
      }
      lista.sort((a,b) => b.atuais - a.atuais || b.cr - a.cr || b.teto - a.teto || a.nome.localeCompare(b.nome));
      lista.forEach((x,i) => { x.pos = i + 1; x.idx = i; });

      const total = (rows || []).length;
      const ok = lista.length;
      const diverg = problemas.length;
      const now = new Date().toLocaleString("pt-BR", { timeZone:"America/Sao_Paulo" });
      const faseTxt = oficial._apurarMata && oficial._apurarMata.oitavas ? "mata-mata em apuração" : (oficial._meta && oficial._meta.segundaFase ? "2ª fase definida" : "fase de grupos/simulação");
      const resumoClass = diverg ? "auditoria-warn" : "auditoria-ok";

      const linhas = lista.map((x,i) => `<div class="auditoria-row">
        <span>${x.pos}º</span><span class="nome">${escHTML(x.nome)}</span>
        <b>${x.atuais}</b><b>${x.perdidos}</b><b>${x.possiveis}</b><b class="teto">${x.teto}</b>
        <span class="hash" title="${escHTML(x.hash)}">${escHTML(x.hash.slice(0,16))}...</span>
        <button class="auditoria-btn" type="button" data-det-aud="${i}">Detalhes</button>
      </div>`).join("");
      const probs = problemas.length
        ? `<div class="auditoria-lista">${problemas.map(p => `<div class="auditoria-row"><span>⚠️</span><span class="nome">${escHTML(p.nome)}</span><span class="auditoria-erro" style="grid-column:3/9">${escHTML(p.erro)}</span></div>`).join("")}</div>`
        : "";

      const html = `<div class="auditoria-resumo">
          <div class="auditoria-kpi ${resumoClass}"><b>${ok}/${total}</b><span>participantes calculados</span></div>
          <div class="auditoria-kpi"><b>${diverg}</b><span>problemas</span></div>
          <div class="auditoria-kpi"><b>${oficial.eliminados ? oficial.eliminados.length : 0}</b><span>eliminados reconhecidos</span></div>
          <div class="auditoria-kpi"><b>${escHTML(faseTxt)}</b><span>fase atual</span></div>
        </div>
        <div class="auditoria-nota">Fonte: <b>copa_revelados</b> no banco lacrado + <b>palpites_mata.json</b> auditado + placares atuais da ESPN. Clique em <b>Detalhes</b> para ver placares, classificação por grupo, 32/16/8/4/2, pódio e extrato de pontos.</div>
        <div class="auditoria-lista">
          <div class="auditoria-row head"><span>pos.</span><span>participante</span><span>conq.</span><span>perd.</span><span>poss.</span><span class="teto">teto</span><span class="hash">hash</span><span>abrir</span></div>
          ${linhas || '<div class="auditoria-row"><span>—</span><span class="nome">Nenhum participante retornado</span><span></span><span></span><span></span><span class="teto"></span><span class="hash"></span><span></span></div>'}
        </div>${probs}
        <div class="auditoria-actions"><button type="button" data-baixar-auditoria>Baixar resumo TXT</button><button class="sec" type="button" data-copiar-auditoria>Copiar resumo</button></div>
        <div class="auditoria-nota">O dossiê individual fica dentro desta janela e também pode ser baixado em TXT.</div>`;

      const txt = [
        "AUDITORIA GERAL DO RANKING — BOLÃO COPA 2026",
        "Gerado em: " + now + " (Brasília)",
        "Fonte: banco lacrado via copa_revelados + resultados oficiais atuais",
        "Participantes retornados: " + total,
        "Participantes calculados: " + ok,
        "Problemas: " + diverg,
        "Fase atual: " + faseTxt,
        "",
        "RANKING RECALCULADO",
        ...lista.map(x => `${String(x.pos).padStart(2,"0")}. ${x.nome} | conquistados=${x.atuais} | perdidos=${x.perdidos} | possiveis=${x.possiveis} | teto=${x.teto} | cravados=${x.cr} | hash=${x.hash}`),
        "",
        "PROBLEMAS",
        ...(problemas.length ? problemas.map(p => `${p.nome}: ${p.erro}`) : ["Nenhum."])
      ].join("\n");

      abrirModalAuditoria(html, txt, lista);
    } catch (e) {
      popup("Não consegui executar a auditoria geral. Verifique conexão/Supabase e tente novamente.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || "🧾 Auditoria geral"; }
    }
  }


  document.addEventListener("DOMContentLoaded", init);
})();
