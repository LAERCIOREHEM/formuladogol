# ORG-6 — Hubs de competições, preparação Discover e restauração dos mascotes

**Projeto:** Fórmula do Gol  
**Data:** 07/09/2026  
**Escopo:** camada orgânica/editorial; sem alteração da metodologia AF-Previsão/AF-Score ou do sistema Push.

## Objetivo

A ORG-6 é a penúltima execução do plano orgânico. Ela amplia os clusters temáticos do domínio e prepara a camada editorial já existente para superfícies de descoberta, sem duplicar ou recalcular dados esportivos. A pedido do responsável pelo projeto, a execução também restaura nas novas páginas individuais dos clubes os mascotes que já existiam no acervo do repositório.

## Alterações

### 1. Hubs canônicos de competição

Foram adicionadas cinco rotas estáticas geradas no deploy:

- `/competicoes/`
- `/brasileirao/`
- `/copa-do-brasil/`
- `/libertadores/`
- `/sul-americana/`

Os hubs usam exclusivamente dados já produzidos pelo projeto. As páginas continentais leem os estados existentes em `dados-br/competicoes-af-previsao/`; o hub do Brasileirão organiza as probabilidades já publicadas pelo AF-Previsão. Não existe novo cálculo probabilístico nesta execução.

Cada hub possui `title`, `meta description`, canonical, um único H1, `max-image-preview:large`, Open Graph, Twitter Card, `CollectionPage`, `BreadcrumbList`, GA4 e linkagem interna para as superfícies relevantes do site.

### 2. Mascotes dos 20 clubes

O repositório já contém 20 assets em `img/mascotes/`, mapeados em `dados-br/mascotes.json`. A ORG-6 volta a consumi-los nas 20 páginas `/clube/<slug>/`.

O mascote foi colocado na seção **Identidade do clube**, mantendo o escudo no hero. Essa decisão evita aumentar a largura mínima do cabeçalho e protege o layout mobile corrigido pela ORG-4R.

A legenda usa o nome do mascote cadastrado em `dados-br/clubes.json`, por exemplo Galo, Urubu, Raposa, Saci, Almirante e Índio Condá.

### 3. Editorial preparado para imagem grande

Os oito artigos atualmente presentes no manifesto `dados-br/analises.json` passam a receber, no artefato público:

- navegação temática por competição;
- hero editorial próprio de 1600×900;
- `og:image` apontando para o card do próprio artigo;
- imagem principal em largura superior a 1200 px;
- manutenção de `max-image-preview:large` já introduzido na fundação orgânica.

Os cards são gerados deterministicamente durante o build a partir do título, linha fina, categoria e data do próprio manifesto editorial. O logotipo genérico deixa de ser a imagem principal desses artigos.

### 4. Sitemap e pipeline

As cinco novas rotas são adicionadas uma única vez ao sitemap principal. O total validado nesta base é de **409 URLs**.

O workflow `Deploy GitHub Pages` passa a executar:

1. montagem pública;
2. ORG-1;
3. ORG-4;
4. ORG-5;
5. ORG-6;
6. geração de `lastmod`;
7. otimização de imagens;
8. validação integral do pacote.

O validador também exige a existência dos cinco hubs e preserva os gates anteriores de clubes e partidas.

## Arquivos da ORG-6

- `.github/workflows/deploy.yml`
- `css/br-clube.css`
- `css/br-competicoes.css`
- `scripts/gerar_paginas_clubes.py`
- `scripts/gerar_hubs_competicoes.py`
- `docs/ORG-6-HUBS-DISCOVER-MASCOTES-20260907.md`

Nenhum asset de mascote precisa ser enviado novamente: os 20 arquivos já pertencem ao repositório.

## Validações executadas

### Pipeline em cópia limpa ORG-4 + ORG-4R + ORG-5

- montagem do site público: PASS;
- ORG-1: PASS;
- ORG-4: PASS;
- ORG-5: PASS;
- ORG-6: PASS;
- `lastmod`: PASS;
- otimização de imagens: PASS;
- validador público integral: PASS.

Resultado do artefato validado:

- 1.148 imagens analisadas pelo otimizador;
- 1.697 arquivos públicos;
- aproximadamente 77 MB;
- 409 URLs no sitemap principal;
- 7 URLs no sitemap da Copa.

### Validação da ORG-6

- 5/5 hubs gerados e validados;
- 20/20 clubes com mascote exibido;
- 20/20 assets de mascote existentes;
- 8/8 artigos com hero editorial;
- 8/8 heroes com 1600×900;
- JSON-LD parseável;
- nenhum link local obrigatório quebrado no validador do deploy.

### Responsividade

Matriz principal sobre 34 superfícies (20 clubes + 5 hubs + índice de análises + 8 artigos):

- Android 320 px: 34/34 PASS;
- Android 360 px: 34/34 PASS;
- Android 393 px: 34/34 PASS;
- Android 412 px: 34/34 PASS;
- iPhone 375 px: 34/34 PASS;
- iPhone 390 px: 34/34 PASS;
- iPhone 430 px: 34/34 PASS;
- desktop 1440 px: 34/34 PASS.

Total: **272/272 PASS**.

Breakpoints adicionais dos 20 clubes em 379/380/381/639/640/641/699/700/701 px: **180/180 PASS**.

Hubs e superfícies editoriais em 320/360/375/390/393/412/430/639/640/641/699/700/701/768/1024/1440 px: **224/224 PASS**.

Não foi encontrado overflow horizontal global. Componentes que já possuem rolagem horizontal deliberada continuam isolados em seus próprios containers.

### Idempotência

Foram produzidas duas árvores equivalentes com `PYTHONHASHSEED=1` e `PYTHONHASHSEED=777`. Foram comparados 43 artefatos da ORG-6:

- 20 páginas de clube;
- 5 hubs;
- 9 superfícies editoriais HTML;
- 8 cards editoriais JPG;
- `sitemap.xml`.

Resultado: **43/43 idênticos byte a byte**.

## Fora do escopo

A ORG-6 não altera:

- Push / R9-R1;
- VAPID;
- Cloudflare Push Worker;
- D1;
- notificações;
- AF-Score;
- AF-Previsão;
- quantidade ou metodologia das simulações;
- coleta ESPN;
- regras esportivas;
- conteúdo privado do bolão.
