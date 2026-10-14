# Incidente — Busca de público/renda indevida na Sul-Americana, 14/10/2026

O Health enviou um alerta de SLA de 120 minutos para Boca Juniors x Vasco da Gama, com o identificador interno `fdg-conmebol-sul-americana-202610132130-boca-juniors-vasco-da-gama`, informando 25 consultas determinísticas ESPN, 8 buscas Gemini e 2 chamadas OpenAI, sem localizar público, pagantes ou renda. O ID tem prefixo documental `fdg-conmebol-`, não é um identificador ESPN.

**Causa:** o Fastlane v13 criava pendências para finais de qualquer liga, e seu `claimDue` selecionava `public_status <> resolved` sem política de elegibilidade. O Health v10 contava esses registros como pendências, tornando permanente a procura por dados não exigidos para Copa do Brasil e competições internacionais.

**Correção R10R17.1:** coletar público/renda somente para `bra.1`; definir estados `not_applicable` e `eligibility_pending`; migração SQL no D1 sem IA nem reinvestigação histórica; impedir reativação por novos seeds; bloquear requisições ESPN por ID documental; restringir pendências e alertas T+120; preservar melhores momentos, monitor continental e Factual Integrity Guard. Ver runbook `POSTGAME-COMPETITION-ELIGIBILITY.md`.

**Verificação:** o teste de integração SQLite cobre Sul-Americana, Libertadores, Copa do Brasil, Brasileirão, identificação desconhecida, reconciliação e migração. O workflow GitHub Actions exige o contrato de produção, e a confirmação da remediação requer a conclusão efetiva do deploy e a inspeção do registro no D1.
