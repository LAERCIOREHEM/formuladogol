# FDG R10R17 HOTFIX1 — MCP-Name Header

Baseline: commit 3c3764b9de2ae49ce380b80a3e14c2c470ef2b2c.

Erro: tools/call HTTP 400 porque o corpo params.name=fdg_ops_status não foi acompanhado pelo cabeçalho obrigatório Mcp-Name.

Correções:
- cloudflare/push-worker/tests/test-ops-mcp.mjs: gera Mcp-Name a partir de params.name em tools/call.
- .github/workflows/deploy-push-worker.yml: inclui -H 'Mcp-Name: fdg_ops_status' no smoke test remoto.

Upload: extrair o ZIP e enviar os arquivos preservando pastas via Add file > Upload files > commit em main.
Workflow: Deploy Push Worker (automático). Se não disparar, executar manualmente Deploy Push Worker.
Não rodar Atualizar Brasileirão, Orchestrator, público/renda ou AF.

Validações locais: node --check PASS; YAML parse PASS; verificação dos blobs originais do baseline PASS. A suíte npm test:sports e o smoke em produção serão executados pelo GitHub Actions após upload.
