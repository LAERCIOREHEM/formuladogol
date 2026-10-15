// R10R17.5: update a confirmed goal only while it has not entered delivery expansion.
// Never generate a second goal event or change the scoring side/score.
const text = (v) => String(v ?? '').trim();
export const SCORER_PUSH_POLICY_VERSION = '6-R10R17.5';
export const SCORER_PUSH_GRACE_SECONDS = 20;
export function eligibleScorerPlay(play) {
  return Boolean(play && play.status === 'confirmed' && play.scorerConflict !== true && text(play.athleteName)
    && (play.homeScoreAfter != null || play.awayScoreAfter != null));
}
export function scorerPatch(payload, play) {
  if (!payload || payload.type !== 'goal' || text(payload.athlete?.name) || !eligibleScorerPlay(play)) return null;
  const oldScore = payload.scoreAfter || {};
  if (play.homeScoreAfter != null && Number(play.homeScoreAfter) !== Number(oldScore.home)) return null;
  if (play.awayScoreAfter != null && Number(play.awayScoreAfter) !== Number(oldScore.away)) return null;
  const name = text(play.athleteName);
  const minute = text(play.minute || payload.minute);
  const base = text(payload.notificationDraft?.body);
  const suffix = play.ownGoal ? ' (contra)' : play.penalty ? ' (pênalti)' : '';
  return { ...payload, athlete: { id: text(play.athleteId), name }, minute,
    scorerSource: text(play.athleteSource || play.sourceName),
    scorerConfidence: play.athleteStructured === true ? 'structured' : 'inferred',
    notificationDraft: { ...payload.notificationDraft,
      body: `${name}${suffix}${minute ? ', ' + minute : ''} · ${base}` } };
}
export async function reconcilePendingGoalScorers(env, eventId, plays = [], logger = console) {
  if (!env?.DB || !eventId) return 0;
  const candidates = plays.filter(eligibleScorerPlay);
  if (!candidates.length) return 0;
  const result = await env.DB.prepare(`
    SELECT e.event_key,e.payload_json,e.home_score,e.away_score,e.scoring_team_id,
           d.expanded_at,d.status
    FROM sports_events e LEFT JOIN push_event_dispatch d ON d.event_key=e.event_key
    WHERE e.event_id=? AND e.event_type='goal' AND (e.athlete_name IS NULL OR e.athlete_name='')
      AND e.created_at >= datetime('now','-90 minutes')
    LIMIT 30
  `).bind(eventId).all();
  let updated = 0;
  for (const row of result.results || []) {
    if (row.expanded_at || ['expanded','complete','sent'].includes(text(row.status))) continue;
    let payload;
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { continue; }
    const matched = candidates.filter(play =>
      (play.homeScoreAfter == null || Number(play.homeScoreAfter) === Number(row.home_score)) &&
      (play.awayScoreAfter == null || Number(play.awayScoreAfter) === Number(row.away_score)) &&
      (!text(row.scoring_team_id) || !text(play.teamId) || text(row.scoring_team_id) === text(play.teamId)));
    // Ambiguous match: preserve the existing event rather than guessing an author.
    if (matched.length !== 1) continue;
    const next = scorerPatch(payload, matched[0]);
    if (!next) continue;
    const result = await env.DB.prepare(`
      UPDATE sports_events SET athlete_id=?,athlete_name=?,minute=?,payload_json=?
      WHERE event_key=? AND (athlete_name IS NULL OR athlete_name='')
        AND NOT EXISTS (SELECT 1 FROM push_event_dispatch d
          WHERE d.event_key=sports_events.event_key AND (d.expanded_at IS NOT NULL OR d.status IN ('expanded','complete','sent')))
    `).bind(text(next.athlete.id),text(next.athlete.name),text(next.minute),JSON.stringify(next),row.event_key).run();
    if (Number(result?.meta?.changes || 0)) updated++;
  }
  if (updated) logger.info?.('scorer_push_reconciled_before_dispatch', { eventId, updated });
  return updated;
}
