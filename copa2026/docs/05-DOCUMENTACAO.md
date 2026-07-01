# 05-DOCUMENTACAO.md — Documentação técnica do módulo COPA2026

> **Última atualização:** 30/06/2026, horário de Brasília.  
> **Escopo:** documentação técnica consolidada do módulo `copa2026/`, com a estrutura real do repositório e as alterações aplicadas em 30/06/2026.

---

## 1. Estrutura geral

```text
copa2026/
  admin.html                  # Área do administrador
  aovivo.html                 # Jogos ao vivo / próximos jogos em janela de live
  estatisticas.html           # Estatísticas gerais da Copa
  index.html                  # Home da Copa: Partidas, Grupos e Mata-mata
  onde-assistir.html          # Visualizar todos os jogos / filtros / calendário
  palpite.html                # Meus Palpites
  palpites.html               # Palpites revelados
  pontos.html                 # Ranking do Bolão e Reis do Cravo
  regras.html                 # Regras e regulamento
  selecoes.html               # Fichas das seleções

  css/
    copa.css                  # CSS principal do módulo Copa

  js/
    admin.js                  # Funções da área administrativa
    aniversarios.js           # Banner/pop-up de aniversários usando ../membros.json
    aovivo.js                 # Ao vivo, lives, gols, placar e links para seleções
    app.js                    # Editor de palpites e comprovante
    config.js                 # Configuração Supabase
    engine.js                 # Motor de geração/derivação da Copa
    estatisticas.js           # Página Estatísticas
    feedback.js               # Modal de sugestões + centralização do menu ativo
    jogo-stats.js             # Bloco reutilizável de estatísticas detalhadas do jogo
    onde-assistir.js          # Lista completa de jogos, filtros, ordenação e calendário
    palpites.js               # Palpites revelados
    pontos.js                 # Ranking oficial e Reis do Cravo
    pontuacao.js              # Motor de pontuação oficial
    resultados.js             # Partidas, grupos, mata-mata e resultados ESPN
    selecoes.js               # Aba Seleções, elenco, país e desempenho
    times.js                  # Helper global COPA_TIMES

  dados/
    agenda_mata.json
    agenda_workflow_copa.json
    elencos.json
    estatisticas.json
    estrutura_mata_mata.json
    fairplay.json
    jogos-completos.json
    jogos-detalhes.json
    lives.json
    melhores-momentos.json
    paises.json
    palpites_mata.json
    rostos.json
    rostos_creditos.json
    rostos_estado.json
    rostos_relatorio.json
    selecoes.json
    terceiros_map.json
    transmissoes.json
    workflow_copa_estado.json

  img/
    header-copa26.jpg
    header-copa26.png
    jogadores/                 # Fotos locais dos jogadores

  docs/
    01-REGRA-DE-NEGOCIOS-BOLAO-COPA-2026.md
    02-REGULAMENTO-FINAL-BOLAO-COPA-2026.md
    03-PROPOSTA-UX-BOLAO-COPA-2026.md
    04-CONTEXTO.md
    05-DOCUMENTACAO.md
    06-CHECKLIST-IMPLEMENTACAO-BOLAO-COPA-2026.md

  buscar_detalhes_jogos.py
  buscar_estatisticas.py
  buscar_fairplay.py
  buscar_melhores_momentos.py
  buscar_rostos_jogadores.py
  buscar_selecoes.py
  deve_rodar_workflow_copa.py
  diagnostico_youtube.py
  gerar_palpites_mata.py

  scripts/
    atualizar_copa.py
    extrair_anexo_c.py
```

---

## 2. Publicação e cache

O módulo é um site estático publicado pelo GitHub Pages. Não há etapa de build local própria do módulo.

Fluxo padrão:

```bash
git add -A
git commit -m "Mensagem objetiva"
git push
```

Depois do push, aguardar o Pages publicar. Como o navegador e o GitHub Pages podem manter cache, os HTMLs usam querystring nos scripts/CSS, por exemplo:

```html
<script src="js/resultados.js?v=20260701-teamlinks-v1"></script>
<link rel="stylesheet" href="css/copa.css?v=20260701-teamlinks-v1">
```

