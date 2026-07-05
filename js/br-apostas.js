/* ==========================================================================
   br-apostas.js — Apostas por rodada do Brasileirão 2026
   Execução 3: janela quinta -> sábado 10h, Supabase, ranking e apuração local.
   ========================================================================== */
(function (global, document) {
  "use strict";

  const CFG = global.BR_CFG || {};
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    jogosJson: null,
    resultadosJson: null,
    membrosJson: null,
    configRodadas: null,
    apuracao: null,
    jogos: [],
    resultados: [],
    membros: [],
    rodadas: [],
    rodada: null,
    membro: "",
    palpitesMeus: [],
    palpitesRodada: [],
    supabase: null,
    aba: "apostas"
  };

  function cacheBust(url) {
    const sep = url.includes("?") ? "&" : "?";
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

  function texto(el, msg, classe) {
    if (!el) return;
    el.textContent = msg;
    el.className = `status ${classe || ""}`.trim();
  }

  function normalizarTexto(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function timeNome(time) { return (time && time.nome) || String(time || ""); }
  function timeSigla(time) { return (time && time.sigla) || normalizarTexto(timeNome(time)).slice(0, 3).toUpperCase(); }
  function timeEscudo(time) { return (time && time.escudo) || ""; }

  function parseDataLocal(iso) {
    if (!iso) return null;
    const s = String(iso);
    // Os JSONs do projeto usam horário de Brasília sem offset: 2026-07-25T11:00.
    // Navegadores brasileiros interpretam como local. Se a ESPN trouxer offset,
    // o Date também entende corretamente.
    const d = new Date(s.length <= 16 ? s : s.replace("Z", "+00:00"));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatarData(iso) {
    const d = parseDataLocal(iso);
    if (!d) return "Data a confirmar";
    return new Intl.DateTimeFormat("pt-BR", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(d).replace(".", "");
  }

  function formatarDataCompleta(d) {
    if (!d) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
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

  function janelaRodada(rodada) {
    const cfg = configRodada(rodada);
    if (cfg && cfg.abre_em && cfg.fecha_em) {
      return { abre: new Date(cfg.abre_em), fecha: new Date(cfg.fecha_em), origem: "config" };
    }

    const jogos = jogosDaRodada(rodada);
    const datas = jogos.map(j => parseDataLocal(j.data_iso)).filter(Boolean).sort((a, b) => a - b);
    const primeira = datas[0] || new Date();

    // Regra do grupo: janela abre na quinta e fecha no sábado às 10h.
    // A referência principal é o sábado da semana da primeira partida. Se a
    // primeira partida for quinta/sexta, pegamos o sábado seguinte; se for
    // domingo/segunda, pegamos o sábado anterior.
    const js = CFG.janelaPadrao || {};
    let sabado;
    if (primeira.getDay() === 0 || primeira.getDay() === 1 || primeira.getDay() === 2 || primeira.getDay() === 3) {
      sabado = setWeekdayAround(primeira, js.fechaDiaSemana ?? 6, false);
    } else {
      sabado = setWeekdayAround(primeira, js.fechaDiaSemana ?? 6, true);
    }
    sabado.setHours(js.fechaHora ?? 10, js.fechaMinuto ?? 0, 0, 0);

    const abre = setWeekdayAround(sabado, js.abreDiaSemana ?? 4, false);
    abre.setHours(js.abreHora ?? 0, 0, 0, 0);

    return { abre, fecha: sabado, origem: "padrao" };
  }

  function configRodada(rodada) {
    const lista = (state.configRodadas && state.configRodadas.rodadas) || [];
    return lista.find(r => Number(r.rodada) === Number(rodada)) || null;
  }

  function estaAberta(rodada) {
    const { abre, fecha } = janelaRodada(rodada);
    const agora = new Date();
    return Number(rodada) >= Number(CFG.rodadaInicialApostas || 20) && agora >= abre && agora < fecha;
  }

  function statusJanela(rodada) {
    const { abre, fecha } = janelaRodada(rodada);
    const agora = new Date();
    if (Number(rodada) < Number(CFG.rodadaInicialApostas || 20)) return { tipo: "lock", texto: "Rodada fora do bolão de placares" };
    if (agora < abre) return { tipo: "warn", texto: `Apostas abrem em ${formatarDataCompleta(abre)}` };
    if (agora >= fecha) return { tipo: "lock", texto: `Apostas encerradas em ${formatarDataCompleta(fecha)}` };
    return { tipo: "open", texto: `Apostas abertas até ${formatarDataCompleta(fecha)}` };
  }

  function jogoId(j) {
    if (j.event_id) return String(j.event_id);
    const mand = normalizarTexto(timeNome(j.mandante));
    const vis = normalizarTexto(timeNome(j.visitante));
    const dt = String(j.data_iso || "").slice(0, 16);
    return `${j.rodada || state.rodada}-${mand}-${vis}-${dt}`;
  }

  function jogosDaRodada(rodada) {
    return state.jogos
      .filter(j => Number(j.rodada) === Number(rodada))
      .sort((a, b) => String(a.data_iso || "").localeCompare(String(b.data_iso || "")));
  }

  function resultadoId(j) {
    return jogoId(j);
  }

  function resultadosPorId(rodada) {
    const mapa = {};
    const todos = []
      .concat(state.resultados || [])
      .concat((state.jogos || []).filter(j => j.placar_mandante !== null && j.placar_mandante !== undefined));
    todos.forEach(r => {
      if (Number(r.rodada) !== Number(rodada)) return;
      if (r.placar_mandante === null || r.placar_mandante === undefined) return;
      if (r.placar_visitante === null || r.placar_visitante === undefined) return;
      const id = resultadoId(r);
      mapa[id] = {
        event_id: id,
        placar_mandante: Number(r.placar_mandante),
        placar_visitante: Number(r.placar_visitante),
        mandante: timeNome(r.mandante),
        visitante: timeNome(r.visitante)
      };
      if (r.event_id) mapa[String(r.event_id)] = mapa[id];
    });
    return mapa;
  }

  function initSupabase() {
    const sb = CFG.supabase || {};
    if (!global.supabase || !sb.url || !sb.key) return null;
    return global.supabase.createClient(sb.url, sb.key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  async function carregarDados() {
    texto($("#status"), "Carregando dados do Brasileirão...", "warn");
    state.supabase = initSupabase();
    state.jogosJson = await fetchJson(CFG.arquivos.jogos, { jogos: [] });
    state.resultadosJson = await fetchJson(CFG.arquivos.resultados, { resultados: [] });
    state.membrosJson = await fetchJson(CFG.arquivos.membros, { membros: [] });
    state.configRodadas = await fetchJson(CFG.arquivos.configRodadas, { rodadas: [] });
    state.apuracao = await fetchJson(CFG.arquivos.apuracao, { rodadas: [], ranking_geral: [] });

    state.jogos = Array.isArray(state.jogosJson.jogos) ? state.jogosJson.jogos : [];
    state.resultados = Array.isArray(state.resultadosJson.resultados) ? state.resultadosJson.resultados : [];
    state.membros = (state.membrosJson.membros || [])
      .map(m => typeof m === "string" ? m : m.nome)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "pt-BR"));

    const rodadas = new Set();
    state.jogos.forEach(j => { if (Number(j.rodada) >= Number(CFG.rodadaInicialApostas || 20)) rodadas.add(Number(j.rodada)); });
    (state.configRodadas.rodadas || []).forEach(r => { if (Number(r.rodada) >= Number(CFG.rodadaInicialApostas || 20)) rodadas.add(Number(r.rodada)); });
    state.rodadas = Array.from(rodadas).filter(Boolean).sort((a, b) => a - b);

    const params = new URLSearchParams(location.search);
    const rodadaUrl = Number(params.get("rodada"));
    state.rodada = state.rodadas.includes(rodadaUrl) ? rodadaUrl : escolherRodadaPadrao();
    state.membro = localStorage.getItem("br_apostas_membro") || "";

    montarSelectMembros();
    renderizarTudo();
    await carregarPalpites();
    renderizarTudo();
    texto($("#status"), `Dados carregados. Fonte dos jogos: ${state.jogosJson.fonte || "JSON local"}.`, "ok");
  }

  function escolherRodadaPadrao() {
    if (!state.rodadas.length) return Number(CFG.rodadaInicialApostas || 20);
    const agora = new Date();
    const futura = state.rodadas.find(r => {
      const jogos = jogosDaRodada(r);
      const datas = jogos.map(j => parseDataLocal(j.data_iso)).filter(Boolean);
      return datas.some(d => d >= agora) || estaAberta(r);
    });
    return futura || state.rodadas[0];
  }

  function montarSelectMembros() {
    const select = $("#membro");
    if (!select) return;
    const atual = state.membro;
    select.innerHTML = '<option value="">Selecione seu nome...</option>' + state.membros.map(nome =>
      `<option value="${escapeHtml(nome)}" ${nome === atual ? "selected" : ""}>${escapeHtml(nome)}</option>`
    ).join("");
    select.onchange = async () => {
      state.membro = select.value;
      localStorage.setItem("br_apostas_membro", state.membro || "");
      await carregarPalpites();
      renderizarTudo();
    };
  }

  async function carregarPalpites() {
    state.palpitesMeus = [];
    state.palpitesRodada = [];
    if (!state.supabase) return;
    const tabela = (CFG.supabase || {}).tabelaPalpites || "br_palpites";
    try {
      let q = state.supabase
        .from(tabela)
        .select("*")
        .eq("temporada", CFG.temporada || 2026)
        .eq("rodada", state.rodada)
        .order("membro", { ascending: true });
      const { data, error } = await q;
      if (error) throw error;
      state.palpitesRodada = Array.isArray(data) ? data : [];
      state.palpitesMeus = state.membro
        ? state.palpitesRodada.filter(p => String(p.membro) === String(state.membro))
        : [];
    } catch (err) {
      console.error(err);
      texto($("#status"), "Não consegui ler os palpites no Supabase. Confira se o SQL da Execução 3 foi aplicado.", "err");
    }
  }

  function palpiteMeuPorJogo() {
    const mapa = {};
    state.palpitesMeus.forEach(p => {
      mapa[String(p.event_id || p.jogo_chave)] = p;
    });
    return mapa;
  }

  function renderizarTudo() {
    renderCabecalhoRodada();
    renderRodadas();
    renderAba();
  }

  function renderCabecalhoRodada() {
    const jogos = jogosDaRodada(state.rodada);
    const st = statusJanela(state.rodada);
    const janela = janelaRodada(state.rodada);
    const els = {
      rodada: $("#numero-rodada"),
      jogos: $("#total-jogos"),
      janela: $("#texto-janela"),
      status: $("#badge-janela"),
      salvos: $("#total-salvos")
    };
    if (els.rodada) els.rodada.textContent = `${state.rodada}ª`;
    if (els.jogos) els.jogos.textContent = String(jogos.length || 0);
    if (els.janela) els.janela.textContent = `${formatarDataCompleta(janela.abre)} → ${formatarDataCompleta(janela.fecha)}`;
    if (els.status) {
      els.status.textContent = st.texto;
      els.status.className = `badge ${st.tipo}`;
    }
    if (els.salvos) els.salvos.textContent = String(state.palpitesRodada.length || 0);
  }

  function renderRodadas() {
    const box = $("#rodadas");
    if (!box) return;
    const rodadas = state.rodadas.length ? state.rodadas : [state.rodada];
    box.innerHTML = rodadas.map(r => `<button type="button" class="${Number(r) === Number(state.rodada) ? "active" : ""}" data-rodada="${r}">${r}ª rodada</button>`).join("");
    $$('[data-rodada]', box).forEach(btn => {
      btn.onclick = async () => {
        state.rodada = Number(btn.dataset.rodada);
        const url = new URL(location.href);
        url.searchParams.set("rodada", state.rodada);
        history.replaceState(null, "", url.toString());
        await carregarPalpites();
        renderizarTudo();
      };
    });
  }

  function setAba(aba) {
    state.aba = aba;
    $$("[data-aba]").forEach(b => b.classList.toggle("active", b.dataset.aba === aba));
    renderAba();
  }

  function renderAba() {
    const main = $("#conteudo");
    if (!main) return;
    if (state.aba === "ranking") main.innerHTML = htmlRanking();
    else if (state.aba === "meus") main.innerHTML = htmlMeusPalpites();
    else if (state.aba === "regras") main.innerHTML = htmlRegrasResumo();
    else main.innerHTML = htmlApostas();
    bindConteudo();
  }

  function htmlApostas() {
    const jogos = jogosDaRodada(state.rodada);
    const aberto = estaAberta(state.rodada);
    const meus = palpiteMeuPorJogo();
    if (!jogos.length) return `<div class="empty">Ainda não há jogos carregados para a ${state.rodada}ª rodada.</div>`;

    return `
      <div class="panel"><div class="panel-inner">
        <div class="kicker">Formulário da rodada</div>
        <h2>Seus placares</h2>
        <p>${aberto ? "Preencha ou altere os placares e salve. A janela fecha no sábado às 10h." : "A janela desta rodada está fechada ou ainda não abriu."}</p>
        <div class="matches">
          ${jogos.map(j => htmlJogo(j, meus[jogoId(j)], aberto)).join("")}
        </div>
        <div class="actions">
          <button class="btn" id="salvar-palpites" ${aberto ? "" : "disabled"}>💾 Salvar palpites da rodada</button>
          <button class="btn secondary" id="recarregar-palpites">↻ Recarregar</button>
          <span class="small">Participante: <strong>${escapeHtml(state.membro || "não selecionado")}</strong></span>
        </div>
      </div></div>`;
  }

  function htmlJogo(j, palpite, aberto) {
    const id = jogoId(j);
    const pm = palpite && palpite.placar_mandante !== null && palpite.placar_mandante !== undefined ? palpite.placar_mandante : "";
    const pv = palpite && palpite.placar_visitante !== null && palpite.placar_visitante !== undefined ? palpite.placar_visitante : "";
    const saved = palpite ? `<span class="badge saved-pill">✅ salvo</span>` : "";
    const st = statusJanela(state.rodada);
    const statusClass = aberto ? "open" : st.tipo;
    const statusText = aberto ? "aberto" : (st.tipo === "warn" ? "ainda não abriu" : "travado");
    const mand = j.mandante || {};
    const vis = j.visitante || {};
    const inputDisabled = aberto ? "" : "disabled";
    return `<article class="match-card" data-jogo="${escapeAttr(id)}">
      <div class="match-top">
        <span>${formatarData(j.data_iso)} · ${escapeHtml(j.estadio || "Estádio a confirmar")}</span>
        <span class="badge ${statusClass}">${statusText}</span>
      </div>
      <div class="match-body">
        <div class="team home">
          ${imgEscudo(mand)}
          <div><div class="team-name">${escapeHtml(timeNome(mand))}</div><div class="team-sigla">${escapeHtml(timeSigla(mand))}</div></div>
        </div>
        <div class="score-inputs">
          <input type="number" min="0" max="30" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(pm)}" aria-label="Placar ${escapeAttr(timeNome(mand))}" data-pm ${inputDisabled}>
          <span>×</span>
          <input type="number" min="0" max="30" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(pv)}" aria-label="Placar ${escapeAttr(timeNome(vis))}" data-pv ${inputDisabled}>
        </div>
        <div class="team away">
          <div><div class="team-name">${escapeHtml(timeNome(vis))}</div><div class="team-sigla">${escapeHtml(timeSigla(vis))}</div></div>
          ${imgEscudo(vis)}
        </div>
      </div>
      <div class="match-extra">
        <span class="badge">📺 ${escapeHtml(j.transmissao || "onde assistir a confirmar")}</span>
        ${saved}
        <span class="badge">ID: ${escapeHtml(id)}</span>
      </div>
    </article>`;
  }

  function htmlMeusPalpites() {
    if (!state.membro) return `<div class="empty">Selecione seu nome para ver seus palpites salvos.</div>`;
    const jogos = jogosDaRodada(state.rodada);
    const meus = palpiteMeuPorJogo();
    const linhas = jogos.map(j => {
      const p = meus[jogoId(j)];
      return `<tr>
        <td>${escapeHtml(timeNome(j.mandante))} × ${escapeHtml(timeNome(j.visitante))}</td>
        <td>${p ? `${p.placar_mandante} × ${p.placar_visitante}` : "—"}</td>
        <td>${p ? formatarData(p.atualizado_em || p.criado_em) : "não salvo"}</td>
      </tr>`;
    }).join("");
    return `<div class="panel"><div class="panel-inner">
      <div class="kicker">Meus palpites</div>
      <h2>${escapeHtml(state.membro)}</h2>
      <p>Conferência rápida da ${state.rodada}ª rodada.</p>
      <table class="rank-table"><thead><tr><th>Jogo</th><th>Palpite</th><th>Status</th></tr></thead><tbody>${linhas}</tbody></table>
    </div></div>`;
  }

  function htmlRanking() {
    const resultados = resultadosPorId(state.rodada);
    const ranking = global.BR_PONTUACAO.agregar(state.palpitesRodada, resultados);
    const apuracaoRodada = ((state.apuracao || {}).rodadas || []).find(r => Number(r.rodada) === Number(state.rodada));
    const lista = ranking.length ? ranking : (apuracaoRodada && apuracaoRodada.ranking) || [];
    if (!lista.length) {
      return `<div class="empty">Ainda não há ranking apurado para a ${state.rodada}ª rodada. Ele aparece assim que houver palpites salvos e resultados finais.</div>`;
    }
    return `<div class="panel"><div class="panel-inner">
      <div class="kicker">Ranking da rodada</div>
      <h2>${state.rodada}ª rodada</h2>
      <p>Desempate: pontos, cravadas, saldos, resultados e ordem alfabética.</p>
      <table class="rank-table">
        <thead><tr><th>#</th><th>Participante</th><th>Pontos</th><th>🎯</th><th>📐</th><th>✅</th><th>❌</th></tr></thead>
        <tbody>${lista.map(r => `<tr>
          <td><span class="medal p${r.pos <= 3 ? r.pos : ""}">${r.pos}</span></td>
          <td><strong>${escapeHtml(r.membro)}</strong></td>
          <td class="pts">${r.pontos}</td>
          <td>${r.cravadas || 0}</td>
          <td>${r.saldos || 0}</td>
          <td>${r.resultados || 0}</td>
          <td>${r.erros || 0}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div></div>`;
  }

  function htmlRegrasResumo() {
    return `<div class="panel"><div class="panel-inner">
      <div class="kicker">Regras da Execução 3</div>
      <h2>Bolão de placares por rodada</h2>
      <div class="rules-list">
        <div class="rule-card"><strong>Janela</strong><span>Abre na quinta-feira e fecha no sábado às 10h. Depois disso, a rodada trava.</span></div>
        <div class="rule-card"><strong>5 pontos</strong><span>Cravou exatamente o placar.</span></div>
        <div class="rule-card"><strong>3 pontos</strong><span>Acertou vencedor e saldo de gols.</span></div>
        <div class="rule-card"><strong>2 pontos</strong><span>Acertou apenas o resultado. Empate errado também vale 2.</span></div>
        <div class="rule-card"><strong>0 ponto</strong><span>Errou vencedor/empate.</span></div>
      </div>
      <div class="actions"><a class="btn secondary" href="regras.html">Abrir regras completas</a></div>
    </div></div>`;
  }

  function bindConteudo() {
    const salvar = $("#salvar-palpites");
    if (salvar) salvar.onclick = salvarPalpites;
    const recarregar = $("#recarregar-palpites");
    if (recarregar) recarregar.onclick = async () => { await carregarPalpites(); renderizarTudo(); };
  }

  async function salvarPalpites() {
    if (!state.membro) {
      texto($("#status"), "Selecione seu nome antes de salvar.", "err");
      $("#membro")?.focus();
      return;
    }
    if (!estaAberta(state.rodada)) {
      texto($("#status"), "A janela desta rodada está fechada. Nenhum palpite foi salvo.", "err");
      return;
    }
    if (!state.supabase) {
      texto($("#status"), "Supabase não carregou. Verifique conexão e configuração.", "err");
      return;
    }

    const jogos = jogosDaRodada(state.rodada);
    const janela = janelaRodada(state.rodada);
    const rows = [];
    for (const card of $$(".match-card[data-jogo]")) {
      const id = card.dataset.jogo;
      const j = jogos.find(x => jogoId(x) === id);
      if (!j) continue;
      const pm = Number.parseInt($('[data-pm]', card).value, 10);
      const pv = Number.parseInt($('[data-pv]', card).value, 10);
      if (!Number.isFinite(pm) || !Number.isFinite(pv) || pm < 0 || pv < 0) continue;
      rows.push({
        temporada: CFG.temporada || 2026,
        rodada: Number(state.rodada),
        event_id: id,
        jogo_chave: `${normalizarTexto(timeNome(j.mandante))}-${normalizarTexto(timeNome(j.visitante))}-${String(j.data_iso || "").slice(0, 10)}`,
        membro: state.membro,
        mandante: timeNome(j.mandante),
        visitante: timeNome(j.visitante),
        placar_mandante: pm,
        placar_visitante: pv,
        kickoff: toIsoBrt(parseDataLocal(j.data_iso)),
        fecha_em: toIsoBrt(janela.fecha),
        origem: "site"
      });
    }

    if (!rows.length) {
      texto($("#status"), "Preencha pelo menos um placar válido para salvar.", "err");
      return;
    }

    const tabela = (CFG.supabase || {}).tabelaPalpites || "br_palpites";
    texto($("#status"), "Salvando palpites...", "warn");
    try {
      const { error } = await state.supabase
        .from(tabela)
        .upsert(rows, { onConflict: "temporada,rodada,event_id,membro" });
      if (error) throw error;
      await carregarPalpites();
      renderizarTudo();
      texto($("#status"), `${rows.length} palpite(s) salvo(s) com sucesso.`, "ok");
    } catch (err) {
      console.error(err);
      texto($("#status"), `Erro ao salvar: ${err.message || err}`, "err");
    }
  }

  function toIsoBrt(d) {
    if (!d || Number.isNaN(d.getTime())) return null;
    // Mantém ISO comum. O banco grava timestamptz; no Brasil, o navegador envia UTC.
    return d.toISOString();
  }

  function imgEscudo(time) {
    const src = timeEscudo(time);
    const alt = timeNome(time);
    if (!src) return `<span class="badge">${escapeHtml(timeSigla(time))}</span>`;
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" onerror="this.style.display='none'">`;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  document.addEventListener("DOMContentLoaded", () => {
    $$("[data-aba]").forEach(btn => btn.addEventListener("click", () => setAba(btn.dataset.aba)));
    carregarDados().catch(err => {
      console.error(err);
      texto($("#status"), `Erro ao inicializar: ${err.message || err}`, "err");
    });
  });
})(window, document);
