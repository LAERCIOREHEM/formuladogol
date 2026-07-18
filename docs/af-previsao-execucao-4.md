# AF-Previsão — Execução 4

**Data de referência:** 18/07/2026  
**Versão do modelo:** AF-Previsão 1.2

## Objetivo

A Execução 4 acrescenta ao motor probabilístico uma leitura conservadora da forma recente, melhora a projeção de posição e pontos finais e integra o histórico de previsões à interface sem criar uma nova seção extensa.

O modelo principal continua sendo o Poisson log-linear regularizado por máxima a posteriori (MAP), selecionado por validação temporal. A forma recente não substitui a campanha acumulada, o mando de campo, as forças ofensiva e defensiva, a tabela restante ou a simulação Monte Carlo.

## Tendência recente

Não foi aplicado Holt-Winters completo porque o Brasileirão não apresenta sazonalidade regular por rodada. A camada adotada é uma EWMA dos resíduos logarítmicos de gols: compara o placar observado de cada clube com a taxa esperada pelo modelo-base e suaviza separadamente ataque e defesa.

Parâmetros de produção:

- janela máxima de 12 jogos por clube;
- ativação somente após seis jogos;
- confiança plena ao atingir 12 jogos;
- `alpha = 0,18`;
- peso de 8% no modelo;
- limite de 6% em cada componente de ataque ou defesa;
- limite final de ±10% na taxa de gols prevista para uma partida;
- pseudocontagem de 0,75 gol para reduzir instabilidade em placares zerados.

Essas travas impedem que uma sequência curta transforme indevidamente um clube em favorito ou candidato ao rebaixamento. O ajuste apenas reconhece, de forma moderada, melhora, estabilidade ou queda recente.

## Projeções finais

A saída pública passa a conter:

- posição projetada inteira;
- média bruta da posição preservada no JSON;
- mediana da posição;
- faixa provável entre os percentis 10 e 90 das simulações;
- pontos projetados inteiros;
- média bruta de pontos preservada no JSON;
- percentis e extremos simulados.

A interface exibe valores inteiros para evitar a falsa impressão de que um clube possa terminar com fração de ponto ou de posição. Os valores decimais permanecem disponíveis para auditoria e avaliação posterior.

## Histórico AF-Previsão

O histórico continua criando um snapshot apenas quando o estado esportivo muda. Cada novo registro guarda, entre outros campos:

- rodada de referência;
- posição e pontos atuais;
- posição e pontos projetados;
- faixa provável;
- probabilidades de título, Libertadores, Sul-Americana e rebaixamento;
- decomposição das vagas continentais;
- tendência recente utilizada.

Na página atual, o histórico aparece recolhido dentro do card de cada clube, limitado aos dez estados mais recentes. Não foi criada uma seção global adicional, evitando poluição visual.

Após o campeonato, a base permitirá uma avaliação própria do AF-Previsão por erro de posição, erro de pontos, calibração e Brier Score.

## Interface

Foram removidas da apresentação principal as métricas G4 e G6. Em seu lugar entram:

- posição projetada;
- faixa provável de posição.

A tabela continua apresentando as chances consolidadas de título, Libertadores, Sul-Americana e rebaixamento, além dos pontos projetados e do detalhamento das vagas.

A autoria foi atualizada para:

> Matemático pela Universidade Federal da Bahia (UFBA), Analista de Sistemas e responsável pelo projeto Brasileirão 2026 — Almoço de Sexta.

## Compatibilidade

A interface mantém compatibilidade com o JSON anterior: quando os novos campos ainda não existem, posição, pontos e faixa provável são derivados das médias e da distribuição de posições já publicadas. A tendência recente só aparece após a primeira geração do AF-Previsão 1.2.

## Validações

A Execução 4 foi submetida a:

- compilação do gerador Python;
- self-test do gerador e testes de regressão dos módulos anteriores;
- geração integrada de 100.000 universos em base de teste consistente;
- verificação de 20 clubes, 38 jogos finais e somas probabilísticas;
- verificação dos limites da tendência por clube e por partida;
- verificação de posição e pontos inteiros com médias brutas preservadas;
- validação do histórico sem snapshots artificiais;
- testes da interface com JSON antigo e com o schema da Execução 4;
- testes em desktop e celular;
- ativação de todas as abas e ordenações;
- verificação de ausência de erros JavaScript e rolagem lateral da página;
- validação estrutural de HTML, CSS, JSON e YAML.

Os dados locais anexados apresentavam divergência temporária entre a tabela e os resultados da ESPN. O bloqueio de integridade foi preservado: nessas condições, o gerador não publica uma previsão nova e mantém o último resultado válido. A atualização normal depende de a coleta do workflow obter fontes sincronizadas.
