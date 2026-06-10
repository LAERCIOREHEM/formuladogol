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

  const FASES = [
    { id: "grupos", nome: "Grupos" }, { id: "r32", nome: "2ª fase" },
    { id: "oitavas", nome: "Oitavas" }, { id: "quartas", nome: "Quartas" },
    { id: "semifinais", nome: "Semis" }, { id: "final", nome: "Final" }
  ];

  let DADOS = {}, USER = null, P = null, derivado = null;
  let faseAtual = "grupos", grupoAberto = null, saveTimer = null;
  let atualizarFeedbackFase = null;

  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

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
      const [s, e, t] = await Promise.all([
        fetch("dados/selecoes.json").then(r => r.json()),
        fetch("dados/estrutura_mata_mata.json").then(r => r.json()),
        fetch("dados/terceiros_map.json").then(r => r.json())
      ]);
      DADOS.selecoes = s.selecoes; DADOS.estrutura = e; DADOS.terceirosMap = t;
      DADOS.nomeDe = {}; DADOS.isoDe = {};
      s.selecoes.forEach(x => { DADOS.nomeDe[x.id] = x.nome; DADOS.isoDe[x.id] = x.iso2; });
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
    $("#popup-ok").onclick = () => $("#popup").classList.add("oculto");
    document.querySelectorAll(".aba").forEach(b => b.onclick = () => trocarTela(b.dataset.tela, b));
    const ba = $("#btn-alterar-palpite");
    if (ba) ba.onclick = () => trocarTela("palpite", document.querySelector('.aba[data-tela="palpite"]'));
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
    txt += (agora < TRAVA
      ? "Situação: ANTES da trava — palpites ainda podiam ser alterados até 10/06 23h59.\n           Gere novamente após a trava para ter o comprovante definitivo.\n"
      : "Situação: APÓS a trava de 10/06 23h59 — palpites bloqueados para alteração.\n");
    txt += "\n----- FASE DE GRUPOS (72 jogos) -----\n";
    Object.keys(porGrupo).sort().forEach(g => { txt += `\nGrupo ${g}\n  ` + porGrupo[g].join("\n  ") + "\n"; });

    let d = null;
    try {
      const arr = Object.keys(P.placaresGrupos).map(id => ({ jogo_id: id, ga: P.placaresGrupos[id].ga, gb: P.placaresGrupos[id].gb }));
      d = COPA_ENGINE.derivar(DADOS.selecoes, arr, P.placaresMata, DADOS.estrutura, DADOS.terceirosMap);
    } catch (e) {}
    if (d && d.campeao) {
      txt += "\n----- MATA-MATA (decorrente dos seus placares) -----\n";
      txt += `Classificados (32): ${(d.classificados32 || []).join(", ")}\n`;
      txt += `Oitavas (16): ${(d.avancam_oitavas || []).join(", ")}\n`;
      txt += `Quartas (8): ${(d.avancam_quartas || []).join(", ")}\n`;
      txt += `Semifinal (4): ${(d.semifinalistas || []).join(", ")}\n`;
      txt += `Final (2): ${(d.finalistas || []).join(", ")}\n`;
      txt += `CAMPEÃO: ${d.campeao} | Vice: ${d.vice} | 3º: ${d.terceiro} | 4º: ${d.quarto}\n`;
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
    if (ONLINE) {
      $("#salvo-texto").textContent = "Salvando...";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const res = await rpc("copa_salvar", { p_nome: USER.nome, p_pin: USER.pin, p_payload: P, p_derivado: derivadoResumo() });
          if (res === "OK") marcaSalvo();
          else if (res === "TRAVADO") $("#salvo-texto").textContent = "Prazo encerrado — palpites travados.";
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

  // ---------- mata-mata ----------
  function renderFaseMata(fase) {
    const c = $("#conteudo-fase"); c.innerHTML = ""; recomputar();
    if (fase === "r32" && derivado.faltaMapa) c.appendChild(avisoAnexoC(derivado.chave));
    c.appendChild(el("div", "titulo-fase", FASES.find(f => f.id === fase).nome));

    let jogos;
    if (fase === "final") {
      jogos = [{ id: "M104", rot: "🏆 Disputa do Título" }, { id: "M103", rot: "Disputa do 3º Lugar" }]
        .map(d => { const t = derivado.timeDe[d.id] || {}; return { id: d.id, a: t.a, b: t.b, rot: d.rot }; });
    } else {
      jogos = jogosDaFase(fase);
    }

    const alertasEl = el("div"); alertasEl.id = "fase-alertas"; c.appendChild(alertasEl);

    const lista = el("div", "lista-jogos");
    jogos.forEach(m => {
      if (m.rot) lista.appendChild(el("div", "rotulo-jogo", m.rot));
      lista.appendChild(cardJogoMata(m));
    });
    c.appendChild(lista);
    if (fase === "final") c.appendChild(blocoRevisao());
    const acoes = el("div", "acoes");
    const idx = FASES.findIndex(f => f.id === fase);
    if (idx > 0) { const a = el("button", "btn-sec", "← " + FASES[idx - 1].nome); a.onclick = () => { faseAtual = FASES[idx - 1].id; renderPalpite(); }; acoes.appendChild(a); }
    let pbtn = null;
    if (idx < FASES.length - 1) { pbtn = el("button", "btn-primario"); acoes.appendChild(pbtn); }

    // alerta + botão de avançar atualizam AO VIVO a cada dígito (sem re-render, preserva o foco)
    atualizarFeedbackFase = function () {
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
    if (fase === "final") {
      const concluir = el("button", "btn-primario", "Concluir meu palpite ✓");
      concluir.onclick = () => {
        persistir();
        const faltam = 104 - totalPreenchidos();
        if (faltam > 0) { popup("Ainda faltam " + faltam + " jogo(s) para concluir. Verifique se há empates no mata-mata — eles não contam até você definir um vencedor."); return; }
        popup("Palpite completo! 🎉 Está salvo. Você pode alterar até 10/06 às 23h59 — depois trava e fica visível a todos em \"Palpites\".");
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
  function blocoRevisao() {
    recomputar();
    const box = el("div", "revisao");
    box.innerHTML = "<h4 style='margin-bottom:10px;color:var(--cinza);font-size:13px;letter-spacing:1px;text-transform:uppercase'>Revisão do palpite</h4>";
    [["Campeão", derivado.campeao], ["Vice", derivado.vice], ["3º lugar", derivado.terceiro], ["4º lugar", derivado.quarto]].forEach(([l, id]) => {
      box.appendChild(el("div", "linha", `<span>${l}</span><b>${id ? bandeira(id) + " " + DADOS.nomeDe[id] : "—"}</b>`));
    });
    const teto = COPA_PONTUACAO.teto(derivado);
    const pb = el("div", "pontos-box");
    pb.innerHTML =
      `<div class="pt"><div class="n">0</div><div class="l">Pontos atuais</div></div>` +
      `<div class="pt"><div class="n">${teto}</div><div class="l">Ainda possíveis</div></div>` +
      `<div class="pt"><div class="n">${teto}</div><div class="l">Teto máximo</div></div>`;
    box.appendChild(pb);
    box.appendChild(el("div", "linha", `<span style='color:var(--cinza);font-size:13px'>Atuais e perdidos passam a contar quando os resultados oficiais entrarem.</span><span></span>`));
    return box;
  }

  document.addEventListener("DOMContentLoaded", init);
})();
