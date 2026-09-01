# Fórmula do Gol — Operação das notificações

## Estado final E1–E6

O site permanece hospedado no GitHub Pages. O subsistema de alertas opera em `push.formuladogol.com.br` na Cloudflare.

Fluxo: `agenda → ESPN scoreboard → ESPN summary sob demanda → confirmação anti-VAR → D1 → Queue → Web Push → Service Worker`.

## Diagnóstico técnico

A página `pwa-teste.html` é `noindex` e concentra os testes técnicos. Na Execução 6, o botão **Ver saúde completa do sistema** consulta `/v1/ops/status`.

Estados possíveis:

- `healthy`: infraestrutura íntegra, sem jogo em andamento;
- `live`: infraestrutura íntegra e pelo menos uma partida em andamento;
- `warning`: sistema operacional, mas existe sinal que deve ser acompanhado (por exemplo retry ou erro recente da ESPN);
- `degraded`: condição que pode impedir alerta correto, como polling ao vivo defasado ou entrega travada.

## Métricas expostas

O status operacional mostra apenas agregados:

- inscrições ativas/inativas;
- gols e anulações registrados nas últimas 24 horas;
- dispatches pendentes/travados;
- entregas sent/retry/gone/failed;
- entregas travadas;
- latência média e máxima entre confirmação do evento e push enviado nas últimas 24 horas;
- último evento e último push;
- status do monitor esportivo e manutenção automática.

Não são expostos endpoints Web Push, chaves VAPID, IDs de instalação ou preferências individuais.

## Autorrecuperação

O cron de 1 minuto executa o watchdog. Ele:

1. atualiza a watchlist e o monitor esportivo;
2. recupera eventos que ficaram pendentes/enfileirados sem expansão;
3. reencaminha entregas `sending/retry` antigas de forma idempotente;
4. executa limpeza de retenção uma vez por dia.

A chave primária `(event_key, subscription_id)` e o lock de entrega impedem que a recuperação gere dois pushes do mesmo evento para a mesma assinatura.

## Retenção

- `push_audit`: 30 dias;
- eventos, dispatches e entregas: 90 dias;
- inscrições inativas e preferências órfãs: 180 dias.

## Critérios de incidente

Investigar imediatamente se:

- `/health` não retornar versão 6;
- `/v1/ops/status` retornar `state=degraded`;
- houver partida ao vivo e o último poll estiver defasado por mais de 2 minutos;
- `stuckDispatches` ou `stuckDeliveries` for maior que zero por vários ciclos;
- `lastCronError` permanecer preenchido;
- falhas/retries crescerem continuamente sem recuperação.

## Limites da validação

Os testes sintéticos cobrem baseline, gol, autoria, anti-VAR, anulação, deduplicação e construção do push. A validação final de latência e comportamento do provedor esportivo depende de partidas reais, pois a atualização da ESPN é externa ao Fórmula do Gol.
