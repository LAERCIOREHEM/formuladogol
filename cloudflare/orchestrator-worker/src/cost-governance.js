// R2: classify orchestration by operational necessity, not by account
// billing telemetry. FINAL certification and official fixture recovery cannot
// be suspended by cloud billing or optional AI spending.
export const ESSENTIAL_ORCHESTRATOR_ACTIONS = Object.freeze([
  'atualizar_brasileirao','refresh_continentais',
  // Publishing verified sporting facts is essential. Paid prose is optional
  // and separately suppressed when R2 optionalAllowed=false.
  'editorial_rodada','deploy_editorial'
]);
export const SECONDARY_ORCHESTRATOR_ACTIONS = Object.freeze([
  'transmissao_aovivo', 'transmissoes_tv'
]);

export function orchestratorCostDecision(action,shield={}) {
  const kind=String(action||'');
  if (ESSENTIAL_ORCHESTRATOR_ACTIONS.includes(kind))
    return {allowed:true,tier:'essential',reason:'sporting_continuity'};
  if (SECONDARY_ORCHESTRATOR_ACTIONS.includes(kind)) {
    if(shield.secondaryAllowed===false)
      return {allowed:false,tier:'secondary',reason:'cost_shield_r2_secondary_paused'};
    return {allowed:true,tier:'secondary',reason:'within_operational_tier'};
  }
  if(shield.optionalAllowed===false||shield.secondaryAllowed===false)
    return {allowed:false,tier:'optional',reason:'cost_shield_r2_optional_paused'};
  return {allowed:true,tier:'optional',reason:'within_operational_tier'};
}
