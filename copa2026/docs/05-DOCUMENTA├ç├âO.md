# DOCUMENTAÇÃO.md — Bolão Copa do Mundo 2026

## Objetivo
Documentar instalação, manutenção, estrutura e operação do módulo Bolão Copa.

## Estrutura recomendada
```text
/
  index.html
  /copa2026/
    copa2026.js
    copa2026.css
    copa2026_ui.js
    copa2026_engine.js
    copa2026_score.js
    copa2026_admin.js
    copa2026_config.json
    copa2026_jogos.json
    copa2026_resultados.json
    copa2026_terceiros_map.json
    teams_map.json
    CONTEXTO.md
    DOCUMENTAÇÃO.md
  /scripts/
    atualizar_copa_resultados.py
    backup_copa.py
  /.github/workflows/
    atualizar_copa.yml
    backup_copa.yml
```

## Integração
O `index.html` principal recebe apenas:
- botão Bolão Copa;
- container da view;
- imports JS/CSS;
- regra do período Copa.

## Configuração
Arquivo: `/copa2026/copa2026_config.json`

Deve conter:
```json
{
  "periodo_copa_inicio": "2026-06-05T00:00:00-03:00",
  "periodo_copa_fim": "2026-07-20T23:59:59-03:00",
  "lock_at": "2026-06-10T23:59:59-03:00",
  "reveal_at": "2026-06-11T00:00:00-03:00",
  "limite_gols": 9,
  "pin_digitos": 6
}
```

## Dados de seleções
Arquivo: `teams_map.json`
- `id`
- `nome`
- `sigla`
- `aliases`
- `grupo`
- `seed_desempate`

## Resultados oficiais
Arquivo: `copa2026_resultados.json`
No mata-mata usar:
```json
"avancou_id": "BRA"
```

## Scripts
- `scripts/atualizar_copa_resultados.py`: busca/normaliza resultados.
- `scripts/backup_copa.py`: exporta dados.

## GitHub Actions
- `atualizar_copa.yml`: cron de resultados.
- `backup_copa.yml`: backup diário durante período Copa.

## Supabase
Tabelas:
- `copa_participantes`
- `copa_palpites`
- `copa_auditoria`
- `copa_config`
- `copa_ranking_cache`

Ativar RLS.

## Segurança
- PIN com hash;
- usuário só edita próprio palpite;
- bloqueio server-side após trava;
- palpites dos demais só após `reveal_at`;
- admin com auditoria.

## Deploy
GitHub Pages continua publicando o site.
Se usar Supabase, configurar:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Nunca expor `SERVICE_ROLE` no front-end.

## Testes obrigatórios
- cadastro;
- login;
- nome duplicado;
- PIN errado;
- reset PIN;
- placar inválido;
- empate mata-mata;
- classificação;
- terceiros;
- chaveamento;
- propagação;
- trava;
- liberação;
- ranking;
- backup;
- retorno pós-Copa.

## Pós-Copa
Após 20/07/2026:
- Ranking do Brasileirão volta;
- Bolão Copa fica histórico;
- edição segue bloqueada.

## Manutenção
Qualquer alteração em regras, pontuação, datas, modelo, fontes, workflows ou segurança exige atualização de:
- `CONTEXTO.md`
- `DOCUMENTAÇÃO.md`
