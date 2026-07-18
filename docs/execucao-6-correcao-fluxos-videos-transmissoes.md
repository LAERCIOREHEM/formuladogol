# Execução 6 — dados, resultados, vídeos e transmissões

Data: 18/07/2026

## Objetivo

Corrigir os fluxos críticos que impediam a atualização completa do site sem alterar a área visual de probabilidades nem a correção mobile da variação de posições, reservadas para a Execução 7.

## Correções aplicadas

### 1. AF-Previsão e workflow principal

A validação do workflow não fixa mais `libertadores_base` em 500%. O schema legado do arquivo preservado trabalha com seis vagas-base, enquanto o schema continental integrado lê a quantidade de vagas da configuração vigente. A trava agora é compatível com os dois schemas e continua validando todas as somas.

### 2. Bahia 2 x 0 Chapecoense

Foi criado um fallback versionado para o evento `401840998`. Ele só atua se a ESPN ainda não tiver encerrado o jogo. Caso a ESPN publique placar final diferente, a execução é bloqueada em vez de sobrescrever a fonte oficial.

A correção remove o jogo da agenda/Ao Vivo e o publica em Resultados. Ajustes antigos de calendário não podem mais manter indefinidamente um estado `pre` ou `in` depois do horário real da partida.

Se o placar estiver confirmado, mas o summary da ESPN ainda não trouxer autores de gols e cartões, o site não inventa eventos. O jogo fica com `detalhes pendentes` e o workflow aceita exclusivamente essa condição declarada para resultados manuais confirmados.

### 3. Melhores momentos

Foram cadastrados os vídeos informados para:

- Mirassol 2 x 1 Grêmio;
- Bahia 2 x 0 Chapecoense.

GE/Globo, CazéTV e Prime Video continuam prioritários. O UOL Esporte passa a ser aceito automaticamente somente depois de 48 horas sem publicação de uma fonte primária. Links manuais validados do UOL podem ser usados imediatamente.

Os vídeos do YouTube abrem em modal incorporado na própria página. O modal possui fechamento por botão X, tecla Escape e clique fora, bloqueio de rolagem do fundo e alternativa para abrir no YouTube caso o proprietário impeça a incorporação.

### 4. Onde assistir — 19ª rodada

O cadastro editorial durável `transmissoes.json` foi preenchido com a programação publicada para a rodada 19. Ele prevalece sobre a ESPN quando a API ainda não informou os canais. O gerador reconhece TV aberta, canais por assinatura e streaming, inclusive GE TV e CazéTV como plataformas oficiais na grade de “onde assistir”.

Atlético-MG x Bahia fica cadastrado em SporTV e Premiere. Os canais já publicados são levados imediatamente para `dados-br/transmissoes-tv.json` e continuam sendo atualizados pelo workflow.

### 5. Correção da composição de canais

A página principal usava por engano a função de normalização dos nomes de clubes para deduplicar canais. Isso fazia nomes de emissoras desaparecerem. A composição agora usa normalização textual própria.

## Arquivos alterados

- `.github/workflows/atualizar-brasileirao.yml`
- `.github/workflows/buscar-melhores-momentos-getv.yml`
- `.github/workflows/buscar-transmissoes-aovivo-brasileirao.yml`
- `aovivo.html`
- `atualizar_espn.py`
- `dados-br/getv-config.json`
- `dados-br/melhores-momentos-manual.json`
- `dados-br/resultados-manuais.json`
- `dados-br/transmissoes-tv.json`
- `index.html`
- `js/br-aovivo.js`
- `scripts/atualizar_transmissoes_tv_brasileirao.py`
- `scripts/buscar_detalhes_jogos_brasileirao.py`
- `scripts/gerar_relatorio_fontes_melhores_momentos.py`
- `scripts/substituir_fontes_preferidas_mm.py`
- `transmissoes.json`
- `docs/execucao-6-correcao-fluxos-videos-transmissoes.md`

## Validações

- compilação dos scripts Python alterados;
- self-tests do coletor ESPN, detalhes por jogo, transmissões de TV, transmissões ao vivo e melhores momentos;
- validação de todos os JSONs e workflows YAML;
- validação sintática de todos os blocos shell dos workflows;
- teste dos dois resultados manuais e da proteção contra placar oficial divergente;
- teste de prioridade editorial das transmissões e de todos os jogos da rodada 19;
- teste da carência automática de 48 horas para UOL;
- auditoria das fontes dos 181 vídeos existentes;
- validação dos scripts JavaScript;
- teste do modal em viewport desktop e celular, incluindo Escape, X, clique externo e ausência de rolagem horizontal;
- validação integral do bloco final do workflow com schemas legado e continental.

A rede do ambiente local não conseguiu resolver os endpoints da ESPN. Por isso, as chamadas reais continuam sendo verificadas no GitHub Actions. As rotinas determinísticas, os parsers, as travas e os arquivos gerados foram testados offline.
