# DOCUMENTACAO.md — Fórmula do Gol

> **Referência técnica consolidada em 10/08/2026 (BRT).**  
> Estado analisado: repositório atual após a sincronização da classificação ao vivo e a implementação do orquestrador inteligente + pipeline independente de públicos.

Este documento descreve a estrutura real do repositório, não o projeto antigo. Ele deve ser mantido junto com `docs/CONTEXTO.md`.

---

## 1. Visão técnica

- **Produto:** Fórmula do Gol.
- **Domínio:** `formuladogol.com.br` (`CNAME`).
- **Hospedagem:** GitHub Pages via GitHub Actions.
- **Repositório esperado:** `LAERCIOREHEM/formuladogol`.
- **Front-end:** HTML/CSS/JavaScript vanilla, sem bundler/framework.
- **Backend operacional:** scripts Python executados no GitHub Actions; Supabase somente para recursos persistentes específicos (feedback e infraestrutura do bolão).
- **Fonte esportiva principal:** ESPN (`site.api.espn.com`).
- **Timezone de negócio:** `America/Sao_Paulo`/BRT.
- **Publicação:** pacote `_site` montado e validado pelo workflow `deploy.yml`.

Fluxo macro:

```text
fontes externas + overrides versionados
          ↓
coletores Python / validações / auditorias
          ↓
JSONs versionados no main
          ↓
GitHub Pages (_site)
          ↓
HTML/JS lê JSONs + scoreboard ESPN direto no browser para AO VIVO
```

---

## 2. Mapa das páginas e rotas

| Arquivo | Rota/uso | Responsabilidade |
|---|---|---|
| `index.html` | `/`, `/jogos`, `/tabela`, `/resultados` | Home SPA parcial: Jogos, Tabela e Resultados; mantém views legadas ocultas do bolão/aniversários/admin. |
| `estatisticas.html` | `/estatisticas.html` | Probabilidades AF, classificação live sincronizada, líderes, jogos, gols por clube, público, desempenho/AF‑Score, histórico e metodologia. |
| `acuracia.html` | `/acuracia.html` | Acurácia pública do AF‑Previsão, timeline e métricas agregadas. |
| `aovivo.html` | `/aovivo.html` | Central ao vivo dos clubes do Brasileirão em competições monitoradas; player oficial quando elegível. |
| `agenda.html` | `/agenda.html` (canônico aponta para `/jogos`) | Agenda consolidada multicompetição; página preservada, link legado removido do menu principal. |
| `clubes.html` | `/clubes.html#slug` | Fichas dos 20 clubes. |
| `museu.html` | `/museu.html` | História, campeões, títulos, recordes e marcos. |
| `sobre.html` | `/sobre.html` | Identidade, fontes, metodologia geral, independência e créditos. |
| `analises/index.html` | `/analises/` | Hub de análises editoriais. |
| `apostas.html` | `/apostas.html` | Área de login/apostas preservada; flags públicas atuais desativam login/módulos privados. |
| `regras.html` | `/regras.html` | Regras do bolão privado preservado; marcada como página privada. |

### Rotas limpas

Os diretórios `jogos/`, `tabela/`, `resultados/`, `bolao/` e `aniversariantes/` contêm `index.html` minimalistas que redirecionam para views da raiz. São publicados explicitamente pelo deploy. `/jogos`, `/tabela` e `/resultados` são as rotas limpas públicas relevantes. `/bolao` e `/aniversariantes` permanecem por compatibilidade histórica.

### Menu atual

O menu principal do `index.html` expõe: **Estatísticas, Jogos, Ao vivo, Tabela, Resultados, Análises, Clubes, Museu e Copa 2026**. O rodapé aponta para **Sobre o Fórmula do Gol**. `br-menu.js` remove o link legado “Agenda” quando aparece em menus antigos.

---

## 3. Front-end compartilhado

### JavaScript (`js/`)

| Arquivo | Função |
|---|---|
| `br-acuracia.js` | Renderiza o painel público de acurácia/timeline do AF‑Previsão. |
| `br-agenda.js` | Agenda consolidada dos clubes, filtros por competição/mês e canais/players. |
| `br-analises.js` | Interação dos artigos editoriais, inclusive modal seguro de vídeo YouTube. |
| `br-aovivo.js` | Central ao vivo multicompetição; scoreboard ESPN 30 s, agenda e transmissões. |
| `br-apostas.js` | Login, palpites, administração e ligações Supabase do módulo privado preservado. |
| `br-classificacao-live.js` | Motor compartilhado que projeta classificação com placares `in`/FINAL ainda não incorporado. |
| `br-clube-retorno.js` | Preserva contexto/âncora de retorno ao navegar para fichas de clubes. |
| `br-clubes.js` | Fichas dos 20 clubes, elenco, agenda, desempenho e projeções. |
| `br-config.js` | Configuração pública: temporada, flags de recursos, Supabase anon e regra de apostas. |
| `br-estatisticas.js` | Página Estatísticas/Probabilidades: líderes, jogos, público, AF-Score, AF‑Previsão, histórico e live sync. |
| `br-feedback.js` | Modal de sugestões/feedback e envio para backend Supabase. |
| `br-menu.js` | Menu responsivo/flutuante, rotas, flags de autenticação e indicador de saúde. |
| `br-museu.js` | Museu do Brasileirão: campeões, títulos, recordes, filtros e links para clubes. |
| `br-pontuacao.js` | Motor de pontuação do bolão privado preservado. |

### CSS (`css/`)

| Arquivo | Escopo |
|---|---|
| `br-acuracia.css` | Acurácia do AF‑Previsão. |
| `br-agenda.css` | Agenda consolidada. |
| `br-analises.css` | Hub/artigos editoriais e modal de mídia. |
| `br-aovivo.css` | Central Ao vivo. |
| `br-apostas.css` | Área privada/apostas/regras. |
| `br-estatisticas.css` | Estatísticas, probabilidades, público e AF-Score. |
| `br-global.css` | Base visual compartilhada, menu/rodapé/responsividade. |
| `br-institucional.css` | Clubes, Museu e páginas institucionais. |
| `br-jogos.css` | Home/Jogos/Tabela/Resultados. |
| `br-sobre.css` | Página Sobre. |

### Assets

- `img/header-formula-do-gol-v2.png` e `img/header-formula-do-gol.png`: cabeçalhos/branding.
- `img/escudo-neutro.svg`: fallback visual.
- `img/mascotes/`: 20 mascotes originais, um por clube da Série A 2026.
- `favicon-formula-do-gol-*`, `apple-touch-icon-formula-do-gol.png`: ícones.
- `og-image-formula-do-gol-v1.png` e `og-image-formula-do-gol-v2.jpg`: Open Graph/compartilhamento.

O workflow de deploy usa `scripts/otimizar_imagens.py` para reduzir o pacote público sem alterar nomes/URLs dos arquivos.

### Arquivos estruturais da raiz e dependências

