# CONTEXTO.md — Fórmula do Gol

> **Estado:** EM PRODUÇÃO.  
> **Última atualização:** 10/08/2026, horário de Brasília.  
> **Domínio:** `https://formuladogol.com.br`  
> **Repositório:** `LAERCIOREHEM/formuladogol`  
> **Escopo deste documento:** visão funcional, decisões de arquitetura, regras operacionais e invariantes que devem ser preservadas em qualquer manutenção.

Este arquivo substitui o contexto antigo do “Bolão Brasileirão Almoço”. O repositório evoluiu para o **Fórmula do Gol**, um site público de acompanhamento, estatísticas, probabilidades e conteúdo editorial do futebol brasileiro, mantendo no código alguns módulos privados/legados do bolão e o módulo histórico/independente `copa2026/`.

---

## 1. O que é o Fórmula do Gol hoje

O Fórmula do Gol é um **site estático publicado no GitHub Pages**, sem framework de front-end e sem etapa de build tradicional. HTML, CSS, JavaScript e JSONs versionados formam o produto público. Scripts Python e GitHub Actions coletam, reconciliam, auditam e publicam os dados.

A página principal acompanha o Brasileirão 2026 e oferece, entre outros recursos:

- agenda/jogos dos clubes da Série A, inclusive Copa do Brasil, Libertadores e Sul-Americana quando pertinente;
- placar e classificação **AO VIVO**, diretamente da ESPN no navegador;
- tabela oficial fechada, resultados e detalhes estatísticos por partida;
- transmissões de TV e players oficiais GE TV/CazéTV quando encontrados com segurança;
- melhores momentos apenas de fontes editoriais preferidas/confiáveis;
- estatísticas gerais, artilharia, assistências, desempenho, sequências e público;
- páginas individuais dos 20 clubes;
- Museu do Brasileirão;
- AF‑Previsão: probabilidades de título, Libertadores, Sul-Americana, rebaixamento, posição/pontos projetados e probabilidades pré-jogo;
- painel público de **Acurácia do AF‑Previsão**;
- análises editoriais automáticas do Brasileirão e da Copa do Brasil;
- módulo `copa2026/`, preservado como área própria da Copa do Mundo 2026;
- feedback/sugestões via Supabase e notificação por e-mail.

O site é independente, informativo e sem fins lucrativos. O rodapé público identifica Laércio Rehem como criador/desenvolvedor/mantenedor e explicita a ausência de afiliação com CBF, clubes, ESPN ou titulares de direitos.

---

## 2. Princípios de arquitetura que NÃO devem ser quebrados

### 2.1 ESPN é a fonte esportiva primária

A ESPN é a fonte principal de classificação, scoreboard, resultados, eventos, summaries, elencos e várias estatísticas. O código normaliza todos os clubes para os **20 nomes canônicos** do projeto.

Se a ESPN estiver temporariamente indisponível, retornar `403`, omitir histórico ou apresentar inconsistência entre standings e scoreboard, o sistema deve **preservar o último snapshot íntegro**. Nunca substituir um conjunto bom por arquivo parcial, vazio ou regressivo.

Fontes complementares existem para lacunas específicas e são auditadas: CBF, GE/Gato Mestre, GE Agenda, YouTube oficial, overrides manuais e API-Football quando configurada.

### 2.2 Classificação AO VIVO não depende de GitHub Actions

Durante jogos, a classificação mostrada ao usuário é calculada no navegador pelo módulo `js/br-classificacao-live.js`.

Fluxo:

1. `tabela.json` continua sendo a classificação oficial fechada do último snapshot íntegro.
2. O navegador consulta o scoreboard ESPN a cada **30 segundos** durante a janela de jogo.
3. Resultados `in` são aplicados provisoriamente à tabela: jogos, pontos, V/E/D, GP, GC, SG e posição são recalculados.
4. Um `FINAL` real ainda não incorporado também pode ser projetado provisoriamente para evitar “voltar” a tabela.
5. Quando `Atualizar Brasileirao (ESPN)` publica a nova tabela oficial, a projeção provisória deixa de ser necessária.

**Gol, empate ou virada NÃO devem disparar o pipeline pesado.** A atualização ao vivo já acontece no cliente. O evento operacional relevante para o backend é o **FINAL ainda não incorporado**.

A página `estatisticas.html` usa o mesmo motor: **POS., PTS e J acompanham a classificação ao vivo**, enquanto os percentuais e projeções do AF‑Previsão permanecem vinculados ao último cálculo válido. Durante essa defasagem, a interface informa “CLASSIFICAÇÃO AO VIVO”/“probabilidades em atualização” em vez de fingir sincronia inexistente.

