# FDG — HOTFIX R10R17-HF2 — Público/Renda 30ª rodada + Match Competition Guard

Baseline validado em `main` GitHub, commit `df14788b5` (11/10/2026 20:45 BRT). Este pacote altera 6 arquivos operacionais + este README, preservando os diretórios.

## Correções documentais, por event_id

| Event ID | Jogo | Público presente | Pagantes | Renda bruta |
|---|---|---:|---:|---:|
| 401841258 | Atlético-MG 2 x 1 Santos | 29.777 | não informado | R$ 1.609.117,32 |
| 401841261 | Palmeiras 4 x 1 Corinthians | 30.112 | não informado | R$ 2.893.994,24 |
| 401841267 | Grêmio 1 x 1 Internacional | 53.528 | não informado | R$ 4.106.188,74 |
| 401841263 | Flamengo 1 x 0 Fluminense | 63.300 | 58.246 | R$ 7.006.350,00 |

Os três primeiros números vêm das fontes fornecidas pelo usuário (No Ataque e UOL). O quarto foi descoberto durante a auditoria, confirmado por SBT Sports e Terra/Jogada10. Nenhum pagante é inferido.

## Incidentes identificados

- Gre-Nal: valor de 55.337 foi indevidamente associado à rodada 30, com fonte da seção Copa do Brasil. O Match Identity Gate antigo exigia dois clubes e contexto, mas não bloqueava categoria de competição na URL sem data.
- Flamengo x Fluminense: renda R$ 1.245.363 vinha de URL antiga do Campeonato Carioca; duas fontes atuais registram R$ 7.006.350.
- Atlético-MG x Santos e Palmeiras x Corinthians: faltavam público e renda mesmo após Actions verdes.
- Workflow com `origem_fastlane=true` apenas importava D1; se não havia dado novo, encerrava com sucesso, sem acionar fallback determinístico/IA.

## Alterações estruturais

- `postgame-search-profile.js`: Search Profile 8 → 9; rejeita URLs de outra competição por segmento editorial de diretório, sem bloquear menções à competição no slug do artigo.
- `test-postgame-fastlane.mjs`: regressões de Gre-Nal, Carioca e fonte correta do Brasileiro.
- `auditar_publicos_identidade.py`: auditoria offline detecta fonte de competição incompatível mesmo quando a URL não tem data; mantém schema 2.
- `atualizar-publicos-brasileirao.yml`: quando a importação Fastlane não resolve público e renda, aciona apenas coleta determinística do evento e, se ainda necessário, fallback IA com grace 30min/backoff. Não roda se o snapshot local ainda não está FINAL.
- `deploy-push-worker.yml`: smoke exige Search Profile 9 e mantém os testes MCP R10R17/HF1.
- `publicos-verificados.json`: correção documental autoritativa por campo/event_id. O workflow de públicos, disparado pelo push, reconsolida `publicos-complementares.json`, `jogos-detalhes.json`, `estatisticas-competicao.json` e auditorias.

## Implantação

1. Extraia este ZIP.
2. GitHub → Add file → Upload files. Selecione os 6 arquivos modificados e este README preservando a estrutura das pastas.
3. Commit diretamente em `main`.
4. Verifique os workflows **Atualizar públicos do Brasileirão**, **Deploy Push Worker**, **Deploy site (GitHub Pages)** e **Reliability Control Plane CI**. Não execute manualmente o Orchestrator.
5. No snapshot publicado, confirme os quatro valores acima. O `Deploy site` pode executar antes do workflow de públicos e publicar um snapshot transitório; aguarde o commit de consolidação e o deploy subsequente.

## Validações locais realizadas

- Testes Node `test-postgame-fastlane.mjs`: PASS (inclusive regressões de competição).
- Auditoria Python `--self-test`: PASS.
- YAML parse e bash -n de cada step: PASS.
- Merge curado sobre Gre-Nal/Flamengo contaminados: PASS; propagação para detalhes: PASS; auditoria final do fixture: 0 críticos.
- Testes completos de GitHub Actions, smoke pós-deploy e disponibilidade real em produção: pendentes até implantação.

## Nota de risco

A trava de competição atua em novos candidatos do Fastlane e na auditoria de publicação. Correções verificadas também prevalecem sobre D1. O sistema continua sujeito a outros tipos de erro semântico que não sejam detectáveis por URL/categoria e exigem prova documental.
