# Execução 8 — Menu suspenso, Bahia x Chapecoense e probabilidades em Clubes

Data: 18/07/2026

## Escopo

Correções cirúrgicas sobre o repositório atualizado após as Execuções 6 e 7:

1. restaurar o comportamento do menu principal suspenso durante a rolagem longa;
2. garantir que Bahia 2 x 0 Chapecoense apareça em Resultados mesmo que o snapshot principal ainda esteja atrasado;
3. impedir que um resultado manual confirmado continue aparecendo como jogo futuro/ao vivo no front-end;
4. exibir probabilidades compactas na página Clubes sem repetir a aba completa de Probabilidades;
5. manter cache-busting dos arquivos visuais alterados.

## Menu principal

O CSS `position: sticky` foi preservado, mas recebeu um fallback controlado pelo `br-menu.js`.

Quando a página rola além da posição original do menu, o próprio elemento de navegação recebe a classe `br-nav-floating` e passa a `position: fixed`. Um placeholder mantém a altura original para não haver salto visual. Ao voltar para o topo, o menu retorna ao fluxo normal.

O comportamento foi aplicado a todas as páginas públicas que usam `.nav[data-br-auth-menu]`.

## Bahia x Chapecoense

O repositório já continha `dados-br/resultados-manuais.json` com o resultado confirmado, mas o front-end ainda dependia apenas de `resultados.json` e `jogos.json`. Por isso, se o workflow ainda não tivesse regenerado os arquivos dinâmicos, a página podia continuar sem o resultado.

A correção passou a usar o fallback manual também no navegador:

- `resultados.json` continua sendo a fonte principal;
- `dados-br/resultados-manuais.json` entra como camada complementar;
- se o resultado manual já passou do horário com placar definido, ele aparece em Resultados;
- o mesmo jogo é removido da aba Jogos, mesmo que `jogos.json` ou o status ao vivo ainda estejam atrasados.

Além disso, os snapshots locais `resultados.json` e `espn_eventos.json` foram atualizados para refletir Bahia 2 x 0 Chapecoense imediatamente.

## Probabilidades em Clubes

A página `clubes.html` agora carrega `dados-br/probabilidades-brasileirao.json` e apresenta uma síntese compacta:

- posição projetada;
- pontos projetados inteiros;
- chance de título quando relevante;
- chance de Libertadores;
- chance de Sul-Americana;
- risco de rebaixamento.

No card da grade, a informação aparece em uma pílula discreta. Na ficha aberta do clube, aparece em um card compacto depois do AF-Score, com link para a aba completa de Probabilidades.

A página continua compatível com o schema antigo e com os campos novos das Execuções 4 e 5.

## Testes realizados

- `node --check` em `js/br-menu.js` e `js/br-clubes.js`;
- validação sintática dos blocos JavaScript inline de `index.html`, `clubes.html`, `apostas.html` e `museu.html`;
- validação dos 85 JSONs do repositório;
- validação dos 13 workflows YAML;
- teste com Chromium headless em viewport mobile 390 × 844 usando conteúdo local roteado:
  - menu recebe `br-nav-floating` ao rolar;
  - menu fica no topo em `y = 4px` no celular;
  - página Clubes renderiza 20 pílulas de Projeção AF;
  - Bahia 2 x 0 Chapecoense aparece em Resultados;
  - Bahia x Chapecoense não aparece mais na aba Jogos;
  - sem erros JavaScript no console.

## Arquivos alterados

- `aovivo.html`
- `apostas.html`
- `clubes.html`
- `estatisticas.html`
- `index.html`
- `museu.html`
- `regras.html`
- `css/br-global.css`
- `css/br-institucional.css`
- `js/br-menu.js`
- `js/br-clubes.js`
- `resultados.json`
- `espn_eventos.json`
- `docs/execucao-8-ajustes-menu-resultado-clubes.md`
