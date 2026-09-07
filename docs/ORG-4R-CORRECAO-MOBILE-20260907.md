# ORG-4R — Correção mobile das páginas de clubes

Data: 2026-09-07

## Problema reproduzido

Nas páginas `/clube/<time>/`, conteúdos internos apareciam cortados à direita em telas estreitas. A causa era estrutural: `.club-page` é um CSS Grid e seus filhos mantinham o `min-width:auto` padrão. A tabela de evolução do AF-Previsão possui `min-width:740px` para conservar legibilidade e, por min-content sizing do Grid, essa largura podia ampliar a coluna principal inteira. O `overflow-x` global mascarava a expansão e o resultado visual era corte de textos, jogos, probabilidades e resultados.

## Correção

- Coluna principal explicitamente `minmax(0,1fr)`.
- `min-width:0` e `max-width:100%` nos itens estruturais relevantes.
- Tabela preservada com rolagem horizontal exclusivamente dentro de `.table-scroll`.
- Quebra segura de textos longos.
- Ajustes mobile para projeção, título, placares e confronto.
- Cache-busting do CSS alterado para `20260907-org4r-mobile-v1`, evitando reaproveitamento do CSS quebrado pelo navegador/celular.

## Escopo preservado

Nenhuma alteração em Push Worker, VAPID, D1, Durable Objects, Queue, R9-R1, AF-Score, AF-Previsão, probabilidades, dados esportivos ou editorial.

## Validação

### Matriz mobile

20 clubes × 7 viewports = 140 renderizações:

- Android: 320×568, 360×800, 393×873, 412×915.
- iPhone: 375×812, 390×844, 430×932.

Resultado: 140 PASS / 0 FAIL.

Critérios automáticos:

- `documentElement.scrollWidth <= viewport`;
- `body.scrollWidth <= viewport`;
- nenhuma seção da página ultrapassa a viewport;
- overflow permitido apenas nos componentes horizontalmente roláveis (`.nav`, `.club-nav`, `.table-scroll`);
- a tabela de AF-Previsão permanece rolável internamente.

### Alertas dinâmicos

Os botões gerados pelo sistema de alertas foram inseridos durante a validação nas mesmas 140 combinações. Resultado: 140 PASS / 0 FAIL.

### Limites de breakpoint e desktop/tablet

20 clubes × 10 larguras = 200 renderizações em 639, 640, 641, 699, 700, 701, 768, 1024, 1366 e 1440 px.

Resultado: 200 PASS / 0 FAIL.

### Pipeline

Executados a partir do workflow real:

- Montar site público: PASS
- ORG-1: PASS
- ORG-4: PASS
- lastmod: PASS
- validador público: PASS
- 44 URLs no sitemap principal
- 7 URLs no sitemap da Copa
- 1.321 arquivos públicos

## Observação sobre motores de navegador

A validação visual automatizada foi realizada no Chromium instalado no ambiente, incluindo emulação de dimensões/UA de Android e iPhone. O binário WebKit não está instalado neste ambiente e a tentativa de instalar Playwright WebKit foi impedida por bloqueio de rede do container. A correção usa propriedades CSS padronizadas e não depende de comportamento exclusivo do Chromium.
