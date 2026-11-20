# CF-COST-SHIELD R2 — Intelligent Cost Governance & Sports Continuity

## Contrato de produção

**Regra inviolável:** o faturamento da Cloudflare não decide se há futebol. Placar ESPN,
monitor de partidas, registro de FINAL, entrega de push, inscrições e healthcheck
continuam ativos em todos os níveis de custo. A API de custos não tem
atualização instantânea; este controlador não é uma garantia de teto monetário
exato de faturamento.

| Situação financeira verificada (USD) | Modo | Ação |
|---|---|---|
| Menos de 2 por dia | normal | operação sem bloqueio |
| De 2 até menos de 5 por dia | observe | observar e registrar tendência; sem desligamento |
| De 5 até menos de 10 por dia | optional_paused | adiar IA, pesquisa de público/renda, melhores momentos e editoriais opcionais |
| A partir de 10 por dia | secondary_paused | também adiar transmissões auxiliares e notificações administrativas não essenciais |
| Projeção mensal maior ou igual a 50 | aviso | métrica de planejamento, **nunca** bloqueio de partidas |
| Custo não verificável por mais de 60 min | unverified | NÃO desligar serviços; chamadas pagas permanecem submetidas a cotas atômicas |
| Alerta D1 alto com métrica recente | secondary_paused | interromper carga secundária, manter futebol essencial |

O custo diário é aferido por lançamentos de ChargePeriodStart compatíveis com
a data de Brasília e/ou pela variação de amostras acumuladas. Os valores são
**observações atrasadas** e podem omitir uso ainda não faturado. A ausência de
um dia/ciclo válido é explícita (costUnverified) e não representa gasto zero.

**Provedores com quotas conservadoras por dia/hora/partida**:
Gemini 80/40/10; OpenAI 32/12/6 (reserva de duas unidades para possível fallback);
Workers AI 120/60/12. Quotas de chamadas são limites operacionais, **não**
estimativas ou garantias de cobrança em USD. O estado de quota é atômico no
Durable Object e reinicia por dia brasileiro. Sob falha do coordenador,
somente as chamadas pagas são suspensas; serviços esportivos continuam.

O Durable Object reutiliza o nome do R1 para preservar histórico, mas o
antigo campo persistente halted deixa de ter autoridade. Não há operação
manual de desbloqueio. A API autenticada /v1/cost-shield/reset responde
com o estado atual, sem alterar critérios.

## Responsabilidades

- **SportsMonitor (10 segundos em janela de jogo):** ESPN e push; nenhum
  acesso repetitivo ao coordenador de cobrança em cada alarme.
- **Worker cron 1 minuto:** manutenção esportiva sempre; pós-jogo oneroso
  apenas quando optionalAllowed; notificações auxiliares somente quando
  secondaryAllowed.
- **Worker cron 5 minutos:** reavalia faturamento e Health Monitor sempre;
  relatório das 8h preservado, inclusive se a API financeira falhar.
- **Orchestrator:** sempre observa e publica FINAL com prioridade.
  Pausa ações opcionais somente no respectivo nível de contenção.
- **HTTP/PWA/push:** sem 503 global por custos; apenas operações opcionais
  explicitamente identificadas podem responder 429.

## Alertas e controles

Um e-mail por escalada de severidade/dia brasileiro, somente nos níveis de
contenção. Nenhum e-mail repetitivo por ausência de fatura. O endpoint
/v1/cost-shield/status divulga version=2, mode, billingVerified,
optionalAllowed, secondaryAllowed, essentialSportsAllowed, custo observado
com hora da última medição e contadores de quota (sem dados de assinantes).

Para avisos de orçamento **sem desligar toda a conta**, usar *Budget alerts*
no painel Cloudflare. Não ativar *Spending limits* de Workers/Durable Objects
como proteção primária de produção: limites nativos interrompem a própria
execução do produto em toda a conta.

Referências oficiais:
- https://developers.cloudflare.com/billing/manage/billable-usage/
- https://developers.cloudflare.com/billing/manage/spend-management/
- https://developers.cloudflare.com/billing/manage/budget-alerts/

## Verificação

- Regressões: cloudflare/push-worker/tests/test-cost-shield.mjs e
  cloudflare/orchestrator-worker/tests/cost-governance.test.mjs.
- CI: CF-COST-SHIELD R2 — Regression.
- Prova independente pós-deploy: CF-COST-SHIELD R2 — Production Smoke.
- Estado esperado durante falha Billing: mode=unverified,
  halted=false, essentialSportsAllowed=true e monitor ESPN em execução.
- Custos reais são confirmados exclusivamente por fonte de faturamento
  válida; billingVerified=false é diagnóstico, nunca um valor USD inventado.
