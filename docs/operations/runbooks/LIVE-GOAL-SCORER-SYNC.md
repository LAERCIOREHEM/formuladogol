# R10R17.2 — Live Goal Scorer Synchronization & Persistence Guard

## Incidente de referência

14/10/2026: usuário informou que a notificação de gol continha o autor, mas a página `/aovivo.html` de Boca Juniors × Vasco (Sul-Americana) não exibia o marcador. Identidade de agenda `fdg-conmebol-...`, distinta do ID numérico ESPN. O incidente é evidência da divergência vista pelo usuário, não comprova qual resposta HTTP ocorreu em produção.

## Contrato operacional

- O monitor esportivo persiste os `plays` validados que alimentam a notificação de gol. A página NÃO consulta notificações push já entregues; o Worker expõe o mesmo estado factual canônico via `/v1/live/summary`.
- `/live-facts` do Durable Object encontra a chave da agenda diretamente ou, apenas para ID numérico, aceita o `sourceEventId` ESPN **previamente reconciliado** na watchlist. Um alias ambíguo ou liga divergente falha fechado (404). Não unir jogos pelo nome dos clubes nem apenas pelo placar.
- `fdg-*` não é ID ESPN: o gateway consulta somente o monitor e nunca envia o identificador documental a `resolveLiveSummary`/ESPN. Para IDs numéricos conserva a consulta estatística ESPN e acrescenta Live Facts do monitor quando coincidem com placar esperado.
- O navegador pode solicitar Live Facts para IDs documentais; renderiza autoria somente após confronto entre gols, times e placar. A camada `br-live-goal-sync.js` preserva um autor anteriormente confirmado quando o *mesmo gol e equipe* vierem sem autor, sem ressuscitar autoria após VAR, mudança de placar ou conflito explícito.
- Após FINAL, `matches` ficam disponíveis por até 24 horas desde o kickoff no Durable Object, **sem** aumentar a janela de polling das APIs. Depois da retenção, dependemos dos fatos disponíveis nas fontes históricas ou cache do navegador.
- Nenhuma chamada adicional a Gemini ou OpenAI é criada por esta mudança.

## Testes obrigatórios

1. `node cloudflare/push-worker/tests/test-live-goal-identity.mjs`: identidade documental, alias validado, liga errada e duplicidade.
2. `node tests/test-br-live-goal-sync.mjs`: mesmo gol preservado; gols/equipes diferentes e conflito rejeitados.
3. `node cloudflare/push-worker/tests/test-monitor-live-facts.mjs`, `node cloudflare/push-worker/tests/test-live-facts.mjs`, `node cloudflare/push-worker/tests/test-live-api.mjs`.
4. CI `npm run test:sports` após `npm install` para a integração real Sports Monitor, e workflow Pages com inclusão de `js/br-live-goal-sync.js` no `PUBLIC_JS`.

## Implantação e verificação

1. Publicar Push Worker e GitHub Pages por workflows automáticos no commit em `main`.
2. Verificar se ambos os deploys estão verdes, especialmente `npm run test:sports` e publicação de `js/br-live-goal-sync.js`.
3. Durante um gol continental, comparar autor na notificação e em `/v1/live/summary?league=...&event=...&expectedHome=...&expectedAway=...`, depois conferir `/aovivo.html`.
4. Se o monitor ainda não confirmou a autoria, a página continuará mostrando `Autor sendo confirmado` ou apenas placar — nunca inventar jogador.

## Rollback

Reverter conjuntamente as alterações do Push Worker, JS, HTML e `.github/workflows`, mantendo intacta a R10R17.1. O Fastlane não é alterado.
