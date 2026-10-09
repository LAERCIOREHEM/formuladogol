// R10R16.1 — política determinística de integridade factual de público/renda.
// IA nunca decide se um número suspeito é correto: o guard apenas detecta,
// põe o campo em quarentena e força nova evidência documental direcionada.
export const FACTUAL_INTEGRITY_POLICY_VERSION = 1;
export const FACTUAL_INCIDENTS = Object.freeze({
  PUBLIC_REVENUE_FIELD_COLLISION: 'PUBLIC_REVENUE_FIELD_COLLISION',
  REVENUE_PER_ATTENDEE_LOW: 'REVENUE_PER_ATTENDEE_LOW',
});
export const FACTUAL_LIMITS = Object.freeze({ lowRevenuePerAttendee: 5 });

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function inspectPostgameFactualIntegrity(values = {}) {
  const publico = positive(values.publico);
  const pagantes = positive(values.publico_pagante ?? values.pagantes);
  const renda = positive(values.renda);
  const critical = [];
  const warnings = [];
  const quarantineFields = [];
  let revenuePerAttendee = null;

  if (publico != null && pagantes != null && pagantes > publico) {
    critical.push('PAID_ATTENDANCE_GT_PRESENT');
    quarantineFields.push('publico_pagante');
  }
  if (publico != null && renda != null) {
    revenuePerAttendee = renda / publico;
    if (Math.abs(renda - publico) < 0.005) {
      critical.push(FACTUAL_INCIDENTS.PUBLIC_REVENUE_FIELD_COLLISION);
      quarantineFields.push('renda');
    } else if (revenuePerAttendee < FACTUAL_LIMITS.lowRevenuePerAttendee) {
      warnings.push(FACTUAL_INCIDENTS.REVENUE_PER_ATTENDEE_LOW);
    }
  }
  return {
    policyVersion: FACTUAL_INTEGRITY_POLICY_VERSION,
    critical,
    warnings,
    quarantineFields: [...new Set(quarantineFields)],
    revenuePerAttendee: revenuePerAttendee == null ? null : Number(revenuePerAttendee.toFixed(4)),
  };
}

export function quarantinePostgameFactualIntegrity(values = {}, sources = {}) {
  const nextValues = { ...values };
  const nextSources = { ...(sources || {}) };
  const verdict = inspectPostgameFactualIntegrity(nextValues);
  for (const field of verdict.quarantineFields) {
    if (field === 'renda') {
      nextValues.renda = null;
      delete nextSources.renda;
    } else if (field === 'publico_pagante') {
      nextValues.publico_pagante = null;
      delete nextSources.publico_pagante;
    }
  }
  return { values: nextValues, sources: nextSources, verdict };
}
