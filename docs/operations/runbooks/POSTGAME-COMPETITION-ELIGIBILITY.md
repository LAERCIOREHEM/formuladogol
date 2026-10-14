# R10R17.1 — Postgame Competition Eligibility Guard

## Contrato de elegibilidade factual

A coleta obrigatória de `publico`, `publico_pagante` (quando divulgado) e `renda` pertence exclusivamente ao Campeonato Brasileiro Série A identificado por `league = bra.1`. Copa do Brasil (`bra.copa_do_brazil`), Libertadores (`conmebol.libertadores`), Sul-Americana (`conmebol.sudamericana`) e todas as demais competições com `league` explícito são dispensadas. Isso NÃO cancela resultados, classificações, eventos ao vivo, publicação editorial, highlights nem monitor de agenda continental.

Uma partida com `league` ausente ou vazio não deve ser presumida como Brasileirão: fica em `public_status = eligibility_pending`, com `public_next_at = NULL`, até que a competição seja classificada por fonte estruturada. Uma partida explicitamente não-brasileirão recebe `public_status = not_applicable`, também com `public_next_at = NULL`. O estado `not_applicable` não é equivalente a `resolved`: ele representa dispensa da obrigação de coleta.

O importador `resultados.json`, dedicado exclusivamente ao Brasileirão, atribui `league = bra.1` explicitamente. O monitor geral não recebe esse valor automaticamente quando o campo vem ausente. Só `bra.1` pode entrar na fila de busca de público/renda e disparar e-mail de SLA T+120 minutos.

## Contrato de integridade e migração D1

A política Fastlane v14 migra diretamente via SQL os registros de competições não obrigatórias. Não há pesquisa ou IA na migração. São preservados placares, dados de público/renda já coletados, fontes, histórico de tentativas de IA, alertas anteriores e estado independente de melhores momentos. Na reentrada de `upsertTask()`, nenhum novo seed reabre uma partida dispensada; uma retificação estruturada para `bra.1` volta a habilitar a coleta legítima.

`claimDue(public)` impõe `league='bra.1'` em ambas as fases de seleção e lock. `processPublicTask` tem barreira de redundância, o alerta SLA bloqueia competição não elegível, e a ESPN não recebe IDs documentais `fdg-*` como IDs numéricos. `cleanup` pode encerrar registros `resolved` ou `not_applicable` após 30 dias, SOMENTE quando melhores momentos também estão resolvidos. Registros desconhecidos (`eligibility_pending`) são preservados até classificação.

Health v11 contabiliza pendências e resolvidos SOMENTE para `bra.1`; apresenta à parte dispensas e competições não identificadas (estas últimas podem justificar alerta amarelo de classificação). MCP `fdg_postgame_status` transmite as mesmas contagens, sem novas ferramentas de escrita. Factual Integrity Guard v1, RAG/MCP operacional e demais políticas continuam independentes.

## Operação / aceite

Testar: `cd cloudflare/push-worker && npm run check && npm run test:sports`. O teste `test-postgame-competition-eligibility.mjs` utiliza SQLite real em memória, sem rede, para provar `bra.1`, Copa do Brasil, Libertadores, Sul-Americana, desconhecidos, migração idempotente v13→v14, histórico preservado, SLA e highlights não bloqueados. O deploy `Deploy Push Worker` realiza migrações já existentes e valida o contrato v14/Health v11 contra produção. O Pages regenerará automaticamente o índice RAG a partir do corpus atualizado.

Após publicar, consultar `/v1/postgame/status` (`storedPolicyVersion=14`, `attendanceEligibilityPolicyVersion=1`, `publicNotApplicable`, `publicEligibilityPending`) e `/v1/postgame?event_id=...` para garantir que o jogo Boca Juniors x Vasco esteja com `not_applicable` e sem `public_next_at`. A leitura no D1 em produção, e não o ZIP, é a prova definitiva da regularização.
