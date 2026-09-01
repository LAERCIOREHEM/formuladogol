# Fórmula do Gol — Push Worker

Backend do sistema de notificações Web Push do Fórmula do Gol.

## Execução 6 — hardening final

Componentes ativos:

- Worker `formula-do-gol-push` em `push.formuladogol.com.br`;
- D1 `formula-do-gol-push` para assinaturas, preferências, eventos, entregas e estado operacional;
- Durable Object `PushState` para o par VAPID persistente;
- Durable Object `SportsMonitor` para monitoramento/deduplicação dos jogos;
- Queue `formula-do-gol-push-delivery` para fan-out, retry e isolamento entre detecção e entrega;
- Cron de 1 minuto como watchdog e Durable Object Alarms para polling rápido durante partidas;
- endpoint agregado `/v1/ops/status` para saúde operacional sem expor endpoints, chaves ou dados identificáveis.

## API token do GitHub

O secret `CLOUDFLARE_API_TOKEN` mantém as permissões configuradas nas Execuções 3 e 5, incluindo **Account → Queues → Edit**. Editar as permissões do mesmo token na Cloudflare não exige trocar o valor já salvo no GitHub.

O workflow cria/atualiza os recursos automaticamente. A chave VAPID privada continua sendo criada e mantida dentro do Durable Object e nunca é armazenada no GitHub.

## Fluxo de produção

`ESPN → SportsMonitor → sports_events/D1 → Queue → seleção por preferências → Web Push → Service Worker → celular`.

A Execução 6 acrescenta:

- watchdog para dispatches pendentes e entregas `sending/retry` antigas;
- reencaminhamento idempotente de entregas travadas;
- limpeza diária de registros operacionais antigos;
- métricas agregadas de eventos, inscrições, retries, falhas e latência de entrega;
- detecção de monitor ao vivo defasado;
- autorrecuperação do `SportsMonitor` quando o status é consultado e o bootstrap/poll está velho;
- smoke test de produção incluindo `health`, motor esportivo, fan-out e `ops/status`;
- teste sintético ponta a ponta: placar → confirmação anti-VAR → payload → anulação sem duplicação.

A disputa de pênaltis continua separada do fluxo de gols regulamentares.

## Execução 6-R — resiliência da fonte ESPN

A E6-R remove a dependência operacional exclusiva de `site.api.espn.com`, que pode responder HTTP 403 a subrequests originados em Workers.

Para placares, a ordem é:

1. `cdn.espn.com/core/soccer/scoreboard?xhr=1&league=...`;
2. `cdn.espn.com/core/{league}/scoreboard?xhr=1`;
3. `site.api.espn.com/apis/site/v2/.../scoreboard` como fallback.

Para detalhes do gol, a ordem é:

1. game package CDN por `soccer`;
2. game package CDN por competição;
3. summary do Site API;
4. plays do Core API como último fallback.

O endpoint técnico `GET /v1/monitor/source-probe` testa, a partir do próprio Worker, a conectividade das quatro competições monitoradas. O workflow de deploy chama esse endpoint depois da publicação e falha se qualquer competição ficar sem uma fonte de scoreboard utilizável. Assim, um workflow verde na E6-R também comprova Worker -> ESPN, e não apenas Worker/D1/Queue.

O status do monitor passa a expor `sourceLayerVersion`, `scoreboardSources`, `summarySources` e `sourceAttempts`. Falhas de uma fonte primária que sejam recuperadas por fallback não contaminam `lastPollError`; esse campo passa a representar somente falha efetiva depois de esgotadas as fontes disponíveis.
