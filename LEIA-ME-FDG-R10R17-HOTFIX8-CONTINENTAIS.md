# Fórmula do Gol — R10R17 HOTFIX 8
## Continental Phase Transition & Schedule Guard

**Baseline auditada:** `c4cdb7936edce47bb2f2a795a8dfbfb77c3be305`  
**Data:** 13/10/2026 (BRT)

## Incidente corrigido

Após o fechamento das quartas de final, os snapshots continentais permaneceram presos em 18/09/2026. A coleta ESPN ampla vinha falhando com HTTP 400 em intervalos grandes e o mecanismo de preservação segura manteve o último snapshot válido para não corromper o AF-Previsão. Essa proteção era correta para o modelo probabilístico, mas estava sendo tratada como se a **agenda operacional também estivesse atualizada**.

Consequência observada em produção: `dados-br/agenda-clubes-br.json` não continha nenhuma semifinal continental e a página Ao Vivo mostrava Mirassol x Internacional (16/10) como próximo jogo, embora Boca Juniors x Vasco da Gama estivesse oficialmente marcado para 13/10 às 21h30.

## Fonte documental oficial das semifinais

O HOTFIX adiciona `dados-br/correcoes/agenda-continentais-oficial.json` como **fallback de agenda**, não como fonte de placar/FINAL.

- CONMEBOL Sudamericana: https://gol.conmebol.com/sudamericana/pt-br/news/en-busca-de-la-gran-conquista-todo-definido-para-las-semifinales-de-la-conmebol-sudamericana
- CONMEBOL Libertadores: https://gol.conmebol.com/libertadores/pt-br/news/datas-confirmadas-confira-como-serao-disputadas-semifinais-da-conmebol-libertadores

Partidas cobertas:

1. 13/10 21:30 — Boca Juniors x Vasco da Gama — Sul-Americana
2. 14/10 19:00 — Atlético-MG x Montevideo City Torque — Sul-Americana
3. 14/10 21:30 — Fluminense x Palmeiras — Libertadores
4. 15/10 21:30 — Estudiantes de La Plata x Flamengo — Libertadores
5. 20/10 21:30 — Vasco da Gama x Boca Juniors — Sul-Americana
6. 21/10 19:00 — Montevideo City Torque x Atlético-MG — Sul-Americana
7. 21/10 21:30 — Palmeiras x Fluminense — Libertadores
8. 22/10 21:30 — Flamengo x Estudiantes de La Plata — Libertadores

O fallback oficial não inventa `event_id` ESPN. Enquanto a ESPN não reconciliar o evento, a agenda usa identidade de competição + times + horário. O navegador já faz o pareamento conservador por times para aceitar o scoreboard direto da mesma competição. Assim que a coleta estruturada encontra o `event_id`, ela prevalece sobre o fallback documental.

## Correções estruturais

### 1. ESPN com janelas adaptativas

`scripts/atualizar_competicoes_af_previsao.py`

- intervalo padrão do scoreboard continental: **7 dias**;
- em erro HTTP/transporte, o intervalo é subdividido deterministicamente até **1 dia**;
- erro diário continua sendo erro real — não é mascarado por resposta vazia;
- preservação do snapshot anterior continua existindo para proteger o AF;
- auditoria agora diferencia explicitamente:
  - `af_snapshot_seguro`;
  - `agenda_operacional_fresca`;
  - `snapshots_preservados`.

### 2. Fallback oficial de agenda continental

`scripts/gerar_agenda_clubes_brasileirao.py`

- mescla os snapshots estruturados com a agenda oficial CONMEBOL;
- dado estruturado com `event_id` tem precedência;
- fallback documental só cobre agenda futura e nunca placar/FINAL;
- publica `integridade_continental` com:
  - jogos oficiais esperados;
  - faltantes;
  - quantidade de fallbacks oficiais ativos;
- se uma partida oficial desaparecer da agenda, a integridade falha.

### 3. Phase Transition Guardian no Orchestrator

Orchestrator **2.5.0**.

- lê no fast path, a cada 5 minutos, apenas dois artefatos pequenos e autoritativos:
  - auditoria continental;
  - agenda oficial CONMEBOL;
- identifica fase seguinte oficial ausente da agenda;
- em lacuna com partida a menos de 24h: retentativa em **30 min**;
- snapshot preservado sem lacuna urgente: retentativa em **360 min**;
- dispara `atualizar-brasileirao.yml` com `forcar_fontes_continentais=true`;
- essa execução ignora o cache da coleta continental, mas **não reconstrói a temporada inteira** e não força AF sem mudança esportiva;
- writer global continua respeitado.

### 4. Health Monitor

O painel de saúde ganha o indicador **Agenda continental**:

- **RED:** partida oficial ausente;
- **YELLOW:** agenda coberta por fallback CONMEBOL ou integridade ainda não confirmada;
- **GREEN:** agenda continental estruturada e íntegra.

Importante: fallback oficial amarelo é um estado saudável/degradado conhecido — muito melhor que esconder a partida. Ele volta a verde quando a fonte estruturada reconcilia os eventos.

### 5. Workflows sincronizados

Incluídos no pacote:

- `.github/workflows/atualizar-brasileirao.yml`
- `.github/workflows/auditar-af-previsao-continental.yml`
- `.github/workflows/deploy-orchestrator-worker.yml`
- `.github/workflows/deploy-push-worker.yml`

O updater valida o arquivo oficial e bloqueia publicação de agenda com `integridade_continental != ok`.

## Validações locais executadas

- `python -m py_compile` dos scripts alterados: **PASS**
- `atualizar_competicoes_af_previsao.py --self-test`: **PASS**
- `gerar_agenda_clubes_brasileirao.py --self-test`: **PASS**
- Orchestrator `npm run validate`: **81/81 PASS**
- Health Monitor targeted test: **PASS**
- YAML dos 4 workflows: **PASS**
- geração determinística da agenda em `2026-10-13T18:40:00-03:00`: **PASS**
  - 52 jogos no recorte;
  - 8 continentais;
  - `integridade_continental.status = ok`;
  - Boca Juniors x Vasco da Gama aparece como primeiro compromisso do recorte;
  - 8 fallbacks documentais ativos no teste offline, como esperado com os snapshots antigos.

A integração real ESPN/Cloudflare só pode ser confirmada após o upload, pois o ambiente local não possui acesso de rede equivalente ao GitHub Actions/Workers.

## Instalação

1. Descompacte o ZIP.
2. GitHub → **Add file → Upload files**.
3. Arraste **todo o conteúdo mantendo as pastas**.
4. Commit em `main`.

O push altera o Orchestrator e o Health Monitor, portanto os deploys correspondentes são acionados pelo próprio repositório. Após o Orchestrator entrar em `active`, o cron de 5 minutos deve detectar a lacuna continental e solicitar a atualização das fontes. O lock global de escrita continua sendo respeitado; se outro writer estiver ativo, a tentativa seguinte ocorre automaticamente.

## Critério de sucesso em produção

Depois da atualização/deploy do site:

- `/dados-br/agenda-clubes-br.json` deve conter as semifinais;
- `integridade_continental.status` deve ser `ok`;
- a página **Ao Vivo** deve colocar Boca Juniors x Vasco da Gama antes de Mirassol x Internacional;
- o Health Monitor deve deixar de aceitar silêncio sobre uma fase continental seguinte.
