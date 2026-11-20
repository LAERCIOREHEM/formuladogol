# EDITORIAL-CLOSURE R2 — Final-Driven Publishing & Verified Delivery

**Fórmula do GOL | Release de 20/11/2026 | Orchestrator v2.6.0**

## Falha corrigida

A agenda pública `dados-br/agenda-clubes-br.json` inclui os jogos futuros e
remove partidas concluídas. O algoritmo anterior tentava reconhecer 10/10
apenas nessa agenda, perdia a última rodada e aguardava o fluxo pesado de
enriquecimento. A rodada 35 já estava criada em `dados-br/analises.json` e
`analises/brasileirao-2026-rodada-35.html`, mas dois guards com data fixa em
`deploy.yml` interrompiam TODO deploy após 19/11.

## Política R2

1. **Fonte FINAL:** leitura única a cada 5 minutos de
   `resultados.json` diretamente de `main` no GitHub, nunca da versão
   antiga do Pages. Cada final exige `estado=post`, placares numéricos e
   `finalizado_em` não futuro. Deduplicação por rodada e clubes evita
   IDs placeholder CBF duplicarem o ESPN.
2. **Preparação antecipada:** as rodadas 35/36/37/38 aparecem em
   `hints.editorialClosure.futureRounds` com 0–10 jogos concluídos,
   pendências e último horário *programado*. O horário previsto jamais
   substitui o sinal real FINAL.
3. **Gatilho:** assim que o 10º FINAL for gravado, o Orchestrator
   (cron de 5 minutos) trata o editorial ANTES de buscas de renda, vídeo
   e transmissões. Em caso de partidas adiadas, preserva a regra
   explícita de 8 concluídos + 8h + 72h de distância da partida pendente.
4. **Redundância:** workflow `editorial-closure-r2-backstop.yml`
   recebe `workflow_run.completed` do Fastlane FINAL e do coletor ESPN,
   reconcilia apenas dados locais e despacha a rodada fechada se o
   artigo estiver ausente. Sem schedule GitHub a cada 15 min e sem IA
   antes de um fechamento real.
5. **Custos:** `editorial_rodada` e `deploy_editorial` são
   **essenciais factuais** no COST-SHIELD R2. O editorial chama OpenAI
   somente quando `optionalAllowed=true`; senão usa o fallback
   determinístico. Um dossiê já válido, inclusive gerado por fallback,
   nunca repete uma chamada paga devido a push, deploy ou vídeo.
6. **Execução:** concorrência dedicada por rodada; não aguarda jobs
   ESPN completos por até 45 min. Escrita `main` preserva tentativas
   otimistas de commit/rebase e validação factual.
7. **Entrega real:** a presença da matéria em `main` NÃO significa
   que ela está publicada. `verifyEditorialDelivery` exige HTTP 200
   e marcadores da rodada, 10 cards, manifesto público com 10 jogos e
   link público na página `/analises/`.
8. **Recuperação:** se o artigo existe em `main` mas a prova pública
   falha, dispara SOMENTE `deploy.yml` via `deploy_editorial`.
   No máximo quatro recuperações em 24h, com cooldown de 10 minutos,
   sem recomputar AF nem gastar novamente na redação.
9. **Status/SLO:** `editorialClosure` expõe `state`, `lastFinalAt`,
   `firstEligibleAt`, `ageMinutes`, `overdue` a partir de 15 min,
   `alertDue` após 30 min, `delivery`, `deliveryRecoveries` e
   `futureRounds`. Alerta técnico em log após esgotar o teto de
   recuperações; são metas operacionais, não garantia de prazo fixo.
10. **Prova independente:** workflow
   `editorial-closure-r2-production-smoke.yml` roda após Pages
   bem-sucedido e mediante disparo manual. Consulta as três URLs reais,
   com novas requisições e prazo limitado de propagação.

## Conclusão das rodadas finais

| Rodada | Comportamento |
|---|---|
| 35 | Finalizada, artigo existente; reparar/validar Pages sem gerar IA novamente |
| 36 | ARMADA; espera os dez placares FINAL, inclusive o último jogo |
| 37 | ARMADA; mesma prova e pipeline, sem antecipar resultado |
| 38 | ARMADA; mesmo mecanismo, respeitando tabela oficial e atrasos |

A cobertura dos vídeos e público/renda é independente da publicação da
matéria; eventualmente poderá ser sincronizada depois. O editorial depende
somente dos fatos, AF auditado e artefatos obrigatórios. Um workflow vermelho
não é sucesso de publicação; somente `SITE_VERIFIED` comprova a entrega.
