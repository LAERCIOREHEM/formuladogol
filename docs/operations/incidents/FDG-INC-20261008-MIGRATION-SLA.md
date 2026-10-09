# FDG-INC-20261008 — MIGRATION_SLA_FALSE_CRITICAL
**Sintoma:** reabertura administrativa por migração apareceu como pendência esportiva antiga e disparou crítico imediato.  
**Regra:** reabertura administrativa recebe âncora própria de SLA; migration grace e `postgameAdministrativeReopenSlaAnchor` permanecem obrigatórios.
