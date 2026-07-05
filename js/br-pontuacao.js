/* ==========================================================================
   br-pontuacao.js — Motor de pontuação das Apostas do Brasileirão
   --------------------------------------------------------------------------
   Regra definida para o grupo:
   - 5 pontos: placar exato.
   - 3 pontos: vencedor + saldo de gols.
   - 2 pontos: apenas resultado V/E/D; empate errado também vale 2.
   - 0 pontos: errou o resultado.
   ========================================================================== */
(function (global) {
  "use strict";

  const PONTOS = (global.BR_CFG && global.BR_CFG.pontuacao) || {
    placarExato: 5,
    resultadoSaldo: 3,
    resultado: 2,
    erro: 0
  };

  function toInt(valor) {
    if (valor === null || valor === undefined || valor === "") return null;
    const n = Number.parseInt(String(valor), 10);
    return Number.isFinite(n) ? n : null;
  }

  function sinal(n) {
    if (n > 0) return 1;
    if (n < 0) return -1;
    return 0;
  }

  function valido(placar) {
    const m = toInt(placar && (placar.placar_mandante ?? placar.pm ?? placar.mandante));
    const v = toInt(placar && (placar.placar_visitante ?? placar.pv ?? placar.visitante));
    return m !== null && v !== null && m >= 0 && v >= 0;
  }

  function normalizar(placar) {
    return {
      placar_mandante: toInt(placar && (placar.placar_mandante ?? placar.pm ?? placar.mandante)),
      placar_visitante: toInt(placar && (placar.placar_visitante ?? placar.pv ?? placar.visitante))
    };
  }

  function calcular(palpiteOriginal, resultadoOriginal) {
    const palpite = normalizar(palpiteOriginal || {});
    const resultado = normalizar(resultadoOriginal || {});

    if (!valido(palpite) || !valido(resultado)) {
      return {
        pontos: 0,
        tipo: "pendente",
        rotulo: "pendente",
        emoji: "⏳",
        detalhe: "Aguardando placar final"
      };
    }

    const pm = palpite.placar_mandante;
    const pv = palpite.placar_visitante;
    const rm = resultado.placar_mandante;
    const rv = resultado.placar_visitante;
    const diffP = pm - pv;
    const diffR = rm - rv;
    const resP = sinal(diffP);
    const resR = sinal(diffR);

    if (pm === rm && pv === rv) {
      return { pontos: PONTOS.placarExato, tipo: "exato", rotulo: "cravou", emoji: "🎯", detalhe: "Placar exato" };
    }

    if (resP !== resR) {
      return { pontos: PONTOS.erro, tipo: "erro", rotulo: "errou", emoji: "❌", detalhe: "Resultado diferente" };
    }

    // Empate: qualquer outro empate vale 2, não 3, ainda que o saldo seja 0.
    if (resR === 0) {
      return { pontos: PONTOS.resultado, tipo: "resultado", rotulo: "empate", emoji: "✅", detalhe: "Acertou empate" };
    }

    if (diffP === diffR) {
      return { pontos: PONTOS.resultadoSaldo, tipo: "saldo", rotulo: "saldo", emoji: "📐", detalhe: "Acertou vencedor e saldo" };
    }

    return { pontos: PONTOS.resultado, tipo: "resultado", rotulo: "resultado", emoji: "✅", detalhe: "Acertou vencedor" };
  }

  function agregar(palpites, resultadosPorJogo) {
    const ranking = new Map();
    (palpites || []).forEach(p => {
      const membro = String(p.membro || "").trim();
      if (!membro) return;
      const id = p.event_id || p.jogo_chave;
      const resultado = resultadosPorJogo && resultadosPorJogo[id];
      if (!resultado) return;
      const det = calcular(p, resultado);
      const atual = ranking.get(membro) || {
        membro,
        pontos: 0,
        cravadas: 0,
        saldos: 0,
        resultados: 0,
        erros: 0,
        palpites_validos: 0
      };
      atual.pontos += det.pontos;
      atual.palpites_validos += 1;
      if (det.tipo === "exato") atual.cravadas += 1;
      else if (det.tipo === "saldo") atual.saldos += 1;
      else if (det.tipo === "resultado") atual.resultados += 1;
      else if (det.tipo === "erro") atual.erros += 1;
      ranking.set(membro, atual);
    });
    return Array.from(ranking.values()).sort((a, b) =>
      (b.pontos - a.pontos) ||
      (b.cravadas - a.cravadas) ||
      (b.saldos - a.saldos) ||
      (b.resultados - a.resultados) ||
      String(a.membro).localeCompare(String(b.membro), "pt-BR")
    ).map((r, i) => ({ pos: i + 1, ...r }));
  }

  global.BR_PONTUACAO = { calcular, agregar, valido, normalizar };
})(window);
