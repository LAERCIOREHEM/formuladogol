# ORG-5 — Páginas de jogos do Brasileirão

Data: 07/09/2026

## Objetivo

Expandir a superfície orgânica do Fórmula do Gol com uma URL HTML real e indexável para cada partida do Brasileirão 2026 que possua data oficialmente definida, reutilizando exclusivamente os dados já produzidos pelo projeto.

Formato canônico:

`/jogo/<mandante>-x-<visitante>-AAAA-MM-DD>/`

A execução não recalcula AF-Previsão, AF-Score, tabela, placares, estatísticas ou qualquer outra métrica esportiva. O gerador apenas materializa no HTML os dados públicos existentes no artefato do deploy.

## Regra de elegibilidade

- partida com `data_iso` definida e `data_definir != true`: gera página indexável;
- partida ainda marcada como `data_definir=true`: não gera URL fictícia;
- quando o calendário passar a trazer data confirmada, a página entra automaticamente no deploy seguinte.

No snapshot utilizado na validação desta execução há 380 partidas no calendário, das quais 360 possuem data confirmada: 255 concluídas e 105 futuras. As 20 restantes ainda aguardam definição de data.

## Conteúdo das páginas

### Pré-jogo

- mandante e visitante, com escudos e links para as páginas dos clubes;
- rodada, data, horário e estádio;
- probabilidades AF-Previsão disponíveis para a partida;
- gols esperados e placar modal quando disponíveis;
- transmissão quando disponível;
- contexto atual dos dois clubes;
- acesso ao sistema existente de alertas;
- partidas relacionadas e linkagem interna.

### Pós-jogo

- placar final;
- gols e assistências quando disponíveis;
- estatísticas da partida;
- público, renda, arbitragem e estádio quando disponíveis;
- probabilidades pré-jogo somente quando existe snapshot histórico gerado antes do início da partida;
- contexto atual dos dois clubes, explicitamente apresentado como estado atual, sem reconstrução retroativa;
- partidas relacionadas e linkagem interna.

Se não existir snapshot pré-jogo preservado para uma partida concluída, a página informa essa ausência. Nenhuma probabilidade retroativa é fabricada.

## SEO e dados estruturados

Cada página recebe:

- `<title>` único;
- meta description;
- canonical absoluto;
- exatamente um H1;
- `robots=index,follow,max-image-preview:large`;
- Open Graph;
- `SportsEvent` em JSON-LD;
- `BreadcrumbList` em JSON-LD;
- data visível de atualização;
- `article:modified_time`;
- links internos para os clubes e partidas relacionadas.

As URLs de jogos são inseridas no `sitemap.xml`. O cálculo de `lastmod` passa a considerar calendário, probabilidades atuais e históricas de jogos, detalhes, transmissões, probabilidades do Brasileirão, ranking, tabela e resultados.

## Integração com páginas dos clubes

O gerador de clubes foi ajustado para acrescentar links para a página da partida sem remover qualquer informação existente:

- próximos jogos do Brasileirão: `Análise do jogo`;
- resultados: `Ver partida`.

Os links só são emitidos quando a partida possui data confirmada e, portanto, URL ORG-5 válida.

## Arquivos da execução

- `.github/workflows/deploy.yml`
- `css/br-jogo.css`
- `scripts/gerar_paginas_jogos.py`
- `scripts/gerar_paginas_clubes.py`
- `docs/ORG-5-PAGINAS-JOGOS-BRASILEIRAO-20260907.md`

As páginas `/jogo/.../` e as alterações do sitemap são artefatos de build; não são versionadas no pacote de patch.

## Limites preservados

A ORG-5 não altera:

- AF-Previsão;
- AF-Score;
- número ou metodologia das simulações;
- ESPN/fallbacks esportivos;
- Push / R9-R1;
- VAPID;
- Cloudflare Push Worker;
- D1;
- lógica editorial.

## Gates obrigatórios

A entrega só é considerada final após:

1. compilação Python e validação YAML;
2. montagem completa do artefato público;
3. ORG-1, ORG-4 e ORG-5 em sequência;
4. auditoria das páginas contra calendário/resultados/fontes;
5. validação de sitemap, canonicals, JSON-LD e links internos;
6. teste de idempotência;
7. verificação responsiva em desktop, Android e dimensões de iPhone;
8. otimização de imagens e validador público integral;
9. reaplicação dos cinco arquivos desta execução sobre uma base limpa ORG-4 + ORG-4R e repetição do pipeline.
