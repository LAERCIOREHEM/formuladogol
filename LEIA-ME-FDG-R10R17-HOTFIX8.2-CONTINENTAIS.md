# HOTFIX 8.2 — CONTINENTAL EVENT ID & BROADCAST GUARD

## Causa verificada
A agenda HOTFIX8 publicou 8 semifinais com `event_id` vazio. Os coletores de transmissão usam `event_id` como chave dos jogos. A rotina de TV ignora explicitamente partidas sem identificador, e o YouTube colapsava os oito jogos na mesma chave vazia.

## Correção
- Gera ID interno estável `fdg-conmebol-...` por competição, horário e mandante/visitante, sem fingir que seja um ID ESPN.
- Registra `event_id_origem=documental_interno` e `espn_event_id=''` nos documentais.
- Quando o ESPN publicar o evento verdadeiro, deduplica por confronto/data e prioriza o ID ESPN real.
- Impede chamar `/summary?event=fdg-conmebol-*` (apenas IDs numéricos vão à ESPN).
- Preserva AF-Previsão: jogos documentais permanecem `probabilidades_disponiveis=false`, até que o motor AF receba o evento estruturado.
- Registra em `transmissoes.json` SBT e Paramount+ para os dois jogos Boca/Vasco, com evidência editorial oficial SBT e GE, sem inventar URL de vídeo ou adicionar ESPN sem confirmação primária.
- Revalida a identidade documental no workflow de busca de transmissões.

## Instalação e ordem
1. Descompacte ZIP, faça GitHub Add file > Upload files preservando diretórios e commit em main.
2. Rode manualmente **Buscar transmissões dos clubes do Brasileirão**, `modo=completo`, `event_id` em branco, `dry_run=false`. Esse workflow regenera a agenda, busca player oficial e grade, grava os JSON e publica a atualização.
3. Aguarde o **Deploy site (GitHub Pages)** terminar verde.
4. Confira `/aovivo.html`: Boca/Vasco deve apresentar SBT e Paramount+ na seção Onde assistir; player YouTube apenas se vídeo exato oficial for confirmado pela API.
5. Não é necessário executar deploy Cloudflare do Orchestrator ou Push Worker: seus contratos não mudaram.

## Observações
A indicação de SBT Sports no YouTube é oficialmente anunciada, mas este pacote não inventa video_id e não transforma pré-jogo/narração em player da partida. Para os outros 6 confrontos, o coletor segue buscando grade automaticamente; nenhum canal foi presumido.
