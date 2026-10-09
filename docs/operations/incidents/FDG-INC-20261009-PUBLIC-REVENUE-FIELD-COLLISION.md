# FDG-INC-20261009 — PUBLIC_REVENUE_FIELD_COLLISION

## Incidente
Evento `401841248` — Fluminense 4 x 0 Coritiba, rodada 29.

O snapshot de público/renda continha:

- público presente: 15.056;
- renda: R$ 15.056,00.

A renda havia recebido numericamente o mesmo valor do público. A identidade da partida e das URLs estava correta, portanto o Match Identity Gate não detectava a colisão semântica entre campos.

## Valor curado

- público presente: 15.056;
- renda adotada: R$ 708.004,50;
- fonte de renda: SBT Sports;
- decisão: correção documental verificada em `dados-br/correcoes/publicos-verificados.json`.

Há divergência de R$ 1.000,00 em fonte secundária (Itatiaia). A execução R10R16.1 preserva a decisão curada de R$ 708.004,50.

## Causa raiz

O pipeline provava que a página pertencia à partida correta, mas não possuía uma trava determinística capaz de detectar que o número do campo `renda` colidia semanticamente com o número de `publico`.

## Regra introduzida

`PUBLIC_REVENUE_FIELD_COLLISION`:

1. `publico > 0` e `renda > 0`;
2. `abs(renda - publico) < 0,005`;
3. preservar `publico`;
4. colocar somente `renda` em quarentena;
5. remover a fonte de renda do snapshot automático;
6. reabrir somente a renda para reconciliação direcionada;
7. correção documental verificada por event_id/campo tem precedência absoluta.

Uma relação renda/público inferior a R$ 5,00 é apenas aviso `REVENUE_PER_ATTENDEE_LOW`; não remove nem inventa valores.

## Prevenção

- Push Worker: Factual Integrity Guard antes de `resolved`;
- migração v13: reabre somente colisões já resolvidas no D1, sem varredura de IA;
- importador Fastlane: bloqueia colisão e aplica correção curada antes do commit;
- coletor offline: sweep determinístico global, sem rede;
- auditoria: crítico quando a colisão chega ao snapshot publicável;
- Incident Regression Suite: fixture permanente `15056 / 15056 = FAIL`, `15056 / 708004.50 = PASS`.
