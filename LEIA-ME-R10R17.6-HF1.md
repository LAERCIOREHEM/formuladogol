# FDG — R10R17.6 HOTFIX 01 — SQL HEALTH/POSTGAME ELIGIBILITY

## Causa comprovada
O Action Center R10R17.6 acrescentou `highlight_overdue` à query de contagem do Health Monitor e um bind de data/hora `.bind(iso(now))`. O teste legado `test-postgame-competition-eligibility.mjs` usava regex que só aceitava `.first()` diretamente e falhou antes da integração SQLite.

## Correção segura
- Atualiza exclusivamente o teste para localizar a query com ou sem bind temporal.
- Reproduz o mesmo argumento `new Date().toISOString()` ao executar a query no SQLite simulado.
- Valida a quantidade de parâmetros SQL e a presença do campo `highlight_overdue`.
- Conserva todas as verificações originais de elegibilidade, Copa do Brasil, CONMEBOL, SLA e Fastlane.
- Workflow `Deploy Push Worker` inclui pré-teste claro para esse contrato e conserva os demais controles.
- Não altera os módulos em produção, D1, agenda ou comportamento dos alertas.

## Upload no GitHub
No repositório `LAERCIOREHEM/formuladogol`, branch `main`, enviar SOMENTE os dois arquivos abaixo com os caminhos preservados:
1. `cloudflare/push-worker/tests/test-postgame-competition-eligibility.mjs`
2. `.github/workflows/deploy-push-worker.yml`

Em GitHub > Add file > Upload files, mantenha as pastas corretamente; commit `R10R17.6 HF1 - corrigir SQL Health no teste de elegibilidade`. Isso aciona `Deploy Push Worker` automaticamente. Aguarde a execução final verde. Não reenviar R10R17.6 inteira.

Se o workflow falhar em outra etapa, enviar novo log. Esse hotfix trata apenas a causa verificada na linha 106.
