# Fórmula do Gol — migração do orquestrador para Cloudflare

## Objetivo

Eliminar o `cron-job.org` como heartbeat do GitHub Actions. O Cloudflare Worker consulta o estado e só cria um `workflow_dispatch` quando existe trabalho factual.

O AO VIVO NÃO faz parte desta migração: `js/br-aovivo.js` e `js/br-estatisticas.js` continuam com refresh ESPN de 30 segundos. O Push Worker existente também não é alterado por este pacote.

## Arquitetura

- Worker novo: `formula-do-gol-orchestrator`
- domínio: `orchestrator.formuladogol.com.br`
- Cron Trigger: `* * * * *`
- estado: Durable Object SQLite `OrchestratorState`, independente do Push Worker
- caminho rápido: agenda pública + ESPN somente na janela de jogo
- avaliação lenta: no máximo a cada 5 minutos
- modo inicial obrigatório: `shadow`
- modo de produção: `active`

## Secrets necessários no GitHub

Já existentes e reutilizados:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Novo:

- `FDG_ORCHESTRATOR_GITHUB_TOKEN`

Crie um Fine-grained Personal Access Token do GitHub restrito ao repositório `LAERCIOREHEM/formuladogol`, com permissão de **Actions: Read and write**. Grave o valor somente em **Settings → Secrets and variables → Actions → Repository secrets**. Não grave o token em arquivo.

## Implantação segura

1. Suba este patch no `main`, preservando as pastas.
2. NÃO desative o cron-job.org ainda.
3. GitHub → Actions → **Deploy Orchestrator Worker** → **Run workflow**.
4. Selecione `shadow`.
5. O workflow valida o código, publica o Worker em SHADOW, cria o Durable Object/Cron Trigger e grava o token GitHub como secret do Worker.
6. Abra `https://orchestrator.formuladogol.com.br/health`. Deve aparecer `ok=true`, `mode=shadow` e `liveBrowserUntouched=true`.
7. Abra `https://orchestrator.formuladogol.com.br/status`. Observe `candidate`, `result`, `errors` e `hints`. Em SHADOW, uma decisão elegível aparece como `result=shadow`, sem criar Action.
8. Deixe SHADOW conviver com o cron-job.org durante a validação.
9. Quando as decisões estiverem corretas, rode **Deploy Orchestrator Worker** novamente e selecione `active`.
10. Confirme `/health` com `mode=active`.
11. Confirme pelo menos uma decisão real correta.
12. DESATIVE o job do cron-job.org. Não apague de imediato.
13. Após operação estável, exclua o cron-job.org.

## Rollback

Para impedir imediatamente novos dispatches automáticos sem remover infraestrutura:

1. GitHub → Actions → **Deploy Orchestrator Worker**.
2. Rode com `mode=shadow`.
3. Se necessário, reative temporariamente o cron-job.org.

## O que o Worker decide

- FINAL ESPN ainda não incorporado: `Atualizar Brasileirao (ESPN)`.
- manutenção diária de segurança: uma vez por dia, quando realmente ausente.
- públicos: primeira tentativa +15 min e backoff progressivo.
- melhores momentos: +20 min e backoff esparso, dirigido por `event_id` no Brasileirão.
- player oficial: T-90, T-45, T-20, T-5, T+10 e T+30.
- TV: 6 h quando crítica (<72 h); 24 h em até 14 dias; 72 h em 15–30 dias; 7 dias quando 30 dias estão cobertos.
- editorial do Brasileirão: somente após fechamento factual da rodada.
- Copa do Brasil: somente após fase encerrada.
- Libertadores/Sul-Americana: somente quando o marco esportivo relevante do recorte brasileiro está fechado.

## Gate de publicação

A existência de uma Action não implica deploy. Os workflows alterados neste pacote distinguem conteúdo factual de auditoria/timestamp. Sem mudança factual de transmissão ou vídeo, não há deploy do site.
