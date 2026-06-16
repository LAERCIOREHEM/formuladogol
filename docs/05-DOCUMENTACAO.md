# DOCUMENTACAO.md — Bolão Copa do Mundo 2026 (módulo `copa2026/`)

> Última atualização: 16/06/2026. Documenta a estrutura real, manutenção e operação do módulo.

## Estrutura de arquivos (real)
```text
copa2026/
  index.html        # Jogos (home do módulo) + aba Grupos
  palpite.html      # Meus Palpites (editor)
  aovivo.html       # Ao vivo
  palpites.html     # Palpites revelados
  pontos.html       # Classificação (Bolão + Reis do Cravo)
  regras.html       # Regras e regulamento
  admin.html        # Área do organizador
  css/
    copa.css        # estilo único de todas as páginas
  js/
    app.js          # editor de palpites (Meus Palpites)
    engine.js       # gera jogos dos grupos e deriva classificação/mata-mata
    pontuacao.js    # cálculo de pontos do bolão
    resultados.js   # Jogos + tabela dos grupos
    aovivo.js       # jogos ao vivo
    palpites.js     # palpites revelados por jogo
    pontos.js       # Classificação (2 visões) + Reis do Cravo
    admin.js        # painel do organizador
    config.js       # conexão Supabase (window.COPA_CFG)
    aniversarios.js # pop-up de aniversário (lê ../membros.json)
  dados/
    selecoes.json          # 48 seleções (id, nome, grupo, seed, iso2)
    estrutura_mata_mata.json
    terceiros_map.json
    transmissoes.json      # canais por jogo (além da CazéTV)
  docs/
    01..06-*.md            # regras, regulamento, UX, contexto, esta doc, checklist
```

## Como rodar e publicar
Site estático no GitHub Pages. Não há build. Fluxo de manutenção:
1. Editar os arquivos localmente (working dir tipicamente `C:\Users\laerc\documents\site_apostas\`).
2. Validar JS alterado: `node --check js/ARQUIVO.js`.
3. `git add -A` → `git commit -m "..."` → `git push`.
4. Aguardar 1–3 min (GitHub Actions → "pages build"); testar com `?v=N` para furar cache.

> **Cache:** GitHub Pages serve com validade ~10 min + cache do navegador. Sempre testar com `?v=N` e avisar os participantes de dar refresh.

## Banco de dados (Supabase)
Conexão em `js/config.js`:
```js
window.COPA_CFG = { url: "https://<projeto>.supabase.co", key: "<anon key pública>" };
```
A anon key é pública por design — a proteção vem do RLS (ON em `participantes`, `palpites`, `config`) e das funções `SECURITY DEFINER` com `search_path` fixo. PIN protegido por `pgcrypto` (`extensions.crypt`/`crypt(pin, pin_hash)`).

### Tabelas
- `participantes(id, nome UNIQUE, pin_hash, finalizado_em timestamptz)`
- `palpites(participante_id, payload jsonb, derivado jsonb, enviado_em)`
- `config(chave, valor)` — guarda, entre outros, a chave `trava` (timestamp da trava geral).

### Funções (RPC) principais
- `copa_login(nome, pin)` — autentica.
- `copa_salvar(nome, pin, payload, derivado)` — salva; recusa se `finalizado_em` preenchido (lacre) ou após a trava.
- `copa_meu_palpite(nome, pin)` — devolve o palpite do participante.
- `copa_finalizar(nome, pin)` — lacra o palpite (grava `finalizado_em`); recusa após a trava.
- `copa_minha_situacao(nome, pin)` — informa se está finalizado e quando.
- `copa_lacres()` — lista nome, data/hora do lacre e se foi voluntário (após a trava).
- `copa_revelados()` — palpites de todos (para a página Palpites e auditoria).

## Fonte de resultados (ESPN)
`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD&limit=N`
- `season.slug` indica a fase. `competitions[0].status.type.state` ∈ {`pre`,`in`,`post`}.
- A sigla `competitor.team.abbreviation` casa com o `id` de `selecoes.json`. Divergências raras (repescagem) são corrigidas por um mapa `ESPN_OVR` no JS da página.

## Operações comuns

### Renomear um participante
```sql
update participantes set nome = 'NOVO' where nome = 'ANTIGO';
```
PIN e palpite são preservados (ligados pelo `id`). Avisar a pessoa que o login passa a ser o novo nome.

### Ver quem lacrou e quando
```sql
select nome, finalizado_em at time zone 'America/Sao_Paulo'
from participantes where finalizado_em is not null order by finalizado_em;
```

### Atualizar transmissões (`dados/transmissoes.json`)
Chave = siglas dos times em ordem alfabética separadas por `-`. Valor = lista de canais extras (além da CazéTV, sempre implícita). Jogo sem entrada = só CazéTV. Catálogo de cores/nomes em `TV_CAT` (em `aovivo.js`/`resultados.js`).

### Boletim de sexta / Auditoria
Rodam no console do navegador (não há SQL para resultados, pois eles vêm da ESPN no cliente): abrir a página Palpites, F12 → Console, colar o script do kit e copiar a saída. Geram, respectivamente, o ranking semanal e o relatório completo de auditoria (palpites + hash + horário do lacre).

## Pontuação

### Bolão (oficial) — `js/pontuacao.js`
Por conjunto de seleções (classificados, avanços por fase, pódio). Teto de 100% = 442 pts. Mostra atuais, perdidos, possíveis e teto.

### Reis do Cravo (apartado) — `js/pontos.js`, fase de grupos
- Placar cravado: 5
- Vencedor + saldo de gols: 3
- Só o resultado (V/E/D): 2
- Errou: 0
- Empate vale 5 (cravou) ou 2 (apostou outro empate). Só pontua jogo encerrado. Desempate: pontos → cravadas → acertos no saldo → ordem alfabética.

## Aniversários no módulo Copa
`js/aniversarios.js` é autônomo: busca `../membros.json` (o do Brasileirão), detecta aniversariante do dia (fuso de Brasília), mostra pop-up 1x/dia por dispositivo e um banner permanente no topo. Estilos em `copa.css` (`.banner-aniv-copa`, `.bac-*`). Falha de rede é silenciosa.

## Convenções
- PT-BR em toda a interface.
- Tema navy (#0b1f3a) + dourado (#f4c542). Fontes Anton + Archivo.
- Não reproduzir marca registrada (FIFA). A marca "COPA 26" (`img/header-copa26.png`) é arte original.
- Ao mexer em qualquer arquivo do módulo, atualizar `04-CONTEXTO.md` e este arquivo.
