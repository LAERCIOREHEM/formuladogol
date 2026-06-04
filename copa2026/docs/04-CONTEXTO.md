# CONTEXTO.md — Bolão Copa do Mundo 2026

## Finalidade
Preservar contexto do projeto para futuras IAs, desenvolvedores e manutenções.

Este arquivo deve ser lido antes de qualquer alteração.

## Site atual
O site Brasileirão2026Almoço é um site estático em GitHub Pages, com:
- `index.html`;
- navegação por abas;
- JSONs;
- scripts Python;
- GitHub Actions.

A lógica atual do Brasileirão não deve ser quebrada.

## Objetivo do módulo Copa
Criar aba “Bolão Copa” para:
- cadastro com nome + PIN de 6 dígitos;
- preenchimento de 104 placares;
- cálculo automático de classificação e mata-mata;
- trava;
- liberação de palpites;
- ranking com pontos atuais, perdidos e possíveis;
- admin e auditoria.

## O que não fazer
- não remover ranking do Brasileirão permanentemente;
- não misturar lógica do Bolão Copa com ranking do Brasileirão;
- não salvar PIN em texto puro;
- não liberar palpites antes da trava;
- não usar preenchimento automático de placares;
- não usar dropdown de placares;
- não confiar só no front-end para bloqueio após trava.

## Período Copa
De 05/06/2026 a 20/07/2026:
- ocultar Ranking do Brasileirão;
- abrir em Bolão Copa.

A partir de 21/07/2026:
- Ranking volta;
- Bolão Copa vira aba histórica.

## Decisões fechadas
- PIN de 6 dígitos.
- Campos numéricos para placar.
- Sem dropdown.
- Sem preenchimento automático.
- 104 jogos.
- Empate permitido em grupos.
- Empate proibido no mata-mata.
- Trava em 10/06/2026 às 23h59min59s.
- Liberação em 11/06/2026 às 00h00.
- Campeão vale mais que vice.
- 3º vale mais que 4º.
- Participante incompleto fora do ranking competitivo.
- Nomes duplicados bloqueados.
- Pontuação por conjunto de seleções.

## Pontuação
Grupos:
- 32 classificados: 3
- campeão de grupo: +2
- vice: +1
- 3º: +1
- último: +1
- melhor terceiro: +3

Mata-mata:
- oitavas: 4
- quartas: 6
- semifinalista: 9
- finalista: 12
- campeão: 40
- vice: 25
- 3º: 15
- 4º: 10

## Arquitetura
Criar `/copa2026/` com JS/CSS/JSON próprios.

## Pontos críticos
- `seed_desempate`;
- `teams_map.json`;
- `copa2026_terceiros_map.json`;
- Supabase/RLS;
- trava server-side;
- backup;
- auditoria;
- resultados com `avancou_id`.

## Pendências externas
- seleções oficiais;
- grupos oficiais;
- calendário oficial;
- ranking/seed;
- fonte primária de resultados;
- mapeamento dos terceiros.

## Instrução para futuras IAs
Antes de alterar:
1. ler este arquivo;
2. ler `DOCUMENTAÇÃO.md`;
3. verificar regra de negócios;
4. manter módulo isolado;
5. atualizar documentação se a decisão mudar.
