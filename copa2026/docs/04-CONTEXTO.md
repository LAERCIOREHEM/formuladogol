# 04-CONTEXTO.md — Módulo COPA2026

> **Estado:** EM OPERAÇÃO, com a Copa em andamento.  
> **Última atualização desta documentação:** 30/06/2026, horário de Brasília.  
> **Escopo:** este arquivo descreve o contexto real e consolidado do módulo `copa2026/`, considerando o repositório atual e as atualizações feitas em 30/06/2026 na aba **Seleções** e nos links das seleções nas páginas vivas.

Este arquivo deve ser lido antes de qualquer alteração no módulo. Ele não é uma proposta: é o retrato do que existe e das decisões que já foram tomadas.

---

## 1. Finalidade do módulo

O módulo `copa2026/` é a área da Copa do Mundo 2026 dentro do site **Bolão Brasileirão Almoço de Sexta**. Ele funciona como um site estático no GitHub Pages, com dados públicos carregados no navegador, arquivos JSON versionados no repositório e persistência dos palpites em Supabase.

O módulo acumula três papéis:

1. **Bolão privado da turma**  
   Cadastro por nome + PIN, edição de palpites, lacre, auditoria, ranking oficial e disputa paralela do “Reis do Cravo”.

2. **Central pública de acompanhamento da Copa**  
   Jogos por dia, jogos ao vivo, mata-mata, onde assistir, melhores momentos, jogos completos, estatísticas e fichas das seleções.

3. **Base histórica/auditável da Copa**  
   Palpites revelados, hashes SHA-256 dos comprovantes, horários de lacre, resultados oficiais usados no ranking e documentação operacional.

Durante a Copa, a raiz do site pode redirecionar para `copa2026/`. O Brasileirão permanece separado e não deve ter sua lógica misturada com a da Copa.

---

## 2. Princípios fechados

Estas decisões são importantes e não devem ser desfeitas sem motivo forte:

- **Isolamento:** o módulo Copa vive em `copa2026/`. Não misturar JS, regras ou dados do Brasileirão, salvo arquivos compartilhados intencionais, como `../membros.json` para aniversários.
- **Site estático:** não há build próprio do front-end. A publicação depende do GitHub Pages.
- **Supabase apenas para o bolão:** resultados da Copa não são salvos no banco; eles vêm da ESPN no cliente ou de JSONs gerados por robôs.
- **Fonte oficial operacional dos resultados:** feed público da ESPN para scoreboard e summary.
- **Dados automáticos nunca devem inventar informação:** se ESPN, YouTube, Wikipedia/Wikimedia ou JSON local falhar, o front-end deve degradar com segurança.
- **PIN nunca em texto puro:** autenticação via RPCs no Supabase com RLS e funções `SECURITY DEFINER`.
- **Não quebrar páginas vivas:** Partidas, Ao vivo, Mata-mata e Onde assistir têm atualizações frequentes e exigem alterações conservadoras.
- **Aba Seleções virou hub individual das seleções:** deve continuar acessível por dropdown superior, scroll lateral de bandeiras e hash `selecoes.html#SIGLA`.
- **Após o fim da fase de grupos, a ficha da seleção mostra Ranking FIFA, não Grupo.** O campo usado é `seed` em `dados/selecoes.json`.

---

## 3. Páginas existentes e papel de cada uma

### `index.html` — Jogos / Partidas / Grupos / Mata-mata

É a home do módulo. Usa `js/resultados.js`.

Funções principais:

- calendário horizontal por dia;
- lista de jogos do dia;
- status pré-jogo, ao vivo e encerrado;
- placar e pênaltis quando houver;
- gols e cartões extraídos do summary da ESPN;
- transmissão por chips de TV;
- botão/link da CazéTV quando disponível;
- melhores momentos e jogos completos quando os JSONs possuem link;
- botão recolhível de estatísticas do jogo, via `js/jogo-stats.js` e `dados/jogos-detalhes.json`;
- aba de grupos com classificação real;
- aba de mata-mata com chave projetada/confirmada;
- ranking de “quem acertou as seleções que avançaram” quando há palpites carregados.

