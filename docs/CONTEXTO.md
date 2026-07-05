# CONTEXTO.md — Site Bolão Brasileirão Almoço

> **Estado:** EM PRODUÇÃO. Última atualização: 05/07/2026 (Brasileirão v2 — fonte ESPN, AO VIVO, novo visual).
> Leia este arquivo antes de qualquer alteração no site.

## Finalidade
Preservar o contexto do site do "Bolão Brasileirão Almoço" (grupo "Almoço de Sexta") para futuras IAs, desenvolvedores e manutenções. Descreve o que existe e as decisões já tomadas.

## O que é o site
Site estático hospedado no **GitHub Pages** (domínio próprio via `CNAME`: brasileirao2026almoco.com.br). Repositório `LAERCIOREHEM/BRASILEIRAO2026ALMOCO`. Um único `index.html` (HTML + CSS + JS embutidos) com navegação por abas, alimentado por arquivos `.json` que são atualizados automaticamente por scripts Python rodando em **GitHub Actions**.

O público são ~27 amigos do grupo "Almoço de Sexta". O site mostra o ranking do bolão do Campeonato Brasileiro, a tabela, próximos jogos, resultados e aniversariantes do grupo.

## Estrutura (raiz do repositório)
- `index.html` — o site inteiro (abas: **Jogos** [página de entrada], Ranking, Brasileirão, Resultados, Aniversariantes, Admin). Visual v2: logo `img/header-br.jpg`, menu com rolagem lateral, pódio no Ranking, tabela com escudos/forma, jogos com filtro por clube e **placar AO VIVO via ESPN (30s)**.
- `membros.json` — os 27 membros do grupo e suas datas de aniversário.
- `tabela.json` — classificação do Brasileirão (gerada por `atualizar_espn.py`, **fonte ESPN**). Os 20 nomes de time são CANÔNICOS — o Ranking depende deles; o robô falha sem gravar se algum nome não mapear.
- `espn_eventos.json` — de-para de jogos da ESPN (id, times canônicos, transmissão), gerado por `atualizar_espn.py`.
- `transmissoes.json` — ajuste MANUAL de "onde assistir" (prioridade sobre Globo/ESPN).
- `jogos.json` — próximos jogos (gerada por `atualizar_jogos.py`).
- `resultados.json` — jogos já realizados (gerada por `atualizar_resultados.py`).
- `atualizar_espn.py` — busca classificação + eventos na **ESPN** (`bra.1`); substitui o antigo `atualizar.py` (Terra), que permanece no repositório apenas como rollback (nenhum workflow o executa).
- `atualizar_jogos.py`, `atualizar_resultados.py` — continuam no Globo (têm nº da rodada e escudos).
- `verificar_aniversarios.py` — verifica aniversariante do dia e envia e-mail (Resend.com).
- `.github/workflows/atualizar-brasileirao.yml` — **workflow principal do Brasileirão** (cron a cada 10 min + dispatch): roda `atualizar_espn.py` + jogos + resultados e publica os 4 JSONs num commit só.
- `.github/workflows/atualizar-tudo.yml` — hoje cuida SOMENTE do ranking de desempenho da Copa (disparado pelo cron-job.org a cada 5 min). Remover junto com o job do cron-job.org após 20/07/2026.
- Os antigos `atualizar-tabela.yml`, `atualizar-jogos.yml` e `atualizar-resultados.yml` foram descontinuados (deletar).
- `copa2026/` — **módulo independente** do Bolão da Copa (tem o seu próprio `docs/`). Não misturar a lógica dos dois.

## Período da Copa (módulo temporário)
Durante a Copa do Mundo (até **20/07/2026**), o `index.html` da raiz **redireciona automaticamente** para `copa2026/`, fazendo o Bolão da Copa ser a primeira coisa que o visitante vê. Há uma saída: acessar com `?brasileirao=1` mantém o Brasileirão visível (grava a preferência na sessão do navegador). A partir de **21/07/2026** o redirect cessa e o Brasileirão volta a ser a home; o Bolão Copa fica acessível como link/menu.

> Esse redirect vive no `<script>` do `index.html` da raiz. Não removê-lo antes de 20/07.

## Aniversariantes
- Lista em `membros.json` (`{nome, aniversario:{dia,mes}}`).
- No site: aba "Aniversariantes", um **pop-up** (1x/dia por dispositivo) e um **banner** permanente quando há aniversário no dia (fuso de Brasília).
- Por e-mail: `verificar_aniversarios.py` + workflow `enviar-aniversarios.yml` mandam um e-mail no dia.
- **No módulo da Copa**: `copa2026/js/aniversarios.js` reaproveita este `membros.json` (lê `../membros.json`) e exibe o mesmo pop-up/banner dentro da Copa, para não perder datas durante o torneio.

## Decisões e histórico relevante
- O grupo **TUPAL** (outro grupo do organizador) já teve uma aba e lista de aniversários aqui, mas foi **migrado para um site próprio** e removido deste repositório em 06/2026 (aba, dados `membros_tupal.json`, script e workflow). Não readicionar.
- O site usa salvamento de membros no GitHub via Admin (token pessoal guardado no `localStorage` do organizador).
- Atualização dos JSON é automática via Actions (cron); não editar os JSON na mão salvo correção pontual.

## O que NÃO fazer
- Não quebrar o redirect do período da Copa (até 20/07).
- Não misturar a lógica do `copa2026/` com a do Brasileirão.
- Não reintroduzir o grupo TUPAL.
- Não comitar tokens/segredos no repositório (o token do Admin vive só no navegador do organizador; o do e-mail é secret do Actions).

## Instrução para futuras IAs
Antes de alterar: 1) ler este arquivo e o `DOCUMENTACAO.md` ao lado; 2) se mexer no módulo da Copa, ler também `copa2026/docs/04-CONTEXTO.md` e `05-DOCUMENTACAO.md`; 3) manter os dois projetos isolados; 4) atualizar a documentação quando uma decisão mudar.