- `CNAME`: domínio canônico `formuladogol.com.br`.
- `robots.txt`, `sitemap.xml`, `news-sitemap.xml` e `feed.xml`: descoberta/indexação/SEO e distribuição editorial.
- `78f8b10d32edcce04827b713eae52df5.txt`: arquivo público de verificação da chave usada pelo IndexNow; não é segredo.
- `requirements-af-previsao.txt`: dependências Python fixadas do pipeline científico/operacional (`numpy==2.3.5` e `curl-cffi==0.15.0` no snapshot documentado).
- `favicon-formula-do-gol.ico` e variantes PNG/Apple Touch: identidade visual do site/navegadores.
- `deploy.yml`, `atualizar-elencos-brasileirao.yml`, `buscar-melhores-momentos-getv.yml`, `buscar-transmissoes-aovivo-brasileirao.yml`, `publicar-analise-copa-do-brasil.yml` e `publicar-analise-rodada.yml` existentes na **raiz** são cópias históricas/auxiliares; os workflows efetivamente executáveis pelo GitHub ficam em `.github/workflows/`.

### Documentos técnicos complementares já preservados em `docs/`

Além deste documento e de `CONTEXTO.md`, permanecem como histórico/apoio:

- `LEIA-ATUALIZAR-CLUBES-JOGADORES.md`;
- `af-previsao-execucao-1.md`;
- `af-previsao-execucao-2.md`;
- `af-previsao-execucao-2-5.md`;
- `af-previsao-execucao-4.md`;
- `af-previsao-execucao-5.md`;
- `execucao-6-correcao-fluxos-videos-transmissoes.md`;
- `execucao-7-ajuste-mobile-metodologia-af-previsao.md`;
- `execucao-8-ajustes-menu-resultado-clubes.md`.

Esses arquivos registram etapas específicas de implementação. Em caso de conflito com o estado atual, **`CONTEXTO.md` e `DOCUMENTACAO.md` prevalecem** para arquitetura/operacional vigente.

---

## 4. Classificação, jogos e resultados

### Arquivos principais de raiz

- `tabela.json`: classificação oficial fechada e normalizada para os 20 nomes canônicos.
- `jogos.json`: agenda/proximidade de jogos do Brasileirão.
- `resultados.json`: resultados encerrados.
- `espn_eventos.json`: índice normalizado de eventos ESPN, IDs, rodada, times, placares, status e metadados.
- `transmissoes.json`: ajuste/editorial manual legado de transmissão com precedência quando aplicável.
- `membros.json`: dados históricos dos membros/aniversários preservados para módulos legados/Copa.

### `atualizar_espn.py`

Produz os quatro artefatos principais de forma transacional. A consulta do scoreboard atual é otimizada em duas camadas:

1. tenta **uma consulta anual** (`01/01–31/12`, `limit=500`) e só aceita se não regredir resultados históricos já confirmados;
2. se a anual falhar/bloquear/omitir eventos, usa o último `espn_eventos.json` íntegro e atualiza uma janela crítica **10 dias para trás / 21 dias para frente**, mais janelas complementares de até 45 dias para trás e 75 dias para frente;
3. em primeira implantação, sem snapshot local, pode fazer blocos de 28 dias;
4. standings e scoreboard precisam descrever estado esportivo coerente antes da publicação;
5. falha transitória preserva o snapshot anterior e atualiza `dados-br/status-atualizacao.json`.

`fontes_brasileirao.py` contém a camada complementar CBF/API-Football. `dados-br/resultados-manuais.json` e `dados-br/ajustes-calendario.json` registram exceções versionadas.

### AO VIVO no navegador

`js/br-classificacao-live.js` é o motor único de projeção da classificação. `index.html` e `estatisticas.html` o reutilizam. Durante a janela operacional, o scoreboard ESPN é lido a cada **30 s**. O algoritmo valida falsos `post`, adiamentos e FINAL precoce, evita duplicar jogo já incorporado e aplica os critérios: pontos → vitórias → saldo → gols pró → nome como desempate técnico final de estabilidade da interface.

Na home, a janela padrão começa 20 min antes e vai até 150 min após o início previsto. A aba Resultados também pode consultar live para reconciliar encerramentos. Em `estatisticas.html`, o refresh leve e o live refresh usam 30 s e sentinelas de hash/status para evitar baixar todo o conjunto pesado sem necessidade.

---

## 5. Estatísticas e página `estatisticas.html`

A página carrega, em conjunto, líderes oficiais, `estatisticas-competicao`, `jogos-detalhes`, ranking de desempenho/histórico, tabela, resultados, agenda, auditorias e todos os artefatos do AF‑Previsão.

Abas/áreas funcionais:

- **Probabilidades**: tabela de clubes, título, Libertadores, Sul-Americana, rebaixamento, posição/pontos projetados, faixa e detalhes.
- **Artilheiros e Assistências**: exclusivamente a partir da fonte de líderes aceita; summaries não “inventam” ranking oficial.
- **Jogos**: cards com placar, eventos e estatísticas detalhadas.
- **Gols por clube**: total e marcadores conhecidos.
- **Campeonato**: performance por partida, sequências e público.
- **Público**: filtros por clube/mandante/visitante/todos, ordenação por média/total/máximo e lista de jogos.
- **Desempenho/AF‑Score**: ranking, métricas, comparação de até três clubes e histórico.
- **Histórico do AF**: evolução versionada por clube/métrica.
- **Metodologia e auditoria**: base histórica, modelo, simulação e integridade.
- **Avaliação final**: só aparece quando `avaliacao-af-previsao.json` autoriza publicação pós-campeonato.

Durante jogos, somente classificação factual (posição/pontos/jogos e badges live/final) é atualizada em tempo real. Percentuais/projeções permanecem no snapshot do AF e a interface explicita a diferença.

---

## 6. AF‑Previsão — arquitetura científica

Configuração central: `dados-br/config-af-previsao.json`. Documentação científica complementar: `docs/af-previsao-execucao-*.md`.

### Base histórica e backtesting

- temporadas históricas: 2023, 2024, 2025;
- 380 partidas/20 clubes/38 rodadas por temporada esperadas;
- validação temporal fora da amostra e prevenção explícita de leakage;
- candidatos: frequência histórica, Poisson regularizado, Poisson MAP/Bayesiano, Dixon–Coles temporal, Elo dinâmico e híbrido DC+Elo;
- métricas de seleção: Log Loss (peso 0,5), Brier multiclasse (0,3), RPS (0,2), ECE como diagnóstico.

### Produção 2026

- arquitetura: `poisson_map_bayesiano`;
- desvio do prior: 0,4; meia-vida: 365 dias;
- Monte Carlo padrão: 2.000.000; semente versionada;
- EWMA de forma recente: janela 12 jogos, alpha 0,18, peso 0,08, ativação mínima 6 jogos e limites conservadores;
- AF-Score não entra no modelo de produção enquanto não houver cobertura histórica equivalente;
- Dixon–Coles permanece com `rho=0` em produção e `rho=0,08` em sensibilidade até comprovar ganho fora da amostra.

### Vagas continentais

`scripts/atualizar_competicoes_af_previsao.py` cria snapshots ESPN de Copa do Brasil, Libertadores e Sul-Americana. `scripts/af_previsao_continental.py` simula esses torneios e aplica, em cada universo, vagas diretas/preliminares e repasses. `scripts/reconciliar_af_continental.py` impede o estado “copas novas + AF antigo”.

