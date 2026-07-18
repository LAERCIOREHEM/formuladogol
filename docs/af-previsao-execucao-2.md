# AF-Previsão — Execução 2: motor probabilístico e Monte Carlo

## Escopo desta execução

A Execução 2 transforma o protocolo selecionado na Execução 1 em um motor automático para o Brasileirão 2026. Ela **não altera a interface do site**: gera os JSONs, a auditoria e a integração com o workflow. A apresentação pública e a metodologia editorial completa pertencem à Execução 3.

Foram implementados:

- ajuste do modelo vencedor com 2023–2025 e todos os jogos concluídos de 2026;
- previsão probabilística de todas as partidas restantes;
- 200.000 simulações completas do campeonato;
- probabilidades de título, G4, G6, Libertadores-base, Sul-Americana-base e rebaixamento;
- distribuição das 20 posições e intervalo projetado de pontos para cada clube;
- histórico versionado por hash dos dados de entrada;
- auditoria de convergência, integridade e sensibilidades;
- execução automática no workflow ESPN do Brasileirão.

## Arquitetura publicada

A arquitetura de produção é o **Poisson log-linear ajustado pelo modo posterior (MAP), com priors gaussianos e partial pooling**. Cada equipe recebe parâmetros de ataque e defesa na escala logarítmica, somados a um intercepto da competição e à vantagem média de mando.

Para uma partida entre mandante `i` e visitante `j`, o motor estima intensidades de gols do tipo:

```text
log(λ_casa) = μ + mando + ataque_i − defesa_j
log(λ_fora) = μ + ataque_j − defesa_i
```

Os priors aproximam equipes com pouca evidência da média da Série A. Isso é especialmente importante para promovidos e clubes que ficaram fora de uma ou mais temporadas recentes. O peso das partidas antigas decai com meia-vida de **365 dias**.

Os hiperparâmetros de produção são os selecionados no fold temporal mais recente da Execução 1, cujo teste foi a temporada de 2025. Essa regra evita criar, por média, uma configuração que nunca tenha sido efetivamente avaliada.

### O que “bayesiano” significa nesta versão

A versão 1.0 usa **regularização bayesiana por MAP**, e não amostragem MCMC da distribuição posterior completa. A incerteza publicada vem dos resultados futuros simulados. Essa distinção é registrada para evitar a afirmação incorreta de que a versão atual integra toda a incerteza dos parâmetros.

## Dixon–Coles: implementado, testado e não forçado

A correção Dixon–Coles está implementada no motor e é recalculada como análise de sensibilidade. Contudo, a Execução 1 mostrou que ela melhorou o diagnóstico de calibração, mas piorou Log Loss, Brier e RPS no conjunto fora da amostra. Por isso, a versão 1.0 mantém `rho = 0` na produção e registra o cenário `rho = 0,08` na auditoria.

Essa decisão é deliberadamente científica: o projeto não ativa uma técnica apenas por prestígio bibliográfico. O parâmetro será reavaliado em versões futuras e só será promovido à produção se houver evidência fora da amostra.

Na base corrente, a sensibilidade com `rho = 0,08` alterou as probabilidades 1X2 em média em **1.2486 ponto percentual**, com máximo de **2.1409 pontos percentuais**.

## AF-Score

O AF-Score atual foi comparado ao vetor de força do modelo MAP. A correlação de Pearson observada foi **0.776**. Apesar da associação relevante, o AF-Score não altera as probabilidades de produção, pois não existe a mesma cobertura estatística detalhada em 2023–2025 para um backtesting temporal equivalente. Incluí-lo apenas em 2026 poderia favorecer artificialmente o modelo e produzir vazamento metodológico.

## Simulação Monte Carlo

Cada uma das 201 partidas restantes recebe uma distribuição de placares. O campeonato completo é então simulado **200.000 vezes**, preservando a tabela oficial já realizada e aplicando, em cada universo simulado:

1. três pontos por vitória e um por empate;
2. pontos;
3. número de vitórias;
4. saldo de gols;
5. gols pró.

Quando clubes permanecem rigorosamente empatados após esses quatro critérios esportivos, a versão 1.0 usa uma chave pseudoaleatória reproduzível. Isso ocorreu em **0.630%** das simulações. Confronto direto e cartões não são simulados porque os dados necessários não estão disponíveis de forma homogênea para todas as partidas futuras. A limitação está explícita na auditoria.

## Convergência numérica

- erro padrão máximo teórico para uma probabilidade binária: **0.1118 p.p.**;
- margem máxima aproximada de 95%: **0.2191 p.p.**;
- maior diferença observada entre as duas metades da simulação: **0.4300 p.p.**.

O workflow bloqueia a publicação se a maior diferença entre metades ultrapassar 1,0 ponto percentual. A semente é fixa e versionada: com os mesmos arquivos de entrada, o script gera exatamente os mesmos resultados e hashes.

## Zonas publicadas

- **Campeão:** 1º lugar;
- **G4:** 1º ao 4º;
- **G6 / Libertadores-base:** 1º ao 6º;
- **Sul-Americana-base:** 7º ao 12º;
- **Rebaixamento:** 17º ao 20º.

