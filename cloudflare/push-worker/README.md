# Fórmula do Gol — Push Worker

Backend do sistema de notificações Web Push do Fórmula do Gol.

## Execução 5

Componentes ativos:

- Worker `formula-do-gol-push` em `push.formuladogol.com.br`;
- D1 `formula-do-gol-push` para assinaturas, preferências, eventos e entregas;
- Durable Object `PushState` para o par VAPID persistente;
- Durable Object `SportsMonitor` para monitoramento/deduplicação dos jogos;
- Queue `formula-do-gol-push-delivery` para fan-out, retry e isolamento entre detecção e entrega;
- Cron de 1 minuto como watchdog e Durable Object Alarms para polling rápido durante partidas.

## API token do GitHub

O secret `CLOUDFLARE_API_TOKEN` precisa manter as permissões anteriores e, a partir da Execução 5, incluir também:

- **Account → Queues → Edit**.

O workflow cria a Queue automaticamente caso ela ainda não exista. A chave VAPID privada continua sendo criada e mantida dentro do Durable Object; ela não é armazenada no GitHub.

## Fluxo de produção

`ESPN → SportsMonitor → sports_events/D1 → Queue → seleção por preferências → Web Push → Service Worker → celular`.

As preferências públicas suportadas são:

- todos os jogos;
- jogos específicos (`event_id` ESPN);
- clubes favoritos (ID ESPN quando disponível, com fallback canônico por nome);
- gols;
- gols anulados.

A disputa de pênaltis continua separada do fluxo de gols regulamentares.
