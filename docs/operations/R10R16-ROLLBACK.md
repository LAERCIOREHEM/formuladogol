# R10R16 — rollback

Rollback deve ser feito por commit/revert dos arquivos da execução; não altere dados esportivos para mascarar falha.

## Ordem segura

1. Reverter os arquivos R10R16 em um único commit.
2. Rodar **Deploy Orchestrator Worker** em `active` se o revert tocar `cloudflare/orchestrator-worker/**` ou `dados-br/config-orquestrador.json`.
3. Confirmar `/health` e `/status`.
4. Não executar `AF-Previsão Fastlane pós-FINAL` manualmente com dados antigos só para testar.
5. Se o problema estiver apenas no novo CI, reverta `.github/workflows/reliability-control-plane.yml` sem mexer nos dados esportivos.

## Não reverter

- Match Identity Gate de público/renda.
- supressão de SLA de migração.
- proteção de cartão vermelho falso.
- FINAL monotônico.
- AF de 2.000.000 simulações.
- Editorial Closure Guarantee.