As expressões “Libertadores-base” e “Sul-Americana-base” são intencionais. Títulos de Copa do Brasil, Libertadores ou Sul-Americana podem redistribuir vagas. O motor não antecipa essas vagas extraordinárias antes de sua confirmação.

## Snapshot gerado com o repositório analisado

- data de referência: **2026-07-16T21:24:00-03:00**;
- jogos concluídos: **179**;
- jogos restantes: **201**;
- previsões individuais geradas: **201**;
- simulações: **200.000**.

### Maiores chances de título no snapshot

| Clube | Título | Libertadores-base | Pontos médios |
|---|---:|---:|---:|
| Palmeiras | 66.7695% | 99.9915% | 78.7 |
| Flamengo | 32.4265% | 99.8840% | 74.8 |
| Fluminense | 0.4120% | 75.3365% | 60.6 |
| Botafogo | 0.1450% | 61.5580% | 58.2 |
| Athletico-PR | 0.1115% | 56.5665% | 57.5 |

### Maiores riscos de rebaixamento no snapshot

| Clube | Rebaixamento | Pontos médios |
|---|---:|---:|
| Chapecoense | 99.7825% | 26.5 |
| Remo | 65.9250% | 41.2 |
| Vasco da Gama | 56.9150% | 42.3 |
| Santos | 44.3780% | 44.1 |
| Mirassol | 30.5430% | 46.0 |

Esses números são apenas o snapshot produzido pelos dados atuais. O workflow recalcula o modelo inteiro após novas partidas concluídas.

## Arquivos produzidos

- `scripts/gerar_probabilidades_brasileirao.py`: motor de ajuste, previsão e Monte Carlo;
- `dados-br/probabilidades-brasileirao.json`: dados destinados à interface;
- `dados-br/auditoria-probabilidades.json`: parâmetros, integridade, convergência e limitações;
- `dados-br/historico-probabilidades.json`: série de snapshots identificados pelo hash da entrada;
- `dados-br/config-af-previsao.json`: configuração versionada;
- `.github/workflows/atualizar-brasileirao.yml`: integração automática;
- `docs/af-previsao-execucao-2.md`: este relatório.

## Travas automáticas

O workflow interrompe a publicação quando:

- a base histórica não possui 1.140 jogos;
- resultados concluídos divergem da tabela oficial;
- concluídos e restantes não totalizam 380;
- alguma simulação não termina com 38 jogos por clube;
- as chances de campeão não somam 100%;
- G4 ou rebaixamento não somam 400%;
- G6, Libertadores-base ou Sul-Americana-base não somam 600%;
- alguma distribuição de posições não soma 100%;
- existem NaN, infinito ou probabilidades fora de 0–100%;
- a diferença entre as metades da simulação ultrapassa 1,0 p.p.;
- o histórico está vazio;
- o número de simulações cai abaixo de 200.000 no workflow de produção.

## Limitações assumidas

- O ajuste é MAP regularizado, não amostragem MCMC da posterior completa.
- A incerteza publicada vem dos resultados futuros simulados; a versão 1.0 não amostra incerteza dos parâmetros.
- Vagas continentais são cenários-base e podem mudar após títulos em copas.
- Confronto direto e cartões não são simulados; empates residuais após pontos, vitórias, saldo e gols pró usam chave reproduzível.
- AF-Score não altera a previsão enquanto não houver backtesting histórico comparável.

## Próxima etapa

A Execução 3 criará a interface responsiva em **Estatísticas → Probabilidades**, a tabela por clube, os destaques, a distribuição de posições e a metodologia pública em dois níveis: explicação acessível e nota técnica completa com referências bibliográficas.

## Referências centrais

1. Dixon, M. J.; Coles, S. G. (1997). *Modelling Association Football Scores and Inefficiencies in the Football Betting Market*. Journal of the Royal Statistical Society: Series C, 46(2), 265–280. DOI: 10.1111/1467-9876.00065.
2. Baio, G.; Blangiardo, M. (2010). *Bayesian hierarchical model for the prediction of football results*. Journal of Applied Statistics, 37(2), 253–264. DOI: 10.1080/02664760802684177.
3. Constantinou, A. C.; Fenton, N. E. (2012). *Solving the problem of inadequate scoring rules for assessing probabilistic football forecast models*. Journal of Quantitative Analysis in Sports, 8(1). DOI: 10.1515/1559-0410.1418.
4. UFMG — Departamento de Matemática. *Probabilidades no Futebol*. Referência brasileira histórica de divulgação e simulação probabilística do Campeonato Brasileiro.

## Autoria e supervisão matemática

Metodologia AF-Previsão desenvolvida para o site **Brasileirão 2026 — Almoço de Sexta**, sob supervisão de **Laércio Rehem, matemático pela Universidade Federal da Bahia (UFBA)**.

Para sugestões, elogios ou dúvidas metodológicas, utilize o botão **SUGESTÕES** do site.
