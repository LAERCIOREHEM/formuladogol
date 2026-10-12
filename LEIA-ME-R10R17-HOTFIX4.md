# Fórmula do Gol — HOTFIX 4 — Pages ↔ D1 Attendance Reconciliation

## Incidente confirmado

O site exibe público/renda corretos de Palmeiras x Corinthians e Grêmio x Internacional, mas o Push Worker enviou e-mails de SLA dizendo "não localizados".

**Causa raiz:** `seedFromStatic` lê dois JSONs em `https://formuladogol.com.br/dados-br/`, porém `.github/workflows/deploy.yml` não os incluía no artefato `_site`. O Worker ainda convertia HTTP 404 silenciosamente em `{jogos:{}}`, de modo que a correção não alcançava o banco D1, embora o site exibisse dados de outros snapshots.

## O que muda

1. `.github/workflows/deploy.yml` publica `dados-br/publicos-complementares.json` e `dados-br/correcoes/publicos-verificados.json`, cria a subpasta `correcoes` e valida o artefato antes do upload.
2. `cloudflare/push-worker/src/postgame-fastlane.js` exige ambos os JSONs válidos, registra `staticSeedError` em falhas, tenta novamente a cada 2 minutos, limpa o erro após sucesso e suprime e-mail de "não localizado" quando o snapshot autoritativo está indisponível. Busca e backoff continuam ativos.
3. `.github/workflows/deploy-push-worker.yml` executa o mesmo validador de contrato do Pages antes dos testes npm.
4. `scripts/validar_contrato_publicos_fastlane.py` garante que os dois arquivos são publicados, têm `jogos` e não são ignorados pelo Worker. Correções verificadas têm precedência e podem anteceder a consolidação do snapshot sem quebrar o deploy.

**Não altera números, políticas de custo, versão de Search Profile (9), versão de Postgame (13), MCP nem regras de identidade.**

## Aplicação

1. Extraia o ZIP e faça `Add files → Upload files` no repositório, preservando os caminhos.
2. Faça commit em `main`. Os workflows **Deploy site (GitHub Pages)** e **Deploy Push Worker AUTO** deverão executar automaticamente.
3. Aguarde o Pages ficar verde. O cron do Worker roda a cada 1 minuto; o HOTFIX força uma leitura inicial e repete falhas a cada **2 minutos** (intervalo normal após sucesso: **10 minutos**). Depois da reconciliação o D1 deverá marcar os quatro eventos corrigidos como `resolved`.
4. Confirme o estado por `https://push.formuladogol.com.br/v1/postgame?event_ids=401841261,401841267,401841258,401841263` (todos com `public_status=resolved`, `public_next_at` vazio e público/renda preenchidos).
5. Se permanecer `pending` após 15 minutos do Pages verde, veja `https://push.formuladogol.com.br/v1/postgame/status` e procure `staticSeedError`. **Não force novas buscas de IA**.

## Verificações

- Arquivos de workflow YAML analisados com PyYAML e shell `bash -n`.
- `node --check` no Worker.
- Contrato `scripts/validar_contrato_publicos_fastlane.py` no repositório e em artefato `_site` simulado.
- `node tests/test-postgame-fastlane.mjs` (sem dependências externas) e `node tests/test-ai-router.mjs` com arquivos locais de referência.
- A suíte completa do GitHub Actions e a reconciliação D1 em produção só podem ser confirmadas após o deploy.

## Base do pacote

Conferido contra `main` em 12/10/2026, HEAD `160e9befc8`, antes deste HOTFIX. `deploy.yml` SHA Git `5d3755114aed1b62041e2dc42a5bcf1cc5566796`; `deploy-push-worker.yml` SHA Git `2b4042299348eb72ad07488fa5e7b793efa4019f`; `postgame-fastlane.js` SHA Git `842df9864a3e39e109b0ac79fb50522fd8aa15e2`.
