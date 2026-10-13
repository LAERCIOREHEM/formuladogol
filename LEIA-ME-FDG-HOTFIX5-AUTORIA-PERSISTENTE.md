# Fórmula do Gol — HOTFIX 5: autoria persistente (R10R6)

**Base obrigatória:** `LAERCIOREHEM/formuladogol`, `main`, commit `30e5140a8b513b2a608784fe6d0d3e26911b54bd` (12/10/2026 BRT).  
**Incidente:** R30, Red Bull Bragantino 3 × 1 Cruzeiro, `event_id=401841260`; a página Ao Vivo exibia `13' Autor sendo confirmado` aos 66' do jogo, apesar de a autoria já estar disponível em cobertura pública. A presença de fontes públicas com nomes não comprova, isoladamente, que a ESPN tenha fornecido esses nomes em todos os seus endpoints.

## Causa técnica demonstrada no código

1. `unresolvedScorersForTransition()` perseguia autores apenas de **gols novos** ou **pendentes**. Assim, um gol `confirmed` sem nome deixava de ser elegível para enriquecimento na manutenção seguinte.
2. A fusão de variantes podia marcar `scorerConflict=true` para divergências textuais transitórias e a atualização do estado mantinha esse flag de forma permanente, mesmo quando um ID estruturado confiável chegava depois.
3. `enrichMonitorGoals()` recusava toda recuperação de autoria em um gol marcado com conflito histórico, ainda que o summary canônico da mesma transição e equipe tivesse uma única identidade estruturada.

## Mudanças

- **`sports-engine.js`:** autoria não resolvida continua elegível após confirmação do gol; `scorerCoverage` trata conflitos como ausências; mescla com prioridade a IDs estruturados, reconcilia nomes abreviados do mesmo ID e limpa somente conflitos transitórios. Dois IDs estruturados distintos permanecem bloqueados; `applyObservation` permite desfazer o conflito já resolvido, sem reenviar gol.
- **`sports-monitor.js`:** reconsulta de autoria enquanto `state=in`, **a cada 30 segundos** quando o gol já é antigo, ou imediatamente quando um novo gol aparece. Sem chamadas de IA; utiliza os feeds ESPN existentes. Persistência do horário da última tentativa para limitar requisições.
- **`monitor-live-facts.js`:** reidrata um conflito histórico com **um único scorerId estruturado** da mesma equipe e do mesmo estado de placar; não reidrata dois IDs estruturados conflitantes nem fontes de equipe adversária.
- **`test-scorer-recovery.mjs`:** regressões para autoria tardia, alias com mesmo ID, conflitos fortes, transição 3×1, gol contra, segurança de equipe/placar e ausência de push duplicado.
- **Testes existentes:** versão de política de autoria `6-R10R6`.
- **`deploy-push-worker.yml`:** valida explicitamente o novo teste antes de publicar; smoke pós-deploy já confere dinamicamente `goalScorerEnrichmentPolicyVersion` no status do monitor.

## Aplicação

1. Extraia o ZIP; preserve a estrutura de diretórios.
2. Envie os **7 arquivos de código/workflow/testes** com GitHub **Add file → Upload files**, todos no mesmo commit para `main` (o oitavo é este README).
3. Aguarde `Deploy Push Worker · AUTO` ficar **verde**. Não é necessário rodar `Deploy site (GitHub Pages)`, pois o HTML/JS não foi alterado.
4. Verifique o status em `https://push.formuladogol.com.br/v1/monitor/status`: `goalScorerEnrichmentPolicyVersion` deve ser `6-R10R6`.
5. Em jogos ao vivo com autores pendentes, a página já solicita summary fresco a cada 5 s; a recuperação do Durable Object fica limitada a 30 s. Quando uma fonte ESPN confirmar o nome com identidade coerente, o placeholder deverá ser substituído automaticamente, sem recarregar a página.

## Limite factual importante

Nenhum sistema deve atribuir nomes sem evidência. Se a ESPN não disponibilizar uma identidade verificável, a autoria permanece pendente. Este HOTFIX corrige o bloqueio de **tentativas posteriores** e a **retenção indevida de conflitos**; não inclui integração com provedores externos (GE, CBF etc.) nem promete nomes que nenhuma fonte ESPN publique. A conferência do caso real no ambiente Cloudflare depende do deploy, do estado persistido e das respostas atuais da ESPN; testes locais usam payloads sintéticos.

## Verificações realizadas

- SHA GitHub dos seis arquivos existentes conferido contra o baseline ZIP e o repositório remoto.
- `node --check` de arquivos modificados e do novo teste: PASS.
- `npm run test:sports`: PASS (todas as suítes locais; import da biblioteca Web Push substituído por stub **apenas no ambiente local de teste**, nunca incluído no ZIP).
- `node tests/test-scorer-recovery.mjs`: PASS.
- `node tests/test-sports-engine.mjs`, `node tests/test-sports-monitor.mjs`, `node tests/test-monitor-live-facts.mjs`: PASS.
- YAML do workflow: PASS.
- Teste de integração com a API ESPN/Cloudflare real: **não executado localmente** (rede indisponível); o workflow realiza testes e smoke após o upload.

**Rollback:** reverta o commit do HOTFIX 5 no GitHub e execute novamente `Deploy Push Worker`.
