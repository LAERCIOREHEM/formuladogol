# AF-Previsão 1.1 — Execução 2.5

## Probabilidades continentais integradas e auditáveis

A Execução 2.5 amplia o AF-Previsão para responder a uma pergunta única e prática:

> **Qual é a chance consolidada de cada clube disputar a Libertadores ou a Sul-Americana, considerando todos os caminhos regulamentares disponíveis?**

A resposta deixa de depender apenas da posição final projetada no Campeonato Brasileiro. Em cada universo simulado, o sistema também considera os desfechos possíveis da Copa do Brasil, da CONMEBOL Libertadores e da CONMEBOL Sudamericana, além das sobreposições e dos repasses de vagas.

A página pública exibirá uma probabilidade consolidada. A decomposição por caminho permanece disponível para detalhamento e auditoria:

- via classificação-base do Brasileirão;
- via Copa do Brasil;
- via título da Libertadores;
- via título da Sul-Americana;
- via repasse regulamentar.

As vias são **mutuamente exclusivas** em cada simulação. Por isso, a soma delas coincide exatamente com a chance consolidada do clube.

---

## 1. Camada factual das competições

O script `scripts/atualizar_competicoes_af_previsao.py` consulta os calendários estruturados da ESPN para:

- Copa do Brasil — `bra.copa_do_brazil`;
- CONMEBOL Libertadores — `conmebol.libertadores`;
- CONMEBOL Sudamericana — `conmebol.sudamericana`.

Para cada evento são normalizados:

- identificador ESPN;
- data e horário;
- fase;
- situação da partida;
- mando;
- placar;
- vencedor;
- decisão por pênaltis;
- clube pertencente ou não à Série A de 2026.

Os snapshots ficam separados do Brasileirão e são validados antes de alimentar o modelo. Falhas temporárias de rede não produzem arquivos vazios: o workflow preserva o último snapshot íntegro.

---

## 2. Modelo de força nas copas

O motor mantém a arquitetura escolhida no backtesting da Execução 1: um modelo log-linear de gols com distribuição de Poisson, estimado por máxima a posteriori — MAP — e regularização gaussiana.

Para cada equipe são estimados parâmetros de ataque e defesa. O modelo inclui ainda vantagem de mando quando aplicável.

Em notação simplificada:

\[
G_{casa} \sim \operatorname{Poisson}(\lambda_{casa}),
\qquad
G_{fora} \sim \operatorname{Poisson}(\lambda_{fora})
\]

\[
\log(\lambda_{casa}) = \mu + h + a_{casa} - d_{fora}
\]

\[
\log(\lambda_{fora}) = \mu + a_{fora} - d_{casa}
\]

onde:

- \(\mu\) representa o nível médio de gols;
- \(h\) representa a vantagem de mando;
- \(a_i\) representa a força ofensiva da equipe \(i\);
- \(d_i\) representa sua proteção defensiva.

### Regularização e partial pooling

Equipes com pouca informação não recebem estimativas extremas. Seus parâmetros são parcialmente atraídos para a média da competição. Conforme novos jogos são observados, o peso dos dados próprios aumenta.

Para clubes da Série A presentes nas copas, o ajuste continental é combinado de forma controlada com a força estimada no Brasileirão. Para clubes estrangeiros ou brasileiros fora da Série A, o parâmetro nasce do histórico disponível na própria competição, com maior regressão à média.

### Decaimento temporal

Partidas recentes recebem peso maior. O decaimento evita que resultados antigos tenham a mesma influência de partidas atuais, sem descartar abruptamente o histórico.

---

## 3. Simulação dos mata-matas

O motor respeita o estado factual de cada confronto:

- placares já ocorridos permanecem fixos;
- jogos futuros são simulados;
- confrontos de ida e volta usam o agregado;
- empate no agregado é resolvido por simulação de pênaltis;
- finais em partida única são tratadas em campo neutro;
- sorteios futuros da Copa do Brasil são simulados quando ainda não foram realizados;
- chaves continentais seguem a ordem estrutural disponível no snapshot.

Uma trava impede a publicação quando uma fase eliminatória deveria ter ida e volta, mas o feed ainda não contém o confronto completo. Nessa situação, a última previsão íntegra é preservada até a sincronização seguinte.

---

## 4. Alocação integrada de vagas

Em cada um dos campeonatos Monte Carlo, o sistema obtém simultaneamente:

1. classificação final do Brasileirão;
2. campeão e vice da Copa do Brasil;
3. campeão da Libertadores;
4. campeão da Sul-Americana.

Em seguida, aplica as regras configuradas para a temporada de 2026.

### Regra de decomposição exclusiva

Para que o detalhamento seja inteligível, a atribuição segue esta ordem:

1. as cinco vagas-base do Brasileirão são atribuídas;
2. títulos continentais classificam clubes que ainda não estavam nessa zona;
3. as vagas da Copa do Brasil classificam clubes ainda não contemplados;
4. toda sobreposição é transformada em repasse pela classificação do Brasileirão;
5. as seis vagas da Sul-Americana são destinadas aos melhores clubes ainda não classificados à Libertadores.

Essa escolha produz uma leitura causal. Se um clube vence uma copa, mas já terminaria na zona-base, sua classificação é contabilizada via Brasileirão e a expansão causada pela sobreposição aparece como repasse.

### Rebaixamento e títulos