### Saídas

- `probabilidades-brasileirao.json`: probabilidade final por clube e decomposição continental;
- `probabilidades-jogos.json`: V/E/D pré-jogo;
- `probabilidades-por-pontuacao.json`: curva pontos × chance de objetivos;
- `historico-probabilidades.json`: snapshots encadeados;
- `historico-probabilidades-jogos.json`: previsão congelada pré-kickoff + observados;
- `historico-probabilidades-continentais.json`: marcos continentais;
- `auditoria-probabilidades*.json`: hashes, integridade e cobertura;
- `avaliacao-af-previsao.json`: avaliação pós-campeonato quando elegível;
- `acuracia-af-previsao.json`: painel público de acompanhamento.

---

## 7. Acurácia

`scripts/gerar_acuracia_af_previsao.py` preserva a previsão V/E/D realmente publicada antes do kickoff, acompanha timeline de posição/pontos/probabilidades e evita reconstruir previsões antigas com informação futura. A interface pública é agregada; não expõe “acurácia jogo a jogo” individual como ranking de acertos. A faixa central de 80% só é aferida quando a classificação final está disponível.

`scripts/gerar_balanco_acuracia_temporada.py` pode gerar um editorial especial de encerramento quando os pré-requisitos finais forem cumpridos.

---

## 8. Públicos

A coleta foi separada do pipeline pesado. O orquestrador dispara `atualizar-publicos-brasileirao.yml` somente quando há FINAL sem público e o backoff venceu.

Política:

- primeira tentativa 15 min após FINAL;
- backoff: 30 min (até 2h), 60 min (até 6h), 120 min (até 24h), 360 min (até 72h), 720 min (até 168h), 1440 min depois;
- GE/Gato Mestre é a fonte documental automática principal;
- descoberta pelo sitemap diário do GE; slug histórico previsível é apenas fallback;
- usar público presente/total; nunca pagantes como substituto;
- valor existente divergente gera conflito, não sobrescrita silenciosa;
- propagação para IDs duplicados da mesma partida;
- nenhuma novidade = nenhum commit/deploy;
- novidade = `publicos-complementares`, `auditoria-publicos`, `jogos-detalhes` e `estatisticas-competicao` atualizados.

---

## 9. Transmissões

### Grade de TV

`scripts/atualizar_transmissoes_tv_brasileirao.py` consolida CBF, GE Agenda, artigos GE, ESPN e ajustes manuais. Janela padrão: 2 dias para trás e 62 para frente; crítica em 72 h. O orquestrador roda a grade normalmente uma vez por dia após 06:30 e faz nova tentativa apenas se houver pendência crítica e tiver passado o intervalo de 6 h.

### Player GE TV/CazéTV

`scripts/buscar_transmissoes_aovivo_brasileirao.py` procura somente nos channelIds oficiais, cruza clubes+horário e prioriza GE TV. O orquestrador entra na janela 90 min antes / 180 min depois e pode tentar a cada 10 min enquanto faltar link elegível. Manual tem prioridade absoluta.

---

## 10. Melhores momentos

Arquivos principais: `getv-config.json`, `melhores-momentos.json`, `melhores-momentos-manual.json`, `auditoria-melhores-momentos.json`, `auditoria-fontes-melhores-momentos.json`.

O workflow `buscar-melhores-momentos-getv.yml` é `workflow_dispatch` e é chamado pelo orquestrador. Primeira tentativa 10 min após FINAL. Backoff: 10 min até 2h, 30 min até 6h, 2h até 24h, 6h até 72h e 12h depois. O pipeline saneia fontes, preserva manual, busca playlists/canais oficiais e também atualiza melhores momentos da fase atual da Copa do Brasil.

`substituir-fontes-mm.yml` é uma revisão manual/administrativa para reprocessar fontes preferidas, com `dry_run` e limites de busca.

---

## 11. Agenda, clubes, elencos e ranking de desempenho

- `gerar_agenda_clubes_brasileirao.py`: reúne Brasileirão + Copa do Brasil + Libertadores + Sul-Americana para clubes da Série A, do dia atual ao fim do mês seguinte.
- `buscar_detalhes_jogos_brasileirao.py`: incremental ESPN summary, preservando detalhes anteriores em oscilação.
- `buscar_lideres_jogadores_espn.py`: reconstrói líderes oficiais aceitos de gols/assistências e valida completude.
- `buscar_elencos_brasileirao.py`: roster ESPN tolerante a falhas parciais; workflow semanal segunda 06:17 UTC.
- `baixar_elencos_local.py` / `baixar_fotos_elencos_local.py`: carga pesada/local opcional.
- `gerar_estatisticas_brasileirao.py`: `estatisticas.json`, `ranking-desempenho.json`, histórico e `jogadores.json`.
- `ranking-desempenho.json`: AF‑Score/ranking vivo; é uma leitura de desempenho publicada, não variável automática do AF‑Previsão.

---

## 12. Conteúdo editorial

O diretório `analises/` contém o hub e os artigos HTML já publicados. O índice `dados-br/analises.json` mantém metadados. Os geradores determinísticos atualizam também `sitemap.xml`, `news-sitemap.xml` e `feed.xml`.

Critério do Brasileirão em `config-analises.json`: fechamento normal com 10 jogos; pode publicar após a janela principal quando houver ao menos 8 jogos e pendência realmente adiada (distância configurada de 72 h), respeitando espera pós-último jogo.

O editorial da Copa do Brasil detecta a fase e só fecha quando todos os confrontos do snapshot daquela fase terminaram. Melhores momentos da fase podem ser incorporados.

---

## 13. Auditoria IA diária

Workflow `auditoria-ia-diaria.yml`: cron `45 11 * * *` = 08:45 BRT, mais dispatch manual. Há lock persistente diário antes da API para impedir segunda chamada concorrente.

Regras implementadas em `scripts/auditoria_ia_diaria.py`:

- somente esse workflow pode referenciar `secrets.OPENAI_API_KEY` (self-test verifica);
- modelo via variável `OPENAI_AUDIT_MODEL`, fallback `OPENAI_MODEL`, depois default do workflow;
- no máximo uma chamada à OpenAI por data BRT;
- no máximo uma tool call de `web_search` dentro dessa chamada;
- análise determinística precede a IA;
- não altera placar, classificação, cálculos ou estatística matemática;
- complementos factuais exigem evidência/fonte/confiança;
- e-mail Resend apenas quando há criticidade não resolvida ou falha operacional grave.

---

## 14. Orquestrador inteligente

### Componentes

- `.github/workflows/orquestrador-inteligente.yml`: runner leve e dispatcher;
- `scripts/orquestrar_workflows.py`: decide;
- `dados-br/config-orquestrador.json`: política;
- cron externo recomendado: `*/10 * * * *` via cron-job.org → GitHub REST `workflow_dispatch`.

### Mapeamento de ações

