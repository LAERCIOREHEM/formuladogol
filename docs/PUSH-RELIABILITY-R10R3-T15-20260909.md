# PUSH RELIABILITY R10R3 — lembrete T-15

Correção pequena solicitada em 09/09/2026 para restaurar o aviso **“Jogo começa em 15 minutos”** sem reativar os demais alertas descartados na R10.

## Contrato público

1. ⏰ Jogo em 15 minutos — todas as competições suportadas.
2. ▶️ Início da partida — todas as competições suportadas.
3. ⚽ Gols — todas as competições suportadas.
4. 🟥 Cartões vermelhos — todas as competições suportadas.
5. 👥 Escalações confirmadas — somente Brasileirão (`bra.1`).
6. 🏁 Fim de jogo — todas as competições suportadas.

Continuam fora do fan-out público: gol anulado, mudança de horário, adiamento, pênaltis, prorrogação, disputa de pênaltis e classificação.

## Implementação

- O cron do Push Worker executa a cada minuto e o bootstrap gera `prematch_15` somente quando faltam entre 13 e 16 minutos, tolerando jitter do agendador.
- A chave `prematch_15:<event_id>:<kickoff_ms>` torna o aviso idempotente: a mesma partida/horário não pode gerar duplicata.
- O evento volta a usar a tabela histórica `match_events`, cujo CHECK já aceita `prematch_15`; os eventos R10 permanecem em `essential_match_events`.
- A preferência foi adicionada por uma tabela-extensão idempotente `push_reminder_preferences`, evitando `ALTER TABLE`, já que o workflow reaplica migrations em todos os deploys.
- A migration reaproveita a escolha histórica de `push_preferences_v2`; quem havia desligado o T-15 continua desligado. Para instalações novas sem histórico, o default é habilitado. Clientes antigos em cache que não enviam `prematch15` preservam a escolha existente em vez de sobrescrevê-la.
- O payload expira em 15 minutos (`ttl=900`) para impedir lembrete atrasado após a bola rolar.
