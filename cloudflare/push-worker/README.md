# Fórmula do Gol — Push Worker

Backend Cloudflare do sistema de Web Push e do motor esportivo.

## Execução 3 — Push Core

- D1 para inscrições, preferências e auditoria.
- Durable Object `PushState` para geração/persistência das chaves VAPID.
- Endpoints `/v1/config`, `/v1/subscribe`, `/v1/unsubscribe`, `/v1/preferences` e `/v1/test`.

## Execução 4 — Sports Monitor

- Durable Object `SportsMonitor` para estado consistente das partidas.
- Cron Trigger de 1 minuto como watchdog/bootstrap.
- Watchlist é preparada com até 6 h de antecedência; Durable Object Alarm passa a 30 s enquanto há jogo ao vivo, gol pendente de confirmação ou partida a ±15 min do início.
- Agenda canônica: `https://formuladogol.com.br/dados-br/agenda-clubes-br.json`.
- ESPN scoreboard por competição; ESPN summary apenas quando placar/estado exige detalhe.
- Baseline seguro quando o Worker entra no meio da partida: gols anteriores não viram novos alertas.
- Confirmação anti-VAR: duas observações e pelo menos 45 s de persistência.
- Gol anulado exige duas evidências consecutivas após regressão do placar.
- Gols simultâneos entre polls são tratados separadamente pelo `scoringPlay`.
- Gol contra e gol de pênalti no tempo regulamentar são classificados; disputa de pênaltis é separada e não vira gol regulamentar.
- Eventos confirmados são gravados idempotentemente em `sports_events` no D1. A distribuição aos assinantes entra na Execução 5.

## Diagnóstico público não sensível

- `GET /health`
- `GET /v1/monitor/status`
- `GET /v1/monitor/events`

Nenhuma chave privada VAPID é exposta por esses endpoints.
