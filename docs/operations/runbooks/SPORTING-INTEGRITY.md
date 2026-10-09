# Runbook — Sporting Integrity

1. Abra o job que falhou e baixe o artifact `fdg-*-diagnostic-*`.
2. Leia `code`, `trace_id`, `message` e `context`.
3. Para `STATE_REGRESSION_AFTER_FINAL`, confirme o mesmo `event_id` em `resultados.json` e `espn_eventos.json`; o estado canônico deve permanecer `post`.
4. Para `AF_COVERAGE_MISMATCH`, compare calendário restante e `probabilidades-jogos.json` pela identidade mandante+visitante.
5. Para `AF_BASE_MISMATCH`, compare `base_corrente.partidas_concluidas` com os resultados concluídos deduplicados.
6. Para `AF_SIMULATION_CONTRACT`, nunca reduza o alvo de 2.000.000 para “fazer passar”. Corrija a geração.
7. Para `CONTRACT_VERSION_DRIFT`, corrija a fonte derivada; não enfraqueça o smoke test.
8. Só publique depois que `scripts/validar_snapshot_esportivo.py --profile ci` passar.
