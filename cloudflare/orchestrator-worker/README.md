# Fórmula do Gol — Cloudflare Orchestrator

Controlador operacional determinístico do Fórmula do Gol.

## Princípio

- Cloudflare acorda a cada minuto; o caminho rápido lê somente a agenda compacta e sonda a ESPN perto dos jogos.
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

- FINAL ESPN não publicado: detectado no ciclo seguinte de 1 minuto, com idempotência por `event_id`.
- manutenção completa: uma vez ao dia, se ainda não houve sucesso naquele dia.
- públicos: primeira tentativa +15 min; backoff progressivo.
- melhores momentos: primeira tentativa +20 min e backoff esparso; Brasileirão usa `event_id` direcionado.
- player oficial: checkpoints T-90, T-45, T-20, T-5, T+10 e T+30, somente quando a grade permitir.
- TV: 6 h se lacuna <72 h; 24 h em até 14 dias; 72 h em 15–30 dias; 168 h se o mês estiver completo.
- editoriais: fechamento factual da rodada/fase, sem decisão por horário arbitrário.

## Deploy

Use exclusivamente `.github/workflows/deploy-orchestrator-worker.yml`.
Primeiro publique em `shadow`; só depois publique em `active`.

## Custo operacional do ciclo

O tick de 1 minuto não baixa `jogos-detalhes.json` nem executa processamento pesado.
A cada minuto ele lê apenas `agenda-clubes-br.json` e, somente quando há jogo na janela, consulta o scoreboard ESPN.
A avaliação de tarefas lentas roda no máximo a cada 5 minutos e usa artefatos públicos menores.

## Rollback imediato

Se houver qualquer dúvida após a ativação, execute novamente **Deploy Orchestrator Worker** escolhendo `shadow`.
O Worker continua observando, mas para de criar `workflow_dispatch` no GitHub.
