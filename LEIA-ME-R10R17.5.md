# FDG R10R17.5 — Scorer Enrichment & Push Reconciliation

Base: formuladogol-main(7).zip (14/10/2026), com R10R17.4.

## O que muda
- Gol sem autor recebe atraso de até 20 segundos **somente na fila de push**, dando oportunidade de recuperação sem atrasar gol que já tem autor.
- Em cada leitura, gols confirmados sem autoria podem ter o registro persistido atualizado com autoria confiável do monitor, desde que o push **ainda não tenha sido expandido para destinatários**.
- Conciliação exige evento, placar e equipe compatíveis; havendo ambiguidade, não atribui o nome.
- Não gera um segundo gol, não reenvia push de gol já expandido, não altera política VAR/readiness.
- Teste novo integrado ao workflow de publicação.

## Limites importantes
- Uma notificação já entregue ao celular **não é substituída**; a recuperação atua antes da expansão da fila. Implementar atualização pós-entrega exigiria um protocolo próprio de substituição, não incluído para evitar duplicidade.
- Se a ESPN não fornecer o autor até o despacho, o alerta continuará sem nome; não inventamos nomes nem recorremos a IA para decidir autoria.
- O teste de integração completo depende das dependências do Worker. O teste unitário novo e a sintaxe passaram localmente; não foi feito deploy.

## Publicar
Na branch `main` do GitHub, envie preservando os caminhos:
1. `cloudflare/push-worker/src/scorer-push-reconciliation.js` (novo)
2. `cloudflare/push-worker/src/sports-monitor.js` (substituir)
3. `cloudflare/push-worker/tests/test-scorer-push-reconciliation.mjs` (novo)
4. `.github/workflows/deploy-push-worker.yml` (substituir)

Em GitHub > Add file > Upload files, preserve os diretórios. Commit: `R10R17.5 - Scorer Push Reconciliation`. Em Actions, acompanhe `Deploy Push Worker` AUTO e confirme o verde. Não é necessário deploy do GitHub Pages nem migração D1.
