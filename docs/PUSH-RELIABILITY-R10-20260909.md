# Fórmula do Gol — Push Reliability R10

Data: 2026-09-09

## Objetivo

Fechar a falha de cobertura observada em Boca Juniors x São Paulo e restringir o produto público aos cinco alertas aprovados:

- Gol
- Cartão vermelho
- Escalações confirmadas (somente Brasileirão)
- Início da partida
- Final da partida

Gol anulado, lembrete T-15, mudança de horário, classificação, disputa de pênaltis e outros eventos podem continuar existindo apenas como informação técnica interna do motor, mas não são elegíveis para fan-out público.

## Readiness Guardian

O monitor passa a executar checkpoints operacionais por partida:

- T-30: descoberta ESPN, identidade do confronto, monitor e audiência.
- T-10: gate obrigatório de prontidão.
- T+3: watchdog de início efetivamente detectado.

Quando o event_id esperado não é encontrado, o monitor tenta reconciliar pelo confronto/horário. O fallback com OpenAI + Web Search só é usado como reconciliação operacional; um event_id sugerido pela IA precisa ser comprovado novamente pela ESPN antes de ser aceito.

A auditoria é persistida em D1 (`monitor_preflight`) e incidentes em estado vermelho são registrados em `monitor_incidents`.

## Cinco alertas públicos

O fan-out aceita somente:

- `goal`
- `red_card`
- `lineup_confirmed`
- `match_start`
- `final_whistle`

A preferência do usuário é armazenada em `push_preferences_v3`.

### Cartão vermelho

- Detectado em feeds estruturados/summary ESPN.
- Exige duas observações e pelo menos 60 segundos entre a primeira detecção e a confirmação.
- Deduplicado por partida/lance/jogador.

### Escalações

- Restritas a `bra.1`.
- Exigem exatamente 11 titulares por lado.
- Exigem duas observações estáveis antes do envio.

### Início

- Emitido na transição para estado `in`.
- Também é protegido contra perda quando a primeira observação válida do monitor já chega com o jogo em andamento.

## Caso de regressão Boca Juniors x São Paulo

O teste `test-readiness-monitor.mjs` simula a partida da Sul-Americana com um event_id de agenda divergente e comprova:

1. reconciliação com o event_id ESPN;
2. T-30 verde;
3. T-10 verde;
4. T+3 verde;
5. persistência única de `match_start`;
6. entrada do alerta de início na Queue.

## Resultados — CTA

`📄 Ver página da partida` foi reduzido para `📄 Ver partida` e a linha do CTA passa a ocupar `grid-column: 1 / -1`, mantendo o botão dentro do card no desktop e compacto no mobile.

## Validação executada

- `npm run check`: PASS
- `npm run test:sports`: PASS
- `npm run test:push`: PASS
- `npm run test:hardening`: PASS
- migrações D1 0001→0006 aplicadas em SQLite local: PASS / integrity_check=ok
- JS `br-alertas.js`: PASS
- YAML de 19 workflows: PASS
- regressão visual do CTA em 14 larguras (320→1920): 14/14 PASS
- `wrangler deploy --dry-run` não foi usado como gate porque o comando tentou comunicação externa e excedeu o timeout do ambiente; os módulos, configuração gerada e suíte local passaram nos gates acima.

## Implantação

1. Subir os arquivos deste pacote preservando as pastas.
2. Executar `Deploy Push Worker` para aplicar a migração 0006 e publicar o Worker.
3. Executar o deploy normal do site para publicar `alertas.html`, `js/br-alertas.js` e `css/br-jogos.css`.
4. Conferir `/ops` e os checkpoints de readiness antes do próximo jogo.

