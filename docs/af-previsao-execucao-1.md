# AF-Previsão — Execução 1

## Base histórica, comparação de modelos e backtesting

**Versão:** AF-Previsão 0.1 — protocolo de seleção  
**Supervisão matemática:** **Laércio Rehem**, matemático pela Universidade Federal da Bahia (UFBA).  
**Sugestões, elogios e dúvidas:** utilize o botão **SUGESTÕES** do site.

## Finalidade desta execução

Esta etapa constrói a fundação científica do futuro módulo de probabilidades do Brasileirão. Ela **não publica ainda percentuais de título, classificação continental ou rebaixamento**. Seu objetivo é impedir que a interface seja criada antes de existir uma validação temporal rigorosa do motor estatístico.

Foram normalizadas e auditadas as temporadas completas de **2023, 2024 e 2025**, totalizando **1.140 partidas**. A temporada de 2026 é mantida separada: entra apenas como estado corrente na próxima execução e nunca é tratada como campeonato concluído.

## Protocolo de validação

O backtesting respeita a ordem temporal. Nenhuma partida futura participa da previsão de uma partida passada. Foram usados dois testes fora da amostra:

### Teste em 2024

Treinamento: 2023; 380 partidas de treinamento e 380 partidas integralmente fora da amostra.
### Teste em 2025

Treinamento: 2023, 2024; 760 partidas de treinamento e 380 partidas integralmente fora da amostra.

Cada teste possui ainda uma validação interna cronológica na temporada anterior para escolher hiperparâmetros sem consultar o campeonato testado.

## Modelos comparados

1. **Frequência histórica regularizada:** referência simples de vitórias do mandante, empates e vitórias do visitante.
2. **Poisson regularizado empírico-bayesiano:** estima forças ofensivas e defensivas com regressão à média por pseudo-observações.
3. **Poisson log-linear MAP:** ajusta ataque e defesa na escala log com priors gaussianos e escolhe o modo posterior; é uma aproximação bayesiana determinística, sem MCMC.
4. **Poisson temporal com correção Dixon–Coles:** acrescenta decaimento temporal e corrige a dependência dos placares baixos — especialmente 0–0, 1–0, 0–1 e 1–1.
5. **Elo dinâmico:** atualiza a força das equipes após cada resultado, considerando mando e margem do placar.
6. **Híbrido Dixon–Coles + Elo:** combina probabilidades de gols e força dinâmica. O peso da combinação é escolhido apenas na janela de calibração anterior.

O AF-Score não foi usado neste backtesting porque as estatísticas detalhadas históricas não possuem a mesma cobertura de 2026. Incluí-lo apenas na temporada corrente produziria uma comparação desigual e poderia gerar vazamento metodológico. Na Execução 2, sua contribuição será testada de forma controlada, sem substituir o modelo de gols.

## Critérios de escolha

A seleção não usa somente “taxa de acerto”. Probabilidades precisam ser **bem calibradas**, não apenas escolher o lado mais provável. O score de seleção combina:

- **50% Log Loss:** pune com força previsões excessivamente confiantes e erradas;
- **30% Brier Score multiclasse:** mede a distância entre as probabilidades e o resultado observado;
- **20% Ranked Probability Score (RPS):** respeita a ordenação vitória–empate–derrota.

As três métricas são regras de pontuação próprias: um modelo não melhora seu resultado apenas “achatando” probabilidades. O erro de calibração (ECE) é exibido e gera alerta acima de 0,05, mas não decide sozinho o vencedor, pois depende da escolha das faixas e pode oscilar em amostras menores. A acurácia do resultado, os erros de gols, o acerto de placar exato e a oscilação entre blocos cronológicos também são diagnósticos.

## Resultado comparativo

| Posição | Modelo | Log Loss | Brier | RPS | ECE | Acurácia do resultado |
|---:|---|---:|---:|---:|---:|---:|
| 1 | Poisson log-linear MAP | 1.0141 | 0.6074 | 0.2072 | 0.0231 | 50.9% |
| 2 | Poisson regularizado empírico-bayesiano | 1.0142 | 0.6074 | 0.2073 | 0.0246 | 50.5% |
| 3 | Poisson temporal + Dixon–Coles | 1.0150 | 0.6081 | 0.2074 | 0.0189 | 49.9% |
| 4 | Híbrido Dixon–Coles + Elo | 1.0196 | 0.6106 | 0.2090 | 0.0216 | 50.0% |
| 5 | Elo dinâmico | 1.0317 | 0.6185 | 0.2128 | 0.0168 | 48.7% |
| 6 | Frequência histórica | 1.0496 | 0.6320 | 0.2189 | 0.0106 | 48.8% |