Quando alterar JS/CSS referenciado por HTML, atualizar o `?v=` correspondente para evitar cache antigo.

---

## 3. Validação mínima antes de enviar alteração

Para JS alterado:

```bash
cd copa2026
node --check js/ARQUIVO.js
```

Para Python alterado:

```bash
cd copa2026
python3 -m py_compile ARQUIVO.py
python3 -m py_compile scripts/ARQUIVO.py
```

Para alterações visuais:

- testar largura desktop;
- testar celular;
- testar menu horizontal;
- testar cards com nome grande de seleção;
- testar cards com seleção indefinida;
- testar hash `selecoes.html#SIGLA`;
- testar estado pré-jogo, ao vivo e encerrado;
- testar pênaltis em mata-mata.

---

## 4. Fontes externas

### ESPN Scoreboard

Usado no navegador por `resultados.js`, `aovivo.js`, `estatisticas.js`, `onde-assistir.js`, `selecoes.js` e por scripts Python.

Endpoint-base:

```text
https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard
```

Uso típico:

```text
?dates=YYYYMMDD-YYYYMMDD&limit=N
```

Campos importantes:

- `events[]`;
- `competitions[0].competitors[]`;
- `competitor.team.abbreviation`;
- `competitor.score`;
- `status.type.state` (`pre`, `in`, `post`);
- `season.slug` para fase.

### ESPN Summary

Usado para lances, gols, cartões e estatísticas detalhadas.

Endpoint-base:

```text
https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=EVENT_ID
```

### YouTube / CazéTV

Usado por `buscar_melhores_momentos.py` para:

- melhores momentos;
- lives;
- jogos completos.

Variáveis/segredos relevantes:

- `YOUTUBE_API_KEY`;
- `CAZE_PLAYLIST_ID`;
- `CAZE_COMPLETOS_PLAYLIST_ID`.

### Wikipedia / Wikimedia / Wikidata

Usados por `buscar_rostos_jogadores.py` como camadas de fallback para fotos públicas de jogadores quando não há headshot ESPN confiável. Créditos são persistidos em `dados/rostos_creditos.json`.

### FlagCDN

Usado para bandeiras via `https://flagcdn.com/` a partir do `iso2`.

---

## 5. Supabase

Arquivo de configuração:

```text
copa2026/js/config.js
```

Objeto global:

```js
window.COPA_CFG = {
  url: "...",
  key: "..."
};
```

A anon key é pública. O controle real fica no banco por RLS e funções `SECURITY DEFINER`.

### RPC wrapper

Os JS que acessam o banco usam padrão semelhante:

```js
fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "apikey": CFG.key,
    "Authorization": "Bearer " + CFG.key
  },
  body: JSON.stringify(body || {})
});
```

### RPCs usadas

Usuário:

- `copa_login`;
- `copa_salvar`;
- `copa_meu_palpite`;
- `copa_finalizar`;
- `copa_minha_situacao`;
- `copa_lacres`;
- `copa_revelados`.

Admin:

- `copa_admin_login`;
- `copa_admin_listar`;
- `copa_admin_add`;
- `copa_admin_reset`;
- `copa_admin_remover`;
- `copa_admin_trocar_senha`.

### Payload de palpite

Formato conceitual:

```js
{
  placaresGrupos: {
    jogo_id: { ga, gb }
  },
  placaresMata: {
    mId: { a, b }
  },
  status: "..."
}
```

O `derivado` é calculado por `engine.js` e salvo junto para auditoria/ranking.

---

## 6. Módulos JavaScript

### `js/engine.js`

Motor puro do bolão.

Responsabilidades:

- gerar jogos de grupos;
- classificar grupos;
- resolver empates;
- calcular melhores terceiros;
- montar round of 32;
- resolver slots;
- propagar mata-mata;
- derivar estrutura final do palpite.

Não depende do DOM.

### `js/pontuacao.js`

Motor puro de pontuação oficial.

Responsabilidades:

- calcular pontos atuais;
- calcular teto;
- calcular pontos perdidos/possíveis;
- respeitar fases realmente abertas/apuradas;
- exportar funções para uso em `pontos.js`.