Uma equipe rebaixada continua podendo obter vaga continental por título de Copa do Brasil, Libertadores ou Sul-Americana. A posição na liga limita apenas as vagas conquistadas pelo próprio Brasileirão.

---

## 5. Probabilidades muito pequenas não são impossibilidades

O sistema não publica `0,0%` como se representasse impossibilidade matemática.

Quando a frequência estimada fica abaixo do limiar visual de 0,1%, a interface deve mostrar:

> **<0,1%**

O JSON preserva:

- número bruto de ocorrências;
- quantidade total de simulações;
- percentual estimado sem arredondamento visual;
- indicação de zero ocorrências observadas;
- limite superior aproximado de 95% pela **regra dos três**, quando o evento não aparece em nenhuma simulação.

Com 2.000.000 simulações e zero ocorrências, a regra dos três produz um limite superior aproximado de:

\[
\frac{3}{2000000} = 0{,}00015\%
\]

Isso significa que o evento não foi observado no experimento Monte Carlo — não que seja logicamente impossível.

---

## 6. Simulação Monte Carlo

A produção utiliza 2.000.000 universos completos e reproduzíveis. Em cada universo são simulados:

- todos os jogos restantes do Brasileirão;
- todos os confrontos restantes das três copas;
- critérios de classificação;
- sobreposições;
- repasses;
- vagas finais de Libertadores e Sul-Americana.

A frequência de ocorrência de cada evento produz sua probabilidade estimada.

Exemplo conceitual:

\[
\widehat{P}(\text{Libertadores}) =
\frac{\text{universos em que o clube se classifica}}{\text{universos simulados}}
\]

A semente pseudoaleatória é fixa e versionada, permitindo reproduzir exatamente a mesma execução quando os dados de entrada permanecem iguais.

---

## 7. Histórico público e avaliação posterior

O arquivo `dados-br/historico-probabilidades.json` guarda um snapshot somente quando o estado esportivo muda. Horários de coleta e atualizações sem alteração de resultados não criam registros artificiais.

Cada snapshot armazena:

- versão do modelo;
- hash dos dados de entrada;
- probabilidades consolidadas;
- probabilidades-base;
- valores exibidos;
- ocorrências brutas;
- decomposição por via;
- projeção média de pontos.

Ao final da temporada, esse histórico permite avaliar publicamente:

- Brier Score;
- Log Loss;
- calibração por faixas de probabilidade;
- evolução das chances ao longo das rodadas;
- desempenho do modelo em título, classificação continental e rebaixamento;
- diferenças entre previsões iniciais e resultados finais.

A qualidade do modelo não será defendida apenas por exemplos favoráveis. Ela será medida com regras próprias de pontuação e calibração.

---

## 8. Auditoria operacional

Foram criadas duas camadas de segurança:

### Workflow principal

`Atualizar Brasileirao (ESPN)` atualiza os dados do Brasileirão, consulta as três competições e publica a previsão integrada junto com os demais JSONs. A coleta continental usa cache de 45 minutos para reduzir requisições desnecessárias.

### Workflow científico independente

`Auditar AF-Previsão Continental` executa coleta estrita, testes determinísticos, 2.000.000 simulações e validação das decomposições. Ele é somente leitura e não publica artefatos no branch principal.

---

## 9. Limitações declaradas

- A estimação é MAP regularizada, não amostragem MCMC da posterior completa.
- A incerteza publicada decorre principalmente dos resultados futuros; a incerteza dos parâmetros ainda não é amostrada em cada universo.
- Clubes sem histórico doméstico homogêneo recebem maior regressão à média.
- Chaves futuras dependem do que a fonte ESPN já disponibilizou; sorteios ainda inexistentes precisam ser simulados.
- Critérios disciplinares e confronto direto não são simulados de forma homogênea em todos os jogos do Brasileirão; empates residuais usam uma chave reproduzível.
- Mudanças regulamentares exigem atualização da configuração e nova auditoria.

Essas limitações fazem parte da metodologia e não são ocultadas do usuário.

---

## 10. Referências

- Dixon, M. J.; Coles, S. G. (1997). *Modelling Association Football Scores and Inefficiencies in the Football Betting Market*. Journal of the Royal Statistical Society: Series C, 46(2), 265–280. DOI: 10.1111/1467-9876.00065.
- Baio, G.; Blangiardo, M. (2010). *Bayesian hierarchical model for the prediction of football results*. Journal of Applied Statistics, 37(2), 253–264. DOI: 10.1080/02664760802684177.
- Gneiting, T.; Raftery, A. E. (2007). *Strictly Proper Scoring Rules, Prediction, and Estimation*. Journal of the American Statistical Association, 102(477), 359–378. DOI: 10.1198/016214506000001437.
- Robert, C. P.; Casella, G. (2004). *Monte Carlo Statistical Methods*. Springer.
- Projeto Probabilidades no Futebol — Departamento de Matemática da Universidade Federal de Minas Gerais.
- Regulamentos específicos da CBF e da CONMEBOL aplicáveis às competições e à temporada.

---

## Responsabilidade científica

**Desenvolvimento e supervisão matemática: Laércio Rehem**  
Matemático pela Universidade Federal da Bahia — UFBA.

Sugestões, elogios e dúvidas: utilize o botão **SUGESTÕES** do site.

O AF-Previsão é um modelo estatístico informativo. Probabilidades não são certezas e devem ser interpretadas junto com suas hipóteses, incertezas e limitações.
