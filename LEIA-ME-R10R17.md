# EXECUÇÃO R10R17 — FDG OPS INTELLIGENCE / RAG + MCP

Baseline: commit `2266e9961cc5b5a7c44bd3a1609f3fde0a423548` (R10R16.1 verde).

Entrega:
- RAG operacional em produção, determinístico e sem IA externa por retrieval;
- índice canônico gerado do corpus `docs/operations` (15 fontes / 33 chunks no baseline desta execução);
- MCP oficial 2026-07-28 no Push Worker via `@modelcontextprotocol/server` 2.3.1, com compatibilidade legacy stateless;
- 5 ferramentas e 2 resources, todos read-only;
- `OPS_MCP_TOKEN` é opcional: sem ele o gateway permanece público/read-only + rate limit; com ele, configure o mesmo secret no GitHub para o deploy/smoke autenticado;
- Health/e-mail diário Policy v10 com indicador MCP separado e RAG Runtime real;
- Fine Tuning permanece fora por desenho;
- nenhuma dependência RAG/MCP no caminho crítico esportivo.

Deploy esperado após Add files:
1. Deploy site (GitHub Pages) — publica/atualiza o índice RAG;
2. Deploy Push Worker — publica RAG runtime + MCP + Health v10;
3. Reliability Control Plane CI — valida corpus/index/contratos;
4. Deploy Orchestrator pode rodar por mudança de teste/config, mas o contrato runtime continua 2.4.0.

Não é necessário executar workflow manual se os automáticos concluírem verdes.
