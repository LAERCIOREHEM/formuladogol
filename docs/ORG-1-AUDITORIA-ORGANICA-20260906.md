# ORG-1 — Auditoria orgânica do Fórmula do Gol

Data-base: 06/09/2026. Escopo: repositório recebido para a Execução ORG-1.

## O que já estava correto e foi preservado

- Metadados `title`, description, canonical e Open Graph já existem nas principais páginas públicas.
- `estatisticas.html` já entrega grande volume de conteúdo no HTML e possui `Dataset` + `WebPage` estruturados.
- Artigos em `/analises/` já usam `NewsArticle`, autor, publisher e datas.
- `sitemap.xml`, `news-sitemap.xml`, `feed.xml` e `robots.txt` já fazem parte do deploy.
- O workflow já calcula `lastmod` com datas reais dos dados, em vez de usar artificialmente a data de cada deploy.
- O deploy já valida XML, JSON-LD, referências locais e URLs esperadas.

## Lacunas encontradas

1. Nenhuma página indexável declarava `max-image-preview:large`, sinal necessário para permitir previews grandes no Google/Discover.
2. `clubes.html` tinha somente 242 caracteres de conteúdo estático útil no `<main>`; os 20 clubes apareciam apenas após JavaScript.
3. `aovivo.html` não tinha H1 no conteúdo principal inicial e servia apenas mensagens de carregamento antes do JavaScript.
4. `agenda.html` não tinha H1/conteúdo útil inicial e ainda executava um redirect JS para `/jogos`, apesar de estar no sitemap com URL própria e `og:url` próprio. O canonical também apontava para `/jogos`, criando sinais contraditórios.
5. A raiz `/` continua funcionando como roteador/redirect para Estatísticas; esta arquitetura será tratada com cautela nas execuções posteriores para não causar migração desnecessária de sinais.

## Alterações ORG-1

- `max-image-preview:large` aplicado automaticamente no artefato publicado, apenas em páginas indexáveis.
- Pré-render de 20 clubes no HTML de `clubes.html`, usando exatamente as fontes JSON já publicadas; o JavaScript existente continua substituindo o conteúdo normalmente.
- Pré-render de snapshot útil em `aovivo.html`; o motor ao vivo continua assumindo o mesmo container após carregar.
- Pré-render de agenda útil em `agenda.html`.
- `agenda.html` passa a ser uma landing page standalone coerente: sem redirect JS e com canonical próprio.
- Gate automático `--check`: falha o deploy se faltar preview grande, algum dos 20 clubes, snapshots, ou se guardas `noindex` críticas forem perdidas.

## Fora de escopo desta execução

- URLs individuais `/clube/<slug>/` — ORG-2/3/4.
- URLs programáticas de jogos — ORG-5.
- Hubs de competições e expansão editorial/Discover — ORG-6.
- Hardening orgânico completo e auditoria final — ORG-7.
