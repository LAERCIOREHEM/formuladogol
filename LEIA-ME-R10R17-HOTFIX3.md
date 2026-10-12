# Fórmula do Gol — R10R17 HOTFIX 3 — TEST SYNC

## Incidente

O Push Worker AUTO parou em `npm run test:sports`, no arquivo `cloudflare/push-worker/tests/test-ai-router.mjs`, linha 23:

`AssertionError: 9 !== 8`

O Search Profile foi atualizado para versão 9 no HOTFIX 2, mas esse teste de integração ainda exigia versão 8. `test-postgame-fastlane.mjs` já exigia 9 e passou no GitHub. Não é erro de coleta, da API ou das credenciais: é asserção obsoleta no teste.

## Alteração

- `cloudflare/push-worker/tests/test-ai-router.mjs`: `POSTGAME_SEARCH_PROFILE_VERSION` esperado passa de 8 para 9; comentário alinhado à versão 9. Nenhuma alteração de runtime.
- `.github/workflows/deploy-push-worker.yml`: workflow integral da versão atual do `main`, incluído para preservar o pacote completo e a validação/deploy automático. O conteúdo do workflow é idêntico ao já publicado; não é necessário alterar sua lógica.

## Aplicação

1. Extraia o ZIP.
2. No repositório `LAERCIOREHEM/formuladogol`, use **Add file > Upload files**, mantendo os caminhos de pastas exatamente como no ZIP.
3. Faça commit em `main`. O workflow **Deploy Push Worker AUTO** é disparado pelo caminho `cloudflare/push-worker/**`; não é necessário executar manualmente.
4. Aguarde `npm run test:sports` passar e depois confira os passos de deploy e smoke test. Não publique outro HOTFIX 2 novamente: esta entrega é complementar.

## Validação

- `node tests/test-ai-router.mjs` — PASS
- `node tests/test-postgame-fastlane.mjs` — PASS
- `node tests/test-resultados-freshness.mjs` — PASS
- `node tests/test-ops-intelligence.mjs` — PASS
- `node --check tests/test-ops-mcp.mjs` — PASS
- `node --check src/ops-mcp.js` — PASS
- Auditoria das referências executáveis a `POSTGAME_SEARCH_PROFILE_VERSION`: ambas exigem 9.
- `npm run test:sports` completo não foi executado neste ambiente, por ausência de dependências npm locais; o GitHub tem `npm install` no workflow.

## Nota operacional

O patch não altera valores de público/renda, Match Identity Gate, política de IA, D1, Worker ou endpoints. Corrige somente o contrato de teste que impediu o deploy.
