# EXECUÇÃO R10R19 — AI Failure Elimination & Provider Reliability

## Escopo aplicado
- **Workers AI**: `source-extraction-cache.js` mantém um cache por evento, URL, modelo e SHA-256 do trecho da fonte já aprovado pelo Match Identity Gate. Reutilização positiva: 6h; resultado negativo/erro: 20min. Qualquer alteração no conteúdo ou no modelo invalida o cache. Toda reutilização é novamente verificada pelo `validatePublicPayload` e pelos guardas factuais em `postgame-fastlane.js`.
- **Gemini**: quando `/v1beta/interactions` devolve HTTP 400, 404, 405 ou 422, o Worker persiste um cooldown de compatibilidade de **6h** no D1 e usa `generateContent` com Google Search em chamadas futuras. Após o prazo, a rota Interactions é testada novamente. Respostas 429 não acionam o cooldown de compatibilidade.
- **Telemetria**: o Health Monitor conserva a contagem **real** das tentativas com erro nas últimas 24h e expõe `providerFailureSummary`, distinguindo sucesso posterior no mesmo evento/finalidade de tentativas sem sucesso posterior e daquelas vinculadas a partidas ainda pendentes. `providerFailureRows[].impact` indica o enquadramento por linha.
- **Logs Gemini**: mensagens HTTP com códigos/status tornam a investigação de incompatibilidade mais específica, com redação de padrões conhecidos de chave. Nunca se registra o prompt na linha de diagnóstico.

## Preservações contratuais
- Nenhuma mudança no limite de **US$ 1 por evento**, **US$ 50 por mês** ou nos avisos de custo diário.
- Nenhuma alteração no Match Identity Gate, no isolamento do trecho da partida, na quarentena de fatos, no esquema do D1 ou na prioridade ESPN/parser determinístico.
- **Falhas não foram apagadas do histórico.** A contagem de 24h naturalmente cairá quando os erros antigos saírem da janela; até lá, é legítimo aparecer um número positivo de erros com saúde geral verde e zero pendências.
- Nada força novas pesquisas pagas ou usa respostas de IA como autoridade direta para público/renda.

## Verificação
- `npm run check`
- `npm run test:sports`, incluindo `test-source-extraction-cache.mjs`, `test-ai-router.mjs`, `test-health-monitor.mjs` e `test-health-action-center.mjs`.
- Após deploy, acompanhar `/v1/health-monitor/status` e o relatório das 08h: comparar novas falhas por provedor **após** o deploy, tentativas de busca, `providerFailureSummary.activeUnresolved`, custo e completude do Brasileirão.

## Limites do diagnóstico
- HTTP 400/404 pode ter causas externas distintas. O cooldown evita chamadas sabidamente incompatíveis; não corrige credenciais/modelos rejeitados em ambas as rotas.
- Sem consultar o D1 em produção não é possível atribuir individualmente as 70 falhas originais a uma causa nem garantir zero falhas futuras em provedores externos.
- Caso necessário, rollback por revert do PR. Registros de cache no `postgame_meta` são ignorados pelo código anterior, sem migration/destruição de dados.
