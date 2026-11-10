/* AF-Previsão E2 · apresentação de placares PRÉ-JOGO.
   A única fonte é o snapshot publicado pelo backend. Sem simulação no cliente.
   Compartilhado entre JOGOS e AO VIVO. */
(function (root) {
  "use strict";

  function validGoal(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 12;
  }

  function validMean(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 12;
  }

  function validPct(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  }

  function read(row) {
    if (!row || row.status !== "pre_jogo") return null;
    const modal = row.placar_modal || {};
    const means = row.gols_esperados || {};
    if (!validGoal(modal.mandante) || !validGoal(modal.visitante) ||
        !validMean(means.mandante) || !validMean(means.visitante)) return null;

    let scores = null;
    const native = row.placares_mais_provaveis;
    if (Array.isArray(native) && native.length >= 3) {
      const subset = native.slice(0, 3);
      const seen = new Set();
      let valid = true;
      for (let i = 0; i < subset.length; i++) {
        const score = subset[i] || {};
        const key = String(score.mandante) + ":" + String(score.visitante);
        if (!validGoal(score.mandante) || !validGoal(score.visitante) ||
            !validPct(score.probabilidade_pct) || seen.has(key) ||
            (i > 0 && subset[i - 1].probabilidade_pct + 0.00011 < score.probabilidade_pct)) {
          valid = false;
          break;
        }
        seen.add(key);
      }
      if (subset[0].mandante !== modal.mandante ||
          subset[0].visitante !== modal.visitante) valid = false;
      if (!valid) return null; // fonte inconsistente: não exibir previsão corrompida
      scores = subset.map(s => ({
        home: s.mandante, away: s.visitante, pct: s.probabilidade_pct
      }));
    } else if (native != null && (!Array.isArray(native) || native.length !== 0)) {
      return null; // Top-3 parcial não pode aparecer como previsão certificada.
    }
    return {
      modal: { home: modal.mandante, away: modal.visitante },
      means: { home: means.mandante, away: means.visitante },
      scores: scores
    };
  }

  function pct(number) {
    return number.toLocaleString("pt-BR", {
      minimumFractionDigits: 1, maximumFractionDigits: 1
    }) + "%";
  }

  function means(number) {
    return number.toLocaleString("pt-BR", {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  function render(row, options) {
    const data = read(row);
    if (!data) return "";
    const context = options && options.context === "aovivo" ? "aovivo" : "jogos";
    const primary = data.scores ? data.scores[0] : null;
    const mainScore = data.modal.home + " × " + data.modal.away;
    const alt = data.scores ? data.scores.slice(1, 3) : [];
    const alternatives = alt.length === 2
      ? '<div class="af-e2-alternatives" aria-label="Dois outros placares possíveis">' +
          alt.map(function (s, index) {
            return '<div class="af-e2-alternative"><span class="af-e2-alt-label">' +
              (index === 0 ? "2º cenário" : "3º cenário") + '</span>' +
              '<strong>' + s.home + ' × ' + s.away + '</strong>' +
              '<span class="af-e2-alt-pct">' + pct(s.pct) + '</span></div>';
          }).join("") + '</div>'
      : '<p class="af-e2-unavailable">Outros placares: aguardando o Top-3 do modelo.</p>';

    return '<section class="af-e2-prediction af-e2-' + context +
      '" aria-label="AF-Previsão: distribuição de placares antes do jogo">' +
      '<div class="af-e2-upper">' +
        '<div class="af-e2-primary">' +
          '<span class="af-e2-eyebrow">⚽ AF-PREVISÃO · PLACAR MAIS PROVÁVEL</span>' +
          '<div class="af-e2-primary-line"><strong class="af-e2-main-score">' + mainScore +
            '</strong><span class="af-e2-main-pct">' +
            (primary ? pct(primary.pct) + ' de chance desse placar' : 'Chance individual indisponível') +
          '</span></div>' +
        '</div>' +
        '<div class="af-e2-means">' +
          '<span>Gols projetados</span>' +
          '<strong>' + means(data.means.home) + ' × ' + means(data.means.away) + '</strong>' +
        '</div>' +
      '</div>' +
      alternatives +
      (alt.length === 2
        ? '<p class="af-e2-note">Os três percentuais são de <strong>placares isolados</strong>, não de vitória, empate ou derrota. Nenhum placar é garantido.</p>'
        : '<p class="af-e2-note">O placar previsto é uma possibilidade, não uma garantia. As chances V/E/D somam diferentes placares.</p>') +
      '</section>';
  }

  root.FDGScoreCards = Object.freeze({ read: read, render: render });
})(typeof window !== "undefined" ? window : globalThis);