### `js/app.js`

Página `palpite.html`.

Responsabilidades:

- login/restauração de sessão;
- renderização das fases de palpite;
- progresso de preenchimento;
- validações de placar;
- salvamento no Supabase;
- lacre voluntário;
- geração de comprovante;
- hash SHA-256 canônico;
- auditoria geral;
- espelhamento de status do ranking oficial.

### `js/resultados.js`

Página `index.html`.

Responsabilidades:

- carregar jogos ESPN por dia;
- montar faixa horizontal de datas;
- renderizar cards de jogos;
- renderizar aba Grupos;
- renderizar aba Mata-mata;
- extrair gols/cartões/lances de summary;
- exibir transmissões, melhores momentos e jogos completos;
- exibir estatísticas detalhadas via `jogo-stats.js`;
- carregar palpites revelados para medalhas/quem acertou;
- calcular/projetar mata-mata usando dados oficiais parciais;
- ler fair play para desempate;
- aplicar links de seleção em Partidas e Mata-mata.

Função importante da atualização de 30/06/2026:

```js
selecaoLinkHTML(id, conteudo, classeExtra)
```

Regra:

- se `id` resolve para seleção real, retorna `<a href="selecoes.html#SIGLA">...`;
- se não resolve, retorna o conteúdo sem link.

### `js/aovivo.js`

Página `aovivo.html`.

Responsabilidades:

- monitorar janela ao vivo;
- decidir frequência de atualização;
- exibir jogos em andamento/atrasados/próximos;
- carregar summary para gols/cartões;
- carregar palpites revelados;
- exibir transmissões/lives;
- aplicar links de seleção no card ao vivo e no cartaz de próximo jogo.

### `js/onde-assistir.js`

Página `onde-assistir.html`.

Responsabilidades:

- listar todos os jogos;
- gerar calendário `.ics`;
- compartilhar página;
- filtrar por seleção;
- filtrar por data;
- ordenar por data ou seleção;
- limpar filtros;
- projetar/identificar mata-mata;
- exibir canais, gols, pênaltis e estatísticas;
- aplicar links de seleção nos cards.

Função importante da atualização de 30/06/2026:

```js
linkSelecaoHTML(id, conteudo, classeExtra)
```

### `js/estatisticas.js`

Página `estatisticas.html`.

Responsabilidades:

- carregar `dados/estatisticas.json`;
- completar gols por seleção;
- listar artilheiros;
- listar assistências;
- listar cartões;
- listar gols por seleção;
- exibir jogos por seleção/fase;
- tratar pênaltis;
- renderizar filtros;
- usar rostos/avatares quando disponíveis.

### `js/selecoes.js`

Página `selecoes.html`.

Responsabilidades:

- carregar `dados/selecoes.json`;
- carregar `dados/paises.json`;
- carregar `dados/elencos.json`;
- carregar `dados/rostos_creditos.json`;
- carregar `dados/estatisticas.json`;
- buscar scoreboard ESPN completo da Copa;
- renderizar dropdown superior;
- renderizar scroll horizontal de bandeiras;
- abrir seleção por clique ou hash `#SIGLA`;
- exibir Ranking FIFA a partir de `seed`;
- exibir curiosidades e elenco;
- montar desempenho da seleção;
- listar jogos da seleção;
- listar marcadores;
- exibir artilheiro/líder de assistências;
- tratar pênaltis em campanha;
- degradar sem quebrar quando feeds falham.

Funções conceituais importantes:

- `rankingLabel`;
- `campanhaSelecao`;
- `desempenhoHTML`;
- `jogosDaSelecao`;
- `marcadoresHTML`;
- `carregarDesempenho`.

### `js/jogo-stats.js`

Componente reutilizável.

Responsabilidades:

- carregar `dados/jogos-detalhes.json`;
- localizar estatísticas por eventId;
- normalizar nomes de métricas;
- renderizar bloco recolhível de estatísticas de jogo;
- injetar CSS próprio quando necessário;
- expor integração segura para páginas que queiram o botão “📊 Estatísticas do jogo”.

Usado por:

