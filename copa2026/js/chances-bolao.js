/* =========================================================================
   chances-bolao.js — Chance matemática crua do Bolão Copa 2026

   Etapa 1B: motor dinâmico, sem depender de PDF/relatório estático.
   - Recebe as linhas já calculadas pelo ranking online.
   - Usa a chave real atual e simula todos os caminhos restantes.
   - Não usa favoritismo, índice, odds ou força de seleção.
   - Exporta window.COPA_CHANCES para a etapa visual em pontos.js.
   ========================================================================= */
(function (global) {
  "use strict";

  const VERSAO = "20260715-terceiro-lugar-8-cenarios";

  // Chave real das quartas de final informada/confirmada no site.
  // M97/M98 formam o caminho M101; M99/M100 formam o caminho M102.
  const CHAVE_QUARTAS_PADRAO = {
    fase_base: "quartas",
    jogos: [
      { id: "M97", caminho: 1, times: ["FRA", "MAR"] },
      { id: "M98", caminho: 1, times: ["ESP", "BEL"] },
      { id: "M99", caminho: 2, times: ["NOR", "ENG"] },
      { id: "M100", caminho: 2, times: ["ARG", "SUI"] }
    ],
    semifinais: [
      { id: "M101", jogos_origem: ["M97", "M98"] },
      { id: "M102", jogos_origem: ["M99", "M100"] }
    ],
    terceiro_lugar: "M103",
    final: "M104"
  };

  function unico(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
  }

  function setDe(arr) {
    return new Set((arr || []).filter(Boolean));
  }

  function pct(n, total) {
    if (!total) return 0;
    return Number(((Number(n || 0) / total) * 100).toFixed(6));
  }

  function pct2(n, total) {
    if (!total) return 0;
    return Number(((Number(n || 0) / total) * 100).toFixed(2));
  }

  function cloneOficial(o) {
    const out = Object.assign({}, o || {});
    out.decididos = Object.assign({}, (o && o.decididos) || {});
    out._faseCompleta = Object.assign({}, (o && o._faseCompleta) || {});
    out._apurarMata = Object.assign({}, (o && o._apurarMata) || {});
    out.eliminados = Array.isArray(o && o.eliminados) ? o.eliminados.slice() : [];
    out._semiLosers = Array.isArray(o && o._semiLosers) ? o._semiLosers.slice() : [];
    [
      "classificados32", "melhores_terceiros", "avancam_oitavas", "avancam_quartas",
      "semifinalistas", "finalistas"
    ].forEach(k => {
      if (Array.isArray(o && o[k])) out[k] = o[k].slice();
    });
    return out;
  }

  function opcoesVencedor(a, b, proximaLista, oficial, opcoes) {
    opcoes = opcoes || {};

    // A disputa de 3º lugar é formada justamente pelos dois perdedores das
    // semifinais. Portanto, estar em _semiLosers ou em eliminados NÃO fixa o
    // resultado desse jogo. Enquanto 3º/4º não estiverem oficialmente decididos,
    // os dois resultados precisam permanecer na simulação.
    if (opcoes.terceiro) {
      return [
        { vencedor: a, perdedor: b, fixo: false },
        { vencedor: b, perdedor: a, fixo: false }
      ];
    }

    const proxima = setDe(proximaLista || []);
    const eliminados = setDe(oficial && oficial.eliminados);
    const semiLosers = setDe(oficial && oficial._semiLosers);

    if (proxima.has(a)) return [{ vencedor: a, perdedor: b, fixo: true }];
    if (proxima.has(b)) return [{ vencedor: b, perdedor: a, fixo: true }];

    // Para semifinais já encerradas, o perdedor pode aparecer em _semiLosers.
    if (semiLosers.has(a) && !semiLosers.has(b)) return [{ vencedor: b, perdedor: a, fixo: true }];
    if (semiLosers.has(b) && !semiLosers.has(a)) return [{ vencedor: a, perdedor: b, fixo: true }];

    if (eliminados.has(a) && !eliminados.has(b)) return [{ vencedor: b, perdedor: a, fixo: true }];
    if (eliminados.has(b) && !eliminados.has(a)) return [{ vencedor: a, perdedor: b, fixo: true }];

    return [
      { vencedor: a, perdedor: b, fixo: false },
      { vencedor: b, perdedor: a, fixo: false }
    ];
  }

  function produto(listas) {
    return listas.reduce((acc, lista) => {
      const out = [];
      acc.forEach(prefixo => lista.forEach(item => out.push(prefixo.concat([item]))));
      return out;
    }, [[]]);
  }

  function gerarCenarios(oficial, cfg) {
    cfg = cfg || CHAVE_QUARTAS_PADRAO;
    const jogos = cfg.jogos || [];
    if (jogos.length !== 4) {
      throw new Error("Configuração inválida da chave: esperados 4 jogos de quartas.");
    }

    const opcoesQuartas = jogos.map(j => {
      const a = j.times && j.times[0], b = j.times && j.times[1];
      if (!a || !b) throw new Error("Jogo de quartas sem duas seleções: " + (j.id || "?"));
      return opcoesVencedor(a, b, oficial && oficial.semifinalistas, oficial);
    });

    const cenarios = [];
    produto(opcoesQuartas).forEach(qfs => {
      const qfPorId = {};
      jogos.forEach((j, i) => { qfPorId[j.id] = Object.assign({ jogo: j.id }, qfs[i]); });

      const semiA = cfg.semifinais[0];
      const semiB = cfg.semifinais[1];
      const semi1Times = semiA.jogos_origem.map(id => qfPorId[id].vencedor);
      const semi2Times = semiB.jogos_origem.map(id => qfPorId[id].vencedor);

      const opSemi1 = opcoesVencedor(semi1Times[0], semi1Times[1], oficial && oficial.finalistas, oficial);
      const opSemi2 = opcoesVencedor(semi2Times[0], semi2Times[1], oficial && oficial.finalistas, oficial);

      produto([opSemi1, opSemi2]).forEach(sfs => {
        const sf1 = Object.assign({ jogo: semiA.id }, sfs[0]);
        const sf2 = Object.assign({ jogo: semiB.id }, sfs[1]);
        const finalistas = [sf1.vencedor, sf2.vencedor];
        const disputaTerceiro = [sf1.perdedor, sf2.perdedor];

        let opFinal;
        if (oficial && oficial.campeao && oficial.vice) {
          opFinal = [{ vencedor: oficial.campeao, perdedor: oficial.vice, fixo: true }];
        } else {
          opFinal = opcoesVencedor(finalistas[0], finalistas[1], oficial && oficial.campeao ? [oficial.campeao] : [], oficial, { final: true });
        }

        let opTerceiro;
        if (oficial && oficial.terceiro && oficial.quarto) {
          opTerceiro = [{ vencedor: oficial.terceiro, perdedor: oficial.quarto, fixo: true }];
        } else {
          opTerceiro = opcoesVencedor(disputaTerceiro[0], disputaTerceiro[1], oficial && oficial.terceiro ? [oficial.terceiro] : [], oficial, { terceiro: true });
        }

        opFinal.forEach(fin => {
          opTerceiro.forEach(ter => {
            cenarios.push({
              id: "C" + String(cenarios.length + 1).padStart(3, "0"),
              quartas: jogos.map(j => Object.assign({ jogo: j.id, times: j.times.slice() }, qfPorId[j.id])),
              semifinais: [
                Object.assign({ jogo: semiA.id, times: semi1Times.slice() }, sf1),
                Object.assign({ jogo: semiB.id, times: semi2Times.slice() }, sf2)
              ],
              final: { jogo: cfg.final, times: finalistas.slice(), campeao: fin.vencedor, vice: fin.perdedor },
              terceiro_lugar: { jogo: cfg.terceiro_lugar, times: disputaTerceiro.slice(), terceiro: ter.vencedor, quarto: ter.perdedor },
              semifinalistas: unico(qfs.map(x => x.vencedor)),
              finalistas: unico(finalistas),
              campeao: fin.vencedor,
              vice: fin.perdedor,
              terceiro: ter.vencedor,
              quarto: ter.perdedor,
              _semiLosers: unico(disputaTerceiro)
            });
          });
        });
      });
    });
    return cenarios;
  }

  function oficialParaCenario(oficial, cenario) {
    const o = cloneOficial(oficial || {});
    o.semifinalistas = unico(cenario.semifinalistas);
    o.finalistas = unico(cenario.finalistas);
    o.campeao = cenario.campeao;
    o.vice = cenario.vice;
    o.terceiro = cenario.terceiro;
    o.quarto = cenario.quarto;
    o._semiLosers = unico(cenario._semiLosers);

    o._apurarMata = Object.assign({}, o._apurarMata, {
      oitavas: true,
      quartas: true,
      semis: true,
      final: true
    });
    o._faseCompleta = Object.assign({}, o._faseCompleta, {
      r32: true,
      oitavas: true,
      quartas: true,
      semis: true,
      final: true
    });
    o.decididos = Object.assign({}, o.decididos, {
      campeao: true,
      vice: true,
      terceiro: true,
      quarto: true
    });

    // Ao final do torneio, todos que não foram campeões já não podem somar campeão.
    // O motor de pontos usa essa lista para perdas; para pontuação final, o que manda
    // são as listas/posições acima, mas manter eliminados completo evita ambiguidades.
    const todos = new Set();
    [
      o.classificados32, o.avancam_oitavas, o.avancam_quartas,
      cenario.semifinalistas, cenario.finalistas, [cenario.vice, cenario.terceiro, cenario.quarto]
    ].forEach(arr => (arr || []).forEach(id => { if (id) todos.add(id); }));
    const eliminados = setDe(o.eliminados || []);
    todos.forEach(id => { if (id !== cenario.campeao) eliminados.add(id); });
    o.eliminados = Array.from(eliminados);

    return o;
  }

  function pontuarLinha(linha, oficialCenario, opts) {
    opts = opts || {};
    if (typeof opts.pontuarCenario === "function") {
      const v = opts.pontuarCenario(linha, oficialCenario);
      return Number.isFinite(Number(v)) ? Number(v) : 0;
    }
    const motor = opts.motorPontuacao || global.COPA_PONTUACAO;
    if (motor && typeof motor.calcular === "function") {
      const r = motor.calcular(linha.d || linha.palpite || {}, oficialCenario);
      return Number(r && r.atuais) || 0;
    }
    return Number(linha.r && linha.r.atuais) || Number(linha.pontos_atuais) || 0;
  }

  function compararRanking(a, b) {
    return (b.pontos_final - a.pontos_final)
      || ((b.cravados || 0) - (a.cravados || 0))
      || ((b.teto || 0) - (a.teto || 0))
      || String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
  }

  function resumoCenario(c) {
    return {
      id: c.id,
      semifinalistas: c.semifinalistas.slice(),
      finalistas: c.finalistas.slice(),
      campeao: c.campeao,
      vice: c.vice,
      terceiro: c.terceiro,
      quarto: c.quarto,
      quartas: c.quartas.map(x => ({ jogo: x.jogo, vencedor: x.vencedor, perdedor: x.perdedor })),
      semifinais: c.semifinais.map(x => ({ jogo: x.jogo, times: x.times.slice(), vencedor: x.vencedor, perdedor: x.perdedor })),
      final: Object.assign({}, c.final),
      terceiro_lugar: Object.assign({}, c.terceiro_lugar)
    };
  }

  function calcular(linhas, oficial, opts) {
    opts = opts || {};
    const entrada = Array.isArray(linhas) ? linhas.filter(Boolean) : [];
    const cfg = opts.chave || CHAVE_QUARTAS_PADRAO;
    const cenarios = gerarCenarios(oficial || {}, cfg);
    const total = cenarios.length;

    const stats = {};
    entrada.forEach(l => {
      const nome = String(l.nome || "").trim();
      if (!nome) return;
      stats[nome] = {
        nome,
        pontos_atuais: Number(l.r && l.r.atuais) || Number(l.pontos_atuais) || 0,
        cravados: Number(l.cr || l.cravados || 0) || 0,
        teto: Number(l.r && l.r.teto) || Number(l.teto || 0) || 0,
        cenarios_titulo: 0,
        cenarios_segundo: 0,
        cenarios_terceiro: 0,
        cenarios_podio: 0,
        melhor_pontuacao: -Infinity,
        pior_pontuacao: Infinity,
        melhor_cenario: null,
        pior_cenario: null,
        melhor_colocacao: Infinity,
        pior_colocacao: -Infinity,
        soma_pontuacao_final: 0,
        resultados_cenarios: []
      };
    });

    const rankingsPorCenario = [];
    cenarios.forEach(cenario => {
      const oSim = oficialParaCenario(oficial || {}, cenario);
      const ranking = entrada.map(l => {
        const nome = String(l.nome || "").trim();
        const st = stats[nome];
        const pontosFinal = pontuarLinha(l, oSim, opts);
        const item = {
          nome,
          pontos_final: pontosFinal,
          cravados: Number(l.cr || l.cravados || 0) || 0,
          teto: Number(l.r && l.r.teto) || Number(l.teto || 0) || 0
        };
        if (st) st.soma_pontuacao_final += pontosFinal;
        return item;
      }).sort(compararRanking);

      ranking.forEach((item, idx) => {
        const st = stats[item.nome];
        if (!st) return;
        const colocacao = idx + 1;
        const resumo = resumoCenario(cenario);
        if (idx === 0) st.cenarios_titulo += 1;
        if (idx === 1) st.cenarios_segundo += 1;
        if (idx === 2) st.cenarios_terceiro += 1;
        if (idx <= 2) st.cenarios_podio += 1;

        st.resultados_cenarios.push({
          id: cenario.id,
          pontos_final: item.pontos_final,
          colocacao,
          campeao_bolao: idx === 0,
          podio_bolao: idx <= 2,
          cenario: resumo
        });

        // Melhor/pior caminho: pontuação é o critério principal; em empate,
        // usa a melhor/pior colocação final no bolão para escolher a descrição.
        if (item.pontos_final > st.melhor_pontuacao
            || (item.pontos_final === st.melhor_pontuacao && colocacao < st.melhor_colocacao)) {
          st.melhor_pontuacao = item.pontos_final;
          st.melhor_colocacao = colocacao;
          st.melhor_cenario = resumo;
        }
        if (item.pontos_final < st.pior_pontuacao
            || (item.pontos_final === st.pior_pontuacao && colocacao > st.pior_colocacao)) {
          st.pior_pontuacao = item.pontos_final;
          st.pior_colocacao = colocacao;
          st.pior_cenario = resumo;
        }
      });

      if (opts.incluirRankingsPorCenario) {
        rankingsPorCenario.push({
          cenario: cenario.id,
          podio_bolao: ranking.slice(0, 3).map((x, i) => ({ pos: i + 1, nome: x.nome, pontos_final: x.pontos_final, cravados: x.cravados }))
        });
      }
    });

    const participantes = Object.values(stats).map(st => {
      const melhor = Number.isFinite(st.melhor_pontuacao) ? st.melhor_pontuacao : st.pontos_atuais;
      const pior = Number.isFinite(st.pior_pontuacao) ? st.pior_pontuacao : st.pontos_atuais;
      return {
        nome: st.nome,
        pontos_atuais: st.pontos_atuais,
        cravados: st.cravados,
        teto: st.teto,
        cenarios_titulo: st.cenarios_titulo,
        cenarios_segundo: st.cenarios_segundo,
        cenarios_terceiro: st.cenarios_terceiro,
        cenarios_podio: st.cenarios_podio,
        chance_titulo_pct: pct2(st.cenarios_titulo, total),
        chance_titulo_pct_exata: pct(st.cenarios_titulo, total),
        chance_segundo_pct: pct2(st.cenarios_segundo, total),
        chance_segundo_pct_exata: pct(st.cenarios_segundo, total),
        chance_terceiro_pct: pct2(st.cenarios_terceiro, total),
        chance_terceiro_pct_exata: pct(st.cenarios_terceiro, total),
        chance_podio_pct: pct2(st.cenarios_podio, total),
        chance_podio_pct_exata: pct(st.cenarios_podio, total),
        melhor_pontuacao: melhor,
        pior_pontuacao: pior,
        pontos_ainda_disputaveis_no_melhor_cenario: Math.max(0, melhor - st.pontos_atuais),
        pontuacao_media_simulada: total ? Number((st.soma_pontuacao_final / total).toFixed(2)) : st.pontos_atuais,
        situacao_titulo: st.cenarios_titulo > 0 ? "vivo" : "sem_chance_matematica_de_titulo",
        situacao_podio: st.cenarios_podio > 0 ? "vivo" : "sem_chance_matematica_de_podio",
        melhor_cenario: st.melhor_cenario,
        pior_cenario: st.pior_cenario,
        melhor_colocacao: Number.isFinite(st.melhor_colocacao) ? st.melhor_colocacao : null,
        pior_colocacao: Number.isFinite(st.pior_colocacao) ? st.pior_colocacao : null,
        resultados_cenarios: st.resultados_cenarios.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
      };
    }).sort((a, b) =>
      b.chance_titulo_pct_exata - a.chance_titulo_pct_exata
      || b.cenarios_titulo - a.cenarios_titulo
      || b.chance_podio_pct_exata - a.chance_podio_pct_exata
      || b.pontos_atuais - a.pontos_atuais
      || b.cravados - a.cravados
      || a.nome.localeCompare(b.nome, "pt-BR")
    );

    participantes.forEach((p, i) => { p.pos_chance_titulo = i + 1; });

    const soma = k => participantes.reduce((acc, p) => acc + Number(p[k] || 0), 0);
    return {
      versao: VERSAO,
      rotulo_card: "Chance de título",
      metodologia: {
        nome: "Chance matemática de título",
        descricao: "Simulação crua, sem favoritismo, de todos os caminhos ainda possíveis da chave. Cada cenário restante tem o mesmo peso.",
        base: "ranking online atual + palpites lacrados já carregados no site + chave real da Copa",
        desempate: ["maior pontuação final", "mais placares cravados na fase de grupos", "maior teto teórico", "nome, apenas como último critério técnico"],
        pontos_considerados: {
          semifinalista: 9,
          finalista: 12,
          campeao: 40,
          vice: 25,
          terceiro: 15,
          quarto: 10
        }
      },
      chave: cfg,
      total_cenarios: total,
      cada_cenario_pct: total ? 100 / total : 0,
      participantes,
      por_nome: participantes.reduce((acc, p) => { acc[p.nome] = p; return acc; }, {}),
      validacao: {
        participantes: participantes.length,
        cenarios_restantes: total,
        soma_chance_titulo_pct_exata: soma("chance_titulo_pct_exata"),
        soma_chance_segundo_pct_exata: soma("chance_segundo_pct_exata"),
        soma_chance_terceiro_pct_exata: soma("chance_terceiro_pct_exata"),
        soma_chance_podio_pct_exata: soma("chance_podio_pct_exata"),
        ok: total >= 1
          && Math.abs(soma("chance_titulo_pct_exata") - 100) < 0.00001
          && Math.abs(soma("chance_segundo_pct_exata") - 100) < 0.00001
          && Math.abs(soma("chance_terceiro_pct_exata") - 100) < 0.00001
          && Math.abs(soma("chance_podio_pct_exata") - 300) < 0.00001
      },
      rankings_por_cenario: opts.incluirRankingsPorCenario ? rankingsPorCenario : undefined
    };
  }

  global.COPA_CHANCES = {
    VERSAO,
    CHAVE_QUARTAS_PADRAO,
    gerarCenarios,
    oficialParaCenario,
    calcular
  };
})(typeof window !== "undefined" ? window : globalThis);
