# Fórmula do Gol — READINESS R10.1 — 2026-10-03

Hotfix isolado do Push Worker para eliminar falsos `NOT READY` e tempestade de e-mails T-30/T-10/T+3/Health Monitor.

## Caso que motivou a correção

Atlético-MG x Bragantino (`event_id 401841168`) foi localizado na ESPN com o mesmo event_id, mas uma divergência editorial de identidade/nome do clube gerou `team_identity_mismatch`. Isso provocou alertas repetidos do Readiness Guardian e abriu/fechou também um incidente `Ao Vivo` no Health Monitor.

## Política R10.1

- `event_id` ESPN exato é autoridade primária de identidade da partida.
- Divergência apenas de nome/sigla com event_id exato vira `team_identity_alias_warning`, não `NOT READY`.
- T-30 somente observa: não envia e-mail.
- T-10 envia no máximo um aviso se o problema ainda for real.
- T+3 envia no máximo uma escalada crítica se a causa persistir.
- Todos os checkpoints usam um único incidente por partida: `push_readiness:<event_id>`.
- Se vários checkpoints estiverem vencidos no mesmo poll, somente o checkpoint mais recente pode notificar.
- `readinessRed` passa a representar partidas realmente pendentes, e não apenas o poll que consumiu o checkpoint.
- Depois de T+3 vermelho, o monitor reavalia em polls seguintes e exige duas leituras verdes consecutivas para fechar silenciosamente o incidente.
- Health Monitor não abre um segundo incidente crítico apenas por `readinessRed`; mostra readiness pendente como amarelo. Poll ao vivo realmente stale continua vermelho.
- Ops trata readiness pendente como warning, não como degradação global do Worker.

## Arquivos

- `.github/workflows/deploy-push-worker.yml`
- `cloudflare/push-worker/src/readiness-guardian.js`
- `cloudflare/push-worker/src/sports-monitor.js`
- `cloudflare/push-worker/src/health-monitor.js`
- `cloudflare/push-worker/src/ops.js`
- `cloudflare/push-worker/src/index.js`
- `cloudflare/push-worker/tests/test-readiness-guardian.mjs`
- `cloudflare/push-worker/tests/test-readiness-monitor.mjs`
- `cloudflare/push-worker/tests/test-ops.mjs`

## Deploy

Subir todos os arquivos preservando os caminhos e executar apenas `Deploy Push Worker` se o workflow não disparar automaticamente.

## Validações executadas

- `npm run check` — PASS
- `npm run test:sports` — PASS
- `npm run test:hardening` — PASS
- regressão específica de alias com event_id exato — PASS
- regressão de incidente único T-30/T-10/T+3 — PASS

Observação: os testes locais usaram apenas um stub temporário de `@block65/webcrypto-web-push` para carregar os módulos, porque a instalação npm externa expirou no ambiente. O stub não está incluído no pacote; o GitHub Actions instala a dependência real.
