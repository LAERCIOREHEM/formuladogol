# AF-Previsão — Execução E1: auditoria histórica de placares (2026)

## Objetivo e limites

Recuperar **somente** previsões de gols e placar modal documentalmente presentes em snapshots registrados no Git **antes** do início da respectiva partida do Brasileirão 2026.

A E1 **não** altera o AF-Previsão, o histórico V/E/D original, as probabilidades atuais, o site, o esquema do banco nem a distribuição de placares durante o jogo. As interfaces de JOGOS, RESULTADOS e ACURÁCIA são entregas posteriores (E2–E4).

## Entradas

- `dados-br/probabilidades-jogos.json`, examinado **em todos os commits que modificaram o arquivo**;
- `dados-br/probabilidades-brasileirao.json`, com `partidas_restantes`, também examinado em todos os commits;
- `resultados.json`, para os placares finais, identidade do confronto e referência de horário;
- `dados-br/historico-probabilidades-jogos.json`, exclusivamente para conferência de SHA-256, **sem escrita**.

É necessário `git fetch --unshallow` ou `actions/checkout` com `fetch-depth: 0`. Sem histórico Git, o relatório não pode ser considerado completo.

## Critérios de elegibilidade

1. O jogo deve existir nos resultados finais, com gols inteiros e mandante/visitante identificados.
2. O snapshot deve ser de 2026, com `status: ok`, evento e confronto verificáveis.
3. O commit Git, `gerado_em` e `calculado_em` (quando presente) devem ser **anteriores** ao `data_iso` de início registrado no resultado consolidado. Commits posteriores nunca são aceitos, mesmo que contenham `gerado_em` antigo.
4. As taxas `gols_esperados` e as probabilidades V/E/D devem ser numéricas e válidas; `placar_modal` precisa ser um placar inteiro válido.
5. Para a mesma partida, prevalece a previsão mais recentemente versionada antes do início. IDs ESPN alternativos não multiplicam jogos; a identidade esportiva é o par ordenado mandante/visitante.
6. Se dois resultados do mesmo confronto divergem em placar ou início, o caso é **quarentenado como conflito**, sem previsão declarada como comprovada.
7. O Top-3 somente é certificado se `placares_mais_provaveis` estiver **documentado no snapshot**. É permitido conciliar a lista de um snapshot com a previsão selecionada **apenas** quando geração, gols esperados, V/E/D e placar modal coincidirem. A E1 não reconstrói Top-3 a partir de resultados ou de parâmetros modernos.

## Saída

`dados-br/auditoria-historica-placares-af-2026.json`, contendo:

- cobertura total: partidos concluídos, recuperáveis, sem evidência, em conflito ou sem horário;
- um registro por confronto mandante/visitante;
- para cada previsão comprovada, **gols esperados**, **placar modal**, **V/E/D**;
- Top-3 nativo, quando documentalmente disponível;
- SHA do commit de origem, horário do commit, modelo, horário de geração, SHA-256 do arquivo fonte e da linha;
- SHA-256 consolidado do relatório e identificador do arquivo histórico V/E/D original.

A saída separa `situacao: comprovado`, `sem_snapshot_prejogo_comprovavel`, `conflito_resultado` e `inicio_factual_indisponivel`. Dados ausentes continuam ausentes.

O histórico Git prova a existência do snapshot no commit, **não** prova isoladamente que ele já havia sido exibido por uma página pública. O horário factual é o `data_iso` consolidado de `resultados.json`; divergências dessa fonte requerem reconciliação esportiva adicional, não ajuste silencioso.

## Reprodutibilidade

```bash
python scripts/auditar_historico_placares_af.py --self-test
python scripts/auditar_historico_placares_af.py
```

O workflow `af-e1-auditoria-placares.yml` roda as verificações com histórico completo e disponibiliza o arquivo gerado como artefato, além de gravá-lo em `main` após validação. Executar novamente com as mesmas fontes e o mesmo histórico produz o mesmo relatório.

## Regra de publicação para E2–E4

Só mostrar previsão antiga quando `situacao == "comprovado"`. Não exibir resultado inferido como se fosse predição pré-jogo. Diferenciar a chance da vitória V/E/D da probabilidade do placar isolado. Não publicar taxas de acerto usando como denominador os 380 jogos da temporada se apenas uma parte tiver previsões comprovadas.