- `index.html` / `resultados.js`;
- `onde-assistir.html` / `onde-assistir.js`;
- `estatisticas.html` / `estatisticas.js`;
- `selecoes.html` / `selecoes.js`.

### `js/times.js`

Helper global `COPA_TIMES`.

Responsabilidades:

- carregar dados de seleções;
- resolver sigla;
- resolver nome;
- resolver `iso2`;
- montar URL da bandeira.

### `js/pontos.js`

Página `pontos.html`.

Responsabilidades:

- carregar palpites revelados;
- montar oficial parcial a partir da ESPN;
- calcular ranking oficial;
- renderizar extrato do bolão;
- mostrar fases do palpite;
- calcular e renderizar Reis do Cravo;
- desempatar rankings.

### `js/palpites.js`

Página `palpites.html`.

Responsabilidades:

- carregar `copa_revelados`;
- montar visualização por jogo;
- montar visualização por classificação/grupo;
- calcular hash canônico;
- mostrar hashes para auditoria.

### `js/admin.js`

Página `admin.html`.

Responsabilidades:

- autenticação admin;
- adicionar participantes em lote;
- gerar PINs;
- resetar PIN;
- remover participante;
- trocar senha;
- listar progresso/lacre;
- gerar JSON manual de melhores momentos.

### `js/feedback.js`

Responsabilidades:

- criar/abrir modal de sugestões;
- centralizar item ativo do menu horizontal;
- manter comportamento mobile/desktop do menu.

### `js/aniversarios.js`

Responsabilidades:

- buscar `../membros.json`;
- detectar aniversariantes do dia no fuso de Brasília;
- renderizar banner;
- renderizar popup uma vez por dia/dispositivo;
- criar link de WhatsApp.

---

## 7. CSS principal: `css/copa.css`

O CSS é compartilhado por todas as páginas da Copa.

Áreas relevantes:

- tema navy/dourado;
- menu superior;
- cards de jogos;
- tabela de grupos;
- mata-mata;
- rankings;
- palpite/editor;
- estatísticas;
- seleções;
- aniversários;
- feedback;
- responsividade mobile.

### Classes adicionadas/atualizadas em 30/06/2026

Aba Seleções:

- `.sel-det-ranking`;
- `.sel-performance`;
- `.sel-perf-head`;
- `.sel-perf-grid`;
- `.sel-perf-card`;
- `.sel-perf-note`.

Links de seleção:

- `.team-link`;
- `.team-link-lado`;
- `.team-link-mm`;
- `.team-link-mm-opcao`;
- `.team-link-oa`;
- `.team-link-live`;
- `.team-link-cartaz`.

Regra visual:

- o link não deve parecer um botão novo;
- deve preservar cor, espaçamento e layout existentes;
- hover/focus pode indicar clique de forma discreta;
- no mobile, não deve quebrar alinhamento dos cards.

---

## 8. Dados JSON em detalhe

### `dados/selecoes.json`

Estrutura conceitual:

```js
{
  "selecoes": [
    {
      "id": "BRA",
      "nome": "Brasil",
      "grupo": "...",
      "seed": 5,
      "iso2": "br"
    }
  ]
}
```

Observações:

- `id` deve casar com siglas internas e, preferencialmente, com ESPN;
- `seed` é tratado visualmente como Ranking FIFA na aba Seleções;
- `grupo` pode continuar existindo como dado histórico, mas não é mais o foco visual da ficha.

### `dados/paises.json`

Usado por `selecoes.js` para curiosidades do país.

### `dados/elencos.json`

Usado por `selecoes.js`.

Contém metadados e `times[SIGLA]` com atletas.

### `dados/estatisticas.json`

Gerado por `buscar_estatisticas.py`.

Campos conceituais:

- fonte;
- atualizado_em;
- período;
- jogos_encontrados;
- jogos_processados;
- artilheiros;
- assistências;
- cartões;
- gols por seleção/agregados.

Usado por:

- `estatisticas.js`;
- `selecoes.js`.

### `dados/jogos-detalhes.json`

Gerado por `buscar_detalhes_jogos.py`.

Usado por `jogo-stats.js` para botão de estatísticas.

