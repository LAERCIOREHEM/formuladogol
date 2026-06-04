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

  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

  function bandeira(id) {
    const iso = DADOS.isoDe[id];
    if (!iso) return "";
    return `<img class="flag" src="https://flagcdn.com/w40/${iso}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
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
    $("#popup-ok").onclick = () => $("#popup").classList.add("oculto");
    document.querySelectorAll(".aba").forEach(b => b.onclick = () => trocarTela(b.dataset.tela, b));
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
    sessionStorage.setItem("copa2026_sessao", JSON.stringify(USER));
    abrirApp();
  }

  async function restaurarSessao() {
    const ses = sessionStorage.getItem("copa2026_sessao");
    if (!ses) return;
    USER = JSON.parse(ses);
    if (ONLINE) {
      let pl = null; try { pl = await rpc("copa_meu_palpite", { p_nome: USER.nome, p_pin: USER.pin }); } catch (e) {}
      P = pl || palpiteVazio();
    } else {
      const salvo = localStorage.getItem(chaveUser(USER.nome));
      P = (salvo && JSON.parse(salvo).palpite) || palpiteVazio();
    }
    abrirApp();
  }

  function abrirApp() {
    $("#tela-login").classList.add("oculto");
    $("#abas").classList.remove("oculto");
    $("#topo-usuario").classList.remove("oculto");
    $("#usuario-nome").textContent = "Olá, " + USER.nome;
    trocarTela("palpite");
  }
  function sair() {
    sessionStorage.removeItem("copa2026_sessao");
    USER = null; P = null; derivado = null;
    $("#abas").classList.add("oculto"); $("#topo-usuario").classList.add("oculto");
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
    return { campeao: derivado.campeao, vice: derivado.vice, terceiro: derivado.terceiro, quarto: derivado.quarto, chave: derivado.chave };
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

  function trocarTela(qual, btn) {
    document.querySelectorAll(".tela").forEach(t => t.classList.add("oculto"));
    document.querySelectorAll(".aba").forEach(b => b.classList.remove("ativa"));
    if (btn) btn.classList.add("ativa");
    else document.querySelector('.aba[data-tela="palpite"]').classList.add("ativa");
    if (qual === "palpite") { $("#tela-palpite").classList.remove("oculto"); renderPalpite(); }
    if (qual === "ranking") { $("#tela-ranking").classList.remove("oculto"); renderRanking(); }
    if (qual === "resultados") { $("#tela-resultados").classList.remove("oculto"); renderResultados(); }
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
    const lista = el("div", "lista-jogos");
    jogosDaFase(fase).forEach(m => lista.appendChild(cardJogoMata(m)));
    c.appendChild(lista);
    if (fase === "final") c.appendChild(blocoRevisao());
    const acoes = el("div", "acoes");
    const idx = FASES.findIndex(f => f.id === fase);
    if (idx > 0) { const a = el("button", "btn-sec", "← " + FASES[idx - 1].nome); a.onclick = () => { faseAtual = FASES[idx - 1].id; renderPalpite(); }; acoes.appendChild(a); }
    if (idx < FASES.length - 1) { const p = el("button", "btn-primario", FASES[idx + 1].nome + " →"); p.onclick = () => { faseAtual = FASES[idx + 1].id; renderPalpite(); }; acoes.appendChild(p); }
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
    wrap.appendChild(card); wrap.appendChild(venc); mostrarVencedor(venc, m, p);
    card.querySelectorAll("input").forEach(inp => {
      inp.oninput = () => {
        inp.value = inp.value.replace(/[^0-9]/g, "").slice(0, 1);
        const a = card.querySelector('[data-k="a"]').value, b = card.querySelector('[data-k="b"]').value;
        const va = a === "" ? null : +a, vb = b === "" ? null : +b;
        P.placaresMata[m.id] = { a: va, b: vb };
        persistir();
        if (va != null && vb != null && va === vb) popup("No mata-mata não pode haver empate. Defina um vencedor.");
        mostrarVencedor(venc, m, { a: va, b: vb }); atualizarProgresso(); renderEtapas();
      };
    });
    return wrap;
  }
  function mostrarVencedor(elv, m, p) {
    if (p && p.a != null && p.b != null && p.a !== p.b && m.a && m.b) {
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

  // ---------- Ranking (quem já enviou) ----------
  async function renderRanking() {
    const c = $("#ranking-conteudo");
    if (!ONLINE) { c.innerHTML = "<p>Conecte o Supabase (js/config.js) para ver o ranking entre os participantes.</p>"; return; }
    c.innerHTML = "<p>Carregando…</p>";
    try {
      const lista = await rpc("copa_status", {});
      const enviados = lista.filter(x => x.enviado).length;
      const box = el("div", "classif");
      box.innerHTML = `<h4>${enviados} de ${lista.length} já enviaram</h4><ol></ol>`;
      const ol = box.querySelector("ol");
      lista.forEach(x => {
        const li = el("li", x.enviado ? "passa" : "");
        li.innerHTML = `<span>${x.nome}</span><span>${x.enviado ? "enviou ✓" : "aguardando"}</span>`;
        ol.appendChild(li);
      });
      c.innerHTML = ""; c.appendChild(box);
      c.appendChild(el("p", "placeholder", "<p>A pontuação competitiva entra quando os resultados oficiais começarem a ser registrados.</p>"));
    } catch (e) { c.innerHTML = "<p>Não consegui carregar o ranking agora.</p>"; }
  }

  // ---------- Resultados / Transparência pós-trava ----------
  async function renderResultados() {
    const c = $("#resultados-conteudo");
    if (!ONLINE) return; // mantém o texto estático do index.html
    c.innerHTML = "<p>Carregando…</p>";
    try {
      const arr = await rpc("copa_revelados", {});
      if (!arr.length) {
        c.innerHTML = "<p>Para garantir a lisura, os palpites de todos só ficam visíveis aqui <b>depois da trava (10/06, 23h59)</b>. " +
          "Os placares oficiais entram pelo robô de resultados durante a Copa.</p>";
        return;
      }
      const box = el("div", "classif");
      box.innerHTML = "<h4>Palpite de campeão de cada participante</h4><ol></ol>";
      const ol = box.querySelector("ol");
      arr.forEach(row => {
        let camp = "—";
        try {
          const pl = row.payload || {};
          const g = Object.keys(pl.placaresGrupos || {}).map(id => ({ jogo_id: id, ga: pl.placaresGrupos[id].ga, gb: pl.placaresGrupos[id].gb }));
          const d = COPA_ENGINE.derivar(DADOS.selecoes, g, pl.placaresMata || {}, DADOS.estrutura, DADOS.terceirosMap);
          if (d.campeao) camp = bandeira(d.campeao) + " " + DADOS.nomeDe[d.campeao];
        } catch (e) {}
        const li = el("li"); li.innerHTML = `<span>${row.nome}</span><span>${camp}</span>`;
        ol.appendChild(li);
      });
      c.innerHTML = ""; c.appendChild(box);
    } catch (e) { c.innerHTML = "<p>Não consegui carregar agora.</p>"; }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