### 2.3 AF‑Previsão só publica estado íntegro

O AF‑Previsão é uma camada científica separada do placar ao vivo. Ele não é recalculado a cada gol.

Estado de produção:

- versão pública: **AF‑Previsão 1.3**;
- arquitetura: Poisson log-linear MAP/Bayesiano regularizado;
- backtesting temporal fora da amostra em 2023, 2024 e 2025;
- ajuste recente conservador via EWMA;
- vantagem de mando, força ofensiva/defensiva, decaimento temporal e regressão à média;
- simulação padrão: **2.000.000 de universos Monte Carlo**;
- integração com Copa do Brasil, Libertadores e Sul-Americana para vagas/repasses;
- classificação projetada única de 1º a 20º, pontos inteiros e faixa probabilística preservada para auditoria;
- histórico de snapshots encadeado por SHA-256;
- probabilidades pré-jogo V/E/D calculadas pela matriz de placares do mesmo modelo;
- AF-Score/ranking de desempenho auditado, mas não usado como variável do modelo enquanto não houver base histórica homogênea sem vazamento temporal;
- Dixon–Coles permanece implementado como sensibilidade, entrando em produção somente se superar o modelo em validação própria.

Nunca gerar probabilidades com snapshot continental vencido/incompatível nem misturar dados futuros em previsões históricas.

### 2.4 Operação passa pelo orquestrador determinístico

A política atual substitui vários cronogramas “burros” por um **orquestrador de estado**:

- workflow: `.github/workflows/orquestrador-inteligente.yml`;
- cérebro: `scripts/orquestrar_workflows.py`;
- configuração: `dados-br/config-orquestrador.json`;
- o script **não usa OpenAI** e **não altera arquivos**; apenas decide a próxima ação útil;
- o workflow despacha **no máximo um workflow pesado por ciclo**;
- se um writer relevante já estiver ativo e a política exigir bloqueio, evita criar fila inútil;
- `ACAO=none` é resultado normal/sucesso.

A chamada periódica recomendada é externa, via cron-job.org, a cada **10 minutos**, usando `workflow_dispatch` do orquestrador. O cron externo acorda o decisor; isso NÃO significa executar todos os coletores a cada 10 minutos.

Prioridade atual:

1. atualizar Brasileirão;
2. públicos pendentes;
3. primeira tentativa de melhores momentos;
4. transmissão ao vivo;
5. editorial Copa do Brasil;
6. editorial da rodada;
7. retentativa de melhores momentos;
8. grade futura de TV.

### 2.5 Públicos são um pipeline independente

Público não deve depender de uma nova execução pesada do Brasileirão horas depois do jogo.

- workflow: `Atualizar públicos do Brasileirão`;
- script: `scripts/atualizar_publicos_brasileirao.py`;
- primeira tentativa: **15 min após FINAL**;
- retentativas: backoff progressivo definido em `config-orquestrador.json`;
- fonte automática principal: **GE/Gato Mestre**;
- descoberta de matéria via **sitemap diário do GE**, não por adivinhação de slug;
- usar exclusivamente **Público presente/Público total**; jamais substituir por “público pagante”;
- complemento existente divergente não é sobrescrito automaticamente;
- a atualização regenera somente os derivados necessários (`jogos-detalhes` e `estatisticas-competicao`) e dispara deploy apenas se houve novidade.

### 2.6 Melhores momentos e transmissões devem ser conservadores

**Melhores momentos:**

- primeira tentativa 10 min após FINAL;
- retentativas com backoff;
- prioridade editorial: GE/Globo/sportv/Premiere/Globoplay, CazéTV, Prime Video; UOL somente como fallback automático após 48h;
- link manual tem prioridade;
- vídeo de canal aleatório não entra apenas porque o título cita uma fonte confiável;
- jogo sem vídeo não é erro imediato: pode ainda não ter sido editado/publicado.

**Transmissões:**

- grade futura de TV: execução diária e retentativa excepcional para pendência crítica;
- player AO VIVO: busca apenas perto da partida e enquanto faltar link elegível;
- GE TV tem prioridade sobre CazéTV;
- somente vídeo oficial, público, embeddable e de partida integral vira player interno;
- lives de narração, watchalong, multiplex, “lances em tempo real” e similares são rejeitadas;
- informação válida nunca é apagada por resposta vazia posterior.

### 2.7 Editorial é orientado a fechamento, não a relógio

Os editoriais são produzidos quando o estado esportivo torna a publicação elegível.

