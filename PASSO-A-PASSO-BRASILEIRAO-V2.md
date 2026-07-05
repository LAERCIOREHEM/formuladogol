# PASSO A PASSO — Instalação do Brasileirão v2 (fonte ESPN + AO VIVO)

Tempo estimado: 10 minutos, tudo pela interface web do GitHub.
Repositório: `LAERCIOREHEM/BRASILEIRAO2026ALMOCO` (branch `main`).

> **Nada aqui toca o módulo da Copa.** O redirect continua ativo até 20/07;
> o Brasileirão segue acessível em `https://brasileirao2026almoco.com.br/?brasileirao=1`.

## A) Adicionar arquivos NOVOS (Add file → Upload files)

1. Envie **`atualizar_espn.py`** para a **raiz** do repositório.
2. Envie **`transmissoes.json`** para a **raiz**.
3. Crie a pasta **`img/`** e envie **`img/header-br.jpg`**
   (no upload, arraste a pasta `img` inteira do zip — o GitHub cria a pasta).
4. Envie **`.github/workflows/atualizar-brasileirao.yml`**
   (caminho exato: `.github/workflows/`).

## B) SUBSTITUIR arquivos existentes (abrir o arquivo → lápis ✏️ → colar conteúdo → Commit)

5. Substitua **`index.html`** (raiz) pelo novo.
6. Substitua **`.github/workflows/atualizar-tudo.yml`** pelo novo
   (agora ele cuida SOMENTE do ranking de desempenho da Copa).
7. Substitua **`docs/CONTEXTO.md`** e **`docs/DOCUMENTACAO.md`** pelos novos.

## C) DELETAR workflows descontinuados (abrir o arquivo → ⋯ → Delete file)

8. Delete **`.github/workflows/atualizar-tabela.yml`** (era o Terra).
9. Delete **`.github/workflows/atualizar-jogos.yml`**.
10. Delete **`.github/workflows/atualizar-resultados.yml`**.
    *(As funções dos três foram absorvidas pelo `atualizar-brasileirao.yml`.
    Os arquivos `atualizar-jogos.yml`/`atualizar-resultados.yml` que existem
    soltos na RAIZ do repositório são cópias inertes — pode deletar também,
    ou deixar; não executam nada.)*
    O `atualizar.py` (Terra) pode ficar na raiz como rollback: nenhum
    workflow o chama mais.

## D) Primeira execução e conferência

11. Vá em **Actions → "Atualizar Brasileirao (ESPN + jogos/resultados)" → Run workflow**.
12. Abra o log do passo *"Atualizar tabela.json e espn_eventos.json (ESPN)"*
    e confira o bloco **"De-para aplicado"**: devem aparecer os 20 times.
    - Se o robô falhar com *"Times da ESPN SEM correspondência canônica"*,
      ele NÃO gravou nada (proteção). Copie o nome exibido, adicione uma
      linha no dicionário `ALIASES` do `atualizar_espn.py` apontando para o
      nome canônico e rode de novo. É o único ajuste fino previsto.
13. Abra `https://brasileirao2026almoco.com.br/?brasileirao=1` e confira:
    - Entra direto na aba **⚽ Jogos**, com a logo nova no topo;
    - Aba **📊 Brasileirão** com escudos e status "fonte: ESPN" na barra;
    - Aba **🏆 Ranking** com pódio e MESMOS totais de antes;
    - No celular: menu desliza para o lado e a tabela esconde V/E/D/GP/GC/%.

## E) Opcional (recomendado): disparo pelo cron-job.org

O cron interno do GitHub (10 min) é "melhor esforço" e pode atrasar em
horário de pico. Para cadência exata, cadastre no cron-job.org um job a cada
10 min chamando (mesmo modelo do job atual do `atualizar-tudo`):

```
POST https://api.github.com/repos/LAERCIOREHEM/BRASILEIRAO2026ALMOCO/actions/workflows/atualizar-brasileirao.yml/dispatches
Body: {"ref":"main"}
Headers: Authorization: Bearer SEU_TOKEN · Accept: application/vnd.github+json
```

> O placar EM TEMPO REAL não depende disso: durante os jogos o próprio
> navegador consulta a ESPN a cada 30s.

## F) Depois de 20/07/2026 (fim do modo Copa)

14. Delete `.github/workflows/atualizar-tudo.yml` e o job correspondente
    do cron-job.org (o de 5 min). O Brasileirão já estará 100% no workflow novo.

## Onde assistir (ajuste manual)

Para corrigir/definir a emissora de um jogo, edite `transmissoes.json`:

```json
{
  "transmissoes": [
    { "rodada": 20, "mandante": "Flamengo", "visitante": "Palmeiras", "transmissao": "Globo e Premiere" }
  ]
}
```

A ordem de prioridade no site é: **manual > Globo > ESPN**.

## O que ficou para as PRÓXIMAS sessões (combinado)

- **Apostas de placar por rodada** (início na rodada 20 — 25/07; janela
  abre quinta e fecha sábado 10h; Supabase; pontuação 5/3/2 estilo Copa)
  e a apuração/ranking por rodada.
- Museu do Brasileirão, Estatísticas (artilharia etc.) e páginas de Clubes.
