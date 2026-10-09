const BR_LEAGUE = 'bra.1';

function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function articleForRound(analyses, round) {
  return (analyses?.artigos || []).find((article) =>
    article?.tipo === 'brasileirao_rodada' && Number(article?.rodada || 0) === Number(round)
  ) || null;
}

export function eligibleRoundFromAgenda(games, now, config = {}) {
  const current = asDate(now) || new Date();
  const minimum = Number(config.minimo_jogos_para_fechamento_editorial || 8);
  const waitHours = Number(config.espera_apos_ultimo_jogo_horas || 8);
  const postponedHours = Number(config.distancia_jogo_adiado_horas || 72);
  const byRound = new Map();

  for (const game of games || []) {
    if (String(game?.league || '') !== BR_LEAGUE) continue;
    const round = Number(game?.round || 0);
    if (!round) continue;
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(game);
  }

  const eligible = [];
  for (const [round, rows] of byRound.entries()) {
    // O Brasileirão tem 10 jogos por rodada. Agenda incompleta não autoriza
    // fechamento: fail closed para não publicar matéria sobre unidade parcial.
    if (rows.length !== 10) continue;
    const completed = rows.filter((game) => game?.concluded === true);
    const pending = rows.filter((game) => game?.concluded !== true);

    if (completed.length === 10) {
      eligible.push({ round, completed: 10, pending: 0, reason: 'todos os dez jogos foram concluídos' });
      continue;
    }
    if (completed.length < minimum || !pending.length) continue;

    const completedDates = completed.map((game) => asDate(game?.kickoff)).filter(Boolean);
    const pendingDates = pending.map((game) => asDate(game?.kickoff)).filter(Boolean);
    if (!completedDates.length) continue;
    const lastCompleted = new Date(Math.max(...completedDates.map((d) => d.getTime())));
    const pendingFar = !pendingDates.length || Math.min(...pendingDates.map((d) => d.getTime())) >= lastCompleted.getTime() + postponedHours * 3600000;
    const waited = current.getTime() >= lastCompleted.getTime() + waitHours * 3600000;
    if (pendingFar && waited) {
      eligible.push({ round, completed: completed.length, pending: pending.length, reason: 'janela encerrada com partida adiada' });
    }
  }

  if (!eligible.length) return null;
  return eligible.reduce((best, row) => (!best || row.round > best.round ? row : best), null);
}

export function editorialClosureDecision(games, analyses, now, config = {}) {
  const state = eligibleRoundFromAgenda(games, now, config);
  if (!state) return { state: 'idle', eligible: false, round: 0, completed: 0, pending: 0, reason: 'nenhuma rodada elegível' };

  const article = articleForRound(analyses, state.round);
  const articleGames = Number(article?.jogos_concluidos || 0);
  if (article && articleGames >= state.completed) {
    return {
      ...state,
      state: 'resolved',
      eligible: true,
      articlePresent: true,
      articleGames,
      articleId: String(article?.id_editorial || ''),
    };
  }

  return {
    ...state,
    state: 'pending',
    eligible: true,
    articlePresent: false,
    articleGames,
    articleId: '',
  };
}