Atualização de 30/06/2026:

- seleção real exibida em cards de Partidas e Mata-mata virou link para `selecoes.html#SIGLA`;
- placeholders continuam sem link: “A definir”, “Venc. M90”, “1º Grupo A” e equivalentes;
- link é aplicado apenas em bandeira/nome da seleção, não no card inteiro.

### `aovivo.html` — Ao vivo

Usa `js/aovivo.js`.

Funções principais:

- mostra jogo em andamento, atrasado ou dentro da janela operacional;
- atualiza placar/lances com frequência maior apenas quando há necessidade;
- carrega palpites revelados para mostrar situação ao vivo;
- exibe gols, cartões, placar e status;
- pode mostrar cartaz de próximo jogo/lives;
- usa links de CazéTV/lives vindos de `dados/lives.json`.

Atualização de 30/06/2026:

- seleção real exibida no card ao vivo e no cartaz de próximo jogo virou link para `selecoes.html#SIGLA`;
- botões de assistir, estatísticas, palpites e demais ações continuam independentes.

### `onde-assistir.html` — Onde assistir / Visualizar todos os jogos

Usa `js/onde-assistir.js`.

Funções principais:

- lista todos os jogos da Copa;
- permite adicionar todos ao calendário (`.ics`);
- permite compartilhar;
- mostra canais por jogo;
- exibe filtros por seleção e data;
- permite ordenação por data ou seleção, em ordem ascendente/descendente;
- trata jogos de grupo e mata-mata;
- exibe pênaltis, gols e estatísticas de jogo quando disponíveis;
- inclui melhores momentos e jogo completo quando o JSON possui link.

Atualização de 30/06/2026:

- seleção real em cada linha/card virou link para `selecoes.html#SIGLA`;
- filtros, ordenação, calendário, compartilhamento, transmissões e botões foram preservados.

### `estatisticas.html` — Estatísticas

Usa `js/estatisticas.js`, `js/times.js` e `js/jogo-stats.js`.

Funções principais:

- artilheiros;
- assistências;
- gols por seleção;
- cartões;
- jogos por seleção;
- filtro por seleção;
- filtro por fase;
- cards por jogo com placar, data, estádio, pênaltis e botão de estatísticas;
- rostos de jogadores quando há fonte segura, avatar quando não há foto.

A página Estatísticas é a visão geral/ranking da Copa. A aba Seleções reaproveita parte desses dados para montar a visão individual de cada país, mas não deve virar uma cópia da página Estatísticas.

### `selecoes.html` — Seleções

Usa `js/selecoes.js`, `js/times.js` e `js/jogo-stats.js`.

Funções principais:

- dropdown superior “Escolha uma seleção”;
- scroll horizontal de bandeiras;
- cards das 48 seleções;
- ficha individual por seleção via hash `#SIGLA`;
- curiosidades do país;
- ranking FIFA no topo da ficha, usando `seed` de `dados/selecoes.json`;
- elenco com número, posição, foto ou avatar;
- créditos das imagens;
- desempenho da seleção na Copa;
- jogos da seleção;
- marcadores da seleção;
- artilheiro e líder de assistências daquela seleção;
- cartões, média de gols, gols marcados, sofridos, saldo e campanha V/E/D;
- observação específica para mata-mata quando a decisão envolver pênaltis.

Atualização de 30/06/2026:

- a ficha da seleção foi enriquecida com dados de desempenho;
- o campo “Grupo” foi substituído por “Ranking FIFA” na área principal da seleção;
- a seleção pode ser aberta diretamente por links vindos das páginas vivas;
- o topo foi preservado: dropdown e scroll lateral de bandeiras continuam sendo parte essencial da navegação.

### `palpite.html` — Meus Palpites

