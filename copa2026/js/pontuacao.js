/* =========================================================================
   pontuacao.js — Motor de pontuação do Bolão Copa 2026
   Implementa o esquema definido no CONTEXTO.md.
   Compara o palpite "derivado" (saída do engine.js) com o resultado oficial.
   Calcula: pontos ATUAIS (já garantidos), TETO (máximo se tudo der certo),
   PERDIDOS (já impossíveis) e POSSÍVEIS (ainda dá pra somar).
   ========================================================================= */
(function (global) {
  "use strict";

  const PESOS = {
    classificado32: 3,   // por seleção entre as 32
    campGrupo: 2,        // acertar o 1º do grupo (posição exata)
    viceGrupo: 1,        // acertar o 2º do grupo
    terGrupo: 1,         // acertar o 3º do grupo
    ultGrupo: 1,         // acertar o 4º (último) do grupo
    melhorTerceiro: 3,   // por cada um dos 8 melhores terceiros
    oitavas: 4,          // por seleção nas oitavas (16)
    quartas: 6,          // por seleção nas quartas (8)
    semi: 9,             // por semifinalista (4)
    final: 12,           // por finalista (2)
    campeao: 40,
    vice: 25,
    terceiro: 15,
    quarto: 10
  };

  function inter(a, b) {
    const sb = new Set(b);
    return a.filter(x => sb.has(x));
  }

  // Pontos ATUAIS: compara palpite (p) com oficial parcial (o).
  // o pode estar incompleto: conjuntos só com o que já aconteceu,
  // o.classificacao só com grupos encerrados, o.<posicao> só se decidida.
  function calcularAtuais(p, o) {
    const d = {};
    d.classificados = inter(p.classificados32, o.classificados32 || []).length * PESOS.classificado32;
    d.terceiros     = inter(p.melhores_terceiros, o.melhores_terceiros || []).length * PESOS.melhorTerceiro;

    // posições exatas dentro de cada grupo encerrado oficialmente
    d.posGrupos = 0;
    const oc = o.classificacao || {};
    Object.keys(oc).forEach(g => {
      const pg = (p.classificacao || {})[g];
      if (!pg) return;
      const pesos = [PESOS.campGrupo, PESOS.viceGrupo, PESOS.terGrupo, PESOS.ultGrupo];
      for (let i = 0; i < 4; i++) {
        if (pg[i] && oc[g][i] && pg[i].id === oc[g][i].id) d.posGrupos += pesos[i];
      }
    });

    d.oitavas = inter(p.avancam_oitavas, o.avancam_oitavas || []).length * PESOS.oitavas;
    d.quartas = inter(p.avancam_quartas, o.avancam_quartas || []).length * PESOS.quartas;
    d.semis   = inter(p.semifinalistas, o.semifinalistas || []).length * PESOS.semi;
    d.final   = inter(p.finalistas, o.finalistas || []).length * PESOS.final;

    d.campeao  = (o.campeao  && p.campeao  === o.campeao)  ? PESOS.campeao  : 0;
    d.vice     = (o.vice     && p.vice     === o.vice)     ? PESOS.vice     : 0;
    d.terceiro = (o.terceiro && p.terceiro === o.terceiro) ? PESOS.terceiro : 0;
    d.quarto   = (o.quarto   && p.quarto   === o.quarto)   ? PESOS.quarto   : 0;

    d.total = Object.values(d).reduce((a, b) => a + b, 0);
    return d;
  }

  // TETO: máximo que ESTE palpite pode atingir (como se fosse 100% correto).
  function teto(p) {
    const oficialFicticio = {
      classificados32: p.classificados32,
      melhores_terceiros: p.melhores_terceiros,
      classificacao: p.classificacao,
      avancam_oitavas: p.avancam_oitavas,
      avancam_quartas: p.avancam_quartas,
      semifinalistas: p.semifinalistas,
      finalistas: p.finalistas,
      campeao: p.campeao, vice: p.vice, terceiro: p.terceiro, quarto: p.quarto
    };
    return calcularAtuais(p, oficialFicticio).total;
  }

  // Visão completa. o pode incluir o.eliminados (array de ids já fora) e
  // o.decididos = {campeao:bool, vice:bool, terceiro:bool, quarto:bool}.
  function calcular(p, o) {
    o = o || {};
    const atuais = calcularAtuais(p, o);
    const tetoMax = teto(p);

    // PERDIDOS (aproximação honesta a partir dos times já eliminados)
    let perdidos = 0;
    const elim = new Set(o.eliminados || []);
    const fora = (set) => p[set].filter(id => elim.has(id));
    // seleção prevista numa fase mas já eliminada e que NÃO está no oficial daquela fase
    const naoConfirmados = (pset, oset, peso) => {
      const conf = new Set(oset || []);
      return p[pset].filter(id => elim.has(id) && !conf.has(id)).length * peso;
    };
    perdidos += naoConfirmados("classificados32", o.classificados32, PESOS.classificado32);
    perdidos += naoConfirmados("melhores_terceiros", o.melhores_terceiros, PESOS.melhorTerceiro);
    perdidos += naoConfirmados("avancam_oitavas", o.avancam_oitavas, PESOS.oitavas);
    perdidos += naoConfirmados("avancam_quartas", o.avancam_quartas, PESOS.quartas);
    perdidos += naoConfirmados("semifinalistas", o.semifinalistas, PESOS.semi);
    perdidos += naoConfirmados("finalistas", o.finalistas, PESOS.final);
    const dec = o.decididos || {};
    if (dec.campeao  && atuais.campeao  === 0) perdidos += PESOS.campeao;
    if (dec.vice     && atuais.vice     === 0) perdidos += PESOS.vice;
    if (dec.terceiro && atuais.terceiro === 0) perdidos += PESOS.terceiro;
    if (dec.quarto   && atuais.quarto   === 0) perdidos += PESOS.quarto;

    const possiveis = Math.max(0, tetoMax - atuais.total - perdidos);

    return {
      atuais: atuais.total,
      perdidos,
      possiveis,
      teto: tetoMax,
      detalhe: atuais
    };
  }

  global.COPA_PONTUACAO = { PESOS, calcular, calcularAtuais, teto };
})(typeof window !== "undefined" ? window : globalThis);
