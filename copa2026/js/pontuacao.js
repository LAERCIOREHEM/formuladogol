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
    const sb = new Set(b || []);
    return (a || []).filter(x => sb.has(x));
  }
  function lista(p, k) { return Array.isArray(p && p[k]) ? p[k] : []; }
  function faseMataAtiva(o, key) {
    const ap = (o && o._apurarMata) || {};
    if (key === "avancam_oitavas") return !!ap.oitavas;
    if (key === "avancam_quartas") return !!ap.quartas;
    if (key === "semifinalistas") return !!ap.semis;
    if (key === "finalistas") return !!ap.final;
    return true;
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

    // Mata-mata é apurado fase por fase: não antecipa pontuação de quartas/semis/final
    // só porque uma seleção ainda está viva ou eliminada. A fase precisa estar aberta.
    d.oitavas = faseMataAtiva(o, "avancam_oitavas") ? inter(p.avancam_oitavas, o.avancam_oitavas || []).length * PESOS.oitavas : 0;
    d.quartas = faseMataAtiva(o, "avancam_quartas") ? inter(p.avancam_quartas, o.avancam_quartas || []).length * PESOS.quartas : 0;
    d.semis   = faseMataAtiva(o, "semifinalistas") ? inter(p.semifinalistas, o.semifinalistas || []).length * PESOS.semi : 0;
    d.final   = faseMataAtiva(o, "finalistas") ? inter(p.finalistas, o.finalistas || []).length * PESOS.final : 0;

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
      campeao: p.campeao, vice: p.vice, terceiro: p.terceiro, quarto: p.quarto,
      // TETO é o máximo teórico do palpite, não a apuração fase-a-fase.
      // Portanto, todas as fases precisam contar aqui.
      _apurarMata: { oitavas:true, quartas:true, semis:true, final:true }
    };
    return calcularAtuais(p, oficialFicticio).total;
  }

  // PERDIDOS no modo SIMULADO ("se acabasse hoje"): para cada categoria, conta o que
  // o jogador apostou e que NÃO está batendo com a foto de hoje. É o espelho de calcularAtuais.
  // conquistados + perdidos(simulado) = teto SEMPRE (por construção), porque toda vaga
  // apostada ou está certa hoje (conquistado) ou errada hoje (perdido). Nada fica "possível"
  // no simulado: a foto de hoje decide tudo — e muda a cada jogo.
  function perdidosSimulado(p, o) {
    const d = {};
    // seleções entre as 32: apostou e não está entre os 32 de hoje
    const c32 = new Set(o.classificados32 || []);
    d.classificados = (p.classificados32 || []).filter(id => !c32.has(id)).length * PESOS.classificado32;
    // melhores terceiros: apostou e não está entre os 8 de hoje
    const t8 = new Set(o.melhores_terceiros || []);
    d.terceiros = (p.melhores_terceiros || []).filter(id => !t8.has(id)).length * PESOS.melhorTerceiro;
    // posições de grupo: para cada grupo e posição, apostou alguém != do dono de hoje
    d.posGrupos = 0;
    const oc = o.classificacao || {};
    const pesos = [PESOS.campGrupo, PESOS.viceGrupo, PESOS.terGrupo, PESOS.ultGrupo];
    Object.keys(oc).forEach(g => {
      const pg = (p.classificacao || {})[g];
      if (!pg) return;
      for (let i = 0; i < 4; i++) {
        if (pg[i] && oc[g][i] && pg[i].id !== oc[g][i].id) d.posGrupos += pesos[i];
      }
    });
    // títulos/pódio não são antecipados como perdidos aqui. Eles só são debitados
    // quando a posição for oficialmente decidida, mantendo a apuração fase por fase.
    d.campeao = 0; d.vice = 0; d.terceiro = 0; d.quarto = 0;
    d.total = Object.values(d).reduce((a, b) => a + b, 0);
    return d;
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
    // seleção prevista numa fase mas já eliminada e que NÃO está no oficial daquela fase.
    // Para mata-mata, só debita fases já abertas/apuradas.
    const naoConfirmados = (pset, oset, peso) => {
      const conf = new Set(oset || []);
      return lista(p, pset).filter(id => elim.has(id) && !conf.has(id)).length * peso;
    };
    perdidos += naoConfirmados("classificados32", o.classificados32, PESOS.classificado32);
    perdidos += naoConfirmados("melhores_terceiros", o.melhores_terceiros, PESOS.melhorTerceiro);
    if (faseMataAtiva(o, "avancam_oitavas")) perdidos += naoConfirmados("avancam_oitavas", o.avancam_oitavas, PESOS.oitavas);
    if (faseMataAtiva(o, "avancam_quartas")) perdidos += naoConfirmados("avancam_quartas", o.avancam_quartas, PESOS.quartas);
    if (faseMataAtiva(o, "semifinalistas")) perdidos += naoConfirmados("semifinalistas", o.semifinalistas, PESOS.semi);
    if (faseMataAtiva(o, "finalistas")) perdidos += naoConfirmados("finalistas", o.finalistas, PESOS.final);
    const dec = o.decididos || {};
    // Títulos/pódio só entram como perdidos quando a posição estiver decidida.
    if (dec.campeao  && atuais.campeao  === 0) perdidos += PESOS.campeao;
    if (dec.vice     && atuais.vice     === 0) perdidos += PESOS.vice;
    if (dec.terceiro && atuais.terceiro === 0) perdidos += PESOS.terceiro;
    if (dec.quarto   && atuais.quarto   === 0) perdidos += PESOS.quarto;

    let detPerdidos = null;
    // Sempre que há classificação de grupos (simulado parcial OU oficial encerrado),
    // os perdidos da FASE DE GRUPOS são tudo que está errado na foto atual.
    // Isso garante que posições/terceiros errados sejam debitados nos dois modos.
    const temGrupos = o.classificacao && Object.keys(o.classificacao).length > 0;
    if (o._simulado || temGrupos) {
      detPerdidos = perdidosSimulado(p, o);
      // no oficial, soma também os perdidos de mata-mata (fases já decididas) do cálculo padrão
      if (!o._simulado) {
        const dec = o.decididos || {};
        let pmm = 0;
        const naoConf = (pset, oset, peso) => {
          const conf = new Set(oset || []);
          return (p[pset] || []).filter(id => elim.has(id) && !conf.has(id)).length * peso;
        };
        if (faseMataAtiva(o, "avancam_oitavas")) pmm += naoConf("avancam_oitavas", o.avancam_oitavas, PESOS.oitavas);
        if (faseMataAtiva(o, "avancam_quartas")) pmm += naoConf("avancam_quartas", o.avancam_quartas, PESOS.quartas);
        if (faseMataAtiva(o, "semifinalistas")) pmm += naoConf("semifinalistas", o.semifinalistas, PESOS.semi);
        if (faseMataAtiva(o, "finalistas")) pmm += naoConf("finalistas", o.finalistas, PESOS.final);
        if (dec.campeao  && atuais.campeao  === 0) pmm += PESOS.campeao;
        if (dec.vice     && atuais.vice     === 0) pmm += PESOS.vice;
        if (dec.terceiro && atuais.terceiro === 0) pmm += PESOS.terceiro;
        if (dec.quarto   && atuais.quarto   === 0) pmm += PESOS.quarto;
        detPerdidos.matamata = pmm;
        detPerdidos.total += pmm;
      }
      perdidos = detPerdidos.total;
    }

    const possiveis = Math.max(0, tetoMax - atuais.total - perdidos);

    return {
      atuais: atuais.total,
      perdidos,
      possiveis,
      teto: tetoMax,
      detalhe: atuais,
      detPerdidos: detPerdidos
    };
  }

  global.COPA_PONTUACAO = { PESOS, calcular, calcularAtuais, teto, perdidosSimulado, faseMataAtiva };
})(typeof window !== "undefined" ? window : globalThis);
