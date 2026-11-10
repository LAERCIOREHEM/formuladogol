/* AF E4 | avaliação de placares documentados | não afeta a calibração V/E/D. */
(function (window, document) {
  "use strict";
  var DATA_URL = "dados-br/acuracia-placares-af-2026.json";
  var state = { payload: null, club: "", round: "", calibration: "modal" };
  var OUTCOMES = ["mandante", "empate", "visitante"];
  var MIN_BIN = 20;
  function el(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function numeric(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
  function fmt(n, places) {
    if (numeric(n) === null) return "—";
    return n.toLocaleString("pt-BR", {
      minimumFractionDigits: places || 0, maximumFractionDigits: places == null ? 2 : places
    });
  }
  function percent(n, places) { return numeric(n) === null ? "—" : fmt(n, places == null ? 1 : places) + "%"; }
  function score(x) { return esc((x?.mandante ?? "—") + " × " + (x?.visitante ?? "—")); }
  function validate(payload) {
    if (!payload || payload.schema_version !== 1 || payload.temporada !== 2026 ||
        payload.tipo !== "acuracia_placares_af_previsao" || payload.status !== "ok" ||
        !payload.escopo || !Array.isArray(payload.jogos) || !payload.metricas ||
        !payload.integridade || !/^[a-f0-9]{64}$/.test(payload.integridade.hash_jogos) ||
        !Array.isArray(payload.por_rodada) || !Array.isArray(payload.por_clube) ||
        payload.jogos.length !== payload.escopo.jogos_com_previsao_certificada ||
        payload.metricas.jogos !== payload.jogos.length) {
      throw new Error("Base E4 incompleta ou incompatível com a auditoria");
    }
    if (payload.jogos.some(function (row) {
      return !row.commit_prova || !/^[a-f0-9]{40}$/.test(row.commit_prova) ||
        numeric(row.probabilidade_modal_pct) === null ||
        numeric(row.probabilidade_top3_pct) === null ||
        row.probabilidade_modal_pct < 0 ||
        row.probabilidade_top3_pct > 100.0001 ||
        row.probabilidade_modal_pct > row.probabilidade_top3_pct ||
        typeof row.acerto_exato !== "boolean" ||
        typeof row.acerto_top3 !== "boolean" ||
        (row.acerto_exato && !row.acerto_top3);
    })) throw new Error("Registro histórico sem certificação mínima");
    var derived = summarize(payload.jogos);
    if (derived.jogos !== payload.metricas.jogos ||
        derived.placares_exatos !== payload.metricas.placares_exatos ||
        derived.top3_confirmados !== payload.metricas.top3_confirmados ||
        Math.abs(derived.erro_absoluto_medio_gols_por_equipe -
                 payload.metricas.erro_absoluto_medio_gols_por_equipe) > .00011)
      throw new Error("Totais não conciliados com os registros certificados");
    return payload;
  }
  function round4(x) { return Math.round((x + Number.EPSILON) * 10000) / 10000; }
  function summarize(rows) {
    var n = rows.length;
    var exact = rows.filter(function (g) { return g.acerto_exato; }).length;
    var top3 = rows.filter(function (g) { return g.acerto_top3; }).length;
    var errors = rows.reduce(function (sum, g) {
      return sum + g.erro_absoluto_gols_mandante + g.erro_absoluto_gols_visitante;
    }, 0);
    var expectedModal = rows.reduce(function (sum, g) { return sum + g.probabilidade_modal_pct; }, 0);
    var expectedTop3 = rows.reduce(function (sum, g) { return sum + g.probabilidade_top3_pct; }, 0);
    var eligibleV = rows.filter(function (g) { return g.acerto_ved_top1 !== null; });
    return {
      jogos: n, placares_exatos: exact, top3_confirmados: top3,
      taxa_placar_exato_pct: n ? 100 * exact / n : null,
      taxa_top3_pct: n ? 100 * top3 / n : null,
      erro_absoluto_medio_gols_por_equipe: n ? round4(errors / (2 * n)) : null,
      probabilidade_media_modal_pct: n ? expectedModal / n : null,
      probabilidade_media_top3_pct: n ? expectedTop3 / n : null,
      acertos_ved_top1: eligibleV.filter(function(g) { return g.acerto_ved_top1; }).length,
      previsoes_ved_top1_avaliaveis: eligibleV.length,
    };
  }
  function rows() {
    if (!state.payload) return [];
    return state.payload.jogos.filter(function(g) {
      return (!state.club || g.mandante === state.club || g.visitante === state.club) &&
        (!state.round || String(g.rodada) === state.round);
    });
  }
  function kpi(label, value, caption, color) {
    return '<article class="af-e4-kpi af-e4-kpi-' + esc(color) + '">' +
      '<span>' + esc(label) + '</span><strong>' + esc(value) + '</strong>' +
      '<small>' + esc(caption) + '</small></article>';
  }
  function renderSummary() {
    var list = rows(), totals = summarize(list), target = el("af-e4-summary");
    if (!target) return;
    var n = totals.jogos;
    target.innerHTML = kpi("Placar exato", percent(totals.taxa_placar_exato_pct, 1),
      n ? totals.placares_exatos + " de " + n + " partidas" : "Sem partidas para este filtro", "lime") +
      kpi("Placar entre os 3", percent(totals.taxa_top3_pct, 1),
      n ? totals.top3_confirmados + " de " + n + " partidas" : "Sem partidas para este filtro", "blue") +
      kpi("Erro médio de gols", n ? fmt(totals.erro_absoluto_medio_gols_por_equipe, 2) : "—",
      "Gols de diferença por equipe, em média (MAE).", "amber") +
      kpi("Jogos avaliados", fmt(n, 0), "Somente previsões pré-jogo com prova documental", "neutral");
    var caption = el("af-e4-interpretation");
    if (caption) {
      if (!n) {
        caption.textContent = "Este recorte não possui partidas com previsão histórica comprovada.";
      } else {
        caption.textContent = "Em " + n + " jogos auditáveis, o placar isolado mais provável ocorreu " +
          totals.placares_exatos + " vezes; o placar final apareceu entre os três principais em " +
          totals.top3_confirmados + " jogos. O erro médio entre gols previstos e realizados foi " +
          fmt(totals.erro_absoluto_medio_gols_por_equipe, 2) + " por equipe. " +
          (n < 30 ? "Amostra pequena: taxas não devem ser generalizadas." :
            "As taxas não demonstram, isoladamente, superioridade a outros modelos.");
      }
    }
    var cv = el("af-e4-coverage");
    if (cv) {
      var scope = state.payload.escopo;
      cv.textContent = "Base histórica completa desta aferição: " +
        scope.jogos_com_previsao_certificada + " de " +
        scope.resultados_finais_auditados + " resultados com previsão certificada. " +
        scope.sem_prova_historica + " sem prova não entram no cálculo. " +
        (state.club || state.round ? "O filtro selecionado contém " + n + " partidas elegíveis." : "");
    }
  }
  function statsBins(list, type) {
    var key = type === "modal" ? "probabilidade_modal_pct" : "probabilidade_top3_pct";
    var hit = type === "modal" ? "acerto_exato" : "acerto_top3";
    var step = type === "modal" ? 5 : 10;
    var out = [];
    for (var lo = 0; lo < 100; lo += step) {
      var hi = lo + step;
      var selected = list.filter(function(g) {
        return (g[key] >= lo && g[key] < hi) || (hi === 100 && g[key] === 100);
      });
      if (!selected.length) continue;
      var expected = selected.reduce(function (sum, g) { return sum + g[key]; }, 0) / selected.length;
      var observed = selected.filter(function(g) { return g[hit]; }).length;
      out.push({ faixa_pct: [lo, hi], amostra: selected.length, ocorrencias: observed,
        probabilidade_media_pct: expected,
        frequencia_observada_pct: observed * 100 / selected.length
      });
    }
    return out;
  }
  function bar(label, value, cls) {
    var v = Math.max(0, Math.min(100, value));
    return '<div class="af-e4-bar-row"><span>' + esc(label) + '</span>' +
      '<span class="af-e4-track"><i class="' + esc(cls) + '" style="width:' +
        v.toFixed(3) + '%"></i></span><b>' + percent(value, 1) + '</b></div>';
  }
  function renderCalibration() {
    var list = rows(), isModal = state.calibration === "modal";
    var output = el("af-e4-calibration"), intro = el("af-e4-calibration-reading");
    if (!output || !intro) return;
    if (!list.length) {
      output.innerHTML = '<p class="af-e4-empty">Não há dados de calibração neste recorte.</p>';
      intro.textContent = "";
      return;
    }
    var bins = statsBins(list, state.calibration), top = summarize(list);
    var published = isModal ? top.probabilidade_media_modal_pct : top.probabilidade_media_top3_pct;
    var observed = isModal ? top.taxa_placar_exato_pct : top.taxa_top3_pct;
    intro.innerHTML = '<strong>O modelo esperava:</strong> ' + percent(published, 1) +
      ' de ocorrências em média. <strong>O que aconteceu:</strong> ' + percent(observed, 1) +
      ' em ' + list.length + ' partidas.' +
      (list.length < 30 ? ' Amostra pequena; não é possível declarar desvio sistemático.' :
        ' Compare também as faixas abaixo; desvios isolados não provam falha permanente.');
    output.innerHTML = '<div class="af-e4-bins">' + bins.map(function(bin) {
      var notice = bin.amostra < MIN_BIN ?
        '<em>Amostra de ' + bin.amostra + ' jogos; interpretação apenas descritiva.</em>' :
        '<small>Frequência calculada com ' + bin.amostra + ' jogos.</small>';
      return '<article class="af-e4-bin"><div class="af-e4-bin-head"><strong>' +
        bin.faixa_pct[0] + '–' + bin.faixa_pct[1] + '% previstos</strong>' +
        '<span>' + bin.amostra + ' ' + (bin.amostra === 1 ? 'jogo' : 'jogos') + '</span></div>' +
        bar("Chance média", bin.probabilidade_media_pct, "af-e4-bar-predicted") +
        bar("Ocorreu", bin.frequencia_observada_pct, "af-e4-bar-actual") +
        '<p>Esperados ' + percent(bin.probabilidade_media_pct, 1) +
        '; ocorreram ' + bin.ocorrencias + ' de ' + bin.amostra +
        ' (' + percent(bin.frequencia_observada_pct, 1) + ').</p>' + notice +
      '</article>';
    }).join("") + '</div>';
  }
  function renderRounds() {
    var target = el("af-e4-rounds");
    if (!target || !state.payload) return;
    // Visão da temporada, não alterada pelos controles locais: explica-se no título.
    var series = state.payload.por_rodada;
    target.innerHTML = series.map(function(x) {
      var m = x.metricas;
      return '<div class="af-e4-round" aria-label="Rodada ' + x.rodada + ': ' +
        m.jogos + ' partidas, ' + percent(m.taxa_top3_pct, 1) + ' dentro do Top-3">' +
        '<span>R' + x.rodada + '</span><b>' + percent(m.taxa_top3_pct, 0) + '</b>' +
        '<span class="af-e4-mini-track"><i style="width:' + Math.max(0,Math.min(100,m.taxa_top3_pct)) +
        '%"></i></span><small>' + m.top3_confirmados + '/' + m.jogos + ' jogos</small></div>';
    }).join("");
  }
  function renderIntegrity() {
    var target = el("af-e4-integrity");
    if (!target || !state.payload) return;
    var x = state.payload;
    function link(path) {
      return 'https://github.com/LAERCIOREHEM/formuladogol/blob/main/' + path;
    }
    target.innerHTML = '<p>Dados reproduzidos a partir da <a href="' + link(x.origem.e1) +
      '" target="_blank" rel="noopener noreferrer">auditoria E1</a> e do ' +
      '<a href="' + link(x.origem.e3) +
      '" target="_blank" rel="noopener noreferrer">comparativo E3</a>, com hashes SHA-256 verificados antes do cálculo.</p>' +
      '<div class="af-e4-hashes"><span>SHA-256 da base E1: <code>' + esc(x.origem.e1_sha256.slice(0,20)) +
      '…</code></span><span>SHA-256 da base E3: <code>' + esc(x.origem.e3_sha256.slice(0,20)) +
      '…</code></span><span>SHA-256 da aferição: <code>' +
      esc(x.integridade.hash_metricas.slice(0,20)) + '…</code></span></div>';
  }
  function renderAll() {
    renderSummary(); renderCalibration(); renderRounds(); renderIntegrity();
  }
  function setupFilters() {
    var club = el("af-e4-club"), round = el("af-e4-round"),
      method = el("af-e4-calibration-type");
    if (!club || !round || !method) return;
    club.innerHTML = '<option value="">Todos os clubes</option>' +
      state.payload.por_clube.map(function(c) {
        return '<option value="' + esc(c.clube) + '">' + esc(c.clube) + '</option>';
      }).join("");
    round.innerHTML = '<option value="">Todas as rodadas</option>' +
      state.payload.por_rodada.map(function(r) {
        return '<option value="' + r.rodada + '">Rodada ' + r.rodada + '</option>';
      }).join("");
    club.addEventListener("change", function() { state.club = club.value; renderAll(); });
    round.addEventListener("change", function() { state.round = round.value; renderAll(); });
    method.addEventListener("change", function() {
      state.calibration = method.value === "top3" ? "top3" : "modal";
      renderCalibration();
    });
  }
  function load() {
    var status = el("af-e4-status");
    if (status) status.textContent = "Carregando partidas certificadas…";
    fetch(DATA_URL + "?v=20261110-e4", { cache: "no-store",
      headers: { Accept: "application/json" } })
      .then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(json) {
        state.payload = validate(json);
        setupFilters();
        renderAll();
        if (status) status.textContent = "Aferição histórica certificada · temporada 2026";
      })
      .catch(function(error) {
        if (status) status.textContent = "Aferição indisponível; nenhum indicador calculado.";
        var target = el("af-e4-summary");
        if (target) target.innerHTML =
          '<p class="af-e4-error">Não foi possível verificar a base histórica. Dados não exibidos.</p>';
        console.error("AF E4:", error);
      });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();

  window.FDGAccuracyScoresE4 = Object.freeze({
    validate: validate, summarize: summarize, statsBins: statsBins
  });
})(window, document);