| Ação do decisor | Workflow disparado | Inputs |
|---|---|---|
| `atualizar_brasileirao` | `atualizar-brasileirao.yml` | padrão |
| `publicos` | `atualizar-publicos-brasileirao.yml` | padrão |
| `melhores_momentos` | `buscar-melhores-momentos-getv.yml` | `modo=incremental` |
| `transmissao_aovivo` | `buscar-transmissoes-aovivo-brasileirao.yml` | `modo=aovivo`, `event_id` |
| `transmissoes_tv` | `buscar-transmissoes-aovivo-brasileirao.yml` | `modo=tv` |
| `editorial_copa_do_brasil` | `publicar-analise-copa-do-brasil.yml` | padrão |
| `editorial_rodada` | `publicar-analise-rodada.yml` | `rodada` |

### Regras de Atualizar Brasileirão

- pré-jogo se a base estiver velha dentro da janela configurada;
- **FINAL ainda não incorporado** dispara imediatamente;
- falha/pendência recebe retentativa curta;
- manutenção de segurança diária após 05:10;
- **gol/placar `in` não dispara**;
- não há mais heartbeat pesado só porque o jogo está acontecendo.

### Correção importante do step de resumo

`ACAO=none` deve finalizar com código 0. O workflow usa `if` explícito para campos opcionais (`EVENT_ID`, `RODADA`, `MODO`) e `exit 0`; não usar `[[ cond ]] && echo` como último comando de um step com `set -e`, pois condição falsa vira exit 1 e produz falha espúria.

### Configuração do cron-job.org

Chamada externa conceitual:

```text
POST https://api.github.com/repos/LAERCIOREHEM/formuladogol/actions/workflows/orquestrador-inteligente.yml/dispatches
Authorization: Bearer <TOKEN_FINE_GRAINED>
Accept: application/vnd.github+json
Content-Type: application/json
body: {"ref":"main"}
```

O token deve ser fine-grained, limitado ao repositório e com **Actions: Read and write**. Não documentar nem comitar o valor do token. O cron-job.org é **infraestrutura externa e não fica versionado no repositório**; ele pode ser pausado durante manutenção, mas a configuração pretendida é um dispatch do orquestrador a cada 10 minutos — nunca um dispatch direto do workflow pesado.

---

## 15. GitHub Actions — inventário atual

| Arquivo | Nome | Gatilho | Jobs |
|---|---|---|---|
| `apurar-brasileirao.yml` | Apurar Apostas Brasileirão | manual/API (`workflow_dispatch`) | apurar |
| `atualizar-brasileirao.yml` | Atualizar Brasileirao (ESPN) | manual/API (`workflow_dispatch`) | Buscar dados ESPN e publicar JSONs; Avisar falha sem publicar artefatos |
| `atualizar-elencos-brasileirao.yml` | Atualizar Elencos Brasileirao (ESPN) | manual/API (`workflow_dispatch`); schedule: `17 6 * * 1` | Buscar elencos ESPN e publicar JSON |
| `atualizar-publicos-brasileirao.yml` | Atualizar públicos do Brasileirão | manual/API (`workflow_dispatch`) | Completar públicos pendentes |
| `auditar-af-previsao-continental.yml` | Auditar AF-Previsão Continental | manual/API (`workflow_dispatch`); push filtrado | Validar coleta, simulação e alocação de vagas |
| `auditar-af-previsao.yml` | Auditar modelos AF-Previsão | manual/API (`workflow_dispatch`); push filtrado | Validar base histórica e executar backtesting |
| `auditoria-ia-diaria.yml` | Auditoria IA diária | manual/API (`workflow_dispatch`); schedule: `45 11 * * *` | auditar |
| `buscar-melhores-momentos-getv.yml` | Buscar melhores momentos oficiais | manual/API (`workflow_dispatch`) | buscar |
| `buscar-transmissoes-aovivo-brasileirao.yml` | Buscar transmissões dos clubes do Brasileirão | manual/API (`workflow_dispatch`) | Procurar transmissões oficiais |
| `deploy.yml` | Deploy site (GitHub Pages) | manual/API (`workflow_dispatch`); push filtrado | Publicar GitHub Pages |
| `notificar-sugestoes.yml` | Notificar sugestões por e-mail | manual/API (`workflow_dispatch`); schedule: `17 */2 * * *` | notificar |
| `orquestrador-inteligente.yml` | Orquestrador inteligente Fórmula do Gol | manual/API (`workflow_dispatch`) | Decidir próxima ação útil |
| `publicar-analise-copa-do-brasil.yml` | Publicar análise editorial da Copa do Brasil | manual/API (`workflow_dispatch`) | publicar |
| `publicar-analise-rodada.yml` | Publicar análise editorial da rodada | manual/API (`workflow_dispatch`) | publicar |
| `substituir-fontes-mm.yml` | Revisar melhores momentos Brasileirão oficiais | manual/API (`workflow_dispatch`) | revisar |

### Schedules que permanecem intencionalmente no repositório

- `atualizar-elencos-brasileirao.yml`: `17 6 * * 1` (semanal).
- `auditoria-ia-diaria.yml`: `45 11 * * *` (08:45 BRT).
- `notificar-sugestoes.yml`: `17 */2 * * *` (a cada 2 h).

Os workflows de atualização principal, público, vídeos, transmissões e editoriais são `workflow_dispatch` e devem ser acionados pelo orquestrador/operador, não por schedules redundantes.

### Concorrência

Workflows escritores usam majoritariamente `group: repo-write-main` para serializar commits. O orquestrador usa `fdg-orquestrador` com cancelamento da decisão anterior. Pages usa `group: pages` + `cancel-in-progress: true`.

---

## 16. Scripts Python — inventário

