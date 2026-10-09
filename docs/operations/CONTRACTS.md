# Contratos operacionais canônicos

## Fonte única de verdade

O arquivo `cloudflare/orchestrator-worker/src/contract.js` é a autoridade de versão, cron, feature flags de health e SLOs do Orchestrator. O Wrangler usa `__ORCHESTRATOR_VERSION__` e recebe a versão do contrato no render. `package.json` permanece apenas como metadado e é validado contra o contrato antes do deploy.

## Sporting Snapshot Integrity Guard

A publicação exige simultaneamente:

1. FINAL nunca pode regredir para `in/pre` no mesmo `event_id`.
2. Partida concluída não pode existir nas probabilidades pré-jogo.
3. concluídos + restantes = 380.
4. base corrente do AF = resultados concluídos.
5. calendário restante = probabilidades por jogo por identidade esportiva.
6. event_ids e confrontos sem duplicidade.
7. referência do AF não anterior ao último FINAL.
8. exatamente 2.000.000 simulações no AF publicado e auditado.
9. hashes de auditoria compatíveis com os artefatos publicados.

Qualquer violação falha fechada e gera `fdg-diagnostico*.json`.
