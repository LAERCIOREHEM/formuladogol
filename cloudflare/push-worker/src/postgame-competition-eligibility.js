// R10R17.1. Coleta obrigatória EXCLUSIVAMENTE para Brasileirão Série A.
// Desconhecido não é Brasileirão presumido: exige classificação antes de qualquer busca.
export const POSTGAME_ELIGIBILITY_VERSION = 1;
export const ATTENDANCE_REQUIRED_LEAGUE = 'bra.1';
export const ATTENDANCE_EXEMPT_STATUS = 'not_applicable';
export const ATTENDANCE_UNKNOWN_STATUS = 'eligibility_pending';

export function attendanceEligibility(league) {
  const normalized = String(league ?? '').trim().toLowerCase();
  if (!normalized) return Object.freeze({ league: '', required: false, state: 'unknown', publicStatus: ATTENDANCE_UNKNOWN_STATUS });
  if (normalized === ATTENDANCE_REQUIRED_LEAGUE) return Object.freeze({ league: normalized, required: true, state: 'required', publicStatus: null });
  return Object.freeze({ league: normalized, required: false, state: 'exempt', publicStatus: ATTENDANCE_EXEMPT_STATUS });
}
