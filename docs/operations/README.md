# FDG Operations Knowledge Base

Base operacional criada na Execução R10R16. O objetivo é preservar contratos, incidentes e runbooks de forma indexável, sem colocar RAG no caminho crítico esportivo.

Princípio de arquitetura: **dados estruturados → regras determinísticas → validação → publicação**. IA pode descobrir, explicar e redigir; nunca é autoridade para placar, classificação, probabilidades, público/renda ou eventos esportivos.

## Núcleo R10R16

- `cloudflare/orchestrator-worker/src/contract.js`: contrato canônico do Orchestrator.
- `scripts/validar_snapshot_esportivo.py`: Sporting Snapshot Integrity Guard compartilhado por Fastlane e updater completo.
- `scripts/validar_publicacao_brasileirao.py`: validação completa extraída do YAML.
- `scripts/fdg_reliability.py`: códigos de incidente, diagnóstico e correlation ID.
- `dados-br/estado-confiabilidade.json`: estado CORE/ENRICHMENT.
- `dados-br/slo-confiabilidade.json`: observações mensuráveis de SLO quando houver novo FINAL.
- `tests/incidents/`: regressões de incidentes reais.

## Estados

- `CORE_GREEN`: resultado/tabela/AF consistentes; sem degradação relevante.
- `ENRICHMENT_PENDING`: core íntegro, mas público/renda, vídeo ou outro enriquecimento segue pendente.
- `DEGRADED`: core preservado, porém fonte principal está degradada/preservada.
- `CRITICAL`: integridade esportiva não foi provada; publicação deve falhar fechada.
