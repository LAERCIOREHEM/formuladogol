# R10R20 — Matchday Source First / recuperação acelerada

## Incidente que motivou a alteração
Em 18/10/2026, Remo 1 x 1 Bragantino (Série A, rodada 31, ESPN `401841274`), finalizado no Mangueirão, ficou sem dados comprovados de público/renda na auditoria. A URL publicada e identificada pelo mantenedor é:
https://ge.globo.com/pa/futebol/brasileirao-serie-a/jogo/18-10-2026/remo-bragantino.ghtml

A URL documenta a identidade/placar do jogo, **mas não comprova público/renda por si só**. Proibido usar a expectativa de 12 mil antes da partida, público/renda de confrontos anteriores ou estimativas por bilheteria como dado realizado.

## Estratégia do Hunter
1. **Fonte gratuita e direcionada antes da IA**: construir URL do ge para a ficha da própria partida usando clubes, UF do mandante e data em Brasília; armazenar em `postgame_source_cache` com provider `ge-matchday`. A tentativa é idempotente e não importa números sem prova.
2. **Validar a identidade integralmente**: baixar o conteúdo, provar equipes/data/competição/contexto via Match Identity Gate e usar apenas o bloco da partida. Guard factual, fontes robustas e quarentena de renda permanecem.
3. **Evitar inferências vazias**: não gastar Workers AI quando o trecho não tem nenhum rótulo financeiro com valor numérico; não baixar a mesma fonte repetidamente em 90s.
4. **Acelerar enquanto há pendências**: parser/ESPN a cada 3 minutos nas primeiras duas horas; após duas horas, busca gratuita a cada 5 min até T+6h, a cada 15 min até T+24h e depois a cada 60 min.
5. **IA com orçamento**: Gemini elegível T+3; OpenAI no T+20, com fallback no mesmo ciclo a partir de T+20 quando necessário. Mantém os mesmos slots totais de modelo previstos por período, circuit breaker existente e limites máximos US$1/evento e US$50/mês.
6. **Wake-up inicial**: política D1 v16 libera apenas pendências brasileiras das últimas 48h na primeira execução após deploy. Não altera nenhum valor fiscal, contadores ou histórico e não reabre partidas já resolvidas.

## Validação
`npm run check`, `npm run test:sports`, `npm run test:push`, `npm run test:hardening`. Regressões de URL ge local (inclusive hora UTC), cronogramas, guarda anti-inferência, elegibilidade, integridade factual e orçamentos.

**Expectativa realista:** maior agilidade após publicação do dado por uma fonte legível. Resultado, placar, páginas que omitem renda, previsão de público e índices de pesquisa **não** substituem documento fiscal/boletim da partida. Enquanto números estiverem indisponíveis, manter campos nulos e busca ativa.
