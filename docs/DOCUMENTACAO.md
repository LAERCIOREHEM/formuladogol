# DOCUMENTACAO.md — Site Bolão Brasileirão Almoço

> Última atualização: 16/06/2026. Estrutura real, manutenção e operação do site.

## Visão técnica
Site estático no **GitHub Pages**, sem build. Um `index.html` único contém HTML, CSS e JavaScript. Os dados ficam em arquivos `.json` na raiz, atualizados automaticamente por scripts Python no **GitHub Actions**. Domínio próprio via `CNAME`.

## Estrutura de arquivos
```text
/
  index.html               # site inteiro (abas + JS embutido)
  CNAME                     # domínio
  membros.json             # 27 membros + aniversários
  tabela.json              # classificação do Brasileirão
  jogos.json               # próximos jogos
  resultados.json          # jogos realizados
  atualizar.py             # gera tabela.json
  atualizar_jogos.py       # gera jogos.json
  atualizar_resultados.py  # gera resultados.json
  verificar_aniversarios.py# e-mail de aniversário (Resend)
  favicon*, og-image.png, apple-touch-icon.png
  .github/workflows/       # agendamentos (cron) + commits automáticos
  copa2026/                # módulo da Copa (doc própria em copa2026/docs/)
  docs/                    # CONTEXTO.md e DOCUMENTACAO.md (este arquivo)
```

## Abas do site (`index.html`)
- **Ranking** — ranking do bolão do grupo.
- **Brasileirão** — tabela do campeonato (`tabela.json`).
- **Próximos Jogos** — `jogos.json`.
- **Resultados** — `resultados.json`.
- **Aniversariantes** — lista de `membros.json` + pop-up/banner do dia.
- **Admin** — área do organizador (edição de membros, salvamento no GitHub via token).

A troca de abas é feita por `setView(nome)`. Cada aba tem um `view-<nome>` e um `btn-<nome>`.

## Dados e automação

### Scripts Python (rodam no GitHub Actions)
- `atualizar.py` → `tabela.json` (classificação; tenta múltiplas fontes públicas).
- `atualizar_jogos.py` → `jogos.json` (próximos jogos).
- `atualizar_resultados.py` → `resultados.json` (jogos já realizados).
- `verificar_aniversarios.py` → envia e-mail (Resend.com) quando há aniversariante do dia.

### Workflows (`.github/workflows/`)
- `atualizar-tabela.yml`, `atualizar-jogos.yml`, `atualizar-resultados.yml` — rodam o script correspondente e dão commit do JSON.
- `atualizar-tudo.yml` — orquestra as atualizações (acionado por cron).
- `enviar-aniversarios.yml` — dispara o e-mail de aniversário.

> Os horários são definidos por `cron` em cada workflow. Os segredos (ex.: chave do Resend, e-mails) são **secrets do repositório**, nunca commitados.

## Aniversariantes — detalhe
`membros.json`:
```json
{ "atualizado_em": "...", "total": 27, "membros": [ { "nome": "Laércio", "aniversario": { "dia": 8, "mes": 2 } } ] }
```
- No site: pop-up 1x/dia por dispositivo (`localStorage`) + banner permanente, ambos no fuso de Brasília.
- Por e-mail: workflow diário.
- No módulo da Copa: `copa2026/js/aniversarios.js` lê `../membros.json` e replica o pop-up/banner durante o torneio. Editar a lista de aniversários em **um só lugar** (este `membros.json`) atende site, e-mail e Copa.

## Publicar alterações
1. Editar localmente.
2. Se mexer em Python, testar `python -m py_compile arquivo.py`.
3. `git add -A` → `git commit -m "..."` → `git push`.
4. Aguardar o GitHub Pages publicar (1–3 min). Testar com `?v=N` para furar cache.

## Operações comuns

### Adicionar/editar um aniversariante
Pela aba **Admin** do site (recomendado — salva no GitHub via token), ou editando `membros.json` direto e dando push.

### Período da Copa (redirect)
O `index.html` da raiz redireciona para `copa2026/` até 20/07/2026. Para ver o Brasileirão nesse período, acessar com `?brasileirao=1`. Não remover o redirect antes da data.

### Módulo da Copa
Documentação e manutenção próprias em `copa2026/docs/`. Não misturar com o Brasileirão.

## Convenções
- PT-BR em toda a interface.
- Não comitar segredos (tokens/chaves). Token do Admin vive só no navegador do organizador.
- Grupo TUPAL foi migrado para site próprio e removido — não reintroduzir.
- Ao alterar o site, atualizar `docs/CONTEXTO.md` e este arquivo.


---

## Brasileirão v2 (05/07/2026) — fonte ESPN + AO VIVO

**O que mudou**
1. **Fonte da tabela: Terra → ESPN.** `atualizar_espn.py` lê `https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings` e grava `tabela.json` no MESMO formato de sempre (`fonte: "ESPN"`). Regra de ouro: os 20 times saem com os nomes canônicos do site (os mesmos dos palpites do Ranking). Se qualquer time da ESPN não mapear (dicionário `ALIASES` no script), o robô **falha sem gravar** e o `tabela.json` anterior permanece — o Ranking nunca quebra.
2. **AO VIVO no navegador (sem F5).** Durante a janela de jogo (20 min antes até ~150 min depois), a aba Jogos consulta o scoreboard da ESPN a cada **30s** (mesma técnica do módulo da Copa — a API aceita CORS) e mostra placar, minuto, badge AO VIVO e gols (autor/minuto). Fora da janela, zero requisições. Se a ESPN cair, o site segue com os JSONs do robô.
3. **Workflow novo:** `atualizar-brasileirao.yml` (cron `*/10` + dispatch) roda ESPN + jogos + resultados e publica `tabela.json`, `espn_eventos.json`, `jogos.json`, `resultados.json` juntos (push robusto, grupo `repo-write-main`). O cron do GitHub é melhor-esforço; opcionalmente cadastrar o dispatch no cron-job.org.
4. **`atualizar-tudo.yml` virou Copa-only** (ranking de desempenho, 5 min via cron-job.org). Após 20/07: deletar workflow + job do cron-job.org.
5. **Visual v2 do `index.html`:** logo nova no topo (`img/header-br.jpg`), menu rolável estilo Copa, página de entrada = **Jogos**, pódio top-3 no Ranking, tabela com escudos + GP/GC + zona pré-Libertadores (5º–6º) + forma dos últimos 5 (de `resultados.json`), filtro por clube em Jogos, "onde assistir" (prioridade: `transmissoes.json` manual > Globo > ESPN) e rodapé com disclaimers.
6. **Intocados:** redirect da Copa, `calcular()`/`dadosTime()` (validados byte a byte), Admin, Aniversariantes, `copa2026/` inteiro.

**Módulos planejados (próximas sessões):** Apostas de placar por rodada (início na rodada 20, 25/07; janela quinta → sábado 10h; Supabase, regras 5/3/2 estilo Copa), apuração/bolão por rodada, Museu, Estatísticas e páginas de Clubes — ver `PROJETO-BRASILEIRAO-V2.md`.
