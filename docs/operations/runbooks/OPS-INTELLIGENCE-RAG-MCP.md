# R10R17 — FDG Ops Intelligence / RAG + MCP

## Objetivo

Transformar o corpus operacional da R10R16/R10R16.1 em uma camada consultável por agentes sem colocar IA no caminho crítico esportivo.

Fluxo:

`Health / Reliability / Postgame -> RAG operacional -> MCP read-only -> modelo do cliente -> diagnóstico`

O RAG recupera contexto. O modelo do cliente interpreta. Os motores determinísticos continuam sendo a autoridade para placar, tabela, AF, público e renda.

## RAG operacional

- Runtime: `fdg-ops-rag` v1.
- Índice: `/dados-br/ops-rag-index.json`.
- Recuperação: BM25 lexical determinístico com boost de heading/path/frase.
- Corpus: contratos, runbooks, rollback e incidentes reais em `docs/operations`.
- Custo por retrieval: zero chamada externa de IA e zero busca web.
- Cache do Worker: 5 minutos.
- Falha do índice: fail-open para todos os pipelines esportivos.

O índice não contém placares como fonte de autoridade e não pode sobrescrever dados do site.

## MCP Ops

Endpoint: `https://push.formuladogol.com.br/mcp`

Contrato:

- MCP moderno `2026-07-28` via Streamable HTTP.
- Compatibilidade stateless com clientes MCP da era 2025 provida pelo SDK oficial.
- Somente leitura.
- Nenhuma ferramenta de commit, deploy, escrita D1, alteração de JSON esportivo, edição de secrets ou acionamento de workflow.
- Rate limit compartilhado do Push Worker.
- Se `OPS_MCP_TOKEN` existir no ambiente, Bearer token passa a ser obrigatório; o workflow aceita o secret GitHub opcional `OPS_MCP_TOKEN`, replica-o no Worker e usa-o no smoke test. Sem esse secret, o gateway expõe apenas o conjunto público/read-only e limitado abaixo.

### Tools

1. `fdg_ops_status` — estado RAG/MCP.
2. `fdg_rag_search` — recuperação no corpus operacional.
3. `fdg_incident_lookup` — busca focada em incidentes/regressões.
4. `fdg_reliability_context` — CORE/ENRICHMENT, auditoria factual e Orchestrator.
5. `fdg_postgame_status` — resumo seguro do Postgame Fastlane sem executar pesquisa/IA.

### Resources

- `fdg://ops/rag-manifest`
- `fdg://ops/reliability`

## Autoridade e segurança

RAG/MCP podem explicar e localizar precedentes; não podem decidir nem gravar fatos esportivos.

- placar: fonte estruturada + contratos determinísticos;
- classificação: cálculo determinístico;
- probabilidades: AF determinístico de 2 milhões de simulações;
- público/renda: Match Identity + Factual Integrity + correção verificada;
- RAG: diagnóstico/contexto;
- MCP: leitura/orquestração de contexto para o modelo cliente.

## Health

O Health Policy v10 separa cinco indicadores de confiabilidade/inteligência:

1. Sporting Integrity / R10R16;
2. Integridade Factual / Público & Renda;
3. Knowledge Base / RAG Runtime;
4. Operational Diagnostics / Control Plane;
5. MCP Ops / Read-only Gateway.

Fine Tuning continua `not_used_by_design`.
