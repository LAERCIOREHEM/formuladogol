# Fórmula do Gol — HOTFIX 6 — Deploy Auto Worker + Integridade Público/Renda

**Base conferida em GitHub `main`:** `20f226e2ddc0cdaa14edb8640e057f85ffe7dcec` (13/10/2026).

## Falha do Deploy Push Worker

O log fornecido prova que o Worker HTTP foi publicado, `/health`, MCP, Hunter e Gemini passaram. A falha ocorreu **somente** no smoke do Durable Object `SportsMonitor`: `goalScorerEnrichmentPolicyVersion=6-R10R5`, enquanto o Worker novo esperava `6-R10R6`. O monitor estava com partida ao vivo, polling recente e zero autores ausentes.

O deploy agora aguarda até 4 minutos para a propagação do Durable Object. Se o DO ainda responder R10R5 **durante jogo ativo**, aceita apenas esse desvio como `::warning::`, desde que o polling seja recente, não haja falha de polling, gol sem autor no despacho, prontidão vermelha ou qualquer outro contrato divergente. **Não reinicia o DO durante jogo ao vivo.** Outros erros continuam fatais. O job fica verde com aviso explícito de propagação pendente, não com falsa afirmação de convergência estrita.

Referência técnica: Cloudflare Durable Objects — *Known issues / Code updates*: Worker novo e DO antigo podem coexistir por segundos ou minutos durante a propagação global.

## Público e renda — correções documentais

- ESPN `401841265` — **Chapecoense 1 × 4 Athletico-PR**: **3.924 presentes**, **R$ 169.490,00**; pagantes **não comprovados** (remover 58.246). Fonte: BOL/UOL, 12/10/2026.
- ESPN `401841266` — **Bahia 1 × 0 Mirassol**: **28.704 presentes**, **R$ 935.545,00**; pagantes **não comprovados** (remover 18.982). Fonte: Bahia Notícias, 11/10/2026.

As correções são por `event_id`, sem alterar Flamengo × Fluminense nem Atlético-MG × Santos.

## Prevenção da recorrência

- **Search Profile v10:** matérias agregadas do ge/Gato Mestre são recusadas no Fastlane por partida; o parser Python de rodada permanece responsável por elas. Uma mera menção aos dois clubes não autoriza apropriar valores de outro jogo.
- **Capacidade:** validação conservadora por estádio efetivo; Arena Condá = 20.089 lugares. Público/pagantes acima da capacidade são recusados pelo Worker e reprovados pela auditoria offline.
- **Auditoria:** identifica público/renda iguais em confrontos distintos da mesma rodada e pagantes não comprovados mantidos indevidamente.
- **Pages e D1:** correção documental explícita com `pagantes_status: nao_divulgado` elimina valores antigos de pagantes no JSON, detalhes e D1. O D1 reconcilia automaticamente a partir do Pages, inclusive correções verificadas mais antigas que 48 horas. O cron existente é preservado.
- **GitHub Actions:** workflow de públicos consolida correções e remove os valores contaminados antes da auditoria e da publicação. O deploy do Worker valida Search Profile v10 e executa regressão do smoke do DO.

## Como instalar — um único Add files

1. **Descompacte o ZIP.** No GitHub `LAERCIOREHEM/formuladogol`, branch `main`, faça **Add file → Upload files** de todos os arquivos, preservando as pastas (`.github/workflows`, `cloudflare/push-worker`, `scripts`, `dados-br/correcoes`). Não envie o ZIP fechado.
2. O push aciona automaticamente **Deploy Push Worker** e **Atualizar públicos do Brasileirão**. A consolidação dos públicos atualiza `dados-br/publicos-complementares.json` e `dados-br/jogos-detalhes.json` e aciona **Deploy site (GitHub Pages)**.
3. No Actions, confira **Atualizar públicos do Brasileirão**, **Deploy Push Worker** e **Deploy site (GitHub Pages)**. Se o Worker mostrar `::warning::` de DO R10R5 durante partida, é **propagação pendente explicitamente registrada**, não confirmação de DO R10R6.
4. Depois do deploy do Pages, confira no site `/resultados`: Chapecoense × Athletico = 3.924 e R$ 169.490; Bahia × Mirassol = 28.704 e R$ 935.545. **Pagantes não devem aparecer** nesses dois confrontos.
5. O Worker atualiza seu D1 na próxima reconciliação periódica; o endpoint `/v1/postgame?event_ids=401841265,401841266` permite verificar `publico`, `publico_pagante` (null) e `renda` após a sincronização.

## Validação local concluída

- `npm run check` — PASS.
- `npm run test:sports` — PASS, inclusive `test-postgame-fastlane.mjs` e `test-ai-router.mjs` com Search Profile v10.
- `node tests/test-scorer-recovery.mjs` — PASS (R10R6 preservado).
- `node tests/verify-monitor-deploy.mjs --self-test` — PASS.
- `python scripts/curar_publicos_hotfix6.py --self-test` — PASS.
- `python scripts/auditar_publicos_identidade.py --self-test` — PASS.
- Teste integrado de `--sem-rede → curar → --sem-rede → auditar` com dados contaminados de ambas as partidas — PASS, sem críticos.
- YAML e `bash -n` de todas as etapas `run` dos dois workflows — PASS.

**Limites:** testes e ZIP foram preparados localmente; o deploy em produção e a convergência do D1/DO dependem da execução no GitHub/Cloudflare. Não afirmar que o site foi corrigido antes de verificar os três workflows.
