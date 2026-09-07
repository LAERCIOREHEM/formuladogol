# ORG-4 — 20 páginas completas de clubes

A ORG-4 generaliza a página completa criada no piloto do Flamengo para os 20 clubes do Brasileirão 2026, mantendo cada informação nas páginas originais e criando uma superfície agregada por clube em `/clube/<slug>/`.

## Escopo entregue

- 20 páginas reais, únicas e pré-renderizadas;
- slugs normalizados, inclusive `Grêmio → /clube/gremio/`;
- hub `clubes.html` com os 20 cards apontando para as páginas individuais;
- compatibilidade dos antigos hashes `clubes.html#time`, redirecionando para a página nova quando o JavaScript carrega;
- botão **← Voltar para Clubes** em todas as páginas;
- menu principal preservado, com **Clubes** como item ativo;
- canonical, `max-image-preview:large`, `SportsTeam` e `BreadcrumbList` por clube;
- titles únicos entre 53 e 62 caracteres;
- exatamente um H1 por página;
- sitemap com as 20 URLs, cada uma exatamente uma vez;
- `lastmod` das páginas de clube derivado do conjunto completo de fontes que alimenta a página;
- pré-renderização ORG-1 atualizada para apontar diretamente para `/clube/<slug>/`.

## Conteúdo de cada página

Cada clube recebe a mesma arquitetura completa, sempre consumindo os dados oficiais já existentes no repositório e sem recalcular probabilidades ou AF-Score:

1. resumo atual;
2. leitura **O que mudou** contra o marco anterior disponível;
3. probabilidades atuais;
4. distribuição das 20 posições;
5. vias para Libertadores;
6. próximos jogos e probabilidades pré-jogo quando disponíveis;
7. AO VIVO contextual quando houver partida em andamento;
8. últimos resultados;
9. alertas específicos do clube usando o sistema existente;
10. artilheiros;
11. garçons;
12. gols + assistências;
13. AF-Score e componentes ataque, defesa, domínio, eficiência e disciplina;
14. evolução do AF-Score;
15. evolução do AF-Previsão;
16. campanha;
17. público e renda exclusivamente como mandante;
18. competições presentes no calendário agregado;
19. timeline de acurácia do clube;
20. análises relacionadas;
21. identidade institucional do clube.

## Gates executados

A entrega foi reaplicada sobre uma extração limpa do repositório fornecido antes do empacotamento.

- Python compile: PASS;
- `node --check js/br-clubes.js`: PASS;
- `python scripts/gerar_fundacao_organica.py --site-root _site --check`: PASS;
- `python scripts/gerar_paginas_clubes.py --site-root _site --check`: PASS;
- forma alternativa `--site-dir _site --check`: PASS;
- montagem do site público do workflow: PASS;
- geração de `lastmod`: PASS — 44 URLs no sitemap principal e 7 no sitemap da Copa;
- validador público integral do projeto: PASS — 1.321 arquivos públicos;
- 20 slugs únicos: PASS;
- 20 canonicals únicos: PASS;
- 20 titles únicos: PASS;
- exatamente 20 posições por página: PASS;
- 18 blocos `<section>` por página no HTML final: PASS;
- auditoria independente de posição, pontos, jogos, agenda, resultados, jogadores, público/renda, competições, acurácia e análises: PASS, 20 clubes e 0 divergências;
- idempotência com `PYTHONHASHSEED=1` e `PYTHONHASHSEED=777`: PASS, páginas e sitemap idênticos byte a byte.

A tentativa de Chromium headless no ambiente local não concluiu por indisponibilidade do próprio processo Chromium/DBus. A responsividade permanece protegida pelas regras CSS já utilizadas nas páginas institucionais e pelos breakpoints específicos da página de clube; tabelas e menus utilizam rolagem horizontal deliberada onde necessário.

## Superfícies não alteradas

A ORG-4 não modifica o Cloudflare Push Worker, VAPID, D1, Durable Objects, Queue, R9-R1, regras de disparo de notificações, cálculos do AF-Score, cálculos do AF-Previsão ou lógica editorial.
