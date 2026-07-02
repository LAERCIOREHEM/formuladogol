# Atualizar clubes dos jogadores

## O que é

Workflow manual para preencher o campo `clube` dos jogadores em `copa2026/dados/elencos.json`.

Ele usa camadas de busca, com cache:

1. Wikidata SPARQL/P54 em lote.
2. Wikidata Search/P54 por jogador quando o lote não resolve.
3. Wikipedia infobox como fallback.

Não usa a seleção nacional como fallback. Se não houver clube seguro, o campo fica vazio e o front não mostra nada abaixo de posição/número.

## Como rodar

GitHub → Actions → **Atualiza clubes dos jogadores** → **Run workflow**.

Parâmetros recomendados na primeira execução:

- `force`: `NAO`
- `limite`: `0`
- `sem_wikipedia`: `NAO`

Tempo estimado da primeira execução: 20 a 60 minutos.

## Arquivos atualizados

- `copa2026/dados/elencos.json`
- `copa2026/dados/clubes_jogadores_cache.json`
- `copa2026/dados/clubes_jogadores_relatorio.json`

## Importante

O `buscar_selecoes.py` foi ajustado para preservar o campo `clube` quando o elenco for atualizado pela ESPN no futuro.
