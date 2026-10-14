# Fórmula do Gol — R10R17.3 · LIVE GOAL EVENT INTEGRITY GUARD

**Repositório:** `LAERCIOREHEM/formuladogol`  
**Baseline confirmado no GitHub:** `338a71f79bf79e38897fdd66320bf6b92d162b30`  
**Formato:** patch incremental para aplicar sobre a R10R17.2, preservando arquivos não incluídos.  
**Estado:** criado e testado localmente; **NÃO foi publicado em produção**.

## Correções

1. **Score Rollback Guard:** um placar menor vindo da ESPN permanece candidato. São necessárias **quatro observações e 90 segundos** antes de aceitar uma regressão. Antes disso, o placar e os gols confirmados permanecem estáveis.
2. **Anulações sem push original:** gols ainda pendentes não enviam alertas isolados de `GOL ANULADO`. Gols previamente notificados podem receber correção após confirmação persistente.
3. **Play-by-Play vs scoreboard:** variantes que descrevem anulação não elevam o placar. Quando o CORE adianta um gol legítimo, há uma janela de 120 segundos para o scoreboard alcançar o PBP sem tratar isso como rollback.
4. **Recuperação tardia:** gols legítimos podem ser notificados até **12 minutos** após a primeira detecção; depois disso, o estado é corrigido silenciosamente, evitando notificações históricas.
5. **Outbox D1/Queue:** cron recupera eventos `goal` de até **15 minutos** que foram persistidos em `sports_events`, mas nunca receberam uma linha em `push_event_dispatch`; a recuperação é idempotente.
6. **Página Ao Vivo:** publica autoria canônica do gateway antes de completar uma nova tentativa de estatísticas parciais; nova versão de cache do JavaScript.

## Instalação no GitHub

1. Extraia este ZIP; **não faça upload do próprio ZIP** para o repositório.
2. Abra o repositório, branch `main` e envie os arquivos nas pastas correspondentes, preservando `.github/`, `cloudflare/`, `js/`, `tests/` e `aovivo.html`.
3. Confirme as substituições e faça o commit. Os workflows **Deploy Push Worker** e **Deploy site (GitHub Pages)** possuem gatilho automático na `main`.
4. Em **Actions**, aguarde os DOIS workflows verdes. O deploy Pages sozinho não atualiza o Sports Monitor.
5. Depois do deploy, verifique `https://formuladogol.com.br/aovivo.html` e o endpoint de operações já existente; acompanhe as próximas partidas sem realizar testes simulados na base de produção.

**Não há migração D1**, nem alteração de secrets, RAG, MCP, orquestrador ou algoritmos de probabilidade.

## Cobertura validada

- `npm run check`
- `node tests/test-sports-engine.mjs`
- `node tests/test-sports-monitor.mjs`
- `node tests/test-live-goal-event-integrity.mjs`
- `node tests/test-live-goal-outbox.mjs`
- `node tests/test-push-dispatch.mjs`
- `npm run test:hardening`
- `node tests/test-scorer-recovery.mjs`
- `node tests/test-br-live-goal-sync.mjs`
- `node tests/test-br-classificacao-live.mjs`

**Ambiente:** para testes locais dos módulos de monitor/push foi usada uma substituição temporária, SOMENTE DE TESTE, da dependência de criptografia Web Push não instalada. Nenhum mock entra no ZIP. A suíte `npm run test:sports` passou por todos os testes esportivos/operacionais exceto o teste MCP final, bloqueado porque `@modelcontextprotocol/server` não estava instalado no ambiente local. O workflow instala as dependências oficiais com `npm install` antes de testar e só então publica.

## Verificação esperada após commit

- Push Worker: teste adicional de integridade + teste de recuperação de outbox + suítes existentes, depois deploy Worker.
- Pages: validações existentes, conferência de `br-aovivo.js?v=20261014-r10r17-3`, build e smoke remoto.
- Em jogo ao vivo: o envio push continua sujeito à disponibilidade da ESPN, da Queue, às preferências do assinante e à entrega do navegador. Os testes sintéticos não comprovam entrega em aparelho real.
