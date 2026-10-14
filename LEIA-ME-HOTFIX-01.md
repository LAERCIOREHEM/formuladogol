# FDG R10R17.3 — HOTFIX 01 — Monitor Deploy Contract

## Causa
O teste `verify-monitor-deploy.mjs` ainda exigia `6-R10R4` para `overturnPolicyVersion` e `goalRecoveryPolicyVersion`, enquanto o SportsMonitor DO já executava `6-R10R17.3`. O Worker estava publicado, mas o smoke test rejeitava o contrato correto.

## Correção
- O teste deriva as versões diretamente de `SPORTS_ENGINE_CONSTANTS`, evitando contratos desatualizados.
- Mantém verificações rígidas de saúde e regressões para rejeitar versões antigas.
- Inclui o workflow de deploy no pacote.

## Instalação
Faça upload dos dois arquivos nas pastas correspondentes, commit na `main`, acompanhe **Deploy Push Worker**:
- `cloudflare/push-worker/tests/verify-monitor-deploy.mjs`
- `.github/workflows/deploy-push-worker.yml`

Não é necessário migrar D1, reiniciar Durable Objects nem reenviar os demais arquivos R10R17.3.

## Validação
- Self-test: PASS.
- JSON real do monitor anexado ao erro: PASS.
- Workflow YAML: validado.

O HOTFIX corrige o bloqueio exibido; não garante outras etapas ainda não executadas.
