# ORG-7 — Fechamento orgânico e hardening de indexação

Data: 07/09/2026
Projeto: Fórmula do Gol

## Objetivo

Encerrar a frente ORG-1 → ORG-7 com um gate operacional de SEO/indexabilidade e fechar a linkagem interna das páginas programáticas já implantadas, sem alterar a lógica esportiva, o sistema de notificações ou os modelos AF-Previsão/AF-Score.

## Implementação

### Arquivo integral de partidas

A ORG-7 cria, durante o build, a rota estática indexável:

`/brasileirao/jogos/`

O arquivo lista por rodada todas as partidas do Brasileirão com data confirmada e cria ligação direta para:

- cada URL `/jogo/<mandante>-x-<visitante>-<data>/`;
- a página individual de cada clube;
- o hub `/brasileirao/`.

No snapshot atual há 360 partidas com data confirmada. Os 20 jogos ainda marcados com `data_definir=true` permanecem fora até receberem data real; o gerador passa a incluí-los automaticamente quando a fonte for atualizada.

### Hub do Brasileirão

O hub `/brasileirao/` passa a oferecer ligação explícita para o arquivo de partidas e amplia a linkagem para páginas individuais dos clubes nas superfícies de título e permanência.

### IndexNow

O workflow deixa de manter uma lista curta e manual de URLs. Após deploy bem-sucedido, o lote IndexNow passa a ser derivado do `sitemap.xml` publicado, deduplicado e limitado pelo gate de 10.000 URLs. No estado atual, o sitemap principal contém 410 URLs indexáveis.

O IndexNow não é usado como substituto do sitemap/lastmod para o Google.

### Gate final ORG-7

O novo `scripts/validar_org_final.py` impede o deploy se detectar regressões em:

- sitemap e canonicals;
- `noindex` indevido em superfícies orgânicas;
- H1 ausente/duplicado;
- `max-image-preview:large` ausente;
- 20 páginas de clubes;
- páginas de partidas geradas a partir do calendário confirmado;
- 6 hubs orgânicos;
- linkagem arquivo → 360 partidas;
- linkagem partidas → clubes;
- schemas SportsTeam, SportsEvent e BreadcrumbList;
- imagens editoriais grandes;
- declaração dos sitemaps em `robots.txt`.

## Resultado do build final em base limpa ORG-6

- ORG-1: PASS
- ORG-4: PASS
- ORG-5: PASS — 360 páginas de jogo
- ORG-6: PASS — 5 hubs, 20 mascotes, 8 heroes editoriais
- ORG-7: PASS — arquivo com 360 partidas
- lastmod: PASS — 410 URLs principais + 7 URLs Copa
- gate final ORG-7: PASS
- otimização de imagens: PASS — 1.148 analisadas, 1.141 otimizadas
- validador público integral: PASS
- artefato público: 1.699 arquivos, aproximadamente 77 MB

## Responsividade final

Renderização automatizada em Chromium sobre a cópia limpa final:

- 360 páginas de jogo × 320 px: 360/360 PASS
- 360 páginas de jogo × 430 px: 360/360 PASS
- páginas dos 20 clubes em Android 320/360/393/412 e iPhone 375/390/430: 140/140 PASS
- hubs + editoriais em 19 larguras de 320 a 1440 px: 285/285 PASS

Total da matriz contabilizada: 1.145 renderizações, 0 falhas de overflow global.

Componentes deliberadamente roláveis na horizontal permanecem confinados ao próprio componente.

## Idempotência

Com `PYTHONHASHSEED=1` e `PYTHONHASHSEED=777`, os três artefatos diretamente reescritos pela ORG-7 ficaram idênticos byte a byte:

- `brasileirao/jogos/index.html`
- `brasileirao/index.html`
- `sitemap.xml`

Resultado: 3/3 PASS.

## Limites preservados

A ORG-7 não altera:

- Push/R9-R1;
- VAPID;
- Cloudflare Push Worker;
- D1;
- notificações;
- ESPN/coleta esportiva;
- AF-Score;
- AF-Previsão;
- Monte Carlo;
- regras de classificação ou probabilidades.