- Brasileirão: `scripts/gerar_analise_rodada.py` + `publicar-analise-rodada.yml`;
- Copa do Brasil: `scripts/gerar_analise_copa_do_brasil.py` + `publicar-analise-copa-do-brasil.yml`;
- os cálculos, placares, variações e tabelas são determinísticos;
- a IA diária pode fornecer redação editorial validada, mas os geradores editoriais **não chamam OpenAI diretamente**;
- artigos publicados alimentam `analises/`, `dados-br/analises.json`, `sitemap.xml`, `news-sitemap.xml` e `feed.xml`.

### 2.8 A única IA operacional é uma camada posterior

A IA não controla placar, classificação, AF‑Previsão, orquestração ou gatilhos.

`Auditoria IA diária` roda em uma única janela diária (08:45 BRT / cron UTC `45 11 * * *`) e possui trava persistente para no máximo **uma chamada OpenAI por data de Brasília**.

Ela recebe primeiro a auditoria determinística. Pode usar uma única `web_search` quando houver lacuna factual real. Sua atuação é limitada:

- nunca altera placar, classificação, estatística calculada ou probabilidades;
- pode complementar público/transmissão apenas com evidência permitida e confiança alta;
- melhores momentos não são vinculados automaticamente pela IA;
- pode produzir editorial que depois passa pelos validadores determinísticos;
- falha da OpenAI não derruba os workflows esportivos;
- e-mail é reservado para problema realmente crítico não resolvido.

### 2.9 Deploy é transacional e concorrência antiga deve ser descartada

`.github/workflows/deploy.yml` monta `_site`, valida o pacote, otimiza imagens para publicação, configura Pages e executa `actions/deploy-pages` com retentativas.

A concorrência é:

```yaml
concurrency:
  group: pages
  cancel-in-progress: true
```

Isso é intencional: deploy antigo/obsoleto não deve segurar a versão mais recente numa fila longa.

O deploy também valida SEO, sitemap/feed, CNAME, rotas, arquivos obrigatórios, integridade editorial, assets e módulo Copa; depois notifica IndexNow. Falha de IndexNow não deve derrubar o deploy.

---

## 3. Estado do acesso público e módulos privados

`js/br-config.js` define atualmente:

```js
recursos: {
  login: false,
  modulosPrivados: false,
  copa2026: true
}
```

Logo, o site principal está em **modo público**. `index.html` também declara `BR_PUBLIC_ONLY = true`.

O código de login, sessões, bolão, participantes, ligas, regras privadas e RPCs Supabase permanece preservado para compatibilidade/histórico, mas **não deve ser interpretado como requisito atual de navegação pública**.

Arquivos como `apostas.html`, `regras.html`, `br-apostas.js`, `br-pontuacao.js`, `apurar_rodada.py` e os SQLs `supabase/brasileirao_apostas*.sql` são a infraestrutura do antigo/possível módulo privado. Não remover sem decisão explícita, mas não reativar login por acidente.

---

## 4. Páginas públicas atuais

- `/` e `/jogos` — home/jogos; calendário, filtros, partidas, transmissões, probabilidades pré-jogo e live.
- `/tabela` — classificação oficial + projeção ao vivo.
- `/resultados` — resultados, detalhes do jogo e melhores momentos.
- `/estatisticas.html` — probabilidades, artilharia, assistências, jogos, gols por clube, campeonato, público, AF-Score/desempenho, histórico e metodologia.
- `/acuracia.html` — avaliação pública do AF‑Previsão ao longo do campeonato.
- `/aovivo.html` — central de partidas ao vivo dos clubes da Série A nas competições monitoradas, com player oficial quando disponível.
- `/clubes.html` — fichas dos 20 clubes, agenda, elenco, probabilidades e histórico relacionado.
- `/museu.html` — campeões, títulos, recordes e marcos do Brasileirão.
- `/analises/` — hub editorial e artigos estáticos.
- `/sobre.html` — identidade, metodologia geral, fontes e caráter independente.
- `/copa2026/` — módulo próprio da Copa do Mundo 2026.

`agenda.html` continua publicado como página técnica/editorial de agenda consolidada, embora o menu principal atual remova o antigo link “Agenda” para concentrar a navegação em Jogos.

As rotas limpas `/jogos`, `/tabela`, `/resultados`, `/bolao` e `/aniversariantes` são diretórios estáticos que redirecionam para views do `index.html`. As duas últimas estão preservadas por legado e não compõem a experiência pública principal atual.

---

## 5. Fontes e precedência

### Dados esportivos

1. ESPN — fonte primária;
2. CBF — complemento oficial especialmente para calendário/grade/resultado divergente;
3. API-Football — fallback opcional quando secrets/configuração existem;
4. `dados-br/resultados-manuais.json` / ajustes versionados — exceções auditáveis.

### Público

