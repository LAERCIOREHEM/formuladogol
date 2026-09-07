# ORG-2 — Arquitetura de clubes + piloto Flamengo

## Escopo

A ORG-2 cria a primeira URL individual e indexável de clube do Fórmula do Gol:

- `/clube/flamengo/`
- botão obrigatório `← Voltar para Clubes`;
- mesmo cabeçalho, menu, tipografia, cores, cards e breakpoints das páginas institucionais já aprovadas;
- dados exclusivamente das fontes existentes (`tabela.json`, `dados-br/probabilidades-brasileirao.json`, `dados-br/ranking-desempenho.json`, `dados-br/agenda-clubes-br.json`, `dados-br/clubes.json`);
- canonical, SportsTeam, WebPage e BreadcrumbList;
- entrada no sitemap;
- conexão do card do Flamengo no hub `clubes.html`.

## Limite deliberado da ORG-2

É um piloto estrutural. A página já é útil e indexável, mas os módulos profundos validados pelo produto entram na ORG-3: distribuição das 20 posições, evolução AF-Score, evolução AF-Previsão, jogadores, público/renda, histórico, competições, acurácia específica e alertas contextuais.

## Segurança

Nenhuma lógica de AF-Score/AF-Previsão é duplicada ou recalculada. A página apenas apresenta valores das mesmas fontes do site. Push, VAPID, D1 e Cloudflare Worker não são alterados.