Usa `js/app.js`, `js/engine.js`, `js/pontuacao.js` e `js/config.js`.

Funções principais:

- login por nome + PIN;
- edição dos palpites dos 104 jogos;
- fase de grupos e mata-mata;
- validação de empates permitidos/proibidos conforme a fase;
- salvamento no Supabase;
- lacre voluntário;
- trava geral;
- geração de comprovante `.txt`;
- hash SHA-256 do palpite canônico;
- auditoria geral quando aplicável;
- comparação com resultado oficial parcial para status das fases.

### `palpites.html` — Palpites de todos

Usa `js/palpites.js`.

Funções principais:

- consome `copa_revelados`;
- mostra palpites por jogo;
- mostra visões por classificação/grupos;
- exibe hash de cada participante;
- só faz sentido depois da liberação/revelação dos palpites.

### `pontos.html` — Bolão / Ranking / Reis do Cravo

Usa `js/pontos.js`, `js/pontuacao.js` e `js/engine.js`.

Funções principais:

- ranking oficial do bolão;
- pontos atuais;
- pontos possíveis/teto/perdidos;
- extrato por participante;
- status de fase do palpite;
- disputa paralela “Reis do Cravo”;
- cálculo do Reis do Cravo somente sobre placares de jogos encerrados da fase de grupos.

### `regras.html` — Regras

Página estática com regras e regulamento do bolão.

### `admin.html` — Área do administrador

Usa `js/admin.js`.

Funções principais:

- login administrativo por senha validada no servidor;
- listar participantes;
- adicionar participantes;
- gerar PIN;
- resetar PIN;
- remover participante;
- trocar senha administrativa;
- exibir situação de envio/lacre;
- gerar JSON manual de melhores momentos no formato esperado.

---

## 4. Dados estáticos e JSONs operacionais

### Dados estruturais

- `dados/selecoes.json`  
  Fonte interna das 48 seleções: sigla/id, nome, grupo original, `seed`/ranking FIFA e `iso2`. O campo `seed` é usado visualmente como Ranking FIFA na aba Seleções.

- `dados/paises.json`  
  Curiosidades do país exibidas na ficha da seleção.

- `dados/elencos.json`  
  Elencos por seleção, gerados a partir da ESPN.

- `dados/estrutura_mata_mata.json`  
  Estrutura da chave do mata-mata.

- `dados/terceiros_map.json`  
  Mapa oficial das combinações dos melhores terceiros.

- `dados/agenda_mata.json`  
  Agenda conhecida dos jogos de mata-mata.

- `dados/agenda_workflow_copa.json`  
  Agenda operacional usada pelo guard do workflow da Copa para decidir se deve rodar.

### Dados de acompanhamento

- `dados/estatisticas.json`  
  Artilheiros, assistências, cartões, gols por seleção, jogos processados e metadados de atualização.

- `dados/jogos-detalhes.json`  
  Estatísticas detalhadas de jogos para o botão “📊 Estatísticas do jogo”.

- `dados/fairplay.json`  
  Pontos de conduta/cartões usados como critério de desempate na fase de grupos.

- `dados/transmissoes.json`  
  Canais extras por jogo. CazéTV é implícita na interface.

- `dados/melhores-momentos.json`  
  Links de melhores momentos por confronto.

- `dados/lives.json`  
  Links de lives ou transmissões agendadas.

- `dados/jogos-completos.json`  
  Links de jogos completos.

- `dados/palpites_mata.json`  
  Apoio/auditoria de palpites de mata-mata.

### Dados de rostos/imagens

- `dados/rostos.json`  
  Mapa nome normalizado → foto local.

- `dados/rostos_estado.json`  
  Cache de busca de rostos e ausências conhecidas.

- `dados/rostos_creditos.json`  
  Créditos/licenças de imagens vindas de Wikipedia/Wikimedia.

- `dados/rostos_relatorio.json`  
  Relatório de cobertura/execução do robô de rostos.

