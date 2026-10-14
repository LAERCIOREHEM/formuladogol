// R10R17.2: identidade validada do evento entre agenda documental e ESPN.
// A associação por clubes/nome/placar não é permitida: evita autoria de outra partida.
function text(value) { return String(value == null ? '' : value).trim(); }
export const LIVE_GOAL_IDENTITY_VERSION = 1;
export function resolveTrackedLiveGoalMatch(matches, watchlist, eventId, league = '') {
  const id = text(eventId), requestedLeague = text(league);
  if (!id || !matches || typeof matches !== 'object') return null;
  const accept = (key, strategy) => {
    const match = matches[key];
    if (!match || (requestedLeague && text(match.league) !== requestedLeague)) return null;
    return { key, match, strategy };
  };
  // O ID da agenda é sempre a identidade canônica do monitor.
  if (Object.prototype.hasOwnProperty.call(matches, id)) return accept(id, 'agenda-id');
  // Só o sourceEventId que o monitor previamente reconciliou com a ESPN pode ser alias.
  if (!/^\d{5,15}$/.test(id)) return null;
  const candidates = Object.keys(matches).filter((key) => {
    const match = matches[key];
    return text(watchlist?.[key]?.sourceEventId || match?.sourceEventId) === id
      && (!requestedLeague || text(match?.league) === requestedLeague);
  });
  if (candidates.length !== 1) return null; // colisão de alias = falha fechada
  return accept(candidates[0], 'validated-espn-alias');
}
