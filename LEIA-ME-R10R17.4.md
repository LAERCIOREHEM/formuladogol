# R10R17.4 — CONTINENTAL READINESS FALSE-ALARM GUARD

## Alterações
- `readiness-guardian.js`: T+3 aceita estado `in/post` confirmado pelo Sports Monitor mesmo quando o scoreboard ESPN está em `pre`; registra warning explícito, sem esconder o status ESPN.
- `sports-monitor.js`: quando a ÚNICA causa do RED é `espn_still_pre_after_tplus3` em jogo continental com ID válido e monitor inicializado, mantém RED em observação por 10 minutos sem enviar email T+3 imediatamente. Se persistir, o acompanhamento envia alerta crítico uma única vez. Falta de ID, identidade inválida e monitor não inicializado continuam gerando alerta sem adiamento.
- Teste de regressão e workflow PUSH WORKER AUTO atualizados.

## Instalação no GitHub
1. Acesse o repositório `LAERCIOREHEM/formuladogol`, branch `main`.
2. Extraia este ZIP e envie os 4 arquivos mantendo as pastas e substituindo os correspondentes.
3. Commit na `main`.
4. Em Actions, acompanhe **PUSH WORKER AUTO**. Aguarde a conclusão VERDE.
5. Não é necessário executar `Deploy site (GitHub Pages)`, alterar banco D1, secrets ou agendamentos.

## Segurança operacional
- Não modifica detecção de gols, reversão VAR, fila de push, entrega de alertas nem RAG/MCP.
- Alerta RED permanece no estado e banco durante os 10 minutos de carência; só o email de status `pre` é diferido.
- Não confirma correção em produção até o workflow concluir e a telemetria do próximo jogo ser verificada.