---

## 5. Robôs e workflows

### `melhores-momentos.yml`

Workflow acionado externamente por `workflow_dispatch`, normalmente via cron-job.org. Usa `deve_rodar_workflow_copa.py` para decidir se a Copa deve rodar naquela janela.

Quando `RUN_COPA=true`, executa:

- `buscar_melhores_momentos.py`;
- `buscar_estatisticas.py`;
- `buscar_detalhes_jogos.py`.

Atualiza, quando houver mudança:

- `dados/melhores-momentos.json`;
- `dados/lives.json`;
- `dados/jogos-completos.json`;
- `dados/estatisticas.json`;
- `dados/jogos-detalhes.json`;
- `dados/workflow_copa_estado.json`.

### `deve_rodar_workflow_copa.py`

Guard técnico do workflow pesado da Copa. Objetivo:

- rodar de 1h antes do jogo até janela pós-jogo;
- considerar atrasos, prorrogação e pênaltis;
- usar fallback limitado quando ESPN falhar;
- não rodar em dias sem jogos confirmados, como 08/07/2026;
- desligar o módulo pesado fora da janela real.

### `atualizar-selecoes.yml`

Atualiza elencos e rostos. Executa:

- `buscar_selecoes.py`;
- `buscar_rostos_jogadores.py`.

Possui janela de povoamento controlada por data e inputs manuais para tempo/limite/retry.

### `fairplay.yml`

Atualiza `dados/fairplay.json` com cartões da fase de grupos.

### Workflows do Brasileirão

Existem workflows de Brasileirão no mesmo repositório (`atualizar-jogos.yml`, `atualizar-resultados.yml`, `atualizar-tabela.yml`, `atualizar-tudo.yml`, `enviar-aniversarios.yml`). Eles não devem ser confundidos com os workflows da Copa. O módulo Copa só deve ser alterado quando o caminho estiver sob `copa2026/` ou quando o workflow explicitamente o acionar.

---

## 6. Banco de dados / Supabase

A conexão fica em `js/config.js`, exposta como `window.COPA_CFG`. A anon key é pública por design. A segurança depende de RLS e RPCs no banco.

### Tabelas principais

- `participantes`  
  Participantes, nome único, hash do PIN e horário de lacre.

- `palpites`  
  Payload de palpites, derivado calculado e data/hora de envio.

- `config`  
  Configurações gerais, especialmente trava.

### RPCs usadas pelo front-end

Usuário/bolão:

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

---

## 7. Regras de negócio do bolão

- 104 jogos.
- PIN de 6 dígitos.
- Palpite por placar numérico.
- Empate permitido na fase de grupos.
- Empate proibido no mata-mata.
- Trava geral: 10/06/2026 às 23h59.
- Liberação dos palpites: 11/06/2026 às 00h00.
- Lacre voluntário permitido antes da trava.
- Salvamento bloqueado após lacre ou trava.
- Participante incompleto fica fora da disputa competitiva quando aplicável.
- Nomes duplicados são bloqueados.
- Comprovante tem hash SHA-256 para auditoria.
- Pontuação oficial é por conjuntos de seleções/fases, não por placar jogo a jogo.
- “Reis do Cravo” é disputa apartada da fase de grupos.

---

## 8. Pontuação oficial e Reis do Cravo

### Pontuação oficial

Implementada em `js/pontuacao.js` e consumida por `js/pontos.js`.

Critérios documentados no motor:

- classificados às fases;
- posições de grupo;
- melhores terceiros;
- oitavas;
- quartas;
- semifinais;
- finalistas;
- campeão;
- vice;
- terceiro;
- quarto.

O cálculo mostra pontos atuais, teto, possíveis e perdidos.

### Reis do Cravo

Implementado em `js/pontos.js`, apenas para fase de grupos:

- placar exato: 5 pontos;
- vencedor + saldo: 3 pontos;
- resultado correto: 2 pontos;
- erro: 0 ponto;
- empate pontua quando o empate foi previsto, com 5 se cravou e 2 se acertou apenas o resultado.

---

## 9. Atualizações aplicadas em 30/06/2026

### 9.1. Aba Seleções enriquecida

Arquivos alterados:

- `copa2026/selecoes.html`;
- `copa2026/js/selecoes.js`;
- `copa2026/css/copa.css`.

Resultado:

- a seleção agora exibe um raio-x individual;
- Ranking FIFA substitui Grupo na ficha;
- desempenho inclui campanha, gols, sofridos, saldo, média, cartões, artilheiro, assistências, jogos e marcadores;
- jogos da seleção exibem status, placar, pênaltis, fase, data, estádio e botão de estatísticas quando disponível;
- dados vêm de `estatisticas.json`, scoreboard ESPN e JSONs já existentes;
- se dado não existir, o front-end mostra “—” ou mensagem segura, sem inventar.

### 9.2. Links para seleções nas páginas vivas

Arquivos alterados:

- `copa2026/index.html`;
- `copa2026/onde-assistir.html`;
- `copa2026/aovivo.html`;
- `copa2026/js/resultados.js`;
- `copa2026/js/onde-assistir.js`;
- `copa2026/js/aovivo.js`;
- `copa2026/css/copa.css`.

Resultado:

- seleções reais em Partidas, Mata-mata, Onde assistir/Visualizar todos os jogos e Ao vivo viraram links para `selecoes.html#SIGLA`;
- placeholders e slots não definidos não viram link;
- a âncora envolve apenas bandeira/nome da seleção;
- cards, botões, menu, layout e áreas de bolão/palpites não foram alterados;
- cache-busting dos HTMLs foi atualizado para scripts/CSS envolvidos.

---

## 10. O que não mexer sem necessidade

- Não mexer em Grupos, Bolão, Palpites e Meus Palpites apenas para adicionar links de seleção.
- Não transformar cards inteiros de jogos em links; isso conflita com botões internos.
- Não remover dropdown nem scroll horizontal da aba Seleções.
- Não trocar `seed` por busca externa de ranking sem necessidade.
- Não alterar regra de pontuação durante a Copa sem registrar claramente no regulamento e nesta documentação.
- Não alterar as RPCs ou a estrutura do payload sem migração planejada.
- Não rebaixar fotos/imagens manualmente sem preservar créditos quando a origem exigir.
- Não substituir a lógica ESPN por outra fonte sem validar siglas, fases, status e pênaltis.

---

## 11. Pendências conhecidas / atenção operacional

- Monitorar siglas divergentes da ESPN, principalmente seleções oriundas de repescagem. Quando aparecer card sem link ou sem associação, revisar os mapas de de/para.
- Conferir transmissões do mata-mata à medida que emissoras definirem grade.
- Monitorar se o workflow pesado da Copa está realmente pausando em dias sem jogo.
- Conferir `estatisticas.json` e `jogos-detalhes.json` após jogos com prorrogação/pênaltis.
- Validar se os links de CazéTV/lives continuam corretos, pois IDs de lives podem mudar.
- Depois da Copa, avaliar transformar o módulo em área histórica e desligar workflows pesados.

---

## 12. Instrução obrigatória para futuras IAs/desenvolvedores

Antes de alterar qualquer coisa no módulo Copa:

1. Leia este arquivo.
2. Leia `05-DOCUMENTACAO.md`.
3. Identifique exatamente quais arquivos serão alterados.
4. Preserve o módulo do Brasileirão.
5. Rode `node --check` nos JS alterados.
6. Rode `python -m py_compile` nos Python alterados.
7. Teste desktop e celular quando a alteração afetar layout.
8. Atualize `04-CONTEXTO.md` e `05-DOCUMENTACAO.md` se a alteração mudar comportamento, regra, fluxo, fonte de dados ou operação.