| Script | Responsabilidade resumida |
|---|---|
| `atualizar_espn.py` | atualizar_espn.py — Fonte ESPN para o módulo Brasileirão 2026. |
| `fontes_brasileirao.py` | Fontes complementares e auditáveis do Brasileirão. |
| `scripts/af_previsao_backtest.py` | Backtesting comparativo da Execução 1 do AF-Previsão. |
| `scripts/af_previsao_base_historica.py` | Validação e auditoria da base histórica do projeto AF-Previsão. |
| `scripts/af_previsao_continental.py` | Motor continental integrado do AF-Previsão — Execução 2.5. |
| `scripts/apurar_rodada.py` | apurar_rodada.py — Apuração auditável das apostas do Brasileirão 2026. |
| `scripts/atualizar_competicoes_af_previsao.py` | Atualiza as competições que influenciam as vagas continentais do AF-Previsão. |
| `scripts/atualizar_publicos_brasileirao.py` | Completa público presente de jogos finalizados: ESPN quando disponível e GE/Gato Mestre como fonte documental, com descoberta via sitemap, auditoria, preservação de conflitos e propagação para derivados. |
| `scripts/atualizar_transmissoes_tv_brasileirao.py` | Consolida transmissões oficiais dos clubes do Brasileirão. |
| `scripts/auditoria_ia_diaria.py` | Camada diária de inteligência/auditoria do Fórmula do Gol. |
| `scripts/avaliar_af_previsao.py` | Avalia o histórico público do AF-Previsão sem antecipar resultados futuros. |
| `scripts/baixar_elencos_local.py` | baixar_elencos_local.py — execução local pesada dos elencos do Brasileirão. |
| `scripts/baixar_fotos_elencos_local.py` | baixar_fotos_elencos_local.py — baixa localmente as fotos dos jogadores. |
| `scripts/buscar_detalhes_jogos_brasileirao.py` | Coleta incrementalmente summary/scoreboard ESPN de jogos finalizados para `jogos-detalhes.json`, preservando estatísticas boas quando a fonte oscila. |
| `scripts/buscar_elencos_brasileirao.py` | buscar_elencos_brasileirao.py — coleta elencos dos clubes do Brasileirão pela ESPN. |
| `scripts/buscar_lideres_jogadores_espn.py` | Reconstrói artilharia/assistências a partir dos eventos validados jogo a jogo e usa rankings ESPN apenas como referência/fallback, bloqueando regressões e nomes contaminados. |
| `scripts/buscar_melhores_momentos_copa_do_brasil.py` | Localiza melhores momentos oficiais das fases eliminatórias da Copa do Brasil 2026 no YouTube. |
| `scripts/buscar_melhores_momentos_getv.py` | Busca playlists/vídeos de melhores momentos da GE TV e cruza com jogos do Brasileirão. |
| `scripts/buscar_transmissoes_aovivo_brasileirao.py` | Localiza transmissões oficiais dos clubes do Brasileirão nos canais GE TV e CazéTV. |
| `scripts/gerar_acuracia_af_previsao.py` | Mantém o histórico auditável e o painel público de acurácia do AF-Previsão. |
| `scripts/gerar_agenda_clubes_brasileirao.py` | Gera a agenda complementar dos clubes do Brasileirão. |
| `scripts/gerar_analise_copa_do_brasil.py` | Publica o fechamento editorial das fases eliminatórias da Copa do Brasil 2026. |
| `scripts/gerar_analise_rodada.py` | Gera e valida as análises editoriais estáticas do Brasileirão. |
| `scripts/gerar_auditoria_calendario.py` | Gera e audita o calendário completo do Brasileirão 2026. |
| `scripts/gerar_auditoria_cobertura_resultados.py` | Gera auditoria de cobertura da aba Resultados do Brasileirão. |
| `scripts/gerar_auditoria_estatisticas_brasileirao.py` | Audita líderes, detalhes, estatísticas e ranking antes do commit, bloqueando regressões gritantes/contaminação textual. |
| `scripts/gerar_balanco_acuracia_temporada.py` | Gera o editorial especial de encerramento do AF-Previsão 2026. |
| `scripts/gerar_estatisticas_brasileirao.py` | gerar_estatisticas_brasileirao.py — Estatísticas do Brasileirão v2. |
| `scripts/gerar_estatisticas_competicao_brasileirao.py` | Consolida performance por partida, sequências, públicos, gols por clube, marcadores e índice de jogos em `estatisticas-competicao.json`. |
| `scripts/gerar_probabilidades_brasileirao.py` | Gera as probabilidades do AF-Previsão para o Brasileirão 2026. |
| `scripts/gerar_probabilidades_jogos.py` | Gera probabilidades pré-jogo de vitória, empate e derrota. |
| `scripts/gerar_relatorio_fontes_melhores_momentos.py` | Audita as fontes dos melhores momentos exibidos na aba Resultados. |
| `scripts/gerenciar_status_brasileirao.py` | Gera o estado operacional do Brasileirão e envia alertas privados. |
| `scripts/notificar_sugestoes.py` | Lê feedbacks pendentes no Supabase, envia cada sugestão via SMTP Zoho e marca como enviada somente após sucesso, permitindo retentativa segura. |
| `scripts/orquestrar_workflows.py` | Orquestrador determinístico dos workflows do Fórmula do Gol. |
| `scripts/otimizar_imagens.py` | Otimizador de imagens do site (execucao local, uma unica vez ou quando entrarem imagens novas). |
| `scripts/reconciliar_af_continental.py` | Garante que o AF publicado corresponda exatamente ao estado esportivo atual. |
| `scripts/substituir_fontes_preferidas_mm.py` | Sanitiza/substitui melhores momentos usando apenas fontes editoriais permitidas; aplica UOL só como fallback após 48 h e gera relatório de pendências/substituições. |
| `scripts/validar_artefatos_analises.py` | Valida o arquivo editorial do Fórmula do Gol, localmente ou no pacote do Pages. |
| `scripts/validar_python_embutido_workflow.py` | Compila os blocos ``python - <<'PY'`` dos workflows antes da coleta pesada. |

---

## 17. `dados-br/` — inventário completo dos JSONs

Os arquivos abaixo são parte do estado/auditoria/configuração do site. Arquivos em subpastas são listados separadamente.

