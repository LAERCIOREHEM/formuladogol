# FDG R10R17 — HOTFIX 8.1 — Deploy Orchestrator / RAG Contract Sync

## Falha corrigida

O Deploy Orchestrator Worker falhava em `npm run validate`, teste 71:

`corpus operacional e rollback existem sem ativar RAG no caminho crítico`

O teste antigo exigia:

`manifest.production_rag_enabled === false`

Esse requisito ficou obsoleto depois da ativação do RAG operacional R10R17.
O manifesto canônico atual declara `production_rag_enabled: true`, mas também
declara `runtime.critical_path: false`, `runtime.fail_open: true` e mantém
placar/classificação/probabilidades sob fontes estruturadas/determinísticas.

Portanto o runtime não estava errado; o teste estava desatualizado.

## Alteração

Somente:
`cloudflare/orchestrator-worker/tests/reliability-control-plane.test.mjs`

O teste agora valida o contrato correto:
- RAG operacional em produção: true;
- RAG fora do caminho crítico esportivo: false em `runtime.critical_path`;
- fail-open: true;
- placar: structured_source_only;
- classificação: deterministic_only;
- probabilidades: deterministic_only;
- o Orchestrator continua com `rag_em_producao: false` no seu próprio caminho crítico.

Nenhum cálculo de AF-Previsão, agenda continental, Phase Transition Guardian,
Worker, health endpoint ou versão foi alterado.

## Instalação

Upload pelo GitHub em `main`, preservando o caminho. A mudança está dentro de
`cloudflare/orchestrator-worker/**`, portanto o workflow existente
`Deploy Orchestrator Worker` é acionado automaticamente.