### `dados/fairplay.json`

Gerado por `buscar_fairplay.py`.

Critério de fase de grupos:

- amarelo: -1;
- vermelho direto: -4.

### `dados/transmissoes.json`

Chave de confronto e canais extras.

CazéTV é tratada como canal padrão/implícito em diversas telas.

### `dados/melhores-momentos.json`, `dados/lives.json`, `dados/jogos-completos.json`

Gerados/atualizados por `buscar_melhores_momentos.py`.

Regras:

- não sobrescrever entradas manuais marcadas como admin quando o script preserva isso;
- evitar link genérico errado;
- validar se o vídeo corresponde ao confronto.

### `dados/rostos*.json`

Usados para fotos e créditos.

Nunca inventar rosto. Na ausência, usar avatar de iniciais.

---

## 9. Scripts Python

### `buscar_estatisticas.py`

Gera `dados/estatisticas.json`.

Fontes:

- ESPN scoreboard;
- ESPN summary.

Extrai:

- gols;
- assistências;
- cartões;
- gols por seleção;
- metadados de processamento.

É defensivo: se ESPN oscilar, não deve zerar dados bons sem necessidade.

### `buscar_detalhes_jogos.py`

Gera `dados/jogos-detalhes.json`.

Extrai estatísticas detalhadas de cada jogo a partir do summary ESPN.

### `buscar_fairplay.py`

Gera `dados/fairplay.json`.

Focado na fase de grupos.

### `buscar_melhores_momentos.py`

Atualiza:

- `dados/melhores-momentos.json`;
- `dados/lives.json`;
- `dados/jogos-completos.json`.

Usa YouTube Data API e regras rígidas para casar título/vídeo com confronto.

### `buscar_selecoes.py`

Atualiza:

- `dados/elencos.json`;
- `dados/rostos.json`;
- fotos em `img/jogadores/` quando disponíveis via ESPN.

### `buscar_rostos_jogadores.py`

Povoa rostos com cache e fallback:

1. ESPN headshot;
2. Wikipedia pageimages;
3. Wikidata P18 / Wikimedia Commons;
4. avatar no front-end quando não há foto segura.

Gera/atualiza:

- `dados/rostos.json`;
- `dados/rostos_estado.json`;
- `dados/rostos_creditos.json`;
- `dados/rostos_relatorio.json`.

### `deve_rodar_workflow_copa.py`

Decide se workflow pesado da Copa deve executar.

Saída para GitHub Actions:

- `RUN_COPA=true/false`;
- `RUN_COPA_MOTIVO=...`.

Permite teste local com:

```bash
AGORA_BRT=2026-07-08T12:00:00-03:00 python3 copa2026/deve_rodar_workflow_copa.py
```

### `diagnostico_youtube.py`

Diagnóstico manual da API do YouTube/lives da CazéTV.

### `gerar_palpites_mata.py`

Script auxiliar relacionado a palpites de mata-mata.

### `scripts/extrair_anexo_c.py`

Regera `dados/terceiros_map.json` a partir da tabela oficial das combinações de melhores terceiros.

---

## 10. Workflows GitHub Actions

### Copa

#### `.github/workflows/melhores-momentos.yml`

Acionado por `workflow_dispatch`, normalmente via cron-job.org.

Executa:

- `deve_rodar_workflow_copa.py`;
- `buscar_melhores_momentos.py`;
- `buscar_estatisticas.py`;
- `buscar_detalhes_jogos.py`.

Arquivos commitados quando mudam:

- `copa2026/dados/melhores-momentos.json`;
- `copa2026/dados/lives.json`;
- `copa2026/dados/jogos-completos.json`;
- `copa2026/dados/estatisticas.json`;
- `copa2026/dados/jogos-detalhes.json`;
- `copa2026/dados/workflow_copa_estado.json`.

#### `.github/workflows/atualizar-selecoes.yml`

Atualiza elencos e rostos.

Executa selftests offline e depois:

- `buscar_selecoes.py`;
- `buscar_rostos_jogadores.py`.

#### `.github/workflows/fairplay.yml`

Atualiza `fairplay.json`.

### Brasileirão / repo geral

