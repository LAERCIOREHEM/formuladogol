# Runbook — Postgame Factual Integrity Guard

## Objetivo

Impedir publicação de público/renda semanticamente incoerentes sem transformar a auditoria em uma revisão cara de todas as partidas.

## Fluxo

`fonte descoberta -> Match Identity Gate -> extração por campo -> Factual Integrity Guard -> publicação`

Se o guard detectar `PUBLIC_REVENUE_FIELD_COLLISION`:

1. público permanece válido;
2. renda e sua URL entram em quarentena;
3. a partida volta a `pending` somente para o campo renda;
4. cache/fontes já conhecidas são rechecados primeiro;
5. Gemini/OpenAI só entram conforme o Hunter normal e somente para a partida afetada;
6. nenhuma varredura histórica global por IA é executada.

## Autoridade

Ordem de precedência:

1. correção documental verificada em `dados-br/correcoes/publicos-verificados.json`;
2. extração determinística de fonte cuja identidade foi provada;
3. Workers AI apenas sobre janela textual já validada;
4. Gemini/OpenAI somente para descoberta de fontes, nunca para gravar números diretamente.

## Health

O relatório diário expõe quatro sinais adicionais:

- Sporting Integrity / R10R16;
- Integridade Factual / Público & Renda;
- Knowledge Base / RAG Readiness;
- Operational Diagnostics / Control Plane.

`RAG READY` significa corpus/manifesto íntegros. Não significa runtime RAG em produção. MCP Ops fica reservado para R10R17. Fine Tuning permanece não utilizado por desenho.