1. ESPN summary quando informa público;
2. `dados-br/publicos-complementares.json` (coleta documental);
3. GE/Gato Mestre via sitemap diário como principal descoberta automática;
4. complementos manuais/documentais versionados já existentes, sem substituir “pagantes” por “presentes”.

### Transmissões

CBF detalhada → GE Agenda/artigos → ESPN summary → `transmissoes.json`/manuais, respeitando a política específica de exclusividade e preservação.

### Vídeos

Manual confiável > GE/Globo/sportv/Premiere/Globoplay > CazéTV > Prime Video > UOL após carência de 48 h. Outros canais automáticos são rejeitados.

---

## 6. Módulo Copa 2026

`copa2026/` é um módulo autônomo, preservado dentro do mesmo Pages. Possui páginas, JS, dados e documentação próprios. Inclui partidas, ao vivo, estatísticas, seleções, palcos, museu, onde assistir, bolão/palpites, ranking e administração histórica.

A raiz do projeto não deve misturar regras internas da Copa com o Brasileirão, exceto integrações deliberadas (por exemplo, agenda dos clubes, dados continentais e eventuais recursos compartilhados). Para alteração interna da Copa, ler também:

- `copa2026/docs/04-CONTEXTO.md`;
- `copa2026/docs/05-DOCUMENTACAO.md`;
- demais regras/checklists em `copa2026/docs/`.

A documentação interna da Copa é histórica e pode conter datas anteriores; o inventário técnico atualizado do repositório também está consolidado em `docs/DOCUMENTACAO.md` da raiz.

---

## 7. Segredos e credenciais

Nunca comitar secrets. O repositório referencia, conforme o workflow:

- `OPENAI_API_KEY`;
- `YOUTUBE_API_KEY`;
- `RESEND_API_KEY`;
- `EMAIL_DESTINO`, `EMAIL_REMETENTE`, `EMAIL_DESTINO_SUGESTOES`;
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`;
- `API_FOOTBALL_KEY`, `API_FOOTBALL_LEAGUE_ID`.

A anon/publishable key do Supabase em `js/br-config.js` é pública por natureza; a segurança deve continuar nas RLS/RPCs. Nunca colocar `service_role` no front-end.

O cron-job.org precisa de um token GitHub restrito apenas ao repositório e a `Actions: write`. O token nunca deve entrar em arquivo do repositório.

---

## 8. Regras de manutenção para futuras IAs/desenvolvedores

Antes de mudar o projeto:

1. ler este arquivo e `docs/DOCUMENTACAO.md`;
2. identificar se a mudança toca o módulo principal, AF‑Previsão, editorial, automação ou `copa2026/`;
3. preservar snapshots válidos e fallbacks;
4. nunca transformar ausência de dado em zero/dado inventado;
5. nunca recalcular o AF com estado esportivo incompleto;
6. não criar novo cron fixo quando o orquestrador puder decidir pelo estado;
7. não disparar workflow pesado por gol ao vivo;
8. evitar duplicar lógica de classificação: `br-classificacao-live.js` é o motor compartilhado;
9. respeitar nomes canônicos dos clubes;
10. manter atualizados querystrings `?v=` dos assets alterados quando necessário para cache;
11. validar Python, JS, YAML e JSON antes do commit;
12. executar os `--self-test` existentes nos scripts alterados;
13. se alterar deploy/workflow, simular as etapas críticas localmente;
14. atualizar estes dois documentos quando arquitetura, gatilhos, fontes, regras ou páginas mudarem.

### Não fazer

- não reintroduzir cron de meia em meia hora no workflow principal apenas por conveniência;
- não usar IA como decisor de gatilho operacional;
- não apagar dados históricos porque uma fonte externa retornou vazio/403;
- não aceitar qualquer vídeo do YouTube como “melhores momentos”;
- não usar público pagante como público presente;
- não misturar percentuais antigos do AF com linha/posição errada após reordenar classificação ao vivo: probabilidades são vinculadas ao **clube**, não ao índice da linha;
- não remover arquivos legados do bolão/Supabase sem verificar dependências e decisão de produto;
- não tratar `ACAO=none` do orquestrador como falha.

---

## 9. Documentação detalhada

`docs/DOCUMENTACAO.md` é a referência técnica completa e contém:

- mapa de páginas e rotas;
- inventário de JS/CSS;
- inventário de todos os JSONs `dados-br`;
- scripts Python e suas responsabilidades;
- workflows, gatilhos e efeitos;
- política exata do orquestrador;
- AF‑Previsão, acurácia, estatísticas, públicos, transmissões, vídeos e editoriais;
- Supabase/bolão legado;
- módulo Copa 2026;
- SEO, Analytics, deploy e IndexNow;
- secrets, testes, operação manual e diagnóstico.