Existem workflows para dados do Brasileirão e aniversários:

- `atualizar-jogos.yml`;
- `atualizar-resultados.yml`;
- `atualizar-tabela.yml`;
- `atualizar-tudo.yml`;
- `enviar-aniversarios.yml`.

Eles compartilham o repositório, mas não devem ser confundidos com regras/dados do módulo Copa.

---

## 11. Links para seleções nas páginas vivas

Atualização aplicada em 30/06/2026.

### Regra funcional

Sempre que uma seleção real aparecer em área viva de acompanhamento, bandeira/nome podem virar link para:

```text
selecoes.html#SIGLA
```

Exemplos:

```text
selecoes.html#BRA
selecoes.html#ARG
selecoes.html#FRA
```

### Onde existe link

- `index.html` / `resultados.js`: Partidas;
- `index.html` / `resultados.js`: Mata-mata;
- `onde-assistir.html` / `onde-assistir.js`: Visualizar todos os jogos;
- `aovivo.html` / `aovivo.js`: Ao vivo e cartaz de próximo jogo.

### Onde não colocar link

- Grupos;
- Bolão;
- Palpites;
- Meus Palpites;
- rankings;
- áreas administrativas;
- páginas de aposta/auditoria.

### Placeholders sem link

Não criar link para:

- `A definir`;
- `Venc. M90`;
- `Vencedor M90`;
- `1º Grupo A`;
- `2º Grupo B`;
- qualquer slot ainda matemático ou textual que não seja seleção real.

### CSS

Usar `.team-link` e variações específicas por contexto. Não criar botão visual novo.

---

## 12. Aba Seleções: desempenho individual

Atualização aplicada em 30/06/2026.

### Arquivos

- `selecoes.html`;
- `js/selecoes.js`;
- `css/copa.css`.

### Dados usados

- `dados/selecoes.json`;
- `dados/paises.json`;
- `dados/elencos.json`;
- `dados/rostos_creditos.json`;
- `dados/estatisticas.json`;
- scoreboard ESPN `20260611-20260719`;
- `dados/jogos-detalhes.json` via `jogo-stats.js`.

### Conteúdo da ficha

- cabeçalho da seleção;
- Ranking FIFA;
- curiosidades;
- desempenho na Copa;
- campanha V/E/D;
- gols marcados;
- gols sofridos;
- saldo;
- média de gols;
- cartões;
- artilheiro;
- líder de assistências;
- jogos da seleção;
- marcadores;
- elenco;
- créditos.

### Comportamento esperado

- abrir seleção por clique no dropdown;
- abrir seleção por clique no scroll horizontal;
- abrir seleção por hash externo;
- manter estado ativo visualmente;
- não quebrar quando estatísticas ainda não carregaram;
- não inventar jogador/foto/estatística.

---

## 13. Onde assistir: filtros e ordenação

A página `onde-assistir.html` possui controles:

- seleção;
- data;
- ordenar por data ou seleção;
- direção ascendente/descendente;
- limpar filtros.

IDs relevantes:

- `oa-filtro-selecao`;
- `oa-filtro-data`;
- `oa-ordem-campo`;
- `oa-ordem-direcao`;
- `oa-limpar-filtros`;
- `oa-filtro-resumo`.

Ao alterar esta página, preservar:

- botão de calendário;
- botão de compartilhar;
- subtabs;
- layout responsivo;
- transmissões;
- links para seleções;
- estatísticas de jogo.

---

## 14. Estatísticas detalhadas de jogo

Componente: `js/jogo-stats.js`.

Arquivo de dados: `dados/jogos-detalhes.json`.

O botão deve ser recolhível e seguro:

- se não houver estatística, não quebrar card;
- se houver, mostrar métricas normalizadas;
- não bloquear renderização da página principal.

Usado em:

- Jogos/Partidas;
- Onde assistir;
- Estatísticas;
- Seleções.

---

## 15. Pênaltis e mata-mata

Pênaltis exigem atenção em todas as páginas:

- Partidas;
- Mata-mata;
- Onde assistir;
- Estatísticas;
- Seleções.

Regra de exibição:

