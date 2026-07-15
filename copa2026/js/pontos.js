/* =========================================================================
   pontos.js — Classificação do bolão por PONTOS (Copa 2026)
   Cruza o palpite de cada um (derivado pela engine) com o resultado OFICIAL
   (montado a partir do feed da ESPN) usando COPA_PONTUACAO.calcular.
   Pontuação só começa na 2ª fase (quando as 32 são definidas).
   ========================================================================= */
(function () {
  "use strict";
  const CFG = window.COPA_CFG || { url: "", key: "" };
  const $ = s => document.querySelector(s);
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const ESPN_OVR = {};
  // janelas de data por fase (calendário oficial da ESPN)
  const JANELAS = ["20260611-20260627", "20260628-20260703", "20260704-20260707", "20260709-20260711", "20260714-20260715", "20260718-20260718", "20260719-20260719"];
  let DADOS = {}, JOGOS = [], GRUPOS = [], PART = [], timer = null;
  let FILTRO = "", ORDEM = "atuais", ULTIMO_O = null;
  let ABA = (new URLSearchParams(location.search).get("aba") === "placares") ? "placares" : "bolao";
  let ORDEM_P = "pts";
  // Até esta data/hora (Brasília), o Ranking mostra a PRÉVIA SIMULADA (foto de hoje).
  // Depois, vira o Ranking normal (pontuação real da 2ª fase).
  const VIRADA_SIMULADO = new Date("2026-06-28T02:00:00-03:00");
  function modoSimulado() { return Date.now() < VIRADA_SIMULADO.getTime(); }

  async function rpc(fn, body) {
    const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": CFG.key, "Authorization": "Bearer " + CFG.key },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error("RPC " + fn);
    return r.json();
  }
  const nome = id => (DADOS.nomeDe && DADOS.nomeDe[id]) || id || "—";
  const iso = id => (DADOS.isoDe && DADOS.isoDe[id]) || "";
  const flag = id => { const c = iso(id); return c ? `<img src="https://flagcdn.com/w40/${c}.png" title="${nome(id)}" alt="" onerror="this.style.visibility='hidden'">` : ""; };
  const norm = ab => ESPN_OVR[ab] || ab;
  const inter = (a, b) => { const s = new Set(b || []); return (a || []).filter(x => s.has(x)); };
  function eficienciaPct(r) {
    const a = Number(r && r.atuais);
    const p = Number(r && r.perdidos);
    if (!Number.isFinite(a) || !Number.isFinite(p)) return "…";
    const decidido = a + p;
    if (decidido <= 0) return "—";
    return (a / decidido * 100).toLocaleString("pt-BR", { minimumFractionDigits:1, maximumFractionDigits:1 }) + "%";
  }
  function faseCompleta(o, fase) {
    return !!(o && o._faseCompleta && o._faseCompleta[fase]);
  }
  function emLista(o, key, team) {
    return !!(o && Array.isArray(o[key]) && o[key].indexOf(team) !== -1);
  }
  function vivoNoTorneio(team, o) {
    // Auditoria de "ainda vivo": precisa bater com a fase atual do mata-mata,
    // não apenas com "entrou nas 32". Depois que uma fase fecha, quem não
    // aparece na fase seguinte está fora do páreo, mesmo se o feed não marcar loser.
    if (!o || !o.classificados32 || !o.classificados32.length) return "pend";
    if (o.classificados32.indexOf(team) === -1) return "wrong";
    if ((o.eliminados || []).indexOf(team) !== -1) return "out";

    if (faseCompleta(o, "r32") && !emLista(o, "avancam_oitavas", team)) return "out";
    if (faseCompleta(o, "oitavas") && !emLista(o, "avancam_quartas", team)) return "out";
    if (faseCompleta(o, "quartas") && !emLista(o, "semifinalistas", team)) return "out";
    if (faseCompleta(o, "semis") && !emLista(o, "finalistas", team)) return "out";
    if (faseCompleta(o, "final") && o.campeao && team !== o.campeao) return "out";

    return "alive";
  }
  const fateDe = vivoNoTorneio;

  function chaveAtualDoPareo(o) {
    if (!o || !o.classificados32 || !o.classificados32.length) return null;
    if (faseCompleta(o, "final")) return "campeao";
    if (faseCompleta(o, "semis")) return "finalistas";
    if (faseCompleta(o, "quartas")) return "semifinalistas";
    if (faseCompleta(o, "oitavas")) return "avancam_quartas";
    if (faseCompleta(o, "r32")) return "avancam_oitavas";
    return "classificados32";
  }
  function listaOficialDoPareo(o, key) {
    if (!o || !key) return [];
    if (key === "campeao") return o.campeao ? [o.campeao] : [];
    return Array.isArray(o[key]) ? o[key] : [];
  }
  function listaPalpiteDoPareo(p, key) {
    if (!p || !key) return [];
    if (key === "campeao") return p.campeao ? [p.campeao] : [];
    return Array.isArray(p[key]) ? p[key] : [];
  }
  function statusNoPareo(team, p, o) {
    // Status dos ícones das 32 do participante:
    // - wrong: ele colocou entre as 32, mas a seleção nem classificou.
    // - alive: segue viva NO CAMINHO QUE ELE CRAVOU para a fase atual.
    // - out: classificou, mas caiu do caminho do palpite dele em alguma fase.
    if (!o || !o.classificados32 || !o.classificados32.length) return "pend";
    if (o.classificados32.indexOf(team) === -1) return "wrong";
    const key = chaveAtualDoPareo(o);
    const real = new Set(listaOficialDoPareo(o, key));
    const palpite = new Set(listaPalpiteDoPareo(p, key));
    return real.has(team) && palpite.has(team) ? "alive" : "out";
  }
  function qtdAindaNoPareo(p, o) {
    if (!o || !o.classificados32 || !o.classificados32.length) return 0;
    const key = chaveAtualDoPareo(o);
    const real = new Set(listaOficialDoPareo(o, key));
    return listaPalpiteDoPareo(p, key).filter(t => real.has(t)).length;
  }

  async function init() {
    try {
      const [s, e, t, pm, fp] = await Promise.all([
        fetch("dados/selecoes.json").then(r => r.json()),
        fetch("dados/estrutura_mata_mata.json").then(r => r.json()),
        fetch("dados/terceiros_map.json").then(r => r.json()),
        fetch("dados/palpites_mata.json").then(r => r.json()).catch(() => ({ apostadores: {} })),
        // Fair play OFICIAL, gerado pelo robô em dados/fairplay.json.
        // Usado apenas para classificar os resultados reais/atuais da Copa.
        // Não é aplicado nos palpites lacrados, porque o apostador não informou cartões.
        fetch("dados/fairplay.json?t=" + Date.now()).then(r => r.json()).catch(() => ({ fairplay: {} }))
      ]);
      DADOS.selecoes = s.selecoes; DADOS.estrutura = e; DADOS.terceirosMap = t;
      DADOS.palpitesMata = (pm && pm.apostadores) || {};
      DADOS.fairplay = (fp && fp.fairplay) || {};
      DADOS.nomeDe = {}; DADOS.isoDe = {};
      s.selecoes.forEach(x => { DADOS.nomeDe[x.id] = x.nome; DADOS.isoDe[x.id] = x.iso2; });
    } catch (err) { $("#app").innerHTML = '<p class="vazio">Erro ao carregar os dados da Copa.</p>'; return; }
    JOGOS = COPA_ENGINE.gerarJogosGrupos(DADOS.selecoes);
    GRUPOS = [...new Set(JOGOS.map(j => j.grupo))].sort();

    try {
      const rows = await rpc("copa_revelados", {});
      PART = (rows || []).map(r => {
        const pl = r.payload || {};
        const g = Object.keys(pl.placaresGrupos || {}).map(id => ({ jogo_id: id, ga: pl.placaresGrupos[id].ga, gb: pl.placaresGrupos[id].gb }));
        let d = null;
        try { d = COPA_ENGINE.derivar(DADOS.selecoes, g, pl.placaresMata || {}, DADOS.estrutura, DADOS.terceirosMap); } catch (e) {}
        // PALPITE DE MATA-MATA: usa as listas FIÉIS do relatório de auditoria (12/jun),
        // não a propagação por posição (que mudava com a correção do desempate).
        // O que cada um CRAVOU que avança em cada fase é fixo e foi auditado com hash.
        if (d) {
          const pm = DADOS.palpitesMata[r.nome];
          if (pm) {
            d.classificados32  = pm.classificados32 || d.classificados32;
            d.avancam_oitavas  = pm.avancam_oitavas  || d.avancam_oitavas;
            d.avancam_quartas  = pm.avancam_quartas  || d.avancam_quartas;
            d.semifinalistas   = pm.semifinalistas   || d.semifinalistas;
            d.finalistas       = pm.finalistas       || d.finalistas;
            d.campeao  = pm.campeao  || d.campeao;
            d.vice     = pm.vice     || d.vice;
            d.terceiro = pm.terceiro || d.terceiro;
            d.quarto   = pm.quarto   || d.quarto;
          }
        }
        return { nome: r.nome, d, pg: pl.placaresGrupos || {} };
      }).filter(p => p.d);
    } catch (e) { PART = []; }

    if (!PART.length) { $("#app").innerHTML = '<div class="bloq"><div class="cad">🔒</div><h2>Aguardando a trava</h2><p>A classificação aparece depois que as apostas travarem (10/06 23h59) e os palpites forem liberados.</p></div>'; return; }

    atualizar(); timer = setInterval(atualizar, 120000); // recalcula a cada 2 min
  }

  // ---- monta o resultado OFICIAL a partir da ESPN ----
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

    // Primeiro tenta pelo texto/slug da ESPN. A ESPN pode variar o slug conforme a fase.
    if (/group/.test(raw)) return "group-stage";
    if (/third|3rd|bronze|terceiro/.test(raw)) return "third-place";
    if (/round[-\s_]*of[-\s_]*32|round32|\br32\b|\b32\b/.test(raw)) return "round-of-32";
    if (/round[-\s_]*of[-\s_]*16|round16|\br16\b|\b16\b|oitava|octav/.test(raw)) return "round-of-16";
    if (/quarter|quartas|quarterfinal/.test(raw)) return "quarterfinals";
    if (/semi|semifinal/.test(raw)) return "semifinals";
    if (/final/.test(raw)) return "final";

    // Fallback por calendário oficial da Copa 2026, em Brasília.
    // Isso garante a apuração mesmo se a ESPN trocar slug/nome da fase.
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
  function teamsOf(ev) { return (ev.competitions[0].competitors || []).map(c => norm((c.team || {}).abbreviation)).filter(t => DADOS.nomeDe && DADOS.nomeDe[t]); }
  function isPost(ev) { return ev.competitions[0].status.type.state === "post"; }
  function winLoseOf(ev) {
    const cs = ev.competitions[0].competitors || [];
    const w = cs.find(c => c.winner), l = cs.find(c => !c.winner);
    const W = w ? norm((w.team || {}).abbreviation) : null, L = l ? norm((l.team || {}).abbreviation) : null;
    return { w: (W && DADOS.nomeDe[W]) ? W : null, l: (L && DADOS.nomeDe[L]) ? L : null };
  }

  function buildOficial(events) {
    const o = { decididos: {} };
    const slugTeams = slug => [...new Set(events.filter(e => phaseOf(e) === slug).flatMap(teamsOf))];
    const postCount = slug => events.filter(e => phaseOf(e) === slug && isPost(e)).length;
    const faseCompletaOficial = {
      r32: postCount("round-of-32") >= 16,
      oitavas: postCount("round-of-16") >= 8,
      quartas: postCount("quarterfinals") >= 4,
      semis: postCount("semifinals") >= 2,
      final: postCount("final") >= 1
    };

    // --- mata-mata: quem ALCANÇOU cada fase ---
    // 1) usa os times que já aparecem nos confrontos da fase;
    // 2) soma os vencedores dos jogos encerrados da fase anterior.
    // Isso evita o bug clássico: Canadá venceu os 16-avos, mas ainda não apareceu
    // no card ESPN das oitavas; mesmo assim, já conquistou os +4.
    const addUnico = (arr, id) => { if (id && arr.indexOf(id) === -1) arr.push(id); };
    const faseComecou = slug => events.some(e => phaseOf(e) === slug && e.competitions && e.competitions[0] && e.competitions[0].status && e.competitions[0].status.type && e.competitions[0].status.type.state !== "pre");
    const r32 = slugTeams("round-of-32");
    o._apurarMata = {
      oitavas: faseComecou("round-of-32"),
      quartas: faseComecou("round-of-16"),
      semis: faseComecou("quarterfinals"),
      final: faseComecou("semifinals")
    };
    o.avancam_oitavas = slugTeams("round-of-16");
    o.avancam_quartas = slugTeams("quarterfinals");
    o.semifinalistas = slugTeams("semifinals");
    o.finalistas = slugTeams("final");
    const semiLosers = [];
    events.filter(e => phaseOf(e) !== "group-stage" && isPost(e)).forEach(ev => {
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

    // --- grupos: posições + melhores terceiros, derivados com a própria engine ---
    const realG = [];
    events.filter(e => phaseOf(e) === "group-stage" && isPost(e)).forEach(ev => {
      const cs = ev.competitions[0].competitors;
      const home = cs.find(c => c.homeAway === "home") || cs[0], away = cs.find(c => c.homeAway === "away") || cs[1];
      const hId = norm(home.team.abbreviation), aId = norm(away.team.abbreviation);
      const j = JOGOS.find(x => (x.a === hId && x.b === aId) || (x.a === aId && x.b === hId));
      if (!j) return;
      const hs = parseInt(home.score || "0", 10), as = parseInt(away.score || "0", 10);
      const ga = j.a === hId ? hs : as, gb = j.a === hId ? as : hs;
      const inv = (j.a !== hId); // ESPN mostra invertido vs engine?
      realG.push({ jogo_id: j.jogo_id, ga, gb, inv: inv, homeId: hId, awayId: aId });
    });
    const completos = {}; GRUPOS.forEach(g => completos[g] = realG.filter(p => p.jogo_id.startsWith("G_" + g + "_")).length === 6);
    const todosGrupos = GRUPOS.every(g => completos[g]);

    if (realG.length) {
      let dg = null;
      try {
        // Resultado oficial: aqui SIM precisa considerar fair play antes do ranking FIFA.
        // Mantém a aba Pontos alinhada com Resultados/chaveamento oficial.
        dg = COPA_ENGINE.derivar(DADOS.selecoes, realG, {}, DADOS.estrutura, DADOS.terceirosMap, DADOS.fairplay || {});
      } catch (e) {}
      if (dg) {
        o.classificacao = {};
        GRUPOS.forEach(g => { if (completos[g]) o.classificacao[g] = dg.classificacao[g]; });
        if (todosGrupos) { o.classificados32 = dg.classificados32; o.melhores_terceiros = dg.melhores_terceiros; }
        else if (modoSimulado()) {
          // PRÉVIA (foto de hoje): usa a classificação SIMULADA COMPLETA de todos os grupos,
          // para pontuar 1º/2º/3º/4º e os 8 melhores terceiros como se a fase acabasse agora.
          o.classificacao = {};
          GRUPOS.forEach(g => { if (dg.classificacao[g]) o.classificacao[g] = dg.classificacao[g]; });
          o.classificados32 = dg.classificados32;
          o.melhores_terceiros = dg.melhores_terceiros;
          o._simulado = true;
        }
      }
    }
    if (r32.length === 32) o.classificados32 = r32; // so vale com os 32 REAIS definidos (ignora placeholders 'a definir' da ESPN)

    // --- 1º a 4º ---
    const fin = events.find(e => phaseOf(e) === "final" && isPost(e));
    if (fin) { const wl = winLoseOf(fin); o.campeao = wl.w; o.vice = wl.l; o.decididos.campeao = true; o.decididos.vice = true; }
    const ter = events.find(e => (phaseOf(e) === "third-place") && isPost(e));
    if (ter) { const wl = winLoseOf(ter); o.terceiro = wl.w; o.quarto = wl.l; o.decididos.terceiro = true; o.decididos.quarto = true; }

    // --- eliminados (para os "perdidos") ---
    const elim = new Set();
    events.forEach(ev => { if (phaseOf(ev) !== "group-stage" && isPost(ev)) { const wl = winLoseOf(ev); if (wl.l) elim.add(wl.l); } });
    if (todosGrupos && o.classificados32) {
      const passou = new Set(o.classificados32);
      DADOS.selecoes.forEach(s => { if (!passou.has(s.id)) elim.add(s.id); });
    } else if (o._simulado && o.classificados32) {
      // SIMULADO (foto de HOJE): se a Copa acabasse agora, quem está fora dos 32 já era.
      const passou = new Set(o.classificados32);
      DADOS.selecoes.forEach(s => {
        if (!passou.has(s.id)) elim.add(s.id);
      });
    }

    // Auditoria completa do mata-mata: quando uma fase encerrou,
    // a lista da fase seguinte passa a ser a fonte da verdade para quem segue vivo.
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

    o._realGrupos = {}; realG.forEach(x => o._realGrupos[x.jogo_id] = { ga: x.ga, gb: x.gb, inv: x.inv, homeId: x.homeId, awayId: x.awayId });
    o._meta = { todosGrupos, segundaFase: !!(o.classificados32 && o.classificados32.length), nGruposCompletos: GRUPOS.filter(g => completos[g]).length, simulado: !!o._simulado };
    return o;
  }

  async function atualizar() {
    let events = [];
    try {
      const lotes = await Promise.all(JANELAS.map(d => fetch(`${API}?dates=${d}&limit=120`).then(r => r.json()).catch(() => ({ events: [] }))));
      const vistos = new Set();
      lotes.forEach(l => (l.events || []).forEach(ev => { if (!vistos.has(ev.id)) { vistos.add(ev.id); events.push(ev); } }));
    } catch (e) {}
    const o = buildOficial(events);
    ULTIMO_O = o;
    render(o);
  }

  function cravadosDe(pg, real) { let n = 0; for (const id in real) { const a = pg[id]; if (a && a.ga === real[id].ga && a.gb === real[id].gb) n++; } return n; }

  // ---- render ----
  const FASES = [
    { k: "classificados32", n: 32, lab: "2ª fase" },
    { k: "avancam_oitavas", n: 16, lab: "Oitavas" },
    { k: "avancam_quartas", n: 8, lab: "Quartas" },
    { k: "semifinalistas", n: 4, lab: "Semifinal" }
  ];
  function podioJaCaiu(p, o, key) {
    // Visual da tela principal alinhado ao motor de pontos perdidos:
    // se a seleção apostada já foi eliminada, o item do pódio deixa de ficar
    // como "aguardando" e passa a mostrar "já caiu" imediatamente.
    const id = p && p[key];
    if (!id || !o) return false;
    const dec = o.decididos || {};
    if (dec[key]) return false;
    const elim = new Set(o.eliminados || []);
    if (!elim.has(id)) return false;
    const semiLosers = new Set(o._semiLosers || []);
    // Quem perdeu a semifinal ainda pode terminar em 3º/4º até o jogo de terceiro lugar.
    if ((key === "terceiro" || key === "quarto") && semiLosers.has(id) && !dec.terceiro && !dec.quarto) return false;
    return true;
  }

  function detalheFinal(p, o) {
    const labs = [["campeao", "Campeão", 40], ["vice", "Vice", 25], ["terceiro", "3º lugar", 15], ["quarto", "4º lugar", 10]];
    return labs.map(([k, lab]) => {
      const pick = p[k]; if (!pick) return "";
      let st = "", cls = "pend";
      if (o.decididos && o.decididos[k]) {
        if (o[k] === pick) { st = "✓ acertou"; cls = "ok"; }
        else { st = "✗ errou"; cls = "err"; }
      } else if (podioJaCaiu(p, o, k)) {
        st = "já caiu"; cls = "err";
      } else {
        st = "aguardando";
      }
      return `<div class="fp"><span>${lab}: ${flag(pick)} ${nome(pick)}</span><span class="${cls}">${st}</span></div>`;
    }).join("");
  }

  function statusFasePalpite(id, key, o) {
    const oficiais = new Set(o[key] || []);
    if (oficiais.has(id)) return "ok";
    // Caiu em campo, perdeu imediatamente qualquer fase futura que dependia dela.
    // A ampulheta é reservada somente a seleções que ainda estão vivas no torneio.
    if ((o.eliminados || []).indexOf(id) !== -1) return "no";
    if (key === "classificados32" && o.classificados32 && o.classificados32.length && o.classificados32.indexOf(id) === -1) return "no";
    return "pend";
  }
  function chipFasePalpite(id, key, o) {
    const st = statusFasePalpite(id, key, o);
    const ico = st === "ok" ? "✅" : (st === "no" ? "❌" : "⏳");
    const cls = st === "ok" ? "gg-ok" : (st === "no" ? "gg-no" : "gg-pend");
    return `<span class="gg-cel ${cls}">${flag(id)} ${id} ${ico}</span>`;
  }
  function fasesDoPalpiteHTML(p, o, apostador) {
    const fases = [
      ["classificados32", "2ª fase", 32],
      ["avancam_oitavas", "Oitavas", 16],
      ["avancam_quartas", "Quartas", 8],
      ["semifinalistas", "Semis", 4],
      ["finalistas", "Final", 2]
    ];
    const linhas = fases.map(([key, lab, total]) => {
      const ids = p[key] || [];
      if (!ids.length) return "";
      const ok = ids.filter(id => statusFasePalpite(id, key, o) === "ok").length;
      const no = ids.filter(id => statusFasePalpite(id, key, o) === "no").length;
      const pend = ids.length - ok - no;
      return `<div class="gg-lin"><span class="gg-g">${lab}<small>${ok}/${total}</small></span><div class="gg-cels">${ids.map(id => chipFasePalpite(id, key, o)).join("")}</div></div>`;
    }).join("");
    const podio = [["campeao","Campeão"],["vice","Vice"],["terceiro","3º"],["quarto","4º"]]
      .map(([key, lab]) => {
        const id = p[key]; if (!id) return "";
        let cls = "gg-pend", ico = "⏳";
        if (o.decididos && o.decididos[key]) {
          const ok = o[key] === id; cls = ok ? "gg-ok" : "gg-no"; ico = ok ? "✅" : "❌";
        } else if (podioJaCaiu(p, o, key)) {
          cls = "gg-no"; ico = "❌";
        }
        return `<span class="gg-cel ${cls}"><i>${lab}</i> ${flag(id)} ${id} ${ico}</span>`;
      }).join("");
    const podioBloco = podio ? `<div class="gg-lin"><span class="gg-g">Pódio</span><div class="gg-cels">${podio}</div></div>` : "";
    return `<button class="vermais2" data-fases="${apostador}">🧭 Fases do palpite ▾</button>
      <div class="ggbox" id="fases-${cssId(apostador)}" style="display:none">
        <div class="gg-leg">✅ conquistou · ⏳ ainda possível · ❌ perdeu nesta fase</div>
        ${linhas}${podioBloco}
      </div>`;
  }

  function toggleHTML() {
    return `<div class="vistog">
      <button class="vbtn ${ABA === "bolao" ? "on" : ""}" data-v="bolao">🏆 ${modoSimulado() ? "Ranking Simulado" : "Ranking"}</button>
      <button class="vbtn ${ABA === "placares" ? "on" : ""}" data-v="placares">🎯 Reis do Cravo</button>
    </div>`;
  }
  function wireToggle() {
    document.querySelectorAll(".vbtn").forEach(b => b.onclick = () => {
      if (ABA === b.dataset.v) return;
      ABA = b.dataset.v; FILTRO = "";
      if (ULTIMO_O) render(ULTIMO_O);
    });
  }
  function render(o) { if (ABA === "placares") renderPlacares(o); else renderBolao(o); }


  // ---- Chance matemática de título / pódio ----
  function fmtPctChance(v) {
    const n = Number(v || 0);
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
  }
  function dadoChance(chances, nome) {
    return chances && chances.por_nome ? chances.por_nome[nome] : null;
  }
  function chanceResumoHTML(chances, x) {
    const c = dadoChance(chances, x.nome);
    if (!c) return "";
    const vivos = Number(c.cenarios_titulo || 0);
    const total = Number(chances.total_cenarios || 0);
    const tituloGarantido = total > 0 && vivos === total;
    if (tituloGarantido) {
      return `<div class="chance-card chance-definida">
        <span class="chance-label">Campeão do Bolão</span>
        <b>🏆 definido</b>
        <small>${vivos}/${total} cenários: ninguém mais alcança o 1º lugar</small>
      </div>`;
    }
    const pct = fmtPctChance(c.chance_titulo_pct_exata ?? c.chance_titulo_pct);
    const cls = vivos > 0 ? "chance-viva" : "chance-zero";
    const sub = vivos > 0 ? `${vivos}/${total} cenários` : "sem caminho matemático para 1º";
    return `<div class="chance-card ${cls}">
      <span class="chance-label">Chance de título</span>
      <b>${pct}</b>
      <small>${sub}</small>
    </div>`;
  }
  function caminhoCurto(c) {
    if (!c) return "";
    const fmt = id => id ? `${flag(id)} ${nome(id)}` : "—";
    // Mostra apenas confrontos ainda abertos no estado atual da Copa.
    // Ex.: se a Espanha já está classificada para a final, não faz sentido
    // repetir "Espanha passa" em todos os cenários.
    const semi = (c.semifinais || [])
      .filter(s => !s.fixo)
      .map(s => `${fmt(s.vencedor)} passa`)
      .join(" · ");
    const final = c.final ? `${fmt(c.final.campeao)} campeão · ${fmt(c.final.vice)} vice` : "";
    const terc = c.terceiro_lugar ? `${fmt(c.terceiro_lugar.terceiro)} 3º · ${fmt(c.terceiro_lugar.quarto)} 4º` : "";
    return [semi, final, terc].filter(Boolean).join("<br>");
  }
  function ordinal(n) {
    n = Number(n || 0);
    return n > 0 ? `${n}º` : "—";
  }
  function cenariosDoParticipanteHTML(c, total) {
    const lista = Array.isArray(c && c.resultados_cenarios) ? c.resultados_cenarios : [];
    if (!lista.length) return "";
    const melhorId = c.melhor_cenario && c.melhor_cenario.id;
    return `<div class="chance-cenarios">
      <div class="chance-cenarios-titulo">Todos os ${total} cenários</div>
      ${lista.map((r, i) => {
        const rc = r.cenario || {};
        const caminho = caminhoCurto(rc);
        const destaque = melhorId && rc.id === melhorId ? " melhor" : "";
        const selo = destaque ? '<span class="chance-cenario-selo">melhor caminho</span>' : "";
        return `<div class="chance-cenario${destaque}">
          <div class="chance-cenario-head">
            <b>Cenário ${i + 1}</b>${selo}
            <span>${ordinal(r.colocacao)} no bolão · <strong>${Number(r.pontos_final || 0)} pts</strong></span>
          </div>
          <div class="chance-cenario-caminho">${caminho}</div>
        </div>`;
      }).join("")}
    </div>`;
  }
  function chanceDetalheHTML(chances, x) {
    const c = dadoChance(chances, x.nome);
    if (!c) return "";
    const total = Number(chances.total_cenarios || 0);
    const linhas = [
      ["1º lugar", c.chance_titulo_pct_exata ?? c.chance_titulo_pct, c.cenarios_titulo],
      ["2º lugar", c.chance_segundo_pct_exata ?? c.chance_segundo_pct, c.cenarios_segundo],
      ["3º lugar", c.chance_terceiro_pct_exata ?? c.chance_terceiro_pct, c.cenarios_terceiro],
      ["Pódio", c.chance_podio_pct_exata ?? c.chance_podio_pct, c.cenarios_podio]
    ].map(([lab, pct, cen]) => `<div class="chance-row"><span>${lab}</span><b>${fmtPctChance(pct)}</b><em>${Number(cen || 0)}/${total}</em></div>`).join("");
    const melhor = Number(c.melhor_pontuacao || 0);
    const pior = Number(c.pior_pontuacao || 0);
    const media = Number(c.pontuacao_media_simulada || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cenariosHTML = cenariosDoParticipanteHTML(c, total);
    return `<button class="vermais2" data-chance="${x.nome}">🧮 Detalhar chances ▾</button>
      <div class="chancebox" id="chance-${cssId(x.nome)}" style="display:none">
        <div class="chance-metodo">Cálculo cru: ${total} cenários possíveis, sem favoritismo. Cada combinação de resultados tem o mesmo peso (${fmtPctChance(chances.cada_cenario_pct || 0)}).</div>
        <div class="chance-grid">${linhas}</div>
        <div class="chance-extra">
          <span>Melhor pontuação: <b>${melhor}</b></span>
          <span>Pior pontuação: <b>${pior}</b></span>
          <span>Média simulada: <b>${media}</b></span>
        </div>
        ${cenariosHTML}
      </div>`;
  }

  function chancePainelHTML(chances) {
    if (!chances || !Array.isArray(chances.participantes) || !chances.participantes.length) return "";
    const total = Number(chances.total_cenarios || 0);
    const cada = Number(chances.cada_cenario_pct || 0);
    const vivosTitulo = chances.participantes.filter(p => Number(p.cenarios_titulo || 0) > 0);
    const semTitulo = chances.participantes.length - vivosTitulo.length;
    const cenTxt = total === 1 ? "1 cenário restante" : `${total} cenários restantes`;
    const cadaTxt = total ? `Cada cenário vale ${fmtPctChance(cada)}.` : "";
    const campeaoMatematico = total > 0 && vivosTitulo.length === 1 && Number(vivosTitulo[0].cenarios_titulo || 0) === total;

    if (campeaoMatematico) {
      const c = vivosTitulo[0];
      return `<section class="chance-topbox chance-campeao-box" aria-label="Campeão matemático do bolão">
        <div class="chance-top-head">
          <div>
            <span class="chance-kicker">🏆 Bolão definido matematicamente</span>
            <h2>Campeão do Bolão</h2>
          </div>
          <div class="chance-top-total"><b>${cenTxt}</b><small>O título já está definido.</small></div>
        </div>
        <div class="chance-campeao-card">
          <span class="chance-campeao-ico">🏆</span>
          <div><b>${c.nome}</b><small>Não há mais cenários matemáticos em que outro participante termine em 1º lugar.</small></div>
        </div>
        <button class="chance-help-btn" type="button" data-chance-help>Como foi definido? ▾</button>
        <div class="chance-helpbox" id="chance-helpbox" style="display:none">
          <p>O motor simulou todos os caminhos restantes da chave, somando a pontuação atual com os pontos futuros possíveis de cada participante.</p>
          <p><b>${c.nome}</b> termina em 1º lugar em ${Number(c.cenarios_titulo || 0)}/${total} cenários restantes. Por isso, a página deixa de tratar como chance e passa a indicar campeão matemático.</p>
          <p>O cálculo segue sem favoritismo: cada jogo restante é tratado como 50/50 e o desempate é por placares cravados.</p>
        </div>
      </section>`;
    }

    const linhas = vivosTitulo.length ? vivosTitulo.map((p, i) => {
      const pct = fmtPctChance(p.chance_titulo_pct_exata ?? p.chance_titulo_pct);
      const podio = fmtPctChance(p.chance_podio_pct_exata ?? p.chance_podio_pct);
      return `<div class="chance-top-row">
        <span class="chance-top-pos">${i + 1}</span>
        <span class="chance-top-nome">${p.nome}</span>
        <b>${pct}</b>
        <small>${Number(p.cenarios_titulo || 0)}/${total} · pódio ${podio}</small>
      </div>`;
    }).join("") : `<div class="chance-top-empty">Nenhum participante tem caminho matemático isolado para o título neste momento.</div>`;
    const tituloLista = vivosTitulo.length === 1 ? "Participante ainda vivo pelo título" : "Participantes ainda vivos pelo título";
    return `<section class="chance-topbox" aria-label="Chance matemática de título do bolão">
      <div class="chance-top-head">
        <div>
          <span class="chance-kicker">🧮 Simulação crua do bolão</span>
          <h2>Chance matemática de título</h2>
        </div>
        <div class="chance-top-total"><b>${cenTxt}</b><small>${cadaTxt}</small></div>
      </div>
      <p class="chance-top-desc">Sem favoritismo: todos os jogos restantes são tratados como 50/50. O cálculo respeita a chave real, a pontuação atual, os pontos futuros de semifinalistas, finalistas e pódio, e o desempate por cravados.</p>
      <button class="chance-help-btn" type="button" data-chance-help>Como é calculado? ▾</button>
      <div class="chance-helpbox" id="chance-helpbox" style="display:none">
        <p><b>Chance de título</b> não é previsão de futebol. É a porcentagem de caminhos restantes em que o participante termina em 1º no bolão.</p>
        <p>O motor simula todos os cenários possíveis da chave a partir do estado atual. Em cada cenário, soma a pontuação atual com os pontos futuros de semifinalistas, finalistas, campeão, vice, 3º e 4º lugar.</p>
        <p>Cada jogo restante é tratado como 50/50. Não usa índice, favoritismo, odds, ranking de seleção ou força histórica.</p>
      </div>
      <div class="chance-top-subtitle">${tituloLista}</div>
      <div class="chance-top-list">${linhas}</div>
      <div class="chance-top-foot">${vivosTitulo.length} participante(s) ainda têm chance de título · ${semTitulo} sem caminho matemático para 1º neste momento.</div>
    </section>`;
  }

  function renderBolao(o) {
    const KEY = { atuais: x => x.r.atuais, possiveis: x => x.r.possiveis, perdidos: x => x.r.perdidos };
    const lin = PART.map(p => {
      const r = COPA_PONTUACAO.calcular(p.d, o);
      const cr = cravadosDe(p.pg, o._realGrupos || {});
      return { nome: p.nome, d: p.d, r, cr };
    });

    let CHANCES = null;
    if (window.COPA_CHANCES && typeof window.COPA_CHANCES.calcular === "function") {
      try {
        CHANCES = window.COPA_CHANCES.calcular(lin, o);
      } catch (err) {
        console.warn("Falha ao calcular chances matemáticas do bolão", err);
      }
    }

    // Sombreamento do pódio: usa a simulação real dos cenários restantes.
    // O card só fica sombreado quando o participante tem 0 caminhos matemáticos
    // para terminar em 1º, 2º ou 3º. Não usa mais a conta antiga de
    // "conquistados + possíveis" contra a pontuação atual do 3º colocado.
    const semChancePodio = x => {
      const c = dadoChance(CHANCES, x.nome);
      if (!c || !CHANCES || !Number(CHANCES.total_cenarios || 0)) return false;
      return Number(c.cenarios_podio || 0) <= 0;
    };

    const chanceOrdem = x => {
      const c = dadoChance(CHANCES, x.nome);
      return c ? Number(c.cenarios_titulo || 0) : -1;
    };
    if (ORDEM === "chance") {
      lin.sort((a, b) => chanceOrdem(b) - chanceOrdem(a) || b.r.atuais - a.r.atuais || b.cr - a.cr || b.r.teto - a.r.teto || a.nome.localeCompare(b.nome, "pt-BR"));
    } else {
      const kf = KEY[ORDEM] || KEY.atuais;
      lin.sort((a, b) => kf(b) - kf(a) || b.cr - a.cr || b.r.teto - a.r.teto || a.nome.localeCompare(b.nome, "pt-BR"));
    }
    lin.forEach((x, i) => x.posReal = i + 1);
    const visiveis = FILTRO ? lin.filter(x => x.nome === FILTRO) : lin;

    const opts = PART.map(p => p.nome).sort((a, b) => a.localeCompare(b))
      .map(n => `<option value="${n}" ${n === FILTRO ? "selected" : ""}>${n}</option>`).join("");
    const ROT = { atuais: "conquistados", chance: "Chance de título", possiveis: "possíveis", perdidos: "perdidos" };
    const pills = Object.keys(ROT).map(k => `<button class="ordbtn ${ORDEM === k ? "on" : ""}" data-ord="${k}">${ROT[k]}</button>`).join("");
    const controles = `<div class="ctrlbar">
      <select id="filtro-part"><option value="">👥 Todos os participantes</option>${opts}</select>
      <div class="ordwrap"><span class="ordlab">ordenar:</span>${pills}</div>
    </div>`;

    let banner = "";
    if (o._meta.simulado) {
      banner = `<div class="aviso">⚠️ <b>Ranking SIMULADO</b>: como ficaria se a fase de grupos acabasse <b>agora</b>. Muda a cada jogo — <b>nada está definido!</b> ${o._meta.nGruposCompletos ? `(${o._meta.nGruposCompletos}/12 grupos encerrados)` : ""}</div>`;
    } else if (!o._meta.segundaFase) {
      banner = `<div class="aviso">A pontuação <b>começa na 2ª fase</b> (quando as 32 forem definidas, no fim dos grupos). Por enquanto mostramos o <b>potencial máximo</b> de cada palpite — o máximo que dá pra fazer. ${o._meta.nGruposCompletos ? `(${o._meta.nGruposCompletos}/12 grupos encerrados)` : ""}</div>`;
    }

    const tbnote = '<p class="tbnote">Desempate: mais placares <b>cravados</b> na fase de grupos 🎯 · Cards sombreados indicam 0 cenários matemáticos de pódio. Cards em ouro, prata e bronze indicam posição de pódio matematicamente garantida.</p>';
    const painelChances = ABA === "bolao" ? chancePainelHTML(CHANCES) : "";
    $("#app").innerHTML = toggleHTML() + controles + banner + painelChances + tbnote + visiveis.map((x, i) => {
      const pos = x.posReal, r = x.r;
      const eficiencia = eficienciaPct(r);
      const tot = r.atuais + r.perdidos + r.possiveis || 1;
      const medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
      const chanceDoCard = dadoChance(CHANCES, x.nome);
      const totalCenarios = Number(CHANCES && CHANCES.total_cenarios || 0);
      const cenariosPodio = Number(chanceDoCard && chanceDoCard.cenarios_podio || 0);
      const tituloGarantido = totalCenarios > 0 && Number(chanceDoCard && chanceDoCard.cenarios_titulo || 0) === totalCenarios;
      const segundoGarantido = totalCenarios > 0 && Number(chanceDoCard && chanceDoCard.cenarios_segundo || 0) === totalCenarios;
      const terceiroGarantido = totalCenarios > 0 && Number(chanceDoCard && chanceDoCard.cenarios_terceiro || 0) === totalCenarios;
      const podioGarantidoClasse = tituloGarantido ? " podio-ouro" : segundoGarantido ? " podio-prata" : terceiroGarantido ? " podio-bronze" : "";
      const semPodio = semChancePodio(x);
      const cls = (pos <= 3 ? " p" + pos : "") + podioGarantidoClasse + (semPodio ? " sem-podio" : "");
      const left = medal ? `<span class="medal">${medal}</span>` : `<span class="pos">${pos}</span>`;
      const motivoSemPodio = `${cenariosPodio}/${totalCenarios} cenários de pódio: não termina em 1º, 2º ou 3º em nenhuma simulação restante`;
      const seloSemPodio = semPodio ? `<div class="selo-sem-podio">⚠️ Sem chance matemática de pódio <small>${motivoSemPodio}</small></div>` : "";
      let seloPodioGarantido = "";
      if (tituloGarantido) seloPodioGarantido = `<div class="selo-podio-garantido selo-ouro">🏆 Campeão do Bolão <small>1º lugar garantido em ${totalCenarios}/${totalCenarios} cenários restantes</small></div>`;
      else if (segundoGarantido) seloPodioGarantido = `<div class="selo-podio-garantido selo-prata">🥈 Vice-campeão matemático <small>2º lugar garantido em ${totalCenarios}/${totalCenarios} cenários restantes</small></div>`;
      else if (terceiroGarantido) seloPodioGarantido = `<div class="selo-podio-garantido selo-bronze">🥉 3º lugar matemático <small>3º lugar garantido em ${totalCenarios}/${totalCenarios} cenários restantes</small></div>`;
      const fasesHTML = FASES.map(f => {
        const real = o[f.k] || [];
        if (!real.length) return `<span class="ph">${f.lab}: <b>—</b></span>`;
        const ac = inter(x.d[f.k], real).length;
        return `<span class="ph">${f.lab}: <b>${ac}/${f.n}</b></span>`;
      }).join("");
      // Bloco visual redundante removido: detalhes ficam apenas em 'Fases do palpite'.
      return `<div class="card${cls}">
        ${seloPodioGarantido}${seloSemPodio}
        <div class="head">${left}<span class="nm">${x.nome}</span><span class="conq">${r.atuais}<small>conquistados</small></span></div>
        <div class="barra"><span class="b v" style="width:${r.atuais / tot * 100}%"></span><span class="b r" style="width:${r.perdidos / tot * 100}%"></span><span class="b g" style="width:${r.possiveis / tot * 100}%"></span></div>
        <div class="nums"><span class="cn">conquistados <b>${r.atuais}</b></span><span class="pn">perdidos <b>${r.perdidos}</b></span><span class="sn">possíveis <b>${r.possiveis}</b></span><span class="tn">eficiência <b>${eficiencia}</b></span></div>
        ${chanceResumoHTML(CHANCES, x)}
        <div class="fases">${fasesHTML}<span class="ph">🎯 <b>${x.cr}</b> cravados</span></div>
        <div class="podiodet">${detalheFinal(x.d, o)}</div>
        ${fasesDoPalpiteHTML(x.d, o, x.nome)}
        ${chanceDetalheHTML(CHANCES, x)}
        <button class="vermais" data-ext="${x.nome}">Ver extrato dos pontos ▾</button>
        <div class="extbox" id="ext-${cssId(x.nome)}" style="display:none">${extratoBolao(x.d, o, x)}</div>
      </div>`;
    }).join("");
    const fp = $("#filtro-part");
    if (fp) fp.onchange = e => { FILTRO = e.target.value; if (ULTIMO_O) render(ULTIMO_O); };
    document.querySelectorAll(".ordbtn[data-ord]").forEach(b => b.onclick = () => { ORDEM = b.dataset.ord; if (ULTIMO_O) render(ULTIMO_O); });
    document.querySelectorAll(".vermais[data-ext]").forEach(b => b.onclick = () => {
      const d = document.getElementById("ext-" + cssId(b.dataset.ext)), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "Ocultar extrato ▴" : "Ver extrato dos pontos ▾";
    });
    document.querySelectorAll(".vermais2[data-fases]").forEach(b => b.onclick = () => {
      const d = document.getElementById("fases-" + cssId(b.dataset.fases)), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "🧭 Ocultar fases do palpite ▴" : "🧭 Fases do palpite ▾";
    });
    document.querySelectorAll(".vermais2[data-chance]").forEach(b => b.onclick = () => {
      const d = document.getElementById("chance-" + cssId(b.dataset.chance)), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "🧮 Ocultar chances ▴" : "🧮 Detalhar chances ▾";
    });
    document.querySelectorAll(".vermais2[data-gg]").forEach(b => b.onclick = () => {
      const d = document.getElementById("gg-" + cssId(b.dataset.gg)), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "Ocultar quem você acertou ▴" : "QUEM VOCÊ ACERTOU ▾";
    });
    document.querySelectorAll("[data-chance-help]").forEach(b => b.onclick = () => {
      const d = document.getElementById("chance-helpbox");
      if (!d) return;
      const ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "Como é calculado? ▴" : "Como é calculado? ▾";
    });
    wireToggle();
  }

  // ===== Extrato da pontuação do Bolão (detalhe de onde vem cada ponto) =====
  function extratoBolao(p, o, x) {
    const P = COPA_PONTUACAO.PESOS;
    const det = COPA_PONTUACAO.calcularAtuais(p, o);
    const elim = new Set(o.eliminados || []);
    const passou = new Set(o.classificados32 || []);
    const linhas = [];
    function row(lab, qtd, peso, pts, tipo) {
      linhas.push(`<div class="exb-row ${tipo}"><span class="exb-d">${lab}</span><span class="exb-p">${pts >= 0 ? "+" : ""}${pts}</span></div>`);
    }
    // CONQUISTADOS
    const nClassif = inter(p.classificados32, o.classificados32 || []).length;
    if (nClassif) row(`${nClassif} seleções entre as 32 classificadas (×${P.classificado32})`, nClassif, P.classificado32, nClassif * P.classificado32, "ok");
    const nTer = inter(p.melhores_terceiros, o.melhores_terceiros || []).length;
    if (nTer) row(`${nTer} melhores terceiros (×${P.melhorTerceiro})`, nTer, P.melhorTerceiro, nTer * P.melhorTerceiro, "ok");
    // posições de grupo detalhadas (1º/2º/3º/4º)
    if (det.posGrupos) {
      const oc = o.classificacao || {};
      let a1 = 0, a2 = 0, a3 = 0, a4 = 0;
      Object.keys(oc).forEach(g => {
        const pg = (p.classificacao || {})[g];
        if (!pg) return;
        if (pg[0] && oc[g][0] && pg[0].id === oc[g][0].id) a1++;
        if (pg[1] && oc[g][1] && pg[1].id === oc[g][1].id) a2++;
        if (pg[2] && oc[g][2] && pg[2].id === oc[g][2].id) a3++;
        if (pg[3] && oc[g][3] && pg[3].id === oc[g][3].id) a4++;
      });
      if (a1) row(`${a1} campeões de grupo (1º) certos (×${P.campGrupo})`, a1, P.campGrupo, a1 * P.campGrupo, "ok");
      if (a2) row(`${a2} vices de grupo (2º) certos (×${P.viceGrupo})`, a2, P.viceGrupo, a2 * P.viceGrupo, "ok");
      if (a3) row(`${a3} terceiros de grupo certos (×${P.terGrupo})`, a3, P.terGrupo, a3 * P.terGrupo, "ok");
      if (a4) row(`${a4} quartos de grupo certos (×${P.ultGrupo})`, a4, P.ultGrupo, a4 * P.ultGrupo, "ok");
    }
    const nOit = inter(p.avancam_oitavas, o.avancam_oitavas || []).length;
    if (nOit) row(`${nOit} seleções nas oitavas (×${P.oitavas})`, nOit, P.oitavas, nOit * P.oitavas, "ok");
    const nQua = inter(p.avancam_quartas, o.avancam_quartas || []).length;
    if (nQua) row(`${nQua} seleções nas quartas (×${P.quartas})`, nQua, P.quartas, nQua * P.quartas, "ok");
    const nSemi = inter(p.semifinalistas, o.semifinalistas || []).length;
    if (nSemi) row(`${nSemi} semifinalistas (×${P.semi})`, nSemi, P.semi, nSemi * P.semi, "ok");
    const nFin = inter(p.finalistas, o.finalistas || []).length;
    if (nFin) row(`${nFin} finalistas (×${P.final})`, nFin, P.final, nFin * P.final, "ok");
    if (det.campeao) row(`Campeão certo`, 1, P.campeao, det.campeao, "ok");
    if (det.vice) row(`Vice certo`, 1, P.vice, det.vice, "ok");
    if (det.terceiro) row(`3º lugar certo`, 1, P.terceiro, det.terceiro, "ok");
    if (det.quarto) row(`4º lugar certo`, 1, P.quarto, det.quarto, "ok");
    const conqHTML = linhas.length ? linhas.join("") : '<div class="exb-row"><span class="exb-d">Ainda sem pontos conquistados</span><span class="exb-p">0</span></div>';

    // PERDIDOS (na foto de hoje) — detalhado por categoria
    const perd = [];
    function prow(lab, pts) { perd.push(`<div class="exb-row err"><span class="exb-d">${lab}</span><span class="exb-p">-${pts}</span></div>`); }
    // seleções fora dos 32
    const classFora = (p.classificados32 || []).filter(id => !passou.has(id));
    if (classFora.length) prow(`${classFora.length} seleções fora dos 32 (×${P.classificado32}): ${classFora.map(id => nome(id)).join(", ")}`, classFora.length * P.classificado32);
    // melhores terceiros errados
    const t8 = new Set(o.melhores_terceiros || []);
    const terErr = (p.melhores_terceiros || []).filter(id => !t8.has(id)).length;
    if (terErr) prow(`${terErr} melhores terceiros errados (×${P.melhorTerceiro})`, terErr * P.melhorTerceiro);
    // posições de grupo erradas (1º/2º/3º/4º)
    const oc3 = o.classificacao || {};
    let e1 = 0, e2 = 0, e3 = 0, e4 = 0;
    Object.keys(oc3).forEach(g => {
      const pg = (p.classificacao || {})[g]; if (!pg) return;
      if (pg[0] && oc3[g][0] && pg[0].id !== oc3[g][0].id) e1++;
      if (pg[1] && oc3[g][1] && pg[1].id !== oc3[g][1].id) e2++;
      if (pg[2] && oc3[g][2] && pg[2].id !== oc3[g][2].id) e3++;
      if (pg[3] && oc3[g][3] && pg[3].id !== oc3[g][3].id) e4++;
    });
    if (e1) prow(`${e1} campeões de grupo (1º) errados (×${P.campGrupo})`, e1 * P.campGrupo);
    if (e2) prow(`${e2} vices de grupo (2º) errados (×${P.viceGrupo})`, e2 * P.viceGrupo);
    if (e3) prow(`${e3} terceiros de grupo errados (×${P.terGrupo})`, e3 * P.terGrupo);
    if (e4) prow(`${e4} quartos de grupo errados (×${P.ultGrupo})`, e4 * P.ultGrupo);
    // mata-mata perdido (só no oficial, quando fases já decididas):
    // cada seleção apostada para uma fase que já caiu antes dela debita o peso daquela fase.
    const perdMata = (key, oficiais, peso, rotulo) => {
      const conf = new Set(oficiais || []);
      const ids = (p[key] || []).filter(id => elim.has(id) && !conf.has(id));
      if (ids.length) prow(`${ids.length} ${rotulo} (×${peso}): ${ids.map(id => nome(id)).join(", ")}`, ids.length * peso);
    };
    perdMata("avancam_oitavas", o.avancam_oitavas, P.oitavas, "seleções não avançaram às oitavas");
    perdMata("avancam_quartas", o.avancam_quartas, P.quartas, "seleções não avançaram às quartas");
    perdMata("semifinalistas", o.semifinalistas, P.semi, "seleções não chegaram à semifinal");
    perdMata("finalistas", o.finalistas, P.final, "seleções não chegaram à final");
    // títulos cuja seleção já caiu
    if (podioJaCaiu(p, o, "campeao")) prow(`Campeão (${nome(p.campeao)}) já caiu`, P.campeao);
    if (podioJaCaiu(p, o, "vice")) prow(`Vice (${nome(p.vice)}) já caiu`, P.vice);
    if (podioJaCaiu(p, o, "terceiro")) prow(`3º lugar (${nome(p.terceiro)}) já caiu`, P.terceiro);
    if (podioJaCaiu(p, o, "quarto")) prow(`4º lugar (${nome(p.quarto)}) já caiu`, P.quarto);
    const perdHTML = perd.length ? perd.join("") : '<div class="exb-row"><span class="exb-d">Nada perdido na foto de hoje 🎉</span><span class="exb-p">0</span></div>';

    // SEGUNDO NÍVEL: detalhe por grupo (1º/2º/3º/4º com ✅/❌)
    const oc2 = o.classificacao || {};
    const pc = p.classificacao || {};
    const ter = new Set(o.melhores_terceiros || []);
    const pter = new Set(p.melhores_terceiros || []);
    const POS = ["1º", "2º", "3º", "4º"];
    const gradeGrupos = GRUPOS.map(g => {
      const og = oc2[g], pgg = pc[g];
      if (!og) return "";
      const cels = POS.map((lab, i) => {
        const real = og[i] ? og[i].id : null;
        if (!real) return `<span class="gg-cel"><i>${lab}</i> —</span>`;
        const acertou = pgg && pgg[i] && pgg[i].id === real;
        return `<span class="gg-cel ${acertou ? "gg-ok" : "gg-no"}"><i>${lab}</i> ${flag(real)} ${real} ${acertou ? "✅" : "❌"}</span>`;
      }).join("");
      return `<div class="gg-lin"><span class="gg-g">Grupo ${g}</span><div class="gg-cels">${cels}</div></div>`;
    }).join("");

    // melhores terceiros: quais ele acertou
    const terReais = (o.melhores_terceiros || []);
    const terCels = terReais.map(id => {
      const acertou = pter.has(id);
      return `<span class="gg-cel ${acertou ? "gg-ok" : "gg-no"}">${flag(id)} ${id} ${acertou ? "✅" : "❌"}</span>`;
    }).join("");
    const terBloco = terReais.length ? `<div class="gg-lin"><span class="gg-g">Melhores 3ºs</span><div class="gg-cels">${terCels}</div></div>` : "";

    const detalheGrupos = `<button class="vermais2" data-gg="${x.nome}">QUEM VOCÊ ACERTOU ▾</button>
      <div class="ggbox" id="gg-${cssId(x.nome)}" style="display:none">
        <div class="gg-leg">✅ você cravou esta posição · ❌ ERROU!</div>
        ${gradeGrupos}${terBloco}
      </div>`;

    return `<div class="exb">
      <div class="exb-sec">✅ Conquistados (${x.r.atuais} pts)</div>${conqHTML}
      <div class="exb-sec">❌ Perdidos (${x.r.perdidos} pts)</div>${perdHTML}
      <div class="exb-sec">⏳ Ainda possíveis: <b>${x.r.possiveis} pts</b> · Eficiência: <b>${eficienciaPct(x.r)}</b></div>
      ${detalheGrupos}
    </div>`;
  }

  // ===== 🎯 PLACARES (Reis do Cravo) — fase de grupos, 5/3/2/0 =====
  function tierDe(g, R) { // retorna [pontos, simbolo]
    if (!g || g.ga == null || g.gb == null) return [0, "—"];
    const sg = Math.sign(g.ga - g.gb), sR = Math.sign(R.ga - R.gb);
    if (g.ga === R.ga && g.gb === R.gb) return [5, "🎯"];
    if (sg === sR && sR !== 0 && (g.ga - g.gb) === (R.ga - R.gb)) return [3, "📐"];
    if (sg === sR) return [2, "✅"];
    return [0, "❌"];
  }
  function calcPlacares(o) {
    const real = o._realGrupos || {};
    const ids = Object.keys(real);
    const lin = PART.map(p => {
      let pts = 0, cr = 0, sal = 0, res = 0;
      ids.forEach(id => {
        const [v] = tierDe(p.pg[id], real[id]);
        pts += v;
        if (v === 5) cr++; else if (v === 3) sal++; else if (v === 2) res++;
      });
      return { nome: p.nome, pts, cr, sal, res };
    });
    return { lin, n: ids.length };
  }
  const SELO = { 5: "CRAVOU", 3: "acertou saldo", 2: "acertou resultado", 0: "errou" };
  function extrato(p, o) {
    const real = o._realGrupos || {};
    const ids = Object.keys(real).sort();
    if (!ids.length) return '<p class="pend" style="padding:4px 2px">Nenhum jogo encerrado ainda.</p>';
    return ids.map(id => {
      const j = JOGOS.find(x => x.jogo_id === id); if (!j) return "";
      const R = real[id], g = p.pg[id];
      const [pts, tag] = tierDe(g, R); // pontuação SEMPRE na ordem da engine (não muda)
      // exibição na ordem da ESPN (mandante na frente):
      const inv = R.inv;
      const ladoA = inv ? j.b : j.a, ladoB = inv ? j.a : j.b;
      const rGa = inv ? R.gb : R.ga, rGb = inv ? R.ga : R.gb;
      const pGa = (g && g.ga != null) ? (inv ? g.gb : g.ga) : null;
      const pGb = (g && g.ga != null) ? (inv ? g.ga : g.gb) : null;
      const pal = (pGa != null) ? `${pGa}×${pGb}` : "—";
      const cls = pts === 5 ? "s5" : pts === 3 ? "s3" : pts === 2 ? "s2" : "s0";
      return `<div class="extrow">
        <span class="extj"><i>${j.grupo}</i> ${flag(ladoA)} ${ladoA} <b>${rGa}×${rGb}</b> ${ladoB} ${flag(ladoB)}</span>
        <span class="extp">palpite ${pal}</span>
        <span class="extpts ${cls}">${tag} ${SELO[pts]} · ${pts}pt</span></div>`;
    }).join("");
  }
  const cssId = nm => nm.replace(/[^a-zA-Z0-9]/g, "_");

  function renderPlacares(o) {
    const { lin, n } = calcPlacares(o);
    const cmpN = (a, b) => a.nome.localeCompare(b.nome);
    lin.sort(ORDEM_P === "cr"
      ? (a, b) => b.cr - a.cr || b.pts - a.pts || b.sal - a.sal || cmpN(a, b)
      : (a, b) => b.pts - a.pts || b.cr - a.cr || b.sal - a.sal || cmpN(a, b));
    lin.forEach((x, i) => x.posReal = i + 1);
    const vis = FILTRO ? lin.filter(x => x.nome === FILTRO) : lin;

    const opts = PART.map(p => p.nome).sort((a, b) => a.localeCompare(b))
      .map(x => `<option value="${x}" ${x === FILTRO ? "selected" : ""}>${x}</option>`).join("");
    const pills = [["pts", "pontos"], ["cr", "cravadas"]]
      .map(([k, lab]) => `<button class="ordbtn ${ORDEM_P === k ? "on" : ""}" data-ordp="${k}">${lab}</button>`).join("");
    const controles = `<div class="ctrlbar">
      <select id="filtro-part"><option value="">👥 Todos os participantes</option>${opts}</select>
      <div class="ordwrap"><span class="ordlab">ordenar:</span>${pills}</div></div>`;
    const banner = `<div class="aviso">🍷 <b>Reis do Cravo</b> — desafio apartado da fase de grupos:
      placar cravado <b>5</b> · vencedor + saldo de gols <b>3</b> · só o resultado <b>2</b> · errou <b>0</b>
      (empate vale 5 ou 2). Prêmio do organizador ao 1º no fim dos grupos: <b>duas garrafas de vinho</b> 🍷🍷.
      Pontua só jogo <b>encerrado</b> — <b>${n} de 72</b> computados.
      Regra completa em <a href="regras.html" style="color:var(--gold)">Regras</a>.</div>`;
    const cards = vis.map(x => {
      const pos = x.posReal, medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
      const campeaoDefinido = n >= 72 && pos === 1;
      const cls = (pos <= 3 ? " p" + pos : "") + (campeaoDefinido ? " cravo-campeao" : "");
      const seloCampeao = campeaoDefinido ? '<div class="cravo-campeao-selo">CAMPEÃO!</div>' : "";
      const left = medal ? `<span class="medal">${medal}</span>` : `<span class="pos">${pos}</span>`;
      const p = PART.find(pp => pp.nome === x.nome);
      const aberto = FILTRO === x.nome; // ao filtrar 1 pessoa, já abre
      return `<div class="card${cls}">
        ${seloCampeao}
        <div class="head">${left}<span class="nm">${x.nome}</span><span class="conq">${x.pts}<small>pontos</small></span></div>
        <div class="fases"><span class="ph">🎯 cravadas <b>${x.cr}</b></span><span class="ph">📐 no saldo <b>${x.sal}</b></span><span class="ph">✅ resultados <b>${x.res}</b></span></div>
        <button class="vermais" data-jg="${x.nome}">${aberto ? "Ocultar jogos ▴" : "Ver jogos ▾"}</button>
        <div class="extbox" id="jg-${cssId(x.nome)}" style="display:${aberto ? "block" : "none"}">${extrato(p, o)}</div>
      </div>`;
    }).join("");
    $("#app").innerHTML = toggleHTML() + controles + banner + cards;
    wireToggle();
    const fp = $("#filtro-part");
    if (fp) fp.onchange = e => { FILTRO = e.target.value; if (ULTIMO_O) render(ULTIMO_O); };
    document.querySelectorAll(".ordbtn[data-ordp]").forEach(b => b.onclick = () => { ORDEM_P = b.dataset.ordp; if (ULTIMO_O) render(ULTIMO_O); });
    document.querySelectorAll(".vermais[data-jg]").forEach(b => b.onclick = () => {
      const d = document.getElementById("jg-" + cssId(b.dataset.jg)), ab = d.style.display === "none";
      d.style.display = ab ? "block" : "none";
      b.innerHTML = ab ? "Ocultar jogos ▴" : "Ver jogos ▾";
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
