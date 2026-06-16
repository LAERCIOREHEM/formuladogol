# CONTEXTO.md — Bolão Copa do Mundo 2026 (módulo `copa2026/`)

> **Estado:** EM OPERAÇÃO (Copa em andamento). Última atualização: 16/06/2026.
> Este arquivo deve ser lido antes de qualquer alteração no módulo.

## Finalidade
Preservar o contexto real do módulo da Copa para futuras IAs, desenvolvedores e manutenções. Descreve o que **foi efetivamente construído** (não o plano original).

## Visão geral
O Bolão Copa 2026 é um módulo dentro do site Brasileirão2026Almoço (site estático em GitHub Pages). Vive na subpasta `copa2026/` e tem o seu próprio front-end (HTML/CSS/JS) e back-end serverless (Supabase). Os participantes (24) cadastram nome + PIN, palpitam os 104 jogos da Copa, e o sistema calcula classificação, mata-mata, pontuação e auditoria.

Durante o período da Copa (até 20/07/2026), o `index.html` da **raiz** do site redireciona automaticamente para `copa2026/`. A partir de 21/07 o redirect cessa e o Brasileirão volta a ser a home, com o Bolão Copa como aba histórica.

## Arquitetura real

### Front-end (`copa2026/`)
Páginas (todas com o mesmo cabeçalho-marca "COPA 26" e menu fixo):
- `index.html` — **Jogos** (é a home do módulo): lista de jogos por dia (feed ESPN) + aba "Grupos" com a tabela de classificação dos grupos. Roda `js/resultados.js`.
- `palpite.html` — **Meus Palpites**: o editor de palpites (login, 104 placares, chave do mata-mata, comprovante). Roda `js/app.js`.
- `aovivo.html` — **Ao vivo**: jogos em andamento com placar/medalhas em tempo real. Roda `js/aovivo.js`.
- `palpites.html` — **Palpites**: palpites revelados de todos, por jogo. Roda `js/palpites.js`.
- `pontos.html` — **Classificação**: duas visões — "Bolão" (ranking oficial) e "Placares" (Reis do Cravo). Roda `js/pontos.js`.
- `regras.html` — regras + regulamento + adendo Reis do Cravo.
- `admin.html` — área do organizador. Roda `js/admin.js`.

Scripts compartilhados: `js/engine.js` (gera jogos e deriva classificação/mata-mata), `js/pontuacao.js` (pontos do bolão), `js/config.js` (conexão Supabase), `js/aniversarios.js` (pop-up de aniversário do Brasileirão). CSS único: `css/copa.css`.

Dados estáticos (`dados/`): `selecoes.json` (48 seleções: id=sigla que casa com a ESPN, nome, grupo, seed, iso2), `estrutura_mata_mata.json`, `terceiros_map.json`, `transmissoes.json` (canais por jogo).

### Back-end (Supabase)
- URL e anon key públicas em `js/config.js` (`window.COPA_CFG`). A segurança vem do RLS e das funções `SECURITY DEFINER`.
- Tabelas: `participantes(id, nome UNIQUE, pin_hash, finalizado_em)`, `palpites(participante_id, payload jsonb, derivado jsonb, enviado_em)`, `config(chave, valor)`.
- `payload` = `{placaresGrupos:{jogo_id:{ga,gb}}, placaresMata:{mId:{a,b}}, status}`.
- RPCs (todas SECURITY DEFINER): `copa_login`, `copa_salvar`, `copa_meu_palpite`, `copa_status`, `copa_revelados`, `copa_finalizar`, `copa_minha_situacao`, `copa_lacres`, e as de admin.
- PIN nunca em texto puro — `pgcrypto` (`extensions.crypt`).

### Fonte de resultados
Feed público da ESPN, consumido client-side:
`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD`
CORS liberado. As siglas da ESPN casam com o `id` de `selecoes.json` (validado em produção). `season.slug`: `group-stage`, `round-of-32`, `round-of-16`, `quarterfinals`, `semifinals`, `third-place`, `final`.

## Funcionalidades em operação
- **Lacre individual + trava geral**: participante pode "Finalizar" o palpite a qualquer momento (lacre voluntário, com data/hora) ou é travado automaticamente na trava geral (10/06 23h59). Bloqueio é server-side (`copa_salvar` recusa após lacre/trava).
- **Comprovante**: arquivo .txt com nome, data/hora, situação, 104 placares e **impressão digital SHA-256**. Mesma impressão exibida na página Palpites — permite auditoria.
- **Medalhas**: por jogo, "CRAVOU/CRAVANDO" (placar exato) e bolinha verde (acertou o resultado). Em Ao vivo é "cravando"; em Resultados/Palpites vira "cravou" no apito final.
- **Tabela dos grupos** (aba Grupos em Jogos): P/J/V/E/D/GP/GC/SG dos resultados reais, ordenação FIFA (pontos → saldo → gols pró).
- **Reis do Cravo** (aba Placares em Classificação): disputa apartada só da fase de grupos. Cravou placar = 5, acertou vencedor + saldo = 3, só o resultado = 2, errou = 0 (empate vale 5 ou 2). Prêmio do organizador. Extrato jogo a jogo por participante.
- **Transmissões**: selos das emissoras por jogo (CazéTV sempre + extras de `transmissoes.json`) e botão "Assistir na CazéTV" (link fixo `youtube.com/@CazeTV/live`; iframe bloqueado pela emissora, erro 153).
- **Aniversários**: `js/aniversarios.js` busca `../membros.json` (do Brasileirão) e mostra pop-up/banner de aniversário também dentro da Copa.

## Decisões fechadas (regras de negócio)
- PIN de 6 dígitos; placar por campos numéricos (sem dropdown, sem auto-preenchimento).
- 104 jogos; empate permitido em grupos, proibido no mata-mata.
- Trava geral 10/06/2026 23h59; liberação 11/06 00h00.
- Pontuação do bolão por **conjunto de seleções** (ver `js/pontuacao.js`).
- Reis do Cravo é **apartado** e foi criado com palpites já lacrados (vale igual para todos).
- Campeão > vice; 3º > 4º. Participante incompleto fora do ranking competitivo. Nomes duplicados bloqueados.

## O que NÃO fazer
- Não quebrar o Brasileirão (raiz) nem misturar a lógica dos dois.
- Não salvar PIN em texto puro.
- Não confiar só no front-end para bloqueio após a trava.
- Não reproduzir o emblema oficial da FIFA — a marca "COPA 26" é arte original.
- Ao editar arquivos do módulo, **sempre** atualizar `docs/04-CONTEXTO.md` e `docs/05-DOCUMENTACAO.md`.

## Pendências conhecidas
- Conferir siglas das 5 vagas de repescagem de `selecoes.json` conforme as seleções entram em campo (card sem "ver palpites" = sigla divergente → mapear em `ESPN_OVR`).
- Mata-mata de `transmissoes.json` a preencher quando as emissoras definirem.
- Validar números da Classificação/Reis do Cravo conforme os jogos avançam.

## Instrução para futuras IAs
Antes de alterar: 1) ler este arquivo; 2) ler `05-DOCUMENTACAO.md`; 3) manter o módulo isolado do Brasileirão; 4) validar JS com `node --check`; 5) atualizar a documentação se a decisão mudar.
