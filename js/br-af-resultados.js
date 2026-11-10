/* Fórmula do Gol · E3 · RESULTADOS, exclusivamente dados auditados na E1.
   Nenhum cálculo preditivo ou recuperação histórica é feito no navegador. */
(function (root) {
  "use strict";
  const URL = "dados-br/resultados-af-placares-2026.json";
  const WIN = ["mandante", "empate", "visitante"];
  const labels = { mandante: "Mandante", empate: "Empate", visitante: "Visitante" };
  let loading = null;
  let active = null;
  let index = null;

  function safe(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, x =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[x]);
  }
  function normalize(name) {
    return String(name || "").normalize("NFKD").toLowerCase()
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function team(x) { return typeof x === "object" && x !== null ? x.nome || x.name || "" : x || ""; }
  function pair(a, b) { return normalize(team(a)) + "|" + normalize(team(b)); }
  function score(x) {
    if (!x || typeof x !== "object") return null;
    const h = Number(x.mandante), a = Number(x.visitante);
    return Number.isInteger(h) && Number.isInteger(a) && h >= 0 && a >= 0 &&
      h <= 30 && a <= 30 ? { h: h, a: a } : null;
  }
  function originalScore(row) {
    return score({ mandante: row.placar_mandante, visitante: row.placar_visitante });
  }
  function actualOutcome(h, a) { return h > a ? "mandante" : a > h ? "visitante" : "empate"; }
  function pct(x) {
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 && n <= 100
      ? n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%" : "—";
  }
  function when(value) {
    if (!value) return null;
    let str = String(value);
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?:[:]\d\d)?$/.test(str)) {
      if (str.length === 16) str += ":00";
      str += "-03:00";
    }
    const v = Date.parse(str);
    return Number.isFinite(v) ? v : null;
  }
  function validDocument(json) {
    if (!json || json.schema_version !== 1 || json.temporada !== 2026 ||
        json.status !== "ok" || json.tipo !== "comparativo_resultados_af_previsao" ||
        !Array.isArray(json.jogos) || !json.resumo ||
        json.resumo.resultados_auditados !== json.jogos.length ||
        !json.integridade || typeof json.integridade.hash_jogos !== "string") {
      throw new Error("Artefato E3 ausente ou formato incorreto");
    }
    return json;
  }
  function createIndex(json) {
    const byId = new Map(), byPair = new Map();
    for (const row of json.jogos) {
      const key = row.identidade_partida || pair(row.mandante, row.visitante);
      if (!key || byPair.has(key)) throw new Error("Confronto duplicado no relatório E3");
      byPair.set(key, row);
      for (const id of row.event_ids || []) {
        if (byId.has(String(id)) && byId.get(String(id)) !== row) {
          throw new Error("Identificador duplicado na E3");
        }
        byId.set(String(id), row);
      }
    }
    return { byId: byId, byPair: byPair };
  }
  function load() {
    if (loading) return loading;
    loading = fetch(URL + "?e3=" + Date.now(), { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(x => {
        active = validDocument(x);
        index = createIndex(active);
        return active;
      })
      .catch(error => {
        loading = null; // permite tentar novamente após falha transitória
        throw error;
      });
    return loading;
  }
  function decide(game, data) {
    if (!game) return { status: "ausente" };
    if (game._provisorioESPN === true) return { status: "provisorio" };
    const doc = data || active;
    if (!doc) return { status: "carregando" };
    const lookup = data && data !== active ? createIndex(validDocument(data)) : index;
    if (!lookup) return { status: "carregando" };
    const matchKey = pair(game.mandante, game.visitante);
    const id = String(game.event_id || game.id || "");
    const idMatch = id ? lookup.byId.get(id) : null;
    // Não aceitar uma coincidência de event_id pertencente a outro confronto.
    if (idMatch && idMatch.identidade_partida !== matchKey) return { status: "inconsistente" };
    const entry = idMatch || lookup.byPair.get(matchKey);
    if (!entry) return { status: "nao_auditado" };
    if (entry.identidade_partida !== matchKey) return { status: "inconsistente" };
    if (entry.situacao !== "comprovado") {
      return { status: entry.situacao === "sem_snapshot_prejogo_comprovavel"
          ? "sem_prova" : "inconsistente", entry: entry };
    }
    const current = originalScore(game), factual = score(entry.placar_final_auditado);
    const currentAt = when(game.data_iso), auditedAt = when(entry.inicio_factual);
    if (!current || !factual || current.h !== factual.h || current.a !== factual.a ||
        currentAt === null || auditedAt === null ||
        Math.abs(currentAt - auditedAt) > 5 * 60 * 1000) {
      return { status: "inconsistente", entry: entry };
    }
    const predicted = score(entry.placar_previsto);
    const top = Array.isArray(entry.top3_placares) ? entry.top3_placares : [];
    const probs = entry.probabilidades_ved_pct || {};
    if (!predicted || top.length !== 3 ||
        !WIN.every(k => Number.isFinite(Number(probs[k])) && Number(probs[k]) >= 0 &&
                  Number(probs[k]) <= 100) ||
        !entry.prova || !/^[a-f0-9]{40}$/.test(entry.prova.commit)) {
      return { status: "inconsistente", entry: entry };
    }
    const topScores = top.map(score);
    if (topScores.some(x => !x) ||
        topScores[0].h !== predicted.h || topScores[0].a !== predicted.a) {
      return { status: "inconsistente", entry: entry };
    }
    const outcome = actualOutcome(current.h, current.a);
    const predictedOutcome = entry.palpite_resultado_top1;
    return {
      status: "comprovado",
      entry: entry,
      actual: current,
      predicted: predicted,
      outcome: outcome,
      top1: WIN.includes(predictedOutcome) ? predictedOutcome === outcome : null,
      exact: predicted.h === current.h && predicted.a === current.a,
      top3: topScores.some(x => x.h === current.h && x.a === current.a),
    };
  }
  function chip(value, text) {
    const name = value === null ? "neutral" : value ? "yes" : "no";
    return '<span class="af-e3-chip af-e3-' + name + '">' +
      (value === null ? "◦ " : value ? "✓ " : "× ") + safe(text) + '</span>';
  }
  function missing(label, detail) {
    return '<div class="af-e3-outcome af-e3-outcome-missing" aria-label="' + safe(detail) + '">' +
      '<span class="af-e3-prefix">AF-Previsão</span><span class="af-e3-muted">' +
      safe(label) + '</span></div>';
  }
  function render(game, data) {
    const decision = decide(game, data);
    if (decision.status === "carregando" || decision.status === "ausente") return "";
    if (decision.status === "provisorio") {
      return missing("Aferição após consolidação do resultado", "Resultado ESPN recente ainda não certificado");
    }
    if (decision.status === "nao_auditado") {
      return missing("Ainda não incluído na auditoria histórica E1", "Partida recente sem aferição documental E1");
    }
    if (decision.status === "sem_prova") {
      return missing("Sem previsão pré-jogo comprovável", "Não é possível atribuir um placar que o histórico não comprova");
    }
    if (decision.status !== "comprovado") {
      return missing("Aferição suspensa — dados em revisão", "Dados atuais ou evidência E1 divergentes; previsão não exibida");
    }
    const e = decision.entry;
    const bestPct = e.top3_placares[0].probabilidade_pct;
    const predicted = decision.predicted.h + " × " + decision.predicted.a;
    const actual = decision.actual.h + " × " + decision.actual.a;
    const source = e.prova;
    const top1Label = decision.top1 === null ? "Sem palpite V/E/D único" :
      decision.top1 ? "Resultado V/E/D" : "V/E/D não confirmado";
    const exactLabel = decision.exact ? "Placar exato" : "Placar diferente";
    const top3Text = decision.top3 ? "O placar final estava entre os três principais." :
      "O placar final não estava entre os três principais.";
    const triple = e.top3_placares.map((x, i) => {
      const isReal = x.mandante === decision.actual.h && x.visitante === decision.actual.a;
      return '<span class="af-e3-score-option' + (isReal ? ' af-e3-hit' : '') + '">' +
        '<small>' + (i + 1) + 'º</small><b>' + x.mandante + ' × ' + x.visitante +
        '</b><span>' + pct(x.probabilidade_pct) + '</span></span>';
    }).join("");
    const fields = WIN.map(k => '<span>' + safe(labels[k]) + ' <strong>' +
      pct(e.probabilidades_ved_pct[k]) + '</strong></span>').join("");
    const sourceUrl = 'https://github.com/LAERCIOREHEM/formuladogol/commit/' + source.commit;
    return '<details class="af-e3-result" data-af-e3="certificado">' +
      '<summary class="af-e3-summary" aria-label="Expandir avaliação histórica do AF-Previsão: placar previsto ' +
        predicted + ', resultado ' + (decision.top1 === null ? 'não definido' : decision.top1 ? 'correto' : 'incorreto') +
        ', placar exato ' + (decision.exact ? 'correto' : 'não confirmado') + '">' +
        '<span class="af-e3-line"><span class="af-e3-prefix">AF-Previsão</span>' +
          '<span class="af-e3-summary-label">Placar previsto</span>' +
          '<strong class="af-e3-score">' + predicted + '</strong>' +
          '<span class="af-e3-pct">' + pct(bestPct) + ' desse placar</span></span>' +
        '<span class="af-e3-statuses">' + chip(decision.top1, top1Label) +
          chip(decision.exact, exactLabel) + '</span>' +
      '</summary>' +
      '<div class="af-e3-details">' +
        '<p><strong>Placar real:</strong> ' + actual +
          ' · <strong>Palpite V/E/D:</strong> ' +
          (e.palpite_resultado_top1 ? safe(labels[e.palpite_resultado_top1]) : 'indefinido por empate de probabilidades') +
          '. Acertar o vencedor/empate não é o mesmo que acertar o placar exato.</p>' +
        '<div class="af-e3-probabilities" aria-label="Probabilidades pré-jogo de resultado">' + fields + '</div>' +
        '<p class="af-e3-heading">Três placares previstos antes do início:</p>' +
        '<div class="af-e3-score-list">' + triple + '</div>' +
        '<p>' + chip(decision.top3, decision.top3 ? "Placar no Top-3" : "Fora do Top-3") +
          ' ' + safe(top3Text) + '</p>' +
        '<p class="af-e3-source">Previsão documental AF-Previsão · ' +
          safe(source.versao_modelo || "") + ' · gerada em ' + safe(source.gerado_em || "") +
          ' · <a href="' + sourceUrl + '" rel="noopener noreferrer" target="_blank" ' +
          'aria-label="Abrir commit de origem da previsão no GitHub">Conferir commit ' +
          safe(source.commit.slice(0, 8)) + '</a>.</p>' +
        '<p class="af-e3-note">O histórico comprova o conteúdo versionado antes do jogo, não sua visualização em tempo real. ' +
          'Probabilidades de placares isolados não equivalem às chances V/E/D.</p>' +
      '</div></details>';
  }

  root.FDGResultadosAF = Object.freeze({
    load: load, render: render, decide: decide,
    validateDocument: validDocument
  });
})(typeof window !== "undefined" ? window : globalThis);