### Arquitetura selecionada para a Execução 2

**Poisson log-linear MAP com priors gaussianos** (`poisson_map_bayesiano`).

Obteve o menor score composto do protocolo, com Log Loss 1.0141, Brier 0.6074, RPS 0.2072 e ECE 0.0231. O ganho de Log Loss sobre o segundo colocado foi de 0.01% no conjunto agregado. O resultado é um empate prático com o Poisson regularizado por pseudo-observações, mas o MAP obteve vantagem pequena e consistente no agregado de Log Loss, Brier e RPS. Ele foi escolhido por representar diretamente ataque e defesa na escala log, com priors gaussianos e partial pooling. A correção Dixon–Coles apresentou ECE menor, porém não superou o MAP nas três regras de pontuação próprias; seguirá como análise de sensibilidade.

A escolha é provisória no sentido científico correto: permanecerá versionada e poderá ser substituída se novos backtests demonstrarem ganho real de calibração. O site não declarará superioridade sem evidência mensurável.

## Tratamento dos clubes promovidos

A ausência de um clube em uma ou mais temporadas da Série A não invalida o histórico. O modelo regularizado aplica **partial pooling**: um time novo ou promovido começa próximo da média da competição, com incerteza maior, e passa a receber identidade própria conforme acumula jogos em 2026. Isso é preferível a atribuir força arbitrária ou importar diretamente resultados da Série B, competição de nível e composição diferentes.

## Limitações assumidas

- Escalações, lesões, suspensões e mudanças de treinador ainda não entram como variáveis explícitas.
- O banco histórico desta execução contém resultados e gols, não xG histórico homogêneo.
- O regulamento de vagas continentais pode mudar conforme campeões de outras competições; esse tratamento será configurável na Execução 2.
- A correção Dixon–Coles melhora a representação de placares baixos, mas não elimina toda dependência entre os gols das equipes.
- Probabilidade não é certeza: um evento com 20% continua possível, e um evento com 80% pode não ocorrer.

## Reprodutibilidade

Os arquivos de auditoria registram:

- fontes e hashes da base;
- partidas e clubes por temporada;
- reconstrução independente das classificações;
- hiperparâmetros testados e selecionados;
- métricas por temporada e agregadas;
- versão do protocolo de seleção.

A Execução 2 deverá usar a arquitetura vencedora para estimar cada partida restante e simular o campeonato por Monte Carlo. A Execução 3 cuidará da interface e da metodologia pública completa.

## Referências bibliográficas centrais

1. Dixon, M. J.; Coles, S. G. (1997). Artigo sobre modelagem de placares de futebol. *Journal of the Royal Statistical Society: Series C*, 46(2), 265–280. DOI: 10.1111/1467-9876.00065. A referência é utilizada exclusivamente pela formulação estatística dos placares.
2. Baio, G.; Blangiardo, M. (2010). *Bayesian hierarchical model for the prediction of football results*. Journal of Applied Statistics, 37(2), 253–264. DOI: 10.1080/02664760802684177.
3. Constantinou, A. C.; Fenton, N. E. (2012). *Solving the problem of inadequate scoring rules for assessing probabilistic football forecast models*. Journal of Quantitative Analysis in Sports, 8(1). DOI: 10.1515/1559-0410.1418.
4. UFMG — Departamento de Matemática. *Probabilidades no Futebol*. Referência brasileira de divulgação e simulação probabilística do Campeonato Brasileiro.

## Autoria

Metodologia AF-Previsão desenvolvida para o site **Brasileirão 2026 — Almoço de Sexta**, sob supervisão de **Laércio Rehem, matemático pela Universidade Federal da Bahia (UFBA)**.

Para sugestões, elogios ou dúvidas metodológicas, utilize o botão **SUGESTÕES** do site.