| Arquivo | Papel |
|---|---|
| `dados-br/acuracia-af-previsao.json` | Painel/timeline público de acurácia do AF‑Previsão. |
| `dados-br/agenda-clubes-br.json` | Agenda consolidada dos clubes da Série A nas quatro competições monitoradas. |
| `dados-br/ajustes-calendario.json` | Correções versionadas de rodada/data/estado do calendário. |
| `dados-br/analises-notificacoes.json` | Fila/estado de notificações editoriais pós-deploy. |
| `dados-br/analises.json` | Índice dos artigos editoriais publicados. |
| `dados-br/apostas-config.json` | Janela e configuração de rodadas do bolão privado. |
| `dados-br/apuracao.json` | Apuração completa das apostas e rankings/ligas. |
| `dados-br/auditoria-base-historica-af-previsao.json` | Auditoria das temporadas históricas usadas no backtest. |
| `dados-br/auditoria-calendario.json` | Cobertura/consistência dos 380 jogos. |
| `dados-br/auditoria-cobertura-resultados.json` | Cobertura de vídeo e estatísticas na aba Resultados. |
| `dados-br/auditoria-competicoes-af-previsao.json` | Saúde e hashes dos snapshots Copa do Brasil/Libertadores/Sul-Americana. |
| `dados-br/auditoria-elencos.json` | Completude/qualidade dos elencos. |
| `dados-br/auditoria-estatisticas.json` | Travas de regressão das estatísticas. |
| `dados-br/auditoria-fontes-melhores-momentos.json` | Origem dos vídeos e pendências por fonte preferida. |
| `dados-br/auditoria-jogos-detalhes.json` | Cobertura de summaries, eventos e público por jogo. |
| `dados-br/auditoria-lideres-jogadores.json` | Validação da fonte de artilharia/assistências. |
| `dados-br/auditoria-melhores-momentos.json` | Resultado da coleta automática de vídeos. |
| `dados-br/auditoria-modelos-af-previsao.json` | Backtesting e seleção de modelos do AF. |
| `dados-br/auditoria-probabilidades-jogos.json` | Integridade das probabilidades pré-jogo. |
| `dados-br/auditoria-probabilidades.json` | Integridade/metodologia/hashes do AF publicado. |
| `dados-br/auditoria-publicos.json` | Cobertura, pendências, fontes e conflitos de público. |
| `dados-br/auditoria-ranking-desempenho.json` | Metodologia/cobertura do AF‑Score/ranking vivo. |
| `dados-br/auditoria-transmissoes-aovivo.json` | Aceites/rejeições/quota da descoberta GE TV/CazéTV. |
| `dados-br/auditoria-transmissoes-tv.json` | Cobertura e pendências da grade de TV. |
| `dados-br/avaliacao-af-previsao.json` | Estado e métricas finais/pós-campeonato quando elegíveis. |
| `dados-br/calendario-completo.json` | Matriz canônica de 380 partidas, datas e pendências. |
| `dados-br/clubes.json` | Metadados dos 20 clubes. |
| `dados-br/config-af-previsao.json` | Configuração científica completa do AF‑Previsão. |
| `dados-br/config-analises.json` | Critérios de fechamento editorial por rodada. |
| `dados-br/config-orquestrador.json` | Política determinística, prioridades e backoffs do orquestrador. |
| `dados-br/config-transmissoes-aovivo.json` | Canais oficiais, janelas e regras de player ao vivo. |
| `dados-br/config-transmissoes-tv.json` | Fontes, janelas e política da grade de TV. |
| `dados-br/creditos-fotos-jogadores.json` | Créditos/estado do uso de fotos de jogadores. |
| `dados-br/elencos.json` | Elencos ESPN dos clubes. |
| `dados-br/estatisticas-competicao.json` | Performance, sequências, público, gols por clube e índice de jogos. |
| `dados-br/estatisticas.json` | Estatísticas consolidadas, líderes derivados e dados por clube. |
| `dados-br/getv-config.json` | Configuração e política de fontes dos melhores momentos. |
| `dados-br/getv-playlists.json` | Playlists GE TV descobertas/cacheadas. |
| `dados-br/historico-probabilidades-continentais.json` | Marcos históricos das chances continentais. |
| `dados-br/historico-probabilidades-jogos.json` | Previsões pré-jogo congeladas e resultados observados. |
| `dados-br/historico-probabilidades.json` | Snapshots encadeados do AF‑Previsão. |
| `dados-br/historico-ranking-desempenho.json` | Snapshots do ranking AF‑Score/desempenho. |
| `dados-br/jogadores.json` | Eventos/jogadores consolidados para estatísticas. |
| `dados-br/jogos-detalhes.json` | Summary/boxscore/eventos/público por event_id. |
| `dados-br/lideres-jogadores.json` | Rankings oficiais de gols e assistências aceitos. |
| `dados-br/mascotes.json` | Mapa dos mascotes originais por clube. |
| `dados-br/melhores-momentos-copa-do-brasil.json` | Vídeos oficiais vinculados à fase atual da Copa do Brasil. |
| `dados-br/melhores-momentos-manual.json` | Overrides manuais prioritários de vídeos. |
| `dados-br/melhores-momentos.json` | Vínculos automáticos de vídeos do Brasileirão. |
| `dados-br/museu-brasileirao.json` | Base histórica do Museu. |
| `dados-br/participantes-bolao-classificacao.json` | Participantes e estado da classificação do bolão. |
| `dados-br/probabilidades-bolao.json` | Chance projetada de título do bolão privado via universos do AF. |
| `dados-br/probabilidades-brasileirao.json` | Saída principal do AF‑Previsão por clube. |
| `dados-br/probabilidades-jogos.json` | Probabilidades V/E/D por partida futura. |
| `dados-br/probabilidades-por-pontuacao.json` | Curvas de pontos necessários por objetivo/probabilidade. |
| `dados-br/publicos-complementares.json` | Complementos documentais de público presente. |
| `dados-br/ranking-apostas.json` | Ranking público/apurado das apostas. |
| `dados-br/ranking-desempenho.json` | AF‑Score/ranking vivo de desempenho. |
| `dados-br/relatorio-substituicao-fontes.json` | Relatório de saneamento/substituição de fontes de vídeos. |
| `dados-br/resultados-manuais.json` | Overrides auditáveis de resultado para exceções ESPN. |
| `dados-br/status-atualizacao.json` | Saúde operacional e último snapshot do Brasileirão. |
| `dados-br/transmissoes-aovivo-manual.json` | Override manual de player/transmissão ao vivo. |
| `dados-br/transmissoes-aovivo.json` | Players oficiais encontrados automaticamente. |
| `dados-br/transmissoes-tv.json` | Grade consolidada de transmissão por jogo. |

### `dados-br/competicoes-af-previsao/`

- `copa-do-brasil.json`: snapshot ESPN normalizado da Copa do Brasil.
- `libertadores.json`: snapshot ESPN normalizado da Libertadores.
- `sul-americana.json`: snapshot ESPN normalizado da Sul-Americana.

### `dados-br/historico-af-previsao/`

- `brasileirao-2023.json`, `brasileirao-2024.json`, `brasileirao-2025.json`: bases históricas completas para backtesting.

---

## 18. Supabase e bolão privado preservado

O front está em modo público, mas a infraestrutura de bolão permanece versionada.

### Configuração front

`js/br-config.js` contém URL e anon/publishable key do Supabase e flags `login=false`, `modulosPrivados=false`, `copa2026=true`. A anon key não é segredo; RLS e RPCs são a barreira de segurança.

### Evolução SQL (`supabase/`)

- `brasileirao_apostas.sql`
- `brasileirao_apostas_exec10.sql`
- `brasileirao_apostas_exec11.sql`
- `brasileirao_apostas_exec12_ligas.sql`
- `brasileirao_apostas_exec13_rankings_liga.sql`
- `brasileirao_apostas_exec14_permissoes_ligas.sql`
- `brasileirao_apostas_exec15_ligas_admin_visual.sql`

As migrações criam/evoluem `br_palpites`, `br_config_rodadas`, `br_participantes`, `br_sessoes`, auditoria/comprovantes, ligas e vínculos, além de RPCs de login, validação de sessão, salvamento, listagem, administração, auditoria e permissões de administrador global/por liga.

`scripts/apurar_rodada.py` usa `SUPABASE_SERVICE_ROLE_KEY` apenas no backend do Actions para apuração sigilosa. Nunca disponibilizar service role em JS.

---

## 19. Feedback e notificações

`br-feedback.js` envia sugestões para o backend configurado. `scripts/notificar_sugestoes.py` busca pendências em `public.feedback_site` no Supabase, envia via SMTP Zoho e só marca `enviado_email=true` após confirmação. O workflow `notificar-sugestoes.yml` roda a cada 2 horas e não precisa disparar deploy.

O status esportivo/erros críticos usa `scripts/gerenciar_status_brasileirao.py` e Resend. O JSON público contém mensagens seguras; detalhes técnicos ficam para administração/logs.

---

## 20. SEO, Analytics e publicação editorial

