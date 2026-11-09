/* AF-Previsão: leitura pública dos indicadores, sem alterar a simulação.
   Recebe o JSON já validado pelo módulo principal após seu carregamento. */
(function (window, document) {
  "use strict";

  var payload = null;
  var MIN_SAMPLE = 30;
  var LABELS = {
    mandante: "Vitória do mandante",
    empate: "Empate",
    visitante: "Vitória do visitante"
  };
  function el(id) { return document.getElementById(id); }
  function esc(input) {
    return String(input == null ? "" : input).replace(/[&<>'"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c];
    });
  }
  function finite(input) {
    if (input == null || input === "") return null;
    var n = Number(input);
    return Number.isFinite(n) ? n : null;
  }
  function nfmt(value) {
    var n = finite(value);
    return n === null ? "—" : n.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }
  function decimal(value, digits) {
    var n = finite(value);
    return n === null ? "—" : n.toLocaleString("pt-BR", {
      minimumFractionDigits: digits, maximumFractionDigits: digits
    });
  }
  function percent(value, digits) {
    return finite(value) === null ? "—" : decimal(value, digits == null ? 1 : digits) + "%";
  }
  function clamp(v) {
    return Math.max(0, Math.min(100, finite(v) == null ? 0 : Number(v)));
  }
  function metricCard(title, value, detail, className) {
    return '<article class="af-insight-kpi ' + esc(className || "") + '">' +
      '<span>' + esc(title) + '</span><strong>' + esc(value) + '</strong>' +
      '<small>' + esc(detail) + '</small></article>';
  }

  function renderSummary() {
    var games = payload.jogos || {}, top = games.maior_probabilidade || {};
    var tech = games.metricas_tecnicas || {};
    var quality = games.controle_qualidade || {};
    var target = el("accuracy-insights-summary"), reading = el("accuracy-insights-reading");
    var total = finite(games.jogos_avaliados) || 0;
    var accuracy = finite(top.taxa_confirmacao_pct);
    var brier = finite(tech.brier_multiclasse_medio);
    if (target) target.innerHTML =
      metricCard("Partidas auditadas", nfmt(total), "Cada jogo conta uma única vez.", "af-kpi-green") +
      metricCard("Palpite principal confirmado", accuracy === null ? "—" : percent(accuracy, 1),
        nfmt(top.confirmadas) + " de " + nfmt(top.amostra) + " palpites Top-1 avaliáveis.", "af-kpi-blue") +
      metricCard("Brier multiclasse", brier === null ? "—" : decimal(brier, 4),
        "Menor é melhor; considera as três probabilidades.", "af-kpi-amber");
    if (reading) {
      if (!total) {
        reading.textContent = "Aguardando partidas com previsões verificáveis feitas antes do início e resultados finais.";
      } else {
        var description = "Em " + nfmt(total) + " partidas únicas, o resultado mais provável ocorreu em " +
          nfmt(top.confirmadas) + " de " + nfmt(top.amostra) + " palpites avaliáveis (" +
          percent(accuracy, 1) + "). Isso mede acerto Top-1, não comprova sozinho a calibração das chances.";
        if (Number(quality.ids_alternativos_conciliados) > 0) {
          description += " Foram conciliados " + nfmt(quality.ids_alternativos_conciliados) +
            " identificadores alternativos que se referiam a partidas já contabilizadas.";
        }
        reading.textContent = description;
      }
    }
    var warning = el("accuracy-insights-warning");
    var above = ((games.insights || {}).auditoria_rodadas || []);
    if (warning) {
      if (above.length) {
        warning.hidden = false;
        warning.textContent = "Auditoria de calendário: " + above.map(function (r) {
          return "rodada " + r.rodada + " (" + r.jogos + " registros)";
        }).join(", ") + " excede dez partidas. Verifique a atribuição de rodadas no histórico de resultados antes de interpretar a evolução por rodada.";
      } else {
        warning.hidden = true;
        warning.textContent = "";
      }
    }
  }

  function renderConfidence() {
    var target = el("accuracy-confidence-cards");
    if (!target) return;
    var rows = ((payload.jogos || {}).insights || {}).faixas_confianca || [];
    if (!rows.length) {
      target.innerHTML = '<p class="af-insight-empty">Aguardando a geração dos indicadores segmentados.</p>';
      return;
    }
    target.innerHTML = rows.map(function (r) {
      var sample = Number(r.amostra || 0), assessed = Number(r.avaliaveis_top1 || 0);
      var rate = finite(r.taxa_acerto_pct), expected = finite(r.probabilidade_media_favorito_pct);
      var id = String(r.id || "");
      var body = assessed
        ? '<div class="af-confidence-stats"><div><span>Palpites confirmados</span><b>' +
          percent(rate, 1) + '</b><small>' + nfmt(r.acertos) + ' de ' + nfmt(assessed) + '</small></div>' +
          '<div><span>Chance média do favorito</span><b>' + percent(expected, 1) +
          '</b><small>probabilidade publicada</small></div></div>' +
          '<p>Em jogos deste perfil, o modelo indicava em média ' + percent(expected, 1) +
          ' para o resultado favorito, que ocorreu em ' + percent(rate, 1) + ' dos casos.' +
          (assessed < MIN_SAMPLE ? ' Amostra reduzida; comparação apenas descritiva.' :
          ' A diferença exige análise de incerteza antes de concluir sobre a calibração.') + '</p>'
        : '<p>Não há palpites Top-1 únicos avaliáveis nesta faixa.</p>';
      return '<article class="af-confidence-card af-confidence-' + esc(id) + '">' +
        '<div class="af-confidence-head"><h4>' + esc(r.rotulo || id) + '</h4><span>' +
        nfmt(sample) + (sample === 1 ? ' partida' : ' partidas') +
        '</span></div>' + body + '</article>';
    }).join("");
  }

  function bar(label, value, className) {
    var v = clamp(value);
    return '<div class="af-insight-bar-row"><span>' + esc(label) + '</span>' +
      '<div class="af-insight-track"><i class="' + esc(className) +
      '" style="width:' + v.toFixed(2) + '%"></i></div>' +
      '<b>' + percent(value, 1) + '</b></div>';
  }

  function renderCalibration() {
    var target = el("accuracy-calibration");
    var note = el("accuracy-calibration-note");
    var explanation = el("accuracy-calibration-explanation");
    if (!target || !payload) return;
    var games = payload.jogos || {}, insights = games.insights || {};
    var filter = el("accuracy-outcome-filter");
    var choice = filter ? filter.value : "todos";
    var groups = choice === "todos" ? (games.calibracao || []) :
      ((insights.calibracao_por_resultado || {})[choice] || []);
    var bins = groups.filter(function (item) { return Number(item.amostra) > 0; });
    if (!bins.length) {
      target.innerHTML = '<p class="af-insight-empty">Ainda não há amostra para este desfecho. O painel só apresenta previsões pré-jogo auditáveis.</p>';
      if (note) note.textContent = "";
      if (explanation) explanation.textContent = "";
      return;
    }
    target.innerHTML = '<div class="af-insight-calibration-grid">' + bins.map(function (item) {
      var count = Number(item.amostra), mean = Number(item.probabilidade_media_pct);
      var observed = Number(item.frequencia_observada_pct);
      var occurrences = finite(item.ocorrencias);
      if (occurrences === null) occurrences = Math.round(count * observed / 100);
      var difference = Math.abs(mean - observed);
      var from = item.faixa_pct ? Number(item.faixa_pct[0]) : 0;
      var to = item.faixa_pct ? Number(item.faixa_pct[1]) : 100;
      var label = from + "–" + to + "%";
      return '<article class="af-insight-calibration-card">' +
        '<div class="af-insight-calibration-head"><strong>Chance na faixa de ' + label + '</strong>' +
        '<span>' + nfmt(count) + ' previsões</span></div>' +
        bar("Chance estimada (média)", mean, "af-bar-estimated") +
        bar("Frequência observada", observed, "af-bar-observed") +
        '<p>O modelo estimou em média <strong>' + percent(mean, 1) + '</strong>.' +
        ' O resultado ocorreu em <strong>' + nfmt(occurrences) + ' de ' +
        nfmt(count) + '</strong> previsões (' + percent(observed, 1) + ').' +
        ' Diferença: <strong>' + decimal(difference, 1) + ' p.p.</strong>' +
        (count < MIN_SAMPLE ? ' <em>Amostra pequena: não é possível concluir se há desvio sistemático.</em>' : '') +
        '</p></article>';
    }).join("") + '</div>';
    var countTotal = bins.reduce(function (acc, b) { return acc + Number(b.amostra || 0); }, 0);
    if (note) note.textContent = choice === "todos"
      ? "Visão geral: " + nfmt(countTotal) + " previsões de resultados (três possibilidades por partida). As três observações de um mesmo jogo não são independentes."
      : LABELS[choice] + ": " + nfmt(countTotal) + " previsões, uma por partida. Barras na mesma escala de 0 a 100%.";
    if (explanation) {
      var mostPopulated = bins.slice().sort(function (a, b) { return Number(b.amostra) - Number(a.amostra); })[0];
      var n = Number(mostPopulated.amostra);
      var p = Number(mostPopulated.probabilidade_media_pct);
      var o = Number(mostPopulated.frequencia_observada_pct);
      explanation.innerHTML = '<strong>Como ler:</strong> na faixa com mais registros, a estimativa média foi ' +
        percent(p, 1) + ' e a frequência real foi ' + percent(o, 1) + ' (' + nfmt(n) +
        ' previsões). Uma divergência pontual não basta para declarar o modelo certo ou errado; também importam tamanho da amostra e qualidade probabilística.';
    }
  }

  function renderExamples() {
    var target = el("accuracy-example-cards");
    if (!target) return;
    var examples = ((payload.jogos || {}).insights || {}).exemplos || [];
    if (!examples.length) {
      target.innerHTML = '<p class="af-insight-empty">Nenhuma partida reúne ainda os critérios para os exemplos auditados.</p>';
      return;
    }
    target.innerHTML = examples.map(function (r) {
      var p = r.probabilidades_pct || {}, selected = r.palpite;
      var chanceFav = selected ? finite(p[selected]) : null;
      var actual = LABELS[r.resultado] || r.resultado;
      var sentence;
      if (r.tipo === "favorito_confirmado") {
        sentence = "O resultado mais provável tinha " + percent(chanceFav, 1) +
          " de chance e aconteceu. Isso não significa certeza antecipada.";
      } else if (r.tipo === "surpresa") {
        sentence = "O favorito tinha " + percent(chanceFav, 1) +
          " de chance, mas ocorreu outro resultado, com probabilidade estimada de " +
          percent(r.probabilidade_resultado_pct, 1) + ".";
      } else {
        sentence = "Nenhum resultado tinha vantagem clara. O desfecho observado possuía " +
          percent(r.probabilidade_resultado_pct, 1) +
          " de chance; um erro do palpite principal não prova má calibração.";
      }
      var type = r.tipo === "favorito_confirmado" ? "Favorito confirmado" :
        r.tipo === "surpresa" ? "Surpresa estatística" : "Jogo aberto";
      return '<article class="af-insight-example"><div class="af-insight-example-top">' +
        '<span>' + esc(type) + '</span><small>R' + nfmt(r.rodada) + '</small></div>' +
        '<h4>' + esc(r.mandante) + ' × ' + esc(r.visitante) + '</h4>' +
        '<div class="af-insight-outcomes"><span>Mandante <b>' + percent(p.mandante, 1) +
        '</b></span><span>Empate <b>' + percent(p.empate, 1) +
        '</b></span><span>Visitante <b>' + percent(p.visitante, 1) + '</b></span></div>' +
        '<p><strong>O que aconteceu:</strong> ' + esc(actual) + '.</p>' +
        '<p>' + esc(sentence) + '</p>' +
        '<small>Previsão pré-jogo: SHA-256 ' + esc(String(r.hash_previsao || "").slice(0, 12)) + '…</small>' +
        '</article>';
    }).join("");
  }

  function renderBenchmark() {
    var target = el("accuracy-benchmark");
    if (!target) return;
    var games = payload.jogos || {};
    var tech = games.metricas_tecnicas || {};
    var comparison = (games.insights || {}).comparador || {};
    var actualBrier = finite(tech.brier_multiclasse_medio);
    var baseBrier = finite(comparison.brier_multiclasse);
    var actualLoss = finite(tech.log_loss_medio);
    var baseLoss = finite(comparison.log_loss);
    if (actualBrier === null || baseBrier === null) {
      target.innerHTML = '<p>Aguardando valores completos para uma comparação válida.</p>';
      return;
    }
    var result = actualBrier < baseBrier ? "abaixo" : actualBrier > baseBrier ? "acima" : "igual";
    target.innerHTML = '<h4>Comparação com referência neutra</h4>' +
      '<p>Referência com as três probabilidades iguais (33,3% para cada resultado), avaliada sobre as mesmas partidas.</p>' +
      '<div class="af-benchmark-stats"><div><span>Brier do AF</span><b>' +
      decimal(actualBrier, 4) + '</b></div><div><span>Brier neutro</span><b>' +
      decimal(baseBrier, 4) + '</b></div><div><span>Log Loss do AF</span><b>' +
      decimal(actualLoss, 4) + '</b></div><div><span>Log Loss neutro</span><b>' +
      decimal(baseLoss, 4) + '</b></div></div>' +
      '<p>O Brier do AF ficou ' + esc(result) +
      ' da referência neutra. Quanto menor, melhor. Essa comparação simples não permite declarar o AF superior a outros modelos profissionais ou ao mercado.</p>';
  }

  document.addEventListener("af:acuracia-ready", function (event) {
    if (!event.detail || event.detail.status !== "ok") return;
    payload = event.detail;
    renderSummary();
    renderConfidence();
    renderCalibration();
    renderExamples();
    renderBenchmark();
  });
  var select = el("accuracy-outcome-filter");
  if (select) select.addEventListener("change", renderCalibration);
})(window, document);
