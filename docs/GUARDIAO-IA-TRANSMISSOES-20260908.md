# Fórmula do Gol — Guardião IA de Transmissões

Data: 08/09/2026  
Escopo: correção e auditoria automatizada de “Onde assistir” para jogos de clubes da Série A acompanhados pelo Fórmula do Gol.

## Objetivo

Eliminar dois estados operacionais inadequados próximos ao início de uma partida:

1. jogo a menos de 24 horas do início sem transmissão publicada; e
2. link/canal antigo permanecer apresentado como transmissão da partida quando era apenas pré-jogo, aquecimento ou um player já encerrado.

A solução acrescenta uma camada de auditoria sem substituir as fontes determinísticas já existentes. CBF/GE/ESPN/YouTube e overrides editoriais continuam sendo utilizados. O Guardião usa GPT-5.6 Sol com Web Search somente nos checkpoints críticos ou quando há ausência, conflito, fonte preservada/antiga ou player que exija revalidação.

## Política de execução

Checkpoints relativos ao início da partida:

- T-24h (`-1440` min): auditoria completa;
- T-6h (`-360` min): revalidação condicional;
- T-90min (`-90` min): auditoria completa;
- T-15min (`-15` min): revalidação de grade/player;
- T+10min (`10` min): confirma se a transmissão digital continua válida já com o jogo em andamento.

A auditoria completa é obrigatória em T-24h e T-90min. Nos checkpoints intermediários, a chamada de IA é evitada quando a grade já está forte, atual e sem player suspeito.

## Precedência das fontes

A reconciliação final preserva a autoridade editorial existente:

1. override manual explícito;
2. overlay validado do Guardião IA;
3. fontes automáticas determinísticas atuais;
4. snapshot anterior apenas quando não há evidência de que esteja obsoleto.

O Guardião nunca substitui override manual.

## Segurança contra alucinação

A IA não recebe autoridade para inventar evento, horário ou participantes. A identidade da partida (`event_id`, mandante, visitante, competição e data) vem da agenda local.

Uma conclusão só é publicável quando passa por todas as travas aplicáveis:

- canal/plataforma pertence à allowlist do projeto;
- confiança mínima de 0,90;
- URLs declaradas como evidência foram efetivamente retornadas pela ferramenta Web Search;
- pelo menos uma fonte forte ou duas fontes independentes permitidas sustentam a conclusão;
- `exclusive=true` exige exatamente um canal/plataforma;
- se a IA considerar um player YouTube válido para a partida, o canal correspondente precisa existir na grade final;
- falha de validação mantém o estado anterior em vez de publicar uma inferência não comprovada.

O modelo padrão é `gpt-5.6-sol`. Pode ser alterado por `OPENAI_TRANSMISSION_MODEL` sem editar o código.

## YouTube: separação entre estado da partida e estado do vídeo

Foi removida a regra incorreta em que `game.state === "in"` podia fazer o frontend tratar o player YouTube como “AO VIVO”.

Agora:

- somente `principal.status === "live"` torna o vídeo ao vivo;
- “AO VIVO em breve” só aparece quando o próprio player está `upcoming` e dentro da janela pré-jogo;
- um vídeo pode ser classificado como `match`, `pre_game`, `post_game`, `highlights` ou `unknown`;
- player classificado como pré-jogo/aquecimento deixa de ser tratado como transmissão dos 90 minutos;
- após a revalidação do YouTube, a grade de TV é reconciliada localmente para que um canal digital antigo não sobreviva apenas por snapshot.

A normalização de URLs também preserva o parâmetro `v=` de `youtube.com/watch`, impedindo que vídeos diferentes colidam na mesma identidade `/watch`.

## Arquivos de runtime

O Guardião produz, quando necessário:

- `dados-br/transmissoes-guardiao.json` — overlay factual validado;
- `dados-br/auditoria-transmissoes-guardiao.json` — trilha de auditoria.

Esses arquivos são gerados operacionalmente e não são pré-preenchidos no patch com respostas artificiais.

## Orquestração

O Cloudflare Orchestrator passa a conhecer a ação `transmissoes_guardian` e os checkpoints `[-1440, -360, -90, -15, 10]`.

O workflow `Guardião IA de transmissões`:

1. atualiza a agenda;
2. revalida player YouTube conhecido quando a chave do YouTube está disponível;
3. atualiza as fontes determinísticas;
4. executa o Guardião com Responses API + Web Search;
5. reconcilia a grade local;
6. valida o resultado;
7. commita somente mudança factual/auditoria;
8. dispara o deploy do site apenas se publicou mudança.

## Deploy obrigatório

Há dois passos porque o site e o Orchestrator Worker são superfícies diferentes:

1. subir os arquivos deste patch e executar o Deploy normal do site;
2. GitHub Actions → **Deploy Orchestrator Worker** → **Run workflow** → `mode=active`.

Após o segundo passo, `https://orchestrator.formuladogol.com.br/health` deve informar:

- `version: "1.1.0"`;
- `transmissionGuardian: true`;
- `transmissionGuardianCheckpointsMinutes: [-1440,-360,-90,-15,10]`.

Para uma correção imediata de uma partida específica, o workflow **Guardião IA de transmissões** também pode ser executado manualmente com `event_id`, `checkpoint` e `force=true`.

## Secrets / configuração

A solução reutiliza secrets já previstos no projeto:

- `OPENAI_API_KEY`;
- `YOUTUBE_API_KEY` (revalidação específica do player; ausência não impede Web Search);
- credenciais já usadas para GitHub/Cloudflare no deploy do Orchestrator.

Não há chave OpenAI em arquivo do repositório.

## Validações realizadas antes da entrega

- compilação Python dos módulos alterados;
- self-tests do Guardião, grade de TV, coletor YouTube, agenda e orquestrador;
- self-test de segurança da auditoria IA diária;
- sintaxe JavaScript do frontend e do Worker;
- suíte `npm run validate` do Orchestrator Worker;
- YAML de todos os workflows e JSONs de configuração;
- cenário offline Santa Fe x Vasco → Paramount+ com evidências permitidas, confiança 0,99 e exclusividade preservada;
- cenário offline GE TV somente pré-jogo + Premiere na partida → player GE removido e Premiere preservado;
- teste de identidade seletiva de dois vídeos YouTube distintos;
- build estático ORG-1→ORG-7R e validador público do site;
- matriz responsiva do `aovivo.html` em 320, 360, 375, 390, 393, 412, 430, 768 e 1440 px, sem overflow global.

## Limites deliberados

- o Guardião não “adivinha” transmissão: sem evidência suficiente, não publica;
- a chamada real à API OpenAI depende do secret do repositório e ocorre no GitHub Actions; testes locais usam fixtures controladas;
- o Guardião não altera AF-Previsão, AF-Score, Monte Carlo, resultados, Push/VAPID/D1 ou o monitor esportivo de gols;
- a rotina não transforma qualquer vídeo de canal oficial em transmissão da partida: escopo e estado do player são tratados separadamente.
