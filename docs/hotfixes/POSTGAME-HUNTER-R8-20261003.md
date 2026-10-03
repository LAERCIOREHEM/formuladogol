# POSTGAME-HUNTER-R8 — 2026-10-03

Escopo: público/renda do Brasileirão, pós-jogo persistente, controle de custo e Health Report diário.

Principais contratos:
- Attendance/Revenue Hunter v6.
- Gemini + Google Search: +5/+15/+30/+60/+120 min; depois, a cada 1h.
- OpenAI Web Search (Terra): +45/+90/+120 min; depois, a cada ~3h, sujeito ao budget guard.
- Workers AI: extração das páginas descobertas.
- Não existe GAVE_UP para público/renda; após 2h o estado é OVERDUE e a busca continua.
- Budget guard padrão: US$ 0,25/evento; US$ 10/mês; aviso/limitação OpenAI a 80% do budget mensal.
- E-mail das 08h mostra cobertura, pendências analíticas, tentativas, fontes e custo estimado do Hunter.
- Consolidação GitHub de achado concreto de público/renda não expira após 24h.
- Push de correção documental curada consolida os derivados sem abrir nova pesquisa paga.

Backfill incluído:
- event_id 401841169 — São Paulo 1 x 2 Santos (R21, 02/10/2026)
- Público: 43.398
- Renda: R$ 2.034.540,00
- Fonte: Gazeta Esportiva (ficha técnica).

Workflows de deploy incluídos no pacote:
- .github/workflows/deploy-push-worker.yml
- .github/workflows/deploy-orchestrator-worker.yml
- .github/workflows/deploy.yml
- .github/workflows/atualizar-publicos-brasileirao.yml
