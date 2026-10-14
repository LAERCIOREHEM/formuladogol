# FDG HOTFIX 8.3 — autoria de gols continentais

## Baseline verificada
js/br-aovivo.js Git blob SHA: a8690e6e461b01357ad7739eb5e522e57d516920 (main consultada em 13/10/2026).

## Mudanças
- Para jogos com ID ESPN numérico, consulta summary mesmo quando o card herdou `source=local`.
- IDs documentais `fdg-conmebol-*` NÃO são enviados à ESPN.
- Liga continental em andamento com gols pede summary fresco; antes fresh era restrito a `bra.1`.
- Gols com autoria ainda não confirmada aparecem como `Autor sendo confirmado` e acionam novas consultas de 5 em 5 segundos, inclusive quando o Worker não devolveu Live Facts.
- Sem inventar autor, assistência ou minuto; placar continua soberano.

## Instalação
1. GitHub > repositório formuladogol > Add file > Upload files; envie `js/br-aovivo.js` preservando pasta `js/`.
2. Commit na main. Aguarde workflow de deploy do site / GitHub Pages. Se o workflow não rodar automaticamente, execute o deploy do site já existente.
3. Abra /aovivo.html com Ctrl+F5 e confira a aba Rede (Network): `/v1/live/summary?league=conmebol.sudamericana&event=<ID_NUMERICO>&fresh=1`.
4. Se a ESPN não fornecer autoria, a interface mostrará `Autor sendo confirmado`. Isso é degradação explícita, NÃO sucesso de identificação.

## Escopo
Somente JS do site. Não muda Worker, contratos, versão de API, Orchestrator, matemática AF nem workflow de deploy. Não garante que ESPN disponibilize autor; a verificação do payload real continua necessária.
