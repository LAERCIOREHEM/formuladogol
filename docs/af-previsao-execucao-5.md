# AF-Previsão — Execução 5

**Data de referência:** 18/07/2026  
**Versão do modelo:** AF-Previsão 1.3  
**Versão da avaliação:** AF-Avaliação 1.0

## Objetivo

A Execução 5 transforma o histórico criado nas etapas anteriores em uma base pública realmente auditável e prepara a avaliação científica do modelo sem poluir a página durante o campeonato.

A etapa não altera a arquitetura estatística escolhida, o peso conservador da tendência recente, a simulação Monte Carlo, a integração continental ou a apresentação principal das probabilidades. O foco é assegurar que as previsões registradas agora possam ser comparadas, no futuro, com os resultados efetivamente observados.

## Histórico encadeado

Cada snapshot passa a guardar:

- hash do estado esportivo utilizado na previsão;
- hash do snapshot anterior;
- hash SHA-256 do próprio conteúdo;
- rodada de referência;
- versão do modelo;
- projeção inteira e média bruta de posição;
- distribuição probabilística das 20 posições;
- projeção inteira, média bruta e percentis de pontos;
- probabilidades e ocorrências dos eventos;
- decomposição das vagas continentais;
- tendência recente aplicada.

O hash de cada registro inclui o hash do elo anterior. Assim, uma alteração retroativa em qualquer snapshot quebra a cadeia a partir daquele ponto e é detectada automaticamente.

A migração é não destrutiva: snapshots anteriores são preservados como foram publicados e apenas recebem os campos de encadeamento. Informações que não existiam nas versões antigas não são inventadas retrospectivamente.

## Avaliação durante a temporada

Enquanto o campeonato estiver em andamento, `dados-br/avaliacao-af-previsao.json` publica somente:

- quantidade de snapshots;
- rodadas distintas registradas;
- primeiro e último registro;
- versões do modelo presentes;
- estado da cadeia de integridade;
- métricas planejadas para a avaliação final.

Nenhum Brier Score, Log Loss ou erro final é calculado com eventos ainda não resolvidos. Isso evita uma avaliação enganosa baseada em resultados parciais.

## Condições para a avaliação final

A avaliação só é liberada quando:

1. a tabela contém exatamente 20 clubes;
2. todos os clubes têm 38 partidas;
3. as posições finais formam a sequência de 1º a 20º;
4. Copa do Brasil, Libertadores e Sul-Americana possuem campeão e vice definidos;
5. a cadeia do histórico passa em todas as verificações;
6. existem pelo menos cinco snapshots para publicação sem alerta de amostra reduzida.

Se o Brasileirão terminar antes de alguma competição relacionada às vagas, o sistema permanece em `aguardando_resultados_continentais` e não presume classificados.

## Métricas finais

### Posição

- erro absoluto médio — MAE;
- raiz do erro quadrático médio — RMSE;
- acerto exato;
- percentual dentro de uma posição;
- percentual dentro de duas posições;
- Ranked Probability Score da distribuição completa das 20 posições.

O RPS avalia a distribuição, não apenas a posição arredondada. Um clube projetado principalmente entre 3º e 5º recebe tratamento diferente de outro com média igual, mas distribuição muito espalhada.

### Pontos

- MAE de pontos;
- RMSE de pontos;
- viés médio, para detectar superestimação ou subestimação sistemática.

### Eventos binários

Para campeão, Libertadores, Sul-Americana e rebaixamento:

- Brier Score;
- Log Loss;
- calibração em dez faixas de probabilidade.

As métricas são calculadas por snapshot, no agregado e por versão do modelo. Isso evita misturar silenciosamente versões diferentes quando houver evolução metodológica.

## Vagas continentais observadas

A avaliação não deduz Libertadores e Sul-Americana apenas pela posição da tabela. Depois do encerramento, aplica novamente a mesma regra integrada utilizada na simulação, agora com:

- classificação final real;
- campeão e vice reais da Copa do Brasil;
- campeão real da Libertadores;
- campeão real da Sul-Americana;
- sobreposições e repasses efetivamente decorrentes desses resultados.

Isso mantém simetria entre o evento previsto e o evento posteriormente pontuado.

## Interface

Durante o campeonato, nenhuma nova seção extensa é exibida. Dentro da nota técnica aparece apenas a quantidade de registros e o estado do encadeamento.

Depois que a avaliação final estiver pronta, um bloco é automaticamente revelado no fim da própria aba **Probabilidades**, antes da autoria. Ele não fica embaixo do Ranking de Desempenho, pois mede a qualidade do modelo, e não o desempenho esportivo dos clubes.

O bloco final apresenta os indicadores principais e mantém Brier e Log Loss em um detalhamento recolhido.

## Automação

O workflow principal passa a:

1. gerar o AF-Previsão;
2. encadear e validar o histórico;
3. executar a avaliação em modo estrito;
4. publicar `avaliacao-af-previsao.json` junto com os demais artefatos.

O workflow científico continental também executa os testes determinísticos da avaliação e confirma que a cadeia gerada é íntegra.

## Limitações declaradas

- Snapshots antigos sem distribuição de posições não recebem dados reconstruídos artificialmente; por isso, algumas métricas podem ter amostra menor.
- A avaliação final mede o desempenho do modelo a partir da primeira previsão pública registrada, não desde a primeira rodada do campeonato.
- Resultados de diferentes snapshots não são observações independentes; a série serve para avaliar a evolução prática das previsões, não para inflar artificialmente significância estatística.
- A publicação de métricas não transforma probabilidades em certezas e não substitui a declaração das hipóteses e limitações do modelo.

## Arquivos alterados ou criados

- `scripts/gerar_probabilidades_brasileirao.py`
- `scripts/avaliar_af_previsao.py`
- `dados-br/config-af-previsao.json`
- `dados-br/avaliacao-af-previsao.json`
- `.github/workflows/atualizar-brasileirao.yml`
- `.github/workflows/auditar-af-previsao-continental.yml`
- `estatisticas.html`
- `js/br-estatisticas.js`
- `css/br-estatisticas.css`
- `docs/af-previsao-execucao-5.md`
