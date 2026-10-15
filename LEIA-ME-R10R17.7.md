# FDG R10R17.7 — HIGHLIGHT COMPETITION ELIGIBILITY GUARD

## Regra de negócio (definitiva)
Melhores Momentos são exigidos/monitorados apenas em `bra.1` (Brasileirão Série A).
`conmebol.sudamericana`, `conmebol.libertadores`, `bra.copa_do_brazil` e toda liga não-`bra.1` são dispensados.
Liga ainda não identificada fica em `eligibility_pending`, sem buscas e sem alerta.

## O que foi corrigido
- Push Worker Fastlane v15: seed/upsert, fila claimDue, migração de linhas legadas no D1, API/status.
- Health Action Center: inclui somente `bra.1` em highlight_pending, highlight_overdue e lista de pendências.
- Orchestrator: deixa de acionar workflows para highlights da Copa do Brasil e CONMEBOL. Mantém Melhores Momentos do Brasileirão e editoriais Copa/CONMEBOL.
- Workflow editorial da Copa do Brasil: não executa mais busca YouTube de MM.
- Preserva históricos de gols, público, renda, tentativas e JSON de vídeos antigos; não remove dados.
- Versões sincronizadas no Worker: `postgameFastlaneVersion` e `postgameAttendanceHunterVersion` em 15; versão do Health Monitor permanece em 12.

## Instalação via GitHub
1. Extraia este ZIP em uma pasta nova.
2. Abra o repositório LAERCIOREHEM/formuladogol na branch `main`.
3. Use **Add file > Upload files** na raiz do repositório e envie as pastas `.github` e `cloudflare` extraídas, preservando subpastas. Confirme que os 11 arquivos abaixo aparecem como mudanças.
4. Um único commit: `R10R17.7 - Highlight Competition Eligibility Guard`.
5. Aguarde **Deploy Push Worker** e **Deploy Orchestrator Worker** em Actions. Ambos devem ficar verdes. O workflow da Copa do Brasil foi alterado, mas não precisa ser executado agora.
6. Não envie os arquivos `LEIA-ME-*` e `MANIFESTO-*`, que são apenas documentação. Não rode manualmente o workflow "Atualizar melhores momentos continentais".

## Estado esperado em produção
- O cron de 1 minuto do Push Worker migra o D1 para política v15. Histórico dispensado passa a `highlight_status=not_applicable` e `highlight_next_at=NULL`.
- https://push.formuladogol.com.br/v1/postgame/status: `storedPolicyVersion:15`, `highlightRequiredLeague:'bra.1'`, `highlightPending` contando somente Brasileirão.
- https://push.formuladogol.com.br/health: `postgameFastlaneVersion:15`, `postgameHighlightEligibilityGuard:true`.
- https://push.formuladogol.com.br/v1/health-monitor/status: o item Melhores Momentos não inclui Atlético-MG x Montevideo City Torque nem outras copas. Na próxima rotina de Health, o incidente amarelo anterior será encerrado automaticamente.
- O Orchestrator para de disparar tarefas automáticas de MM de Copa e CONMEBOL. Continua editorial e MM Brasileirão.

## Testes efetuados localmente
- Push Worker `npm run check`: PASS.
- SQLite real: elegibilidade Bra.1/Copa/CONMEBOL, migração v13->v15, reclassificação e preservação: PASS.
- Postgame Fastlane, Action Center, Health Monitor e snapshot D1: PASS.
- Orchestrator `npm run validate`: 82/82 testes PASS (repositório completo disponível localmente).
- YAML dos workflows: PASS.
- `npm run test:sports` integral não iniciou localmente por ausência do módulo externo `@block65/webcrypto-web-push`; o workflow instala dependências via npm antes do teste. Resultado final requer Actions verde.

## Observações
Este patch não precisa de migração manual D1, secrets adicionais, ou deploy separado de GitHub Pages. Evite recolocar versões antigas de `postgame-fastlane.js`, `health-monitor.js` e `orchestrator-state.js` após publicar. O workflow continental manual continua disponível no GitHub, mas deixa de ser chamado automaticamente; NÃO o execute. 
