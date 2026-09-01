# Fórmula do Gol — Push Core (Execução 3)

Backend independente do GitHub Pages.

- API pública: `https://push.formuladogol.com.br`
- D1: assinaturas e preferências anônimas.
- Durable Object SQLite: material VAPID persistente e, nas próximas execuções, estado consistente dos jogos.
- VAPID: gerado uma única vez dentro do Durable Object; a chave privada nunca é publicada no GitHub nem enviada ao browser.
- Rate Limiting: binding nativo do Cloudflare Workers.
- Web Push: `@block65/webcrypto-web-push`.

O workflow `.github/workflows/deploy-push-worker.yml` cria o D1 caso ainda não exista, aplica a migration e publica o Worker. São necessários apenas os secrets do repositório `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` com permissões para Workers, D1 e zona `formuladogol.com.br`.
