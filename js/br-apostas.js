/* ========================================================================== 
   br-apostas.js — Apostas logadas do Brasileirão 2026
   Execução 10: usuário/PIN, admin, janela por rodada, sigilo e comprovante.
   ========================================================================== */
(function (global, document) {
  "use strict";

  const CFG = global.BR_CFG || {};
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const STORAGE_KEY = "brApostasSessaoV2";

  const state = {
    supabase: null,
    usuario: null,
    token: "",
    jogosJson: null,
    resultadosJson: null,
    espnEventosJson: null,
    configLocal: null,
    configSupabase: [],
    jogos: [],
    resultados: [],
    rodadas: [],
    rodada: Number(CFG.rodadaInicialApostas || 20),
    aba: "apostas",
    meusPalpites: [],
    publicos: [],
    apuracao: { rodadas: [], ranking_geral: [] },
    rankingApostas: { ranking_geral: [] },
    auditoria: [],
    auditoriaEventos: [],
    participantes: [],
    progresso: []
  };

  function status(msg, tipo = "warn") {
    const el = $("#status");
    if (!el) return;
    el.textContent = msg;
    el.className = `status ${tipo}`;
  }

  function cacheBust(url) {
    const sep = String(url).includes("?") ? "&" : "?";
    return `${url}${sep}v=${Date.now()}`;
  }

  async function fetchJson(url, fallback) {
    try {
      const res = await fetch(cacheBust(url), { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      console.warn("Falha ao buscar", url, err);
      return fallback;
    }
  }

  function parseData(iso) {
    if (!iso) return null;
    const d = new Date(String(iso).length <= 16 ? iso : String(iso).replace("Z", "+00:00"));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtData(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : parseData(isoOrDate);
    if (!d) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(d).replace(".", "");
  }

  function fmtDataLonga(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : parseData(isoOrDate);
    if (!d) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(d);
  }

  function startOfDay(d) {
    const x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function setWeekdayAround(reference, targetWeekday, preferFuture) {
    const d = startOfDay(reference);
    const current = d.getDay();
    let delta = targetWeekday - current;
    if (preferFuture && delta < 0) delta += 7;
    if (!preferFuture && delta > 0) delta -= 7;
    d.setDate(d.getDate() + delta);
    return d;
  }

  function normalizarTexto(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch] || ch));
  }

  function tipoLabel(tipo) {
    return ({ exato: "cravou", saldo: "saldo", resultado: "resultado", erro: "errou", descartado: "fora do prazo" }[tipo] || tipo || "—");
  }

  function pontosClasse(pontos) {
    const n = Number(pontos || 0);
    if (n >= 5) return "score-max";
    if (n >= 3) return "score-mid";
    if (n >= 2) return "score-low";
    return "score-zero";
  }

  function timeNome(time) { return (time && time.nome) || String(time || ""); }
  function timeSigla(time) { return (time && time.sigla) || normalizarTexto(timeNome(time)).slice(0, 3).toUpperCase(); }
  function timeEscudo(time) { return (time && time.escudo) || ""; }
  function jogoId(j) { return String(j.event_id || j.id || j.jogo_chave || `${timeNome(j.mandante)}-${timeNome(j.visitante)}-${j.data_iso || ""}`); }
  function jogoChave(j) { return `${normalizarTexto(timeNome(j.mandante))}-${normalizarTexto(timeNome(j.visitante))}-${String(j.data_iso || "").slice(0, 10)}`; }

  function todosJogos() {
    const a = (state.jogosJson && state.jogosJson.jogos) || [];
    const b = (state.resultadosJson && state.resultadosJson.resultados) || [];
    const c = ((state.espnEventosJson && state.espnEventosJson.eventos) || []).map(e => ({
      event_id: e.event_id,
      rodada: e.rodada,
      data_iso: e.data_iso,
      mandante: { nome: e.mandante },
      visitante: { nome: e.visitante },
      estadio: e.estadio || "",
      transmissao: e.transmissao || "",
      estado: e.estado || "pre",
      placar_mandante: e.placar_mandante,
      placar_visitante: e.placar_visitante
    }));
    const map = new Map();
    [...a, ...b, ...c].forEach(j => {
      if (!j) return;
      const id = jogoId(j);
      if (!map.has(id)) map.set(id, j);
    });
    return Array.from(map.values()).sort((x, y) => String(x.data_iso || "").localeCompare(String(y.data_iso || "")));
  }

  function jogosDaRodada(rodada) {
    return state.jogos.filter(j => Number(j.rodada) === Number(rodada));
  }

  function configDaRodada(rodada) {
    const supa = state.configSupabase.find(c => Number(c.rodada) === Number(rodada));
    if (supa) return supa;
    const local = ((state.configLocal && state.configLocal.rodadas) || []).find(c => Number(c.rodada) === Number(rodada));
    if (local) return local;
    return null;
  }

  function janelaPadrao(rodada) {
    const jogos = jogosDaRodada(rodada);
    const datas = jogos.map(j => parseData(j.data_iso)).filter(Boolean).sort((a, b) => a - b);
    const primeira = datas[0] || new Date();
    const js = CFG.janelaPadrao || {};
    let sabado;
    if ([0, 1, 2, 3].includes(primeira.getDay())) sabado = setWeekdayAround(primeira, js.fechaDiaSemana ?? 6, false);
    else sabado = setWeekdayAround(primeira, js.fechaDiaSemana ?? 6, true);
    sabado.setHours(js.fechaHora ?? 10, js.fechaMinuto ?? 0, 0, 0);
    const abre = setWeekdayAround(sabado, js.abreDiaSemana ?? 4, false);
    abre.setHours(js.abreHora ?? 0, 0, 0, 0);
    return { rodada, abre_em: abre.toISOString(), fecha_em: sabado.toISOString(), status: "programada", origem: "padrao" };
  }

  function configEfetiva(rodada) {
    const cfg = configDaRodada(rodada) || janelaPadrao(rodada);
    return {
      rodada: Number(rodada),
      abre_em: cfg.abre_em,
      fecha_em: cfg.fecha_em,
      publica_em: cfg.publica_em || null,
      status: cfg.status || "programada",
      observacao: cfg.observacao || ""
    };
  }

  function rodadaAberta(rodada) {
    const cfg = configEfetiva(rodada);
    const agora = new Date();
    const abre = parseData(cfg.abre_em);
    const fecha = parseData(cfg.fecha_em);
    const status = String(cfg.status || "programada").toLowerCase();
    if (["fechada", "apurada", "publicada", "bloqueada", "encerrada"].includes(status)) return false;
    if (!abre || !fecha) return false;
    return Number(rodada) >= Number(CFG.rodadaInicialApostas || 20) && agora >= abre && agora < fecha;
  }

  function rodadaPublica(rodada) {
    const cfg = configEfetiva(rodada);
    const status = String(cfg.status || "").toLowerCase();
    if (["publicada", "apurada"].includes(status)) return true;
    const pub = parseData(cfg.publica_em);
    return Boolean(pub && new Date() >= pub);
  }

  function statusJanela(rodada) {
    const cfg = configEfetiva(rodada);
    const abre = parseData(cfg.abre_em);
    const fecha = parseData(cfg.fecha_em);
    const agora = new Date();
    const status = String(cfg.status || "programada").toLowerCase();
    if (rodadaPublica(rodada)) return { classe: "done", texto: "Palpites publicados", detalhe: `Rodada ${rodada} publicada` };
    if (["fechada", "apurada", "bloqueada", "encerrada"].includes(status)) return { classe: "lock", texto: "Rodada fechada", detalhe: `Fechada em ${fmtDataLonga(fecha)}` };
    if (abre && agora < abre) return { classe: "warn", texto: "Aguardando abertura", detalhe: `Abre em ${fmtDataLonga(abre)}` };
    if (fecha && agora >= fecha) return { classe: "lock", texto: "Janela encerrada", detalhe: `Fechou em ${fmtDataLonga(fecha)}` };
    return { classe: "open", texto: "Apostas abertas", detalhe: `Até ${fmtDataLonga(fecha)}` };
  }

  function sessionPayload() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
    catch (_) { return null; }
  }

  function saveSession(usuario, token) {
    state.usuario = usuario;
    state.token = token;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ usuario, token, salvo_em: new Date().toISOString() }));
  }

  function clearSession() {
    state.usuario = null;
    state.token = "";
    localStorage.removeItem(STORAGE_KEY);
  }

  function rpcRows(name, args) {
    if (!state.supabase) return Promise.reject(new Error("Supabase não inicializado."));
    return state.supabase.rpc(name, args || {}).then(({ data, error }) => {
      if (error) throw error;
      if (!data) return [];
      return Array.isArray(data) ? data : [data];
    });
  }

  function initSupabase() {
    const supa = CFG.supabase || {};
    if (!global.supabase || !supa.url || !supa.key) return null;
    return global.supabase.createClient(supa.url, supa.key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  async function carregarBase() {
    const arq = CFG.arquivos || {};
    const [jogosJson, resultadosJson, espnEventosJson, configLocal, apuracao, rankingApostas] = await Promise.all([
      fetchJson(arq.jogos || "jogos.json", { jogos: [] }),
      fetchJson(arq.resultados || "resultados.json", { resultados: [] }),
      fetchJson(arq.eventos || "espn_eventos.json", { eventos: [] }),
      fetchJson(arq.configRodadas || "dados-br/apostas-config.json", { rodadas: [] }),
      fetchJson("dados-br/apuracao.json", { rodadas: [], ranking_geral: [] }),
      fetchJson("dados-br/ranking-apostas.json", { ranking_geral: [] })
    ]);
    state.jogosJson = jogosJson;
    state.resultadosJson = resultadosJson;
    state.espnEventosJson = espnEventosJson;
    state.configLocal = configLocal;
    state.apuracao = apuracao || { rodadas: [], ranking_geral: [] };
    state.rankingApostas = rankingApostas || { ranking_geral: [] };
    state.jogos = todosJogos();
    const set = new Set();
    for (let r = Number(CFG.rodadaInicialApostas || 20); r <= 38; r += 1) set.add(r);
    state.jogos.forEach(j => { if (Number(j.rodada) >= Number(CFG.rodadaInicialApostas || 20)) set.add(Number(j.rodada)); });
    state.rodadas = Array.from(set).sort((a, b) => a - b);
    if (!state.rodadas.includes(state.rodada)) state.rodada = state.rodadas[0] || Number(CFG.rodadaInicialApostas || 20);
  }

  async function carregarConfigsSupabase() {
    if (!state.supabase) return;
    try {
      state.configSupabase = await rpcRows("br_listar_config_rodadas", { p_temporada: CFG.temporada || 2026 });
    } catch (err) {
      console.warn("Config Supabase indisponível", err);
      state.configSupabase = [];
    }
  }

  async function carregarMeusPalpites() {
    if (!state.usuario) return;
    try {
      state.meusPalpites = await rpcRows("br_listar_meus_palpites", {
        p_participante_id: state.usuario.id,
        p_token: state.token,
        p_rodada: state.rodada,
        p_temporada: CFG.temporada || 2026
      });
    } catch (err) {
      console.warn("Meus palpites indisponíveis", err);
      state.meusPalpites = [];
    }
  }

  async function carregarPublicos() {
    try {
      state.publicos = await rpcRows("br_listar_palpites_publicos", {
        p_rodada: state.rodada,
        p_temporada: CFG.temporada || 2026
      });
    } catch (err) {
      state.publicos = [];
    }
  }

  function htmlTeam(time, cls) {
    const esc = timeEscudo(time);
    return `<div class="team ${cls || ""}">${esc ? `<img src="${esc}" alt="">` : ""}<div><div class="team-name">${timeNome(time)}</div><div class="team-sigla">${timeSigla(time)}</div></div></div>`;
  }

  function palpiteSalvoPara(id) {
    return state.meusPalpites.find(p => String(p.event_id) === String(id));
  }

  function renderResumo() {
    const jogos = jogosDaRodada(state.rodada);
    const st = statusJanela(state.rodada);
    const salvos = state.meusPalpites.length;
    const pct = jogos.length ? Math.round((salvos / jogos.length) * 100) : 0;
    $("#numero-rodada").textContent = state.rodada;
    $("#total-jogos").textContent = jogos.length;
    $("#texto-janela").textContent = st.texto;
    const badge = $("#badge-janela");
    badge.textContent = st.detalhe;
    badge.className = `badge ${st.classe}`;
    $("#meu-percentual").textContent = `${pct}%`;
    $("#meu-total-salvo").textContent = salvos;
  }

  function renderRodadas() {
    const sel = $("#rodada-select");
    const tabs = $("#rodadas");
    if (!sel || !tabs) return;
    sel.innerHTML = state.rodadas.map(r => `<option value="${r}" ${Number(r) === Number(state.rodada) ? "selected" : ""}>Rodada ${r}</option>`).join("");
    tabs.innerHTML = state.rodadas.map(r => `<button type="button" class="${Number(r) === Number(state.rodada) ? "active" : ""}" data-rodada="${r}">R${r}</button>`).join("");
    tabs.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => trocarRodada(Number(btn.dataset.rodada))));
    sel.onchange = () => trocarRodada(Number(sel.value));
  }

  function renderUsuario() {
    const chip = $("#usuario-chip");
    if (!state.usuario) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.innerHTML = `${state.usuario.admin ? "🛠️ " : "👤 "}${state.usuario.nome}<br><button class="btn ghost" type="button" id="sair">sair</button>`;
    $("#sair")?.addEventListener("click", () => { clearSession(); renderLogin(); status("Sessão encerrada.", "warn"); });
    $$(".admin-only").forEach(el => { el.hidden = !state.usuario.admin; });
  }

  function renderLogin() {
    $("#login-area").hidden = Boolean(state.usuario);
    $("#app-area").hidden = !state.usuario;
    renderUsuario();
  }

  function renderApostas() {
    const root = $("#conteudo");
    const jogos = jogosDaRodada(state.rodada);
    const aberta = rodadaAberta(state.rodada);
    const st = statusJanela(state.rodada);
    if (!jogos.length) {
      root.innerHTML = `<section class="panel"><div class="panel-inner empty"><strong>Rodada ${state.rodada} ainda sem jogos no JSON.</strong><p>Quando o workflow ESPN trouxer a tabela da rodada, os confrontos aparecem aqui. O admin já pode configurar a janela.</p></div></section>`;
      return;
    }
    const aviso = aberta ?
      `<div class="status ok">Janela aberta. Você pode salvar ou alterar seus palpites até o fechamento.</div>` :
      `<div class="status warn">${st.texto}. ${st.detalhe}. Os campos ficam bloqueados fora da janela.</div>`;
    root.innerHTML = `${aviso}<form id="form-palpites" class="matches">${jogos.map(j => {
      const id = jogoId(j);
      const salvo = palpiteSalvoPara(id);
      return `<article class="match-card" data-event-id="${id}">
        <div class="match-top"><span>Rodada ${j.rodada} · ${fmtData(j.data_iso)}</span><span class="badge ${aberta ? "open" : "lock"}">${aberta ? "aberto" : "travado"}</span></div>
        <div class="match-body">
          ${htmlTeam(j.mandante, "home")}
          <div class="score-inputs">
            <input name="pm-${id}" type="number" inputmode="numeric" min="0" max="30" value="${salvo?.placar_mandante ?? ""}" ${aberta ? "" : "disabled"} aria-label="Placar ${timeNome(j.mandante)}">
            <span>x</span>
            <input name="pv-${id}" type="number" inputmode="numeric" min="0" max="30" value="${salvo?.placar_visitante ?? ""}" ${aberta ? "" : "disabled"} aria-label="Placar ${timeNome(j.visitante)}">
          </div>
          ${htmlTeam(j.visitante, "away")}
        </div>
        <div class="match-extra">
          <span class="badge info">${j.estadio || "estádio a confirmar"}</span>
          ${salvo ? `<span class="badge open saved-pill">salvo ${fmtDataLonga(salvo.atualizado_em || salvo.criado_em)}</span>` : `<span class="badge">não salvo</span>`}
        </div>
      </article>`;
    }).join("")}
    <div class="actions"><button class="btn" type="submit" ${aberta ? "" : "disabled"}>💾 Salvar palpites da rodada</button><button class="btn secondary" type="button" id="limpar-campos" ${aberta ? "" : "disabled"}>limpar campos</button></div>
    </form>`;
    $("#form-palpites")?.addEventListener("submit", salvarPalpites);
    $("#limpar-campos")?.addEventListener("click", () => $$("#form-palpites input").forEach(i => { i.value = ""; }));
  }

  function coletarPalpitesFormulario() {
    const jogos = jogosDaRodada(state.rodada);
    const payload = [];
    for (const j of jogos) {
      const id = jogoId(j);
      const pmEl = $(`[name="pm-${CSS.escape(id)}"]`);
      const pvEl = $(`[name="pv-${CSS.escape(id)}"]`);
      const pm = pmEl?.value === "" ? null : Number(pmEl?.value);
      const pv = pvEl?.value === "" ? null : Number(pvEl?.value);
      if (pm === null && pv === null) continue;
      if (!Number.isInteger(pm) || !Number.isInteger(pv) || pm < 0 || pv < 0 || pm > 30 || pv > 30) {
        throw new Error(`Placar inválido em ${timeNome(j.mandante)} x ${timeNome(j.visitante)}.`);
      }
      payload.push({
        event_id: id,
        jogo_chave: jogoChave(j),
        mandante: timeNome(j.mandante),
        visitante: timeNome(j.visitante),
        placar_mandante: pm,
        placar_visitante: pv,
        kickoff: j.data_iso || null,
        fecha_em: configEfetiva(state.rodada).fecha_em
      });
    }
    return payload;
  }

  async function salvarPalpites(ev) {
    ev.preventDefault();
    try {
      if (!rodadaAberta(state.rodada)) throw new Error("Rodada fora da janela de apostas.");
      const payload = coletarPalpitesFormulario();
      if (!payload.length) throw new Error("Preencha ao menos um placar antes de salvar.");
      status("Salvando palpites com hash de comprovante...", "warn");
      const rows = await rpcRows("br_salvar_palpites", {
        p_participante_id: state.usuario.id,
        p_token: state.token,
        p_temporada: CFG.temporada || 2026,
        p_rodada: state.rodada,
        p_palpites: payload
      });
      const comprovante = rows[0] || {};
      await carregarMeusPalpites();
      renderResumo();
      renderApostas();
      const root = $("#conteudo");
      root.insertAdjacentHTML("afterbegin", `<div class="comprovante"><strong>🧾 Comprovante gerado</strong><p>Rodada ${state.rodada} · ${payload.length} palpites enviados.</p><p class="hash">${comprovante.hash_fechamento || comprovante.hash || "hash indisponível"}</p></div>`);
      status("Palpites salvos com sucesso.", "ok");
    } catch (err) {
      console.error(err);
      status(err.message || "Falha ao salvar palpites.", "err");
    }
  }

  function renderMeus() {
    const root = $("#conteudo");
    if (!state.meusPalpites.length) {
      root.innerHTML = `<section class="panel"><div class="panel-inner empty">Você ainda não tem palpites salvos na rodada ${state.rodada}.</div></section>`;
      return;
    }
    const hash = state.meusPalpites.find(p => p.hash_fechamento)?.hash_fechamento || "—";
    root.innerHTML = `<section class="panel"><div class="panel-inner">
      <div class="kicker">Meus palpites</div><h2>Rodada ${state.rodada}</h2>
      <p>Você pode consultar seus próprios palpites a qualquer momento. Os palpites dos outros só aparecem após a publicação da rodada.</p>
      <div class="comprovante"><strong>Hash atual da rodada</strong><p class="hash">${hash}</p></div>
      <div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Jogo</th><th>Meu palpite</th><th>Atualizado</th></tr></thead><tbody>
      ${state.meusPalpites.map(p => `<tr><td>${p.mandante} x ${p.visitante}</td><td class="num">${p.placar_mandante} x ${p.placar_visitante}</td><td>${fmtDataLonga(p.atualizado_em || p.criado_em)}</td></tr>`).join("")}
      </tbody></table></div>
    </div></section>`;
  }

  function apuracaoRodada(rodada) {
    const lista = (state.apuracao && state.apuracao.rodadas) || [];
    return lista.find(r => Number(r.rodada) === Number(rodada)) || null;
  }

  function mapaPontosRodada(rodada) {
    const ap = apuracaoRodada(rodada);
    const mapa = new Map();
    if (!ap || !Array.isArray(ap.jogos)) return mapa;
    ap.jogos.forEach(j => {
      (j.palpites || []).forEach(p => {
        mapa.set(`${p.membro || ""}::${j.resultado?.event_id || j.event_id || ""}`, p);
      });
    });
    return mapa;
  }

  function renderRanking() {
    const root = $("#conteudo");
    const ap = apuracaoRodada(state.rodada);
    const geral = (state.rankingApostas && state.rankingApostas.ranking_geral) || (state.apuracao && state.apuracao.ranking_geral) || [];
    if (!ap || ap.sigilosa) {
      root.innerHTML = `<section class="panel"><div class="panel-inner empty"><strong>Ranking da rodada ainda não publicado.</strong><p>A apuração só aparece aqui depois que a rodada tiver resultados e for marcada como apurada/publicada. Enquanto isso, os palpites seguem sigilosos.</p>${state.usuario?.admin ? `<p class="muted-note">Admin: rode o workflow <strong>Apurar Apostas Brasileirão</strong> após os jogos e depois publique a rodada quando quiser liberar para todos.</p>` : ""}</div></section>${renderRankingGeral(geral)}`;
      return;
    }
    const ranking = ap.ranking || [];
    root.innerHTML = `<section class="ranking-grid">
      <article class="panel"><div class="panel-inner">
        <div class="kicker">Ranking da rodada</div><h2>Rodada ${state.rodada}</h2>
        <p>${(ap.vencedores || []).length ? `🏆 Vencedor(es): <strong>${(ap.vencedores || []).map(escapeHtml).join(", ")}</strong>` : "Aguardando jogos apurados."}</p>
        ${ranking.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>Participante</th><th>Pontos</th><th>Cravadas</th><th>Saldo</th><th>Resultado</th><th>Erros</th></tr></thead><tbody>${ranking.map(r => `<tr><td>${r.pos}</td><td>${escapeHtml(r.membro)}</td><td class="num gold-num">${r.pontos}</td><td>${r.cravadas}</td><td>${r.saldos}</td><td>${r.resultados}</td><td>${r.erros}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Nenhum jogo apurado nesta rodada.</div>`}
      </div></article>
      <article class="panel"><div class="panel-inner">
        <div class="kicker">Resumo técnico</div><h2>Apuração</h2>
        <div class="audit-kpis"><span><strong>${ap.participantes || 0}</strong><small>participantes</small></span><span><strong>${ap.jogos_apurados || 0}</strong><small>jogos apurados</small></span><span><strong>${ap.palpites_descartados_fora_do_prazo || 0}</strong><small>descartados</small></span></div>
        <p class="muted-note">Atualizado em ${fmtDataLonga((state.apuracao || {}).atualizado_em)}.</p>
      </div></article>
    </section>${renderRankingGeral(geral)}`;
  }

  function renderRankingGeral(geral) {
    const lista = Array.isArray(geral) ? geral : [];
    if (!lista.length) return `<section class="panel"><div class="panel-inner empty">Ranking acumulado ainda sem rodadas publicadas.</div></section>`;
    return `<section class="panel"><div class="panel-inner"><div class="kicker">Ranking acumulado</div><h2>Bolão de placares</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>Participante</th><th>Pontos</th><th>Cravadas</th><th>Saldo</th><th>Resultado</th><th>Vitórias de rodada</th></tr></thead><tbody>${lista.map(r => `<tr><td>${r.pos}</td><td>${escapeHtml(r.membro)}</td><td class="num gold-num">${r.pontos}</td><td>${r.cravadas}</td><td>${r.saldos}</td><td>${r.resultados}</td><td>${r.vitorias_rodada || 0}</td></tr>`).join("")}</tbody></table></div></div></section>`;
  }

  async function renderPublico() {
    await carregarPublicos();
    const root = $("#conteudo");
    const ap = apuracaoRodada(state.rodada);
    const pontosMap = mapaPontosRodada(state.rodada);
    if (!rodadaPublica(state.rodada) && !state.publicos.length) {
      root.innerHTML = `<section class="panel"><div class="panel-inner empty"><strong>Palpites ainda sigilosos.</strong><p>A rodada ${state.rodada} só abre para todos após o fechamento/publicação feita pelo administrador.</p></div></section>`;
      return;
    }
    if (!state.publicos.length) {
      root.innerHTML = `<section class="panel"><div class="panel-inner empty">Nenhum palpite público encontrado para a rodada ${state.rodada}.</div></section>`;
      return;
    }
    root.innerHTML = `<section class="panel"><div class="panel-inner">
      <div class="kicker">Palpites públicos</div><h2>Rodada ${state.rodada}</h2>
      <p>Lista aberta após publicação da rodada. Quando a apuração já estiver disponível, a tabela mostra pontos e tipo de acerto jogo a jogo.</p>
      ${ap && !ap.sigilosa ? `<div class="status ok">Apuração publicada · ${ap.jogos_apurados || 0} jogos apurados.</div>` : `<div class="status warn">Palpites publicados; pontos aparecem após o workflow de apuração.</div>`}
      <div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Participante</th><th>Jogo</th><th>Palpite</th><th>Pontos</th><th>Tipo</th><th>Hash</th></tr></thead><tbody>
        ${state.publicos.map(p => {
          const det = pontosMap.get(`${p.membro || ""}::${p.event_id || ""}`) || {};
          return `<tr><td>${escapeHtml(p.membro)}</td><td>${escapeHtml(p.mandante)} x ${escapeHtml(p.visitante)}</td><td class="num">${p.placar_mandante} x ${p.placar_visitante}</td><td class="num ${pontosClasse(det.pontos)}">${det.pontos ?? "—"}</td><td>${escapeHtml(tipoLabel(det.tipo))}</td><td class="hash">${escapeHtml(p.hash_fechamento || "—")}</td></tr>`;
        }).join("")}
      </tbody></table></div>
    </div></section>`;
  }

  async function carregarAdmin() {
    if (!state.usuario?.admin) return;
    try {
      const total = jogosDaRodada(state.rodada).length;
      const [participantes, progresso] = await Promise.all([
        rpcRows("br_admin_listar_participantes", { p_admin_id: state.usuario.id, p_token: state.token }),
        rpcRows("br_admin_progresso_rodada", { p_admin_id: state.usuario.id, p_token: state.token, p_temporada: CFG.temporada || 2026, p_rodada: state.rodada, p_total_jogos: total })
      ]);
      state.participantes = participantes;
      state.progresso = progresso;
    } catch (err) {
      console.warn("Admin indisponível", err);
      state.participantes = [];
      state.progresso = [];
    }
  }

  function pinAleatorio() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  async function carregarAuditoria() {
    if (!state.usuario?.admin) return;
    try {
      const [rel, eventos] = await Promise.all([
        rpcRows("br_admin_relatorio_auditoria", { p_admin_id: state.usuario.id, p_token: state.token, p_temporada: CFG.temporada || 2026, p_rodada: state.rodada, p_total_jogos: jogosDaRodada(state.rodada).length }),
        rpcRows("br_admin_auditoria_eventos", { p_admin_id: state.usuario.id, p_token: state.token, p_temporada: CFG.temporada || 2026, p_rodada: state.rodada })
      ]);
      state.auditoria = rel;
      state.auditoriaEventos = eventos;
    } catch (err) {
      console.warn("Auditoria indisponível", err);
      state.auditoria = [];
      state.auditoriaEventos = [];
    }
  }

  async function renderAuditoria() {
    const root = $("#conteudo");
    if (!state.usuario?.admin) {
      root.innerHTML = `<section class="panel"><div class="panel-inner empty">Área restrita ao administrador.</div></section>`;
      return;
    }
    await carregarAuditoria();
    root.innerHTML = `<section class="panel"><div class="panel-inner">
      <div class="kicker">Relatório de auditoria</div><h2>Rodada ${state.rodada}</h2>
      <p>Conferência administrativa: preenchimento, hashes, primeira/última gravação e quantidade de alterações. Os placares continuam preservados pelas regras de publicação.</p>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Participante</th><th>Login</th><th>Preenchido</th><th>%</th><th>Hash</th><th>Primeiro envio</th><th>Última alteração</th><th>Alterações</th></tr></thead><tbody>
        ${state.auditoria.map(r => `<tr><td>${escapeHtml(r.nome)}</td><td>${escapeHtml(r.login)}</td><td>${r.total_palpites}/${r.total_jogos}</td><td>${Number(r.percentual || 0).toFixed(0)}%</td><td class="hash">${escapeHtml(r.hash_fechamento || "—")}</td><td>${fmtDataLonga(r.primeiro_envio)}</td><td>${fmtDataLonga(r.ultimo_envio)}</td><td>${r.alteracoes || 0}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="audit-actions"><button class="btn secondary" type="button" id="copiar-auditoria">copiar resumo</button></div>
    </div></section>
    <section class="panel"><div class="panel-inner"><div class="kicker">Eventos de auditoria</div><h2>Últimas alterações</h2>
      ${state.auditoriaEventos.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Quando</th><th>Participante</th><th>Jogo</th><th>Ação</th><th>Hash</th></tr></thead><tbody>${state.auditoriaEventos.map(e => `<tr><td>${fmtDataLonga(e.criado_em)}</td><td>${escapeHtml(e.membro)}</td><td>${escapeHtml(e.event_id)}</td><td>${escapeHtml(e.acao)}</td><td class="hash">${escapeHtml(e.hash_fechamento || "—")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Ainda não há eventos de auditoria para esta rodada.</div>`}
    </div></section>`;
    $("#copiar-auditoria")?.addEventListener("click", copiarResumoAuditoria);
  }

  async function copiarResumoAuditoria() {
    const linhas = state.auditoria.map(r => `${r.nome}: ${r.total_palpites}/${r.total_jogos} (${Number(r.percentual || 0).toFixed(0)}%) · hash ${r.hash_fechamento || "—"}`);
    const texto = `Auditoria Rodada ${state.rodada}\n` + linhas.join("\n");
    try { await navigator.clipboard.writeText(texto); status("Resumo de auditoria copiado.", "ok"); }
    catch (_) { status("Não consegui copiar automaticamente; selecione a tabela manualmente.", "warn"); }
  }

  async function renderAdmin() {
    await carregarAdmin();
    const cfg = configEfetiva(state.rodada);
    const root = $("#conteudo");
    if (!state.usuario?.admin) {
      root.innerHTML = `<section class="panel"><div class="panel-inner empty">Área restrita ao administrador.</div></section>`;
      return;
    }
    root.innerHTML = `<section class="admin-grid">
      <article class="panel"><div class="panel-inner">
        <div class="kicker">Participantes</div><h2>Criar/alterar acesso</h2>
        <form id="admin-participante" class="admin-form">
          <input type="hidden" id="admin-participante-id">
          <label>Nome <input id="admin-nome" required placeholder="Nome exibido"></label>
          <label>Usuário/login <input id="admin-login" required placeholder="ex.: laercio"></label>
          <label>Novo PIN <input id="admin-pin" inputmode="numeric" placeholder="6 números"></label>
          <div class="actions"><button class="btn secondary" type="button" id="gerar-pin">gerar PIN</button><button class="btn" type="submit">salvar participante</button><button class="btn ghost" type="button" id="limpar-admin">limpar</button></div>
          <div class="switch-row"><label><input type="checkbox" id="admin-e-admin"> administrador</label><label><input type="checkbox" id="admin-ativo" checked> ativo</label></div>
        </form>
      </div></article>
      <article class="panel"><div class="panel-inner">
        <div class="kicker">Janela da rodada</div><h2>Rodada ${state.rodada}</h2>
        <form id="admin-rodada" class="admin-form">
          <div class="two"><label>Abre em <input id="cfg-abre" type="datetime-local" value="${toDatetimeLocal(cfg.abre_em)}"></label><label>Fecha em <input id="cfg-fecha" type="datetime-local" value="${toDatetimeLocal(cfg.fecha_em)}"></label></div>
          <div class="two"><label>Publica em <input id="cfg-publica" type="datetime-local" value="${toDatetimeLocal(cfg.publica_em)}"></label><label>Status <select id="cfg-status"><option value="programada">programada</option><option value="aberta">aberta</option><option value="fechada">fechada</option><option value="apurada">apurada</option><option value="publicada">publicada</option><option value="bloqueada">bloqueada</option></select></label></div>
          <label>Observação <input id="cfg-obs" value="${escapeAttr(cfg.observacao || "")}"></label>
          <div class="actions"><button class="btn" type="submit">salvar janela</button><button class="btn secondary" type="button" id="publicar-rodada">publicar agora</button><button class="btn secondary" type="button" id="apurar-rodada">marcar apurada</button><button class="btn danger" type="button" id="fechar-rodada">fechar rodada</button></div><p class="muted-note">Depois dos jogos, rode o workflow <strong>Apurar Apostas Brasileirão</strong>. Em seguida, marque como apurada/publicada para liberar ranking e palpites públicos.</p>
        </form>
      </div></article>
      <article class="panel" style="grid-column:1/-1"><div class="panel-inner">
        <div class="kicker">Percentual preenchido</div><h2>Admin vê percentual, não placares</h2>
        <div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Participante</th><th>Login</th><th>Status</th><th>Preenchido</th><th>%</th><th>Ação</th></tr></thead><tbody>
          ${state.progresso.map(p => `<tr><td>${p.nome}</td><td>${p.login}</td><td>${p.ativo ? "ativo" : "inativo"}${p.admin ? " · admin" : ""}</td><td>${p.total_palpites}/${p.total_jogos}</td><td><div class="progress-wrap"><div class="progress-bar" style="width:${Math.max(0, Math.min(100, Number(p.percentual || 0)))}%"></div></div></td><td><button class="btn secondary" type="button" data-edit="${p.participante_id}">editar</button></td></tr>`).join("")}
        </tbody></table></div>
      </div></article>
    </section>`;
    $("#cfg-status").value = cfg.status || "programada";
    $("#gerar-pin").addEventListener("click", () => { $("#admin-pin").value = pinAleatorio(); });
    $("#limpar-admin").addEventListener("click", limparFormParticipante);
    $("#admin-participante").addEventListener("submit", salvarParticipanteAdmin);
    $("#admin-rodada").addEventListener("submit", salvarRodadaAdmin);
    $("#publicar-rodada").addEventListener("click", () => alterarStatusRodada("publicada"));
    $("#apurar-rodada")?.addEventListener("click", () => alterarStatusRodada("apurada"));
    $("#fechar-rodada").addEventListener("click", () => alterarStatusRodada("fechada"));
    $$('[data-edit]').forEach(btn => btn.addEventListener("click", () => preencherParticipante(btn.dataset.edit)));
  }

  function toDatetimeLocal(iso) {
    const d = parseData(iso);
    if (!d) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeAttr(s) { return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

  function limparFormParticipante() {
    $("#admin-participante-id").value = "";
    $("#admin-nome").value = "";
    $("#admin-login").value = "";
    $("#admin-pin").value = "";
    $("#admin-e-admin").checked = false;
    $("#admin-ativo").checked = true;
  }

  function preencherParticipante(id) {
    const p = state.participantes.find(x => String(x.participante_id || x.id) === String(id));
    if (!p) return;
    $("#admin-participante-id").value = p.participante_id || p.id;
    $("#admin-nome").value = p.nome || "";
    $("#admin-login").value = p.login || "";
    $("#admin-pin").value = "";
    $("#admin-e-admin").checked = Boolean(p.admin);
    $("#admin-ativo").checked = Boolean(p.ativo);
    $("#admin-nome").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function salvarParticipanteAdmin(ev) {
    ev.preventDefault();
    try {
      status("Salvando participante...", "warn");
      await rpcRows("br_admin_salvar_participante", {
        p_admin_id: state.usuario.id,
        p_token: state.token,
        p_participante_id: $("#admin-participante-id").value || null,
        p_nome: $("#admin-nome").value.trim(),
        p_login: $("#admin-login").value.trim(),
        p_pin: $("#admin-pin").value.trim() || null,
        p_admin: $("#admin-e-admin").checked,
        p_ativo: $("#admin-ativo").checked
      });
      limparFormParticipante();
      status("Participante salvo. Envie o PIN por WhatsApp apenas para a pessoa.", "ok");
      await renderAdmin();
    } catch (err) { status(err.message || "Falha ao salvar participante.", "err"); }
  }

  async function salvarRodadaAdmin(ev) {
    ev.preventDefault();
    await salvarConfigRodada($("#cfg-status").value);
  }

  async function alterarStatusRodada(statusNovo) {
    $("#cfg-status").value = statusNovo;
    await salvarConfigRodada(statusNovo);
  }

  async function salvarConfigRodada(statusNovo) {
    try {
      status("Salvando janela da rodada...", "warn");
      await rpcRows("br_admin_definir_rodada", {
        p_admin_id: state.usuario.id,
        p_token: state.token,
        p_temporada: CFG.temporada || 2026,
        p_rodada: state.rodada,
        p_abre_em: $("#cfg-abre").value ? new Date($("#cfg-abre").value).toISOString() : null,
        p_fecha_em: $("#cfg-fecha").value ? new Date($("#cfg-fecha").value).toISOString() : null,
        p_publica_em: $("#cfg-publica").value ? new Date($("#cfg-publica").value).toISOString() : null,
        p_status: statusNovo,
        p_observacao: $("#cfg-obs").value || null
      });
      await carregarConfigsSupabase();
      status("Janela da rodada salva.", "ok");
      await refresh();
    } catch (err) { status(err.message || "Falha ao salvar janela.", "err"); }
  }

  function renderConteudo() {
    renderResumo();
    renderRodadas();
    $$("[data-aba]").forEach(btn => btn.classList.toggle("active", btn.dataset.aba === state.aba));
    if (state.aba === "meus") return renderMeus();
    if (state.aba === "ranking") return renderRanking();
    if (state.aba === "publico") return renderPublico();
    if (state.aba === "auditoria") return renderAuditoria();
    if (state.aba === "admin") return renderAdmin();
    return renderApostas();
  }

  async function refresh() {
    await carregarConfigsSupabase();
    if (state.usuario) await carregarMeusPalpites();
    renderLogin();
    renderConteudo();
  }

  async function trocarRodada(rodada) {
    state.rodada = Number(rodada);
    await refresh();
  }

  async function onLogin(ev) {
    ev.preventDefault();
    try {
      const login = $("#login-usuario").value.trim();
      const pin = $("#login-pin").value.trim();
      if (!login || !pin) throw new Error("Informe usuário e PIN.");
      status("Validando usuário/PIN...", "warn");
      const rows = await rpcRows("br_login_participante", { p_login: login, p_pin: pin });
      const u = rows[0];
      if (!u || !u.token) throw new Error("Login não retornou sessão válida.");
      saveSession({ id: u.id || u.participante_id, nome: u.nome, login: u.login, admin: Boolean(u.admin) }, u.token);
      status(`Bem-vindo, ${u.nome}.`, "ok");
      await refresh();
    } catch (err) {
      console.error(err);
      clearSession();
      status(err.message || "Usuário ou PIN inválido.", "err");
      renderLogin();
    }
  }

  function bindBaseEvents() {
    $("#form-login")?.addEventListener("submit", onLogin);
    $$("[data-aba]").forEach(btn => btn.addEventListener("click", async () => {
      state.aba = btn.dataset.aba;
      await refresh();
    }));
  }

  async function init() {
    state.supabase = initSupabase();
    bindBaseEvents();
    await carregarBase();
    const sess = sessionPayload();
    if (sess && sess.usuario && sess.token) {
      state.usuario = sess.usuario;
      state.token = sess.token;
    }
    if (!state.supabase) {
      status("Supabase não inicializado. Confira js/br-config.js.", "err");
    } else if (!state.usuario) {
      status("Entre com usuário e PIN para apostar.", "warn");
    }
    await refresh();
  }

  document.addEventListener("DOMContentLoaded", init);
})(window, document);
