/* =========================================================================
   engine.js — Motor de grupos e chaveamento da Copa 2026
   Responsável por: gerar jogos dos grupos, classificar cada grupo pelos
   critérios FIFA, escolher os 8 melhores terceiros, montar a Round of 32
   (consultando o Anexo C) e propagar os vencedores até a final.
   Não tem dependências externas. Tudo determinístico (sem sorteio).
   ========================================================================= */
(function (global) {
  "use strict";

  // ---- 1. Geração dos 6 jogos de cada grupo (round-robin) -----------------
  // A ordem/datas não afetam a classificação; só precisamos dos 6 confrontos.
  function gerarJogosGrupos(selecoes) {
    const porGrupo = {};
    selecoes.forEach(s => { (porGrupo[s.grupo] = porGrupo[s.grupo] || []).push(s.id); });
    const jogos = [];
    Object.keys(porGrupo).sort().forEach(g => {
      const t = porGrupo[g]; // [t1,t2,t3,t4]
      const pares = [[0,1],[2,3],[0,2],[1,3],[0,3],[1,2]];
      pares.forEach((p, i) => {
        jogos.push({ jogo_id: `G_${g}_${i + 1}`, grupo: g, a: t[p[0]], b: t[p[1]] });
      });
    });
    return jogos;
  }

  // ---- 2. Classificação de um grupo (critérios FIFA) ----------------------
  // jogosGrupo: [{a,b,ga,gb}], times: [id...], seed: {id:seed}
  // Critérios: pontos > saldo > gols pró > confronto direto > seed (determinístico)
  function classificarGrupo(jogosGrupo, times, seed, fairplay) {
    const FP = fairplay || {};
    const T = {};
    times.forEach(id => { T[id] = { id, pts: 0, gf: 0, gc: 0, sg: 0 }; });
    jogosGrupo.forEach(j => {
      if (j.ga == null || j.gb == null) return;
      const A = T[j.a], B = T[j.b];
      A.gf += j.ga; A.gc += j.gb; B.gf += j.gb; B.gc += j.ga;
      if (j.ga > j.gb) A.pts += 3;
      else if (j.ga < j.gb) B.pts += 3;
      else { A.pts += 1; B.pts += 1; }
    });
    times.forEach(id => { T[id].sg = T[id].gf - T[id].gc; });

    // Ordenação FIFA 2026 (Art. 13): pontos primeiro; entre empatados em PONTOS,
    // aplica HEAD-TO-HEAD (pts, saldo, gols entre os empatados) ANTES do saldo geral.
    // Depois: saldo geral, gols geral, FAIR PLAY (cartões), ranking FIFA (seed).
    let ordenados = times.map(id => T[id]).sort((x, y) => y.pts - x.pts);
    ordenados = resolverEmpatesPorPontos(ordenados, jogosGrupo, seed, FP);
    return ordenados; // [1º,2º,3º,4º] objetos com stats
  }

  // resolve blocos de times com MESMOS PONTOS, seguindo a ordem oficial da FIFA
  function resolverEmpatesPorPontos(lista, jogosGrupo, seed, fairplay) {
    const FP = fairplay || {};
    const res = [];
    let i = 0;
    while (i < lista.length) {
      let j = i + 1;
      while (j < lista.length && lista[j].pts === lista[i].pts) j++;
      let bloco = lista.slice(i, j);
      if (bloco.length > 1) {
        bloco = ordenarBlocoEmpatado(bloco, jogosGrupo, seed, FP);
      }
      bloco.forEach(t => res.push(t));
      i = j;
    }
    return res;
  }

  // ordena um bloco de times empatados em pontos pela escada oficial da FIFA
  function ordenarBlocoEmpatado(bloco, jogosGrupo, seed, fairplay) {
    const FP = fairplay || {};
    // Passo 1: head-to-head (só jogos ENTRE os empatados): pts, saldo, gols
    const ids = bloco.map(t => t.id);
    const mini = miniTabela(ids, jogosGrupo);
    let ordenado = bloco.slice().sort((x, y) =>
      mini[y.id].pts - mini[x.id].pts ||
      mini[y.id].sg - mini[x.id].sg ||
      mini[y.id].gf - mini[x.id].gf
    );
    // sub-blocos ainda empatados no head-to-head
    const grupos = [];
    let k = 0;
    while (k < ordenado.length) {
      let m = k + 1;
      while (m < ordenado.length &&
             mini[ordenado[m].id].pts === mini[ordenado[k].id].pts &&
             mini[ordenado[m].id].sg === mini[ordenado[k].id].sg &&
             mini[ordenado[m].id].gf === mini[ordenado[k].id].gf) m++;
      grupos.push(ordenado.slice(k, m));
      k = m;
    }
    // para cada sub-bloco ainda empatado: saldo geral, gols geral, FAIR PLAY, ranking FIFA
    const final = [];
    grupos.forEach(sub => {
      if (sub.length > 1) {
        sub.sort((x, y) =>
          y.sg - x.sg ||                                   // saldo geral
          y.gf - x.gf ||                                   // gols feitos geral
          (FP[y.id] || 0) - (FP[x.id] || 0) ||             // fair play: MAIOR (menos negativo) na frente
          (seed[x.id] || 999) - (seed[y.id] || 999));      // ranking FIFA (proxy seed)
      }
      sub.forEach(t => final.push(t));
    });
    return final;
  }

  function quebrarEmpates(lista, jogosGrupo, seed) {
    // Agrupa por (pts,sg,gf) idênticos e reordena cada bloco empatado
    const res = [];
    let i = 0;
    while (i < lista.length) {
      let j = i + 1;
      while (j < lista.length &&
             lista[j].pts === lista[i].pts &&
             lista[j].sg === lista[i].sg &&
             lista[j].gf === lista[i].gf) j++;
      const bloco = lista.slice(i, j);
      if (bloco.length > 1) {
        const ids = bloco.map(t => t.id);
        const mini = miniTabela(ids, jogosGrupo);
        bloco.sort((x, y) =>
          mini[y.id].pts - mini[x.id].pts ||
          mini[y.id].sg - mini[x.id].sg ||
          mini[y.id].gf - mini[x.id].gf ||
          (seed[x.id] || 999) - (seed[y.id] || 999)); // seed: menor = melhor
      }
      bloco.forEach(t => res.push(t));
      i = j;
    }
    return res;
  }

  function miniTabela(ids, jogosGrupo) {
    const M = {};
    ids.forEach(id => { M[id] = { pts: 0, gf: 0, gc: 0, sg: 0 }; });
    jogosGrupo.forEach(j => {
      if (j.ga == null || j.gb == null) return;
      if (ids.indexOf(j.a) < 0 || ids.indexOf(j.b) < 0) return; // só jogos entre empatados
      M[j.a].gf += j.ga; M[j.a].gc += j.gb;
      M[j.b].gf += j.gb; M[j.b].gc += j.ga;
      if (j.ga > j.gb) M[j.a].pts += 3;
      else if (j.ga < j.gb) M[j.b].pts += 3;
      else { M[j.a].pts += 1; M[j.b].pts += 1; }
    });
    ids.forEach(id => { M[id].sg = M[id].gf - M[id].gc; });
    return M;
  }

  // ---- 3. Ranking dos 8 melhores terceiros --------------------------------
  // classificacao: {A:[1º,2º,3º,4º], ...} (objetos com stats e .grupo)
  function melhoresTerceiros(classificacao, seed, fairplay) {
    const FP = fairplay || {};
    const terceiros = Object.keys(classificacao).map(g => {
      const t = classificacao[g][2];
      return Object.assign({}, t, { grupo: g });
    });
    // critério oficial p/ rankear os 3ºs: pts, saldo, gols, FAIR PLAY, ranking FIFA
    // (sem head-to-head: 3ºs de grupos diferentes nunca se enfrentaram)
    terceiros.sort((x, y) =>
      y.pts - x.pts || y.sg - x.sg || y.gf - x.gf ||
      (FP[y.id] || 0) - (FP[x.id] || 0) ||
      (seed[x.id] || 999) - (seed[y.id] || 999));
    return terceiros.slice(0, 8); // 8 objetos com .grupo e .id
  }

  // ---- 4. Montagem da Round of 32 (Anexo C) -------------------------------
  function montarR32(classificacao, best8, estrutura, terceirosMap) {
    const firsts = {}, seconds = {}, thirdByGroup = {};
    Object.keys(classificacao).forEach(g => {
      firsts[g] = classificacao[g][0].id;
      seconds[g] = classificacao[g][1].id;
      thirdByGroup[g] = classificacao[g][2].id;
    });

    const gruposDos8 = best8.map(t => t.grupo).sort();
    const chave = gruposDos8.join("");
    const mapa = (terceirosMap.mapa || {})[chave];

    const r32 = estrutura.r32.map(m => {
      if (m.tipo === "fixo") {
        return { id: m.id, a: resolverSlot(m.a, firsts, seconds), b: resolverSlot(m.b, firsts, seconds) };
      }
      // tipo terceiro
      const hostGrupo = m.host.slice(1);          // "1A" -> "A"
      const a = firsts[hostGrupo];
      let b = null, faltaMapa = false;
      if (mapa && mapa[m.host]) {
        b = thirdByGroup[mapa[m.host]];
      } else {
        faltaMapa = true;                          // combinação não está no Anexo C carregado
      }
      return { id: m.id, a, b, terceiro: true, faltaMapa, chave };
    });

    return { r32, faltaMapa: r32.some(x => x.faltaMapa), chave };
  }

  function resolverSlot(token, firsts, seconds) {
    const pos = token[0], g = token.slice(1);
    return pos === "1" ? firsts[g] : seconds[g];
  }

  // ---- 5. Propagação dos vencedores até a final ---------------------------
  // placares: { M73:{a:2,b:1,vencedor:"BRA",perdedor:"JPN"}, ... }
  // a/b = gols no tempo/prorrogação; vencedor/perdedor resolve pênaltis quando o
  // placar termina empatado. Compatível com o formato antigo {a,b}.
  function resultadoMata(mId, ladoA, ladoB, placares, vencedor, perdedor) {
    const p = placares[mId];
    if (!p || !ladoA || !ladoB) return;

    let win = p.vencedor || p.winner || null;
    let lose = p.perdedor || p.loser || null;

    if (win && win !== ladoA && win !== ladoB) win = null;
    if (lose && lose !== ladoA && lose !== ladoB) lose = null;

    if (!win && p.a != null && p.b != null) {
      if (p.a > p.b) win = ladoA;
      else if (p.b > p.a) win = ladoB;
    }

    if (!win) return; // empate sem pênaltis/sem vencedor explícito: não propaga

    if (!lose) lose = win === ladoA ? ladoB : ladoA;
    vencedor[mId] = win;
    perdedor[mId] = lose;
  }

  function propagar(r32, arvore, placares) {
    const vencedor = {}, perdedor = {}, timeDe = {};
    placares = placares || {};
    // R32
    r32.forEach(m => {
      timeDe[m.id] = { a: m.a, b: m.b };
      resultadoMata(m.id, m.a, m.b, placares, vencedor, perdedor);
    });
    // Árvore
    arvore.forEach(m => {
      const a = referencia(m.a, vencedor, perdedor);
      const b = referencia(m.b, vencedor, perdedor);
      timeDe[m.id] = { a, b };
      resultadoMata(m.id, a, b, placares, vencedor, perdedor);
    });

    // Conjuntos por fase (presença = avançou para aquela fase)
    const ids32 = r32.map(m => [m.a, m.b]).flat().filter(Boolean);
    const oitavas = arvore.filter(m => m.fase === "oitavas")
      .map(m => [timeDe[m.id].a, timeDe[m.id].b]).flat().filter(Boolean);
    const quartas = arvore.filter(m => m.fase === "quartas")
      .map(m => [timeDe[m.id].a, timeDe[m.id].b]).flat().filter(Boolean);
    const semis = arvore.filter(m => m.fase === "semifinais")
      .map(m => [timeDe[m.id].a, timeDe[m.id].b]).flat().filter(Boolean);
    const finalM = arvore.find(m => m.fase === "final");
    const finalistas = finalM ? [timeDe[finalM.id].a, timeDe[finalM.id].b].filter(Boolean) : [];
    const terceiroM = arvore.find(m => m.fase === "terceiro");

    return {
      timeDe, vencedor, perdedor,
      classificados32: [...new Set(ids32)],
      avancam_oitavas: [...new Set(oitavas)],
      avancam_quartas: [...new Set(quartas)],
      semifinalistas: [...new Set(semis)],
      finalistas: [...new Set(finalistas)],
      campeao: finalM ? vencedor[finalM.id] || null : null,
      vice: finalM ? perdedor[finalM.id] || null : null,
      terceiro: terceiroM ? vencedor[terceiroM.id] || null : null,
      quarto: terceiroM ? perdedor[terceiroM.id] || null : null
    };
  }

  function referencia(token, vencedor, perdedor) {
    if (!token) return null;
    const tipo = token[0];        // 'W' vencedor, 'L' perdedor
    const mid = token.slice(1);   // 'M73'
    return tipo === "W" ? (vencedor[mid] || null) : (perdedor[mid] || null);
  }

  // ---- 6. Função orquestradora -------------------------------------------
  // Recebe os placares dos grupos e do mata-mata e devolve tudo "derivado".
  function derivar(selecoes, placaresGrupos, placaresMata, estrutura, terceirosMap, fairplay) {
    const seed = {}; selecoes.forEach(s => { seed[s.id] = s.seed; });
    const FP = fairplay || {}; // {sigla: pontos de conduta, negativo}. Opcional.
    const jogos = gerarJogosGrupos(selecoes);

    // injeta os gols informados nos jogos
    const placMap = {}; placaresGrupos.forEach(p => { placMap[p.jogo_id] = p; });
    jogos.forEach(j => {
      const p = placMap[j.jogo_id];
      j.ga = p ? p.ga : null; j.gb = p ? p.gb : null;
    });

    const porGrupo = {};
    jogos.forEach(j => { (porGrupo[j.grupo] = porGrupo[j.grupo] || []).push(j); });

    const classificacao = {};
    Object.keys(porGrupo).sort().forEach(g => {
      const times = [...new Set(porGrupo[g].map(j => [j.a, j.b]).flat())];
      classificacao[g] = classificarGrupo(porGrupo[g], times, seed, FP)
        .map(t => Object.assign(t, { grupo: g }));
    });

    const best8 = melhoresTerceiros(classificacao, seed, FP);
    const { r32, faltaMapa, chave } = montarR32(classificacao, best8, estrutura, terceirosMap);
    const fim = propagar(r32, estrutura.arvore, placaresMata || {});

    return Object.assign({ classificacao, melhores_terceiros: best8.map(t => t.id),
                           r32, faltaMapa, chave }, fim);
  }

  global.COPA_ENGINE = {
    gerarJogosGrupos, classificarGrupo, melhoresTerceiros,
    montarR32, propagar, derivar
  };
})(typeof window !== "undefined" ? window : globalThis);
