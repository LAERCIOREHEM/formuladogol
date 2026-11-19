# FDG — R35 | Postgame Accuracy & Alert Reliability
Data-base: 19/11/2026. Escopo: Brasileirão Série A 2026, AF-Previsão, Público/Renda, Health Action Center e GitHub Pages.

## Auditoria dos resultados (snapshot documental E1/E3)

- Total finalizado examinado: **347 jogos** (`dados-br/resultados-af-placares-2026.json`).
- Com prova documental de previsão antes do jogo: **165**; sem prova: **182**.
- Entre as previsões comprovadas, **49** têm acerto do desfecho implícito no placar modal sem acerto do placar exato.
- Desse conjunto, **39** já tinham acerto no V/E/D agregado e **10** não tinham: estes eram classificados apenas como "Sem acerto principal" (ou Top-3 quando aplicável).
- **72** partidas tiveram acerto de V/E/D agregado sem placar exato; isso não equivale a 72 novas correções e há interseção com os 49.

### Regra de interpretação
`modal_hit` = desfecho do `placar_previsto` coincide com desfecho factual.
`top1` = `palpite_resultado_top1` (argmax das probabilidades agregadas de mandante/empate/visitante) coincide com desfecho factual.
`exact` = placar previsto é exatamente igual ao resultado.
`top3` = resultado está entre três placares pré-jogo comprovados.

Esses quatro indicadores são **distintos**. Um modal de 1×1 pode ser o placar individual de maior probabilidade e coexistir com maior probabilidade agregada de vitória do mandante. No Grêmio 0×0 Bahia (18/11), modal 1×1: acerto do desfecho do placar previsto; V/E/D principal mandante: erro; placar exato: erro. **Não alterar o motor científico E4, rankings históricos, probabilidades ou snapshots pré-jogo** por causa do rótulo.

O front `js/br-af-resultados.js` e as páginas estáticas de `scripts/gerar_paginas_jogos.py` classificam todos os jogos documentalmente comprovados seguindo a mesma hierarquia, exibindo o indicador modal separadamente. O teste `tests/test-af-e3-resultados.mjs` percorre **todos os registros atuais**, sem criar previsões para os 182 jogos sem prova.

## Correções factuais R35 (por event_id)

| ESPN | Jogo em 18/11 | Público presente | Pagantes | Renda bruta |
|---|---|---:|---:|---:|
| 401841316 | Corinthians 4×0 Botafogo | 43.576 | 43.190 | R$ 2.802.655,15 |
| 401841314 | Cruzeiro 2×1 Palmeiras | 49.664 | não informado | R$ 2.046.742,50 |
| 401841310 | Remo 2×0 Chapecoense | 13.973 | não informado | R$ 274.020,00 |

Fontes por campo estão em `dados-br/correcoes/publicos-verificados.json`. Para Corinthians, total/renda: UOL; pagantes: ficha técnica do Meu Timão. Cruzeiro: Itatiaia, com identificação explícita dos dois valores. Remo: Diário do Iguaçu (ficha técnica de 18/11). **Jamais usar pagantes para preencher público presente** e jamais estimar o número de pagantes quando omitido.

O parser determinístico de `postgame-fastlane.js` prefere campo "público total" antes de "público" e rejeita valores acompanhados por "pagantes" no campo total. `diregional.com.br` passa a integrar as fontes editoriais identificadas. Continuam em vigor Match Identity, data factual, validação por campo, orçamento mensal e retry gratuito; a publicação estática curada reconcilia o D1 pelo ciclo de seed do Fastlane.

## E-mail/saúde

- Alertas de IA `YELLOW` de **responsabilidade automática** com Hunter abaixo de US$ 5/24h ficam no **digest das 08:00 BRT**, sem e-mail extra. Falhas persistentes ou críticas seguem visíveis no diagnóstico.
- `postgame` com qualquer público/renda pendente **não pode receber e-mail RECUPERADO**. Mesmo `budget_guard` administrativo dentro do SLA não fecha o incidente anterior.
- Incidentes comunicados só são considerados recuperados após **três observações verdes consecutivas** por 10 minutos (cron de 5 minutos, gap máximo de 7 minutos).
- Nova falha durante `recovering` cancela a confirmação sem duplicar o alerta do incidente.
- Recuperação geral nunca é enviada enquanto houver incidentes `recovering`; transição de `YELLOW` para `GREEN` é informada apenas pelo digest, sem e-mail adicional.
- E-mails SMTP por cada workflow de deploy foram removidos de `.github/workflows/deploy.yml`. Falhas de build continuam registradas nas Actions, mas não são confundidas com indisponibilidade real; o Health Monitor verifica o site e trata incidentes reais.

Nenhuma migração D1, aumento automático de limite financeiro, serviço externo novo ou modificação de secrets.

## Validação e publicação

Antes de consolidar na `main`, exigir:
1. `node tests/test-af-e3-resultados.mjs` e `python tests/test-af-postgame-pages.py`.
2. `node tests/test-postgame-fastlane.mjs` (ficha com pagantes antes do total, centavos).
3. `node tests/test-health-action-center.mjs` e `node tests/test-health-monitor.mjs` (anti-flapping, pós-jogo pendente e recuperação real).
4. `python scripts/validar_contrato_publicos_fastlane.py --site-root _site` no pacote publicado, testes da pipeline Pages e `npm run check && npm run test:sports` no Worker.
5. Validar no site `/resultados` e nas páginas `/jogo/` Grêmio × Bahia; verificar público/renda dos três jogos da R35; conferir `/v1/postgame/status` e relatório das 08h.

O deploy de dados curados não prova, por si só, convergência de todas as fontes operacionais: confirmar Pages e reconciliação D1 antes de declarar a operação concluída.