- `robots.txt`: referencia `https://formuladogol.com.br/sitemap.xml`.
- `sitemap.xml`: URLs principais e artigos.
- `news-sitemap.xml`: conteúdo editorial recente para notícias.
- `feed.xml`: feed editorial.
- schema.org/JSON-LD está presente em páginas públicas relevantes.
- Open Graph/Twitter usam `og-image-formula-do-gol-v2.jpg`.
- Google Analytics: `G-3956SD5HFC` em páginas públicas.
- Google Ads/conversão: `AW-18273186827` em páginas/rotas onde configurado.
- deploy notifica IndexNow após publicação; falha dessa notificação é aviso, não falha do site.

---

## 21. Deploy GitHub Pages

Workflow: `.github/workflows/deploy.yml`.

Responsabilidades principais:

1. checkout de `main`;
2. montar `_site` somente com conteúdo publicável;
3. atualizar `lastmod` de sitemaps quando necessário;
4. otimizar imagens no pacote público;
5. validar HTML/rotas/JSON/SEO/CNAME/assets/analises/Copa;
6. configurar Pages e destravar/cancelar implantações concorrentes;
7. upload do artifact;
8. deploy com até três tentativas controladas;
9. confirmar publicação editorial/notificações;
10. IndexNow;
11. alerta de falha por e-mail quando configurado.

O deploy possui `pages: write`, `id-token: write`, `contents: write` e `deployments: read`. Concurrency `pages` cancela execução obsoleta em favor da nova.

### Arquivos `.yml` duplicados na raiz

Existem cópias históricas de alguns workflows na raiz (`deploy.yml`, `atualizar-elencos-brasileirao.yml`, `buscar-melhores-momentos-getv.yml`, `buscar-transmissoes-aovivo-brasileirao.yml`, `publicar-analise-*.yml`). **GitHub Actions só executa arquivos em `.github/workflows/`**. As cópias da raiz não são fonte operacional e podem divergir; não editar uma cópia de raiz achando que alterou o workflow ativo.

---

## 22. Secrets e variables

Secrets referenciados pelos workflows:

