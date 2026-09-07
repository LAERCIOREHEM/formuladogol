# ORG-7R — fechamento de produção e navegação das páginas de jogo

Data: 07/09/2026

## Motivo

Após a ORG-7, a URL `/brasileirao/jogos/` foi observada publicamente retornando 404, embora o artefato local contivesse o arquivo. A ORG-7R elimina a dependência dessa resolução de diretório usando a URL canônica `/brasileirao-jogos.html`.

## Mudanças

- Arquivo canônico em `/brasileirao-jogos.html`.
- Rota antiga `/brasileirao/jogos/` mantida como alias `noindex,follow`, com canonical e redirecionamento para a nova URL.
- Sitemap remove a rota antiga e contém somente a canônica.
- Hub `/brasileirao/` aponta para a canônica.
- Aba Jogos exibe `Arquivo completo do Brasileirão` e `Detalhes da partida` nos jogos do Brasileirão com data confirmada.
- Aba Resultados exibe `Abrir arquivo completo` e `Ver página da partida`.
- Smoke test público pós-deploy verifica home, arquivo, hub, Clubes e amostras determinísticas de páginas de clubes e partidas. Um 404 crítico reprova o job.
- O cálculo de `lastmod` ganhou cache por dependência (`lru_cache`), evitando reler os mesmos JSONs centenas de vezes para as 360 páginas de jogo; no teste local caiu de mais de 2 minutos em base fria para cerca de 2 segundos.

## Escopo preservado

Nenhuma alteração em AF-Previsão, AF-Score, Monte Carlo, ESPN, Push, VAPID, D1, Worker Cloudflare, regras esportivas ou notificações.