- placar normal continua sendo exibido;
- linha adicional mostra decisão por pênaltis quando disponível;
- campanha de seleção deve considerar classificação/eliminações por pênaltis sem tratar como “empate seco” no contexto de mata-mata.

---

## 16. De/para de seleções

Há mapas internos de siglas em várias páginas por robustez, além de `times.js`.

Objetivo:

- converter siglas ESPN para siglas internas;
- converter nomes em inglês para nomes PT-BR;
- resolver variações comuns;
- garantir bandeira correta.

Quando aparecer seleção sem link, sem bandeira ou sem nome correto:

1. verificar `dados/selecoes.json`;
2. verificar helper/mapa local da página afetada;
3. verificar `COPA_TIMES`;
4. verificar se a ESPN mudou a sigla ou nome.

---

## 17. Checklist de alteração segura

Antes de enviar arquivos ao repositório:

```bash
cd copa2026
node --check js/resultados.js
node --check js/aovivo.js
node --check js/onde-assistir.js
node --check js/selecoes.js
node --check js/estatisticas.js
node --check js/app.js
node --check js/pontos.js
node --check js/palpites.js
node --check js/admin.js
node --check js/jogo-stats.js
node --check js/feedback.js
node --check js/aniversarios.js
node --check js/engine.js
node --check js/pontuacao.js
node --check js/times.js
```

Para Python:

```bash
python3 -m py_compile buscar_estatisticas.py
python3 -m py_compile buscar_detalhes_jogos.py
python3 -m py_compile buscar_melhores_momentos.py
python3 -m py_compile buscar_selecoes.py
python3 -m py_compile buscar_rostos_jogadores.py
python3 -m py_compile buscar_fairplay.py
python3 -m py_compile deve_rodar_workflow_copa.py
python3 -m py_compile diagnostico_youtube.py
python3 -m py_compile gerar_palpites_mata.py
python3 -m py_compile scripts/extrair_anexo_c.py
```

Testes manuais recomendados:

- abrir `index.html` em Partidas;
- abrir aba Grupos;
- abrir aba Mata-mata;
- clicar em seleção real e confirmar `selecoes.html#SIGLA`;
- confirmar que placeholder não é link;
- abrir `aovivo.html` sem jogo ao vivo;
- abrir `onde-assistir.html` e testar filtros/ordenação;
- abrir `estatisticas.html` e filtrar por seleção;
- abrir `selecoes.html`, testar dropdown, scroll e hash direto;
- abrir `palpite.html` e garantir que o editor não foi afetado;
- testar em mobile.

---

## 18. Convenções de código/interface

- Texto em PT-BR.
- Tema: navy + dourado.
- Fontes principais: Anton e Archivo.
- Evitar bibliotecas novas sem necessidade.
- Preferir degradação segura a erro visível.
- Evitar mexer em HTML quando JS/CSS resolvem.
- Quando mexer em HTML, atualizar cache-busting.
- Não criar botões novos se um link discreto resolve.
- Não alterar menus sem necessidade.
- Não transformar páginas do bolão em páginas de navegação pública.

---

## 19. Arquivos alterados nas últimas duas entregas

### Entrega 1 — Seleções com desempenho

- `copa2026/selecoes.html`;
- `copa2026/js/selecoes.js`;
- `copa2026/css/copa.css`.

### Entrega 2 — Links para seleções nas páginas vivas

- `copa2026/index.html`;
- `copa2026/onde-assistir.html`;
- `copa2026/aovivo.html`;
- `copa2026/js/resultados.js`;
- `copa2026/js/onde-assistir.js`;
- `copa2026/js/aovivo.js`;
- `copa2026/css/copa.css`.

Observação: `copa.css` foi tocado nas duas entregas e precisa ser tratado como arquivo consolidado, não como patch isolado.

---

## 20. Regra final de manutenção

Qualquer alteração que mude comportamento, regra, tela, fonte de dados, workflow, cálculo ou integração deve atualizar estes dois arquivos:

- `docs/04-CONTEXTO.md`;
- `docs/05-DOCUMENTACAO.md`.

A documentação deve refletir o repositório real, não uma intenção futura.