- `API_FOOTBALL_KEY`
- `API_FOOTBALL_LEAGUE_ID`
- `EMAIL_DESTINO`
- `EMAIL_DESTINO_SUGESTOES`
- `EMAIL_REMETENTE`
- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `SMTP_HOST`
- `SMTP_PASS`
- `SMTP_PORT`
- `SMTP_USER`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`
- `YOUTUBE_API_KEY`

Variables relevantes incluem `OPENAI_AUDIT_MODEL`/`OPENAI_MODEL`. Outros parâmetros podem ser passados por env/inputs conforme o script. Nunca documentar o valor de secrets.

---

## 23. Módulo `copa2026/` — inventário atualizado

O módulo possui aproximadamente 142 MB sobretudo por imagens de jogadores. Continua independente do Brasileirão principal.

### Páginas

| Arquivo | Título atual |
|---|---|
| `copa2026/admin.html` | Admin — Bolão Copa 2026 |
| `copa2026/aovivo.html` | Copa do Mundo 2026 ao vivo — Fórmula do Gol |
| `copa2026/estatisticas.html` | Estatísticas da Copa do Mundo 2026 — Fórmula do Gol |
| `copa2026/index.html` | Jogos da Copa do Mundo 2026 — Fórmula do Gol |
| `copa2026/museu.html` | Museu da Copa do Mundo — Fórmula do Gol |
| `copa2026/onde-assistir.html` | Onde assistir à Copa do Mundo 2026 — Fórmula do Gol |
| `copa2026/palcos.html` | Sedes da Copa do Mundo 2026 — Fórmula do Gol |
| `copa2026/palpite.html` | Bolão Copa 2026 — Brasileirão Almoço |
| `copa2026/palpites.html` | Palpites de todos — Bolão Copa 2026 |
| `copa2026/pontos.html` | Bolão — Ranking e Reis do Cravo · Copa 2026 |
| `copa2026/regras.html` | Regras — Bolão Copa 2026 |
| `copa2026/selecoes.html` | Seleções da Copa do Mundo 2026 — Fórmula do Gol |

Além do bolão histórico (`palpite.html`, `palpites.html`, `pontos.html`, `admin.html`), o módulo inclui central pública de partidas, Ao vivo, Estatísticas, Seleções, Onde assistir, Palcos e Museu.

### JavaScript

- `copa2026/js/admin.js`
- `copa2026/js/aniversarios.js`
- `copa2026/js/aovivo.js`
- `copa2026/js/app.js`
- `copa2026/js/avisos-site.js`
- `copa2026/js/br-apostas.js`
- `copa2026/js/chances-bolao.js`
- `copa2026/js/config.js`
- `copa2026/js/engine.js`
- `copa2026/js/estatisticas.js`
- `copa2026/js/feedback.js`
- `copa2026/js/image-preview.js`
- `copa2026/js/jogo-stats.js`
- `copa2026/js/museu.js`
- `copa2026/js/onde-assistir.js`
- `copa2026/js/palcos.js`
- `copa2026/js/palpites.js`
- `copa2026/js/pontos.js`
- `copa2026/js/pontuacao.js`
- `copa2026/js/resultados.js`
- `copa2026/js/selecoes.js`
- `copa2026/js/times.js`

### Dados

- `copa2026/dados/agenda_mata.json`
- `copa2026/dados/agenda_workflow_copa.json`
- `copa2026/dados/clubes_jogadores_cache.json`
- `copa2026/dados/clubes_jogadores_relatorio.json`
- `copa2026/dados/correcoes-jogadores.json`
- `copa2026/dados/elencos.json`
- `copa2026/dados/estatisticas.json`
- `copa2026/dados/estrutura_mata_mata.json`
- `copa2026/dados/fairplay.json`
- `copa2026/dados/jogos-completos.json`
- `copa2026/dados/jogos-detalhes.json`
- `copa2026/dados/lives.json`
- `copa2026/dados/melhores-momentos.json`
- `copa2026/dados/museu-copa.json`
- `copa2026/dados/paises.json`
- `copa2026/dados/palcos.json`
- `copa2026/dados/palcos_creditos.json`
- `copa2026/dados/palpites_mata.json`
- `copa2026/dados/ranking-desempenho.json`
- `copa2026/dados/ranking-selecoes-historico.json`
- `copa2026/dados/rostos.json`
- `copa2026/dados/rostos_creditos.json`
- `copa2026/dados/rostos_estado.json`
- `copa2026/dados/rostos_relatorio.json`
- `copa2026/dados/selecoes.json`
- `copa2026/dados/terceiros_map.json`
- `copa2026/dados/transmissoes.json`
- `copa2026/dados/workflow_copa_estado.json`

### Scripts Python

- `copa2026/buscar_clubes_jogadores.py`
- `copa2026/buscar_detalhes_jogos.py`
- `copa2026/buscar_estatisticas.py`
- `copa2026/buscar_fairplay.py`
- `copa2026/buscar_fotos_palcos.py`
- `copa2026/buscar_melhores_momentos.py`
- `copa2026/buscar_rostos_jogadores.py`
- `copa2026/buscar_selecoes.py`
- `copa2026/deve_rodar_workflow_copa.py`
- `copa2026/diagnostico_youtube.py`
- `copa2026/gerar_palpites_mata.py`
- `copa2026/gerar_ranking_desempenho.py`
- `copa2026/gerar_ranking_historico.py`
- `copa2026/scripts/atualizar_copa.py`
- `copa2026/scripts/extrair_anexo_c.py`

### Assets

- `copa2026/img/jogadores/`: mais de mil fotos locais/cacheadas de jogadores.
- `copa2026/img/bolas/`: imagens históricas de bolas.
- `copa2026/img/mascotes/`: mascotes da Copa.
- `copa2026/img/palcos/`: imagens dos estádios/palcos com créditos em JSON.

Detalhes de regras do bolão e arquitetura interna permanecem em `copa2026/docs/01...06`.

---

## 24. Testes e validação obrigatória

### Python

```bash
python -m py_compile caminho/do/script.py
python caminho/do/script.py --self-test   # quando existir
```

### JavaScript

```bash
node --check js/arquivo.js
```

### JSON

```bash
python -m json.tool arquivo.json > /dev/null
```

### YAML

Parsear todos os `.github/workflows/*.yml` e validar Python embutido com `scripts/validar_python_embutido_workflow.py` quando o workflow contiver heredoc Python.

### Regressões essenciais

- nomes canônicos dos 20 clubes;
- `tabela.json`, `resultados.json`, `jogos.json` e `espn_eventos.json` coerentes;
- nenhum FINAL falso de jogo futuro;
- classificação live não duplica resultado já armazenado;
- Estatísticas e Tabela usam o mesmo estado live;
- AF publicado corresponde aos hashes esportivos/continentais atuais;
- sem regressão de 380 jogos no calendário;
- nenhum público pagante convertido em presente;
- nenhum vídeo de fonte proibida publicado;
- respostas vazias de transmissão não apagam grade válida;
- `ACAO=none` do orquestrador termina em sucesso;
- deploy contém todas as páginas/assets obrigatórios e não possui symlinks indevidos.

---

## 25. Operações manuais comuns

### Testar o orquestrador sem executar workflow pesado

GitHub → Actions → **Orquestrador inteligente Fórmula do Gol** → Run workflow → `dry_run=true`. Também há inputs `sem_rede` e `agora` para simulação.

### Forçar atualização principal

Rodar `Atualizar Brasileirao (ESPN)` manualmente. `forcar_af` existe para uso excepcional; `reconstruir_fontes` força reconstrução das três competições continentais. Não usar sem motivo.

### Atualizar somente públicos

Rodar `Atualizar públicos do Brasileirão`. Se nenhuma fonte nova for encontrada, o snapshot não é tocado.

### Revisar vídeos

Rodar `Buscar melhores momentos oficiais` em modo `incremental` ou `backfill`; para saneamento manual amplo, usar `Revisar melhores momentos Brasileirão oficiais` com `dry_run` primeiro.

### Transmissões

`Buscar transmissões dos clubes do Brasileirão` aceita `aovivo`, `tv` e `completo`, `event_id` opcional e `dry_run`. Em operação normal, deixe o orquestrador escolher.

### Editorial

Os dois workflows editoriais aceitam dispatch manual; `forcar` serve apenas para regeneração/diagnóstico deliberado.

---

## 26. Diagnóstico rápido

### ESPN 403

Não interpretar como “não existe informação”. O sistema deve preservar o snapshot e usar a estratégia anual → incremental. Ver `status-atualizacao.json` e logs do workflow.

### Estatísticas divergentes da Tabela durante jogo

Verificar `br-classificacao-live.js`, carregamento em `estatisticas.html` e `index.html`, e console de fetch ESPN. Não resolver recalculando AF a cada gol.

### Público faltando depois do FINAL

Ver `auditoria-publicos.json`; o orquestrador deve despachar o workflow específico após o backoff. Se matéria GE existir com slug inesperado, o coletor deve descobri-la pelo sitemap.

### Workflow orquestrador vermelho com ação `none`

Isso foi corrigido. Confirmar que o step “Resumir decisão” usa `if` e `exit 0`, sem `[[ ... ]] && echo` como último comando.

### Deploy parado/cancelado por concorrência

Confirmar `concurrency.group=pages` e `cancel-in-progress=true`; uma execução nova deve substituir a obsoleta. O próprio deploy contém etapas de destravar e retentar Pages.

---

## 27. Convenções de manutenção

- Interface em PT-BR.
- Datas/horários esportivos em BRT quando exibidos ao usuário.
- JSONs automáticos devem ser gerados por scripts; edição manual somente em arquivos explicitamente destinados a override/configuração.
- Toda fonte complementar deve deixar rastreabilidade no JSON/auditoria.
- Arquivo anterior válido é preferível a dado novo incompleto.
- Não duplicar regra em várias páginas quando existe módulo compartilhado.
- Não adicionar schedule em workflow especializado sem justificar por que o orquestrador não consegue resolver pelo estado.
- Alteração em JS/CSS pode exigir atualização de `?v=` no HTML para cache busting.
- Alteração estrutural relevante deve atualizar `docs/CONTEXTO.md` e `docs/DOCUMENTACAO.md`.

---

## 28. Inventário físico do snapshot documentado

No estado consolidado analisado em 10/08/2026, após aplicar as correções mais recentes do orquestrador/públicos sobre o repositório enviado, foram contabilizados **1.455 arquivos** (aprox. 201,3 MB). Esse número é diagnóstico de inventário, não invariante: cresce quando entram novas fotos, artigos, snapshots ou dados.

| Área | Arquivos no snapshot | Observação |
|---|---:|---|
| `.github/` | 15 | workflows ativos do GitHub Actions |
| `analises/` | 4 | hub + três artigos publicados no snapshot |
| `copa2026/` | 1.218 | módulo Copa; maior volume é mídia local/cacheada |
| `css/` | 10 | estilos do site principal |
| `dados-br/` | 70 | 64 JSONs na raiz + snapshots/históricos em subpastas |
| `docs/` | 11 | estes dois documentos + documentação técnica histórica |
| `img/` | 23 | identidade/fallback + 20 mascotes |
| `js/` | 14 | módulos JavaScript do site principal |
| `scripts/` | 38 | automação/auditoria/geração do site principal |
| `supabase/` | 7 | SQLs/migrações do bolão/ligas preservado |
| rotas `jogos/`, `tabela/`, `resultados/`, `bolao/`, `aniversariantes/` | 5 | redirects/rotas limpas |

Mídia de maior volume em `copa2026/`: **1.067** arquivos em `img/jogadores/`, **16** em `img/bolas/`, **17** em `img/mascotes/` e **21** em `img/palcos/` no snapshot. O site principal possui **20 mascotes** em `img/mascotes/`. Arquivos binários individuais não são enumerados nominalmente neste documento; sua função e diretórios estão documentados, e o inventário físico acima serve para detectar remoções/regressões acidentais.

---

## 29. Estado documental

Este arquivo foi reconstruído em 10/08/2026 a partir do conteúdo real do repositório. Os documentos antigos de contexto que ainda descreviam `BRASILEIRAO2026ALMOCO`, Terra, cron fixo de 10 minutos, módulos planejados e redirect obrigatório da Copa foram substituídos porque já não representavam a produção atual.
