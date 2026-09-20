# Fórmula do Gol — Cloudflare Orchestrator

Controlador operacional determinístico do Fórmula do Gol.

## Princípio

- Cloudflare acorda a cada 5 minutos; o caminho rápido lê agenda compacta + status operacional e só sonda fontes esportivas quando há motivo.
- GitHub Actions só nasce quando existe uma ação factual elegível.
- O modo `shadow` registra a decisão sem chamar GitHub.
- O modo `active` usa `workflow_dispatch` via GitHub REST API.
- O estado/cooldown fica em um Durable Object SQLite separado do Push Worker.
- OpenAI não participa da decisão operacional.

## O que NÃO é alterado

A interface AO VIVO permanece independente: `js/br-aovivo.js`, `js/br-classificacao-live.js` e a camada de estatísticas continuam consultando a ESPN no navegador em 30 segundos. O Push Worker também permanece separado.

## Endpoints

- `/health` — versão, modo e contrato básico.
- `/status` — última avaliação, candidato, resultado e próximos vencimentos conhecidos.
- `/history` — histórico curto das decisões relevantes.

## Política resumida

- FINAL ESPN não publicado: detectado no ciclo seguinte de 5 minutos, com idempotência por `event_id`.
- manutenção completa: uma vez ao dia, se ainda não houve sucesso naquele dia.
- públicos: primeira tentativa +30 min após FINAL; backoff progressivo e direcionado por `event_id`.
- melhores momentos: primeira tentativa +20 min e backoff esparso; Brasileirão usa `event_id` direcionado.
- player oficial: somente quando a grade exigir GE TV/SBT/CazéTV; oportunidades T-90, T-15 e T+10; player já resolvido encerra novas tentativas.
- TV: jogos a mais de 72 h nunca abrem Action. Se a grade continuar ausente/instável, tentativas determinísticas apenas em T-72 h, T-24 h e T-6 h.
- editoriais: fechamento factual da rodada/fase, sem decisão por horário arbitrário.
- continental: agenda orienta `nextCheckAt`; a mesma assinatura factual só pode ser despachada uma vez; agenda incompleta cai para uma única verificação diária; o circuit breaker é respeitado antes do dispatch.
- fechamento continental conjunto: Libertadores + Sul-Americana são avaliadas como um único ciclo editorial, mas apenas confrontos com brasileiros bloqueiam o fechamento; partidas exclusivamente estrangeiras não atrasam a publicação.
- fases continentais: ida/volta do mesmo confronto são reconciliadas antes da decisão, impedindo um rótulo degradado de `Final/900` na volta de promover artificialmente a fase.
- IA continental: depois do fechamento determinístico, OpenAI recebe o dossiê factual para auditar coerência e redigir; não pode converter jogo pendente em encerrado nem criar classificado/eliminado.
- Brasileirão/ESPN: `status-atualizacao.json` da `main` abre o circuit breaker quando o scoreboard fica indisponível; o Worker continua acordando, faz apenas probe multissuperfície (CDN / Site Web / Site API) e só libera uma tentativa pesada em `HALF_OPEN`.

## Deploy

Use exclusivamente `.github/workflows/deploy-orchestrator-worker.yml`.
Primeiro publique em `shadow`; só depois publique em `active`.

## Custo operacional do ciclo

O tick de 5 minutos não baixa `jogos-detalhes.json` nem executa processamento pesado. O caminho lento usa `nextSlowEvalAt`: em período ocioso pode dormir até 60 minutos, mas mudança factual da agenda acorda a avaliação imediatamente.
A cada ciclo ele lê `agenda-clubes-br.json` e o estado operacional do Brasileirão. Se a última coleta preservou snapshot por indisponibilidade da ESPN, nenhum GitHub Action pesado é criado: somente um probe barato tenta CDN ESPN, Site Web API e Site API.
Quando o probe volta saudável, o breaker passa de `OPEN` para `HALF_OPEN` e permite uma única tentativa de recuperação. Só uma publicação sincronizada fecha o estado em `CLOSED`; uma nova falha volta a `OPEN`.
A avaliação pesada das demais tarefas é amortizada; o cron continua em 5 minutos, mas o caminho lento não roda em todo tick quando nada venceu. O módulo continental não transforma essas avaliações em polling de workflow: ele dorme até a janela esportiva calculada pela agenda ou até detectar mudança factual na própria agenda.

## Rollback imediato

Se houver qualquer dúvida após a ativação, execute novamente **Deploy Orchestrator Worker** escolhendo `shadow`.
O Worker continua observando, mas para de criar `workflow_dispatch` no GitHub.

## Fontes do repositório (v1.6.0)

O Worker tenta cada JSON primeiro em `SITE_BASE`. Se o artefato não estiver publicado no Pages ou a fonte pública estiver temporariamente indisponível, ele faz fallback autenticado para o mesmo caminho no branch configurado do GitHub via Contents API. Locks, estados operacionais críticos e os insumos da decisão continental (`estado-editorial-continentais.json`, `status-atualizacao.json`, snapshots de Libertadores/Sul-Americana, histórico continental e `analises.json`) são lidos diretamente da `main`, evitando decisões com uma cópia atrasada do Pages logo após um resultado ou writer esportivo.

O Fine-grained PAT `FDG_ORCHESTRATOR_GITHUB_TOKEN` precisa de:

- `Actions: Read and write` — para `workflow_dispatch` e inspeção de writers;
- `Contents: Read-only` — somente para leitura dos JSON operacionais. Não é concedida escrita em conteúdo.

No `/status`, `hints.fontesRepositorio` informa quais fontes foram lidas pelo fallback do GitHub. Elas não são tratadas como `fontesDegradadas` se a leitura autenticada tiver sucesso.
