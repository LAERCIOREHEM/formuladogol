# Execução 7 — Ajuste mobile da tabela e metodologia AF-Previsão

Data: 18/07/2026

## Escopo

Esta execução fecha os dois ajustes visuais/editoriais reservados após a Execução 6. Nenhum workflow, coletor, JSON esportivo, motor probabilístico ou outra página foi alterado.

## 1. Variação de posições no celular

A célula de posição da classificação passou a possuir estrutura própria:

- largura reservada para posição, seta e quantidade;
- agrupamento flexível entre o número da posição e a variação;
- remoção de margens que ampliavam a ocupação da seta dentro da tabela;
- contenção do conteúdo na primeira coluna;
- separação física garantida entre a variação e o escudo da segunda coluna.

A correção suporta variações de um e dois dígitos, inclusive o cenário extremo de 19 posições, sem sobrepor o escudo ou criar rolagem horizontal na página.

## 2. Metodologia pública das probabilidades

O guia de leitura do AF-Previsão agora informa diretamente, sem exigir a abertura da nota técnica, que:

- a tendência utiliza os últimos 12 jogos;
- é calculada por suavização exponencial;
- possui peso conservador de 8%;
- não pode alterar em mais de 10% a taxa de gols prevista para uma partida;
- os snapshots históricos só são criados quando o estado esportivo muda;
- o histórico é encadeado por SHA-256 para permitir avaliação posterior.

A nota técnica completa já existente foi preservada.

## Arquivos alterados

- `index.html`
- `estatisticas.html`
- `docs/execucao-7-ajuste-mobile-metodologia-af-previsao.md`

## Validações executadas

- sintaxe dos cinco blocos JavaScript inline de `index.html`;
- sintaxe de `js/br-estatisticas.js`;
- parsing estrutural de `index.html` e `estatisticas.html` sem erros;
- ausência de IDs duplicados;
- confirmação textual de 12 jogos, 8%, limite de 10% e SHA-256 na metodologia pública;
- teste geométrico em 320, 360, 390, 430 e 560 px;
- teste com variação extrema de 19 posições;
- conteúdo da variação integralmente contido na primeira célula;
- distância positiva entre variação e escudo em todas as linhas;
- ausência de rolagem horizontal do documento;
- sete suítes de regressão dos coletores e do AF-Previsão;
- validação dos 85 JSONs;
- validação dos 13 workflows YAML;
- validação sintática dos 70 blocos shell dos workflows.
