# FÓRMULA DO GOL — R10R17.6 — HEALTH ACTION CENTER & ACTIONABLE ALERTS

**Pacote incremental para a `main` atual com R10R17.5.** Não substitua o repositório inteiro. O módulo afetado é o **Cloudflare Push Worker**.

## O que muda

1. O relatório diário das **08:00 BRT** contém uma **CENTRAL DE AÇÕES** com indicador, diagnóstico, evidências, impacto, responsável (automático/manual) e orientação concreta.
2. **Amarelo persistente:** aviso proativo após 15 minutos de confirmação; primeira leitura apenas observa. Um relatório diário enviado no mesmo ciclo cobre o primeiro aviso e evita e-mail duplicado.
3. **Vermelho:** e-mail crítico imediato, como antes, agora com instruções; reenvio controlado após falha no transporte.
4. **Recuperação:** e-mail específico; quando ele foi enviado, o aviso genérico de recuperação é suprimido para evitar duplicidade. Avisos passageiros amarelos que não chegaram a ser enviados se encerram silenciosamente.
5. GitHub Actions >8 disparos/24h, isoladamente, **não** altera a saúde. A anomalia comprovada de disparos novos durante modo `dormant`, sem tarefas e com próximo jogo >72h, continua crítica.
6. Agenda CONMEBOL: integridade `ok`, nenhum jogo oficial ausente e fallbacks documentais passam a ser **informação**, não incidente. Ausência de jogo continua vermelha; integridade desconhecida, amarela.
7. Melhores Momentos: pendência nos **primeiros 120 minutos** após FINAL é informativa. Após isso, amarela com partida, ID interno, tentativas, erro e próxima busca, consultados no D1.
8. IA: detalha falhas por provedor, HTTP e evento, detectando sucessos posteriores no mesmo evento/finalidade (indício de recuperação, não garantia semântica). Não transforma consumo de 49% do orçamento de US$10 em alarme indevido; limiar percentual existente (80%) é preservado. Se as falhas ainda não tiverem sucesso posterior, o alerta fica amarelo.
9. Pendências de público/renda dentro do SLA de 2h tornam-se informativas, sem alterar regras ou orçamento do Hunter.
10. Nenhuma chamada adicional à OpenAI, Gemini ou Workers AI para compor os alertas; usa D1 e informações já coletadas.

## Arquivos de implantação (8)

Suba SOMENTE os arquivos seguintes, conservando nomes e diretórios:

- `cloudflare/push-worker/src/health-action-center.js` **NOVO**
- `cloudflare/push-worker/src/health-monitor.js` **SUBSTITUIR**
- `cloudflare/push-worker/src/index.js` **SUBSTITUIR**
- `cloudflare/push-worker/tests/test-health-action-center.mjs` **NOVO**
- `cloudflare/push-worker/tests/test-health-action-snapshot.mjs` **NOVO**
- `cloudflare/push-worker/tests/test-health-monitor.mjs` **SUBSTITUIR**
- `cloudflare/push-worker/package.json` **SUBSTITUIR**
- `.github/workflows/deploy-push-worker.yml` **SUBSTITUIR**

`LEIA-ME-R10R17.6.md` e `MANIFESTO-R10R17.6.json` são documentação e não precisam ser enviados.

## Instalação via interface web do GitHub

1. Abra https://github.com/LAERCIOREHEM/formuladogol, branch `main`.
2. Extraia o ZIP no computador.
3. **Add file → Upload files**. Inclua os arquivos nas **pastas corretas** (não misture as duas pastas `src` e `tests` na raiz). O próprio GitHub deve reconhecer substituições e a criação dos três novos arquivos.
4. Faça **um único commit** `R10R17.6 - Health Action Center & Actionable Alerts`.
5. Aguarde em **Actions → Deploy Push Worker** (gatilho automático na `main`). Se o GitHub não iniciou o workflow, use **Run workflow → main**.
6. O novo smoke test confere `healthMonitorPolicyVersion` e `healthActionCenterVersion` por comparação com as **constantes do próprio código**, não por números antigos fixados no YAML.
7. Após o deploy, abra https://push.formuladogol.com.br/health para conferir `healthMonitorPolicyVersion:12` e `healthActionCenterVersion:1`. No próximo cron de 5 minutos, confira o objeto `snapshot.actionCenter` em https://push.formuladogol.com.br/v1/health-monitor/status.
8. O relatório diário permanece às **08:00 BRT**; amarelos confirmados após 15 minutos enviam e-mail durante o dia, sem esperar o digest do dia seguinte.

Não precisa executar GitHub Pages, mexer no Orchestrator, configurar novos secrets, rodar migração D1, reiniciar Durable Objects ou mudar budgets.

## Testes executados localmente

- `npm run check` — **PASS**.
- `node tests/test-health-monitor.mjs` — **PASS**.
- `node tests/test-health-action-center.mjs` — **PASS**, com SQLite/D1 em memória; amarelo, vermelho, deduplicação, retries, digest e recuperação.
- `node tests/test-health-action-snapshot.mjs` — **PASS**, integra consultas D1, 17 indicadores, dados HTTP simulados, 15 dispatches, cinco fallbacks, highlights pendentes e falhas de IA recuperadas / não recuperadas.
- `node tests/test-scorer-push-reconciliation.mjs` — **PASS**.
- `node tests/test-continental-readiness-guard.mjs` — **PASS**.
- `node tests/test-live-goal-event-integrity.mjs` — **PASS**.
- YAML do workflow e contratos `/health` — **validados estaticamente**.

A suíte esportiva COMPLETA não executou até o fim neste ambiente porque `@block65/webcrypto-web-push` e outras dependências externas não estavam instaladas. O workflow contém `npm install` antes dessa suíte e sua aprovação só será constatada após rodar no GitHub. **Este pacote não foi implantado automaticamente.**

## Segurança operacional

- Os dados D1 originais não são apagados; chaves `health:<indicator>` continuam idempotentes.
- O orçamento da IA não é alterado; não há novas pesquisas pagas.
- A identificação de recuperação por histórico de uso significa **sucesso posterior da mesma finalidade/evento**, não prova absoluta de conclusão de cada solicitação.
- Links e diagnósticos são informativos e não expõem tokens nem devem receber senhas.
