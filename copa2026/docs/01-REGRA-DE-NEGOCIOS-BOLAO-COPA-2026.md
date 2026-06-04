# REGRA DE NEGÓCIOS — BOLÃO COPA DO MUNDO 2026
## Versão final para implementação

## 1. Objetivo
O Bolão Copa 2026 será um módulo independente dentro do site Brasileirão2026Almoço. O participante preencherá placares para a Copa inteira; o sistema calculará automaticamente classificação dos grupos, melhores terceiros, chaveamento, mata-mata, campeão previsto e ranking.

O módulo deve funcionar sem bagunçar o site atual. Durante a Copa, a aba Bolão Copa será principal; depois, o site volta ao normal e o Bolão Copa permanece como aba secundária/histórica.

## 2. Princípios obrigatórios
1. Módulo Copa isolado do ranking/bolão do Brasileirão.
2. Não reestruturar o site principal sem necessidade.
3. Participante preenche placares; não escolhe classificados manualmente.
4. Sistema calcula grupos, terceiros, chaveamento e avanço.
5. Palpites completos dos demais só aparecem após a trava.
6. Dados protegidos contra alteração após a data limite.
7. Ranking transparente: pontos atuais, perdidos, possíveis e teto máximo.
8. Sem aposta financeira, odds, cotas ou integração com sites de aposta.
9. Interface simples, responsiva, acessível e amigável para pessoas com pouca familiaridade tecnológica.
10. Sem preenchimento automático de placares.
11. Sem dropdown para placar; usar campos numéricos digitáveis.
12. Pontuação intuitiva: campeão vale mais que vice; 3º vale mais que 4º.

## 3. Documentação obrigatória no repositório
O desenvolvedor/IA deverá criar e manter no repositório:
- `CONTEXTO.md`
- `DOCUMENTAÇÃO.md`

Esses arquivos são obrigatórios porque o módulo será construído sobre site existente com HTML, JSON, scripts Python, GitHub Pages e automações. Eles reduzem retrabalho e evitam mudanças indevidas.

### 3.1. `CONTEXTO.md` deve conter
- objetivo do projeto;
- estrutura atual do site;
- o que não deve ser alterado;
- regra de ativação automática do período Copa;
- arquitetura do módulo `/copa2026/`;
- decisões de negócio e técnicas;
- pendências;
- orientação para futuras IAs/desenvolvedores.

### 3.2. `DOCUMENTAÇÃO.md` deve conter
- como rodar/manter o projeto;
- estrutura de pastas;
- arquivos principais;
- modelo de dados;
- Supabase/RLS, se adotado;
- variáveis de ambiente;
- GitHub Actions;
- atualização de resultados;
- recálculo de ranking;
- backup/restauração;
- deploy;
- modo pós-Copa;
- logs e auditoria.

### 3.3. Regra de manutenção
Qualquer alteração relevante em regras, pontuação, dados, workflows, segurança, APIs ou estrutura deve atualizar `CONTEXTO.md` e `DOCUMENTAÇÃO.md` no mesmo commit.

## 4. Período especial no site
De 05/06/2026 a 20/07/2026:
- ocultar a aba Ranking do Brasileirão;
- abrir o site direto em Bolão Copa;
- manter demais abas acessíveis, se desejado.

Antes de 05/06/2026 e a partir de 21/07/2026:
- Ranking volta a aparecer;
- site volta a abrir no Ranking;
- Bolão Copa permanece como aba secundária/histórica.

Implementação sugerida:
```js
function isPeriodoCopa() {
  const agora = new Date();
  const inicio = new Date('2026-06-05T00:00:00-03:00');
  const fim = new Date('2026-07-20T23:59:59-03:00');
  return agora >= inicio && agora <= fim;
}
state.view = isPeriodoCopa() ? 'copa' : 'rank';
```

## 5. Estrutura modular
Criar pasta:
```text
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
```
O `index.html` deve receber apenas botão/aba, container e imports do módulo.

## 6. Sub-abas internas
1. Meu Palpite
2. Ranking
3. Palpites dos Participantes
4. Resultados
5. Regulamento
6. Admin Copa, apenas para administradores

## 7. Cadastro e autenticação
Cada participante informa:
- nome público;
- PIN de 6 dígitos.

Regras:
- PIN exatamente numérico e com 6 dígitos;
- nunca salvar PIN em texto puro;
- salvar apenas hash;
- permitir reset pelo admin;
- bloquear nomes duplicados após normalização de espaços/maiúsculas/minúsculas.

## 8. Persistência
Recomendado: Supabase/Postgres, mantendo site no GitHub Pages.

No Supabase:
- participantes;
- PIN hash;
- rascunhos;
- palpites enviados;
- snapshots travados;
- auditoria;
- configurações;
- ranking cache.

Em JSON/GitHub:
- jogos;
- resultados;
- escudos;
- arquivos públicos;
- documentação.

Tabelas mínimas:
```text
copa_participantes(id, nome_publico, nome_normalizado, pin_hash, ativo, criado_em, ultimo_login_em)
copa_palpites(id, participante_id, status, payload_palpite, payload_derivado, enviado_em, travado_em, atualizado_em)
copa_auditoria(id, participante_id, admin_id, acao, antes, depois, criado_em)
copa_config(chave, valor)
copa_ranking_cache(participante_id, pontos_atuais, pontos_perdidos, pontos_possiveis, teto_maximo, atualizado_em)
```

## 9. Segurança
Usar RLS no Supabase:
- participante só edita próprio palpite antes da trava;
- participante não edita após trava;
- leitura dos palpites dos demais só após `reveal_at`;
- admin altera com auditoria.

A trava precisa ser server-side, não apenas visual.

## 10. Datas
- Prazo final: 10/06/2026 às 23:59:59, horário de Brasília.
- Trava: 11/06/2026 às 00:00:00.
- Liberação dos palpites dos demais: 11/06/2026 às 00:00:00.

## 11. Estados do palpite
- `rascunho`: editável;
- `enviado`: completo e editável até a trava;
- `travado`: congelado;
- incompleto após prazo: fora do ranking competitivo.

## 12. Preenchimento
Cada participante preencherá 104 jogos:
- 72 grupos;
- 16 fase de 32;
- 8 oitavas;
- 4 quartas;
- 2 semifinais;
- 1 disputa de 3º;
- 1 final.

Preenchimento por etapas. A etapa seguinte só abre quando a anterior estiver válida.

## 13. UX obrigatória
Como são 104 placares, a experiência deve ser guiada:
- não mostrar 72 jogos de uma vez;
- mostrar por grupo;
- cards grandes de jogo;
- barra de progresso geral e por etapa;
- indicador de último salvamento;
- botões grandes;
- mensagens simples;
- revisão final antes do envio;
- layout responsivo;
- campos fáceis no celular;
- linguagem sem termos técnicos para o usuário.

## 14. Campos de placar
Campos numéricos:
- aceitar apenas inteiros de 0 a 9;
- sem letras, símbolos, negativos, casas decimais;
- empate permitido nos grupos;
- empate proibido no mata-mata.

Exemplo:
```html
<input type="number" min="0" max="9" inputmode="numeric">
```

## 15. Grupos e desempate
Critérios do palpite:
1. pontos;
2. saldo;
3. gols marcados;
4. confronto direto;
5. `seed_desempate`;
6. sigla alfabética.

O sistema não usará sorteio aleatório. O mesmo palpite sempre gera a mesma classificação.

`seed_desempate`: preferencialmente ranking FIFA masculino pré-Copa; se indisponível, ordem dos potes/sorteio; em último caso, ordem fixa manual.

## 16. Diferença entre palpite e resultado real
No palpite, usar desempate determinístico.
Nos resultados reais, prevalece a classificação oficial da fonte adotada ou correção manual auditada.

## 17. Melhores terceiros
O sistema seleciona 8 melhores terceiros entre 12 por:
1. pontos;
2. saldo;
3. gols marcados;
4. seed_desempate;
5. sigla.

## 18. Chaveamento da fase de 32
Obrigatório criar `copa2026_terceiros_map.json`, com a tabela de combinações dos terceiros para os slots da fase de 32.

Testar:
- nenhum terceiro duplicado;
- nenhum eliminado usado;
- nenhum slot vazio;
- árvore correta.

## 19. Propagação no mata-mata
Ao preencher placar:
1. identificar vencedor;
2. propagar para fase seguinte;
3. se alterar placar anterior, recalcular cascata;
4. limpar placares posteriores incompatíveis.

## 20. Resultados oficiais
Preferência:
1. API do GloboEsporte, se estável;
2. FIFA como conferência;
3. OpenFootball/football-data/API-Football como fallback;
4. admin manual.

Durante dias com jogos: atualizar a cada 15 minutos.
Dias sem jogos: atualização diária.
Admin pode forçar atualização.

Criar `teams_map.json` para padronizar seleções e aliases.

No mata-mata real, usar `avancou_id`, não apenas placar de tempo normal.

## 21. Pontuação
Pontuação por conjunto de seleções, não por confronto exato. Se o participante previu Brasil nas quartas e o Brasil realmente chegou às quartas, pontua, mesmo por caminho diferente.

### Fase de grupos
```text
Cada seleção correta entre as 32 classificadas: 3 pontos
Cada campeão de grupo correto: +2 pontos
Cada vice-campeão de grupo correto: +1 ponto
Cada 3º colocado de grupo correto: +1 ponto
Cada último colocado de grupo correto: +1 ponto
Cada melhor terceiro classificado correto: +3 pontos
```

### Mata-mata
```text
Cada seleção correta nas oitavas: 4 pontos
Cada seleção correta nas quartas: 6 pontos
Cada semifinalista correto: 9 pontos
Cada finalista correto: 12 pontos
Campeão correto: 40 pontos
Vice-campeão correto: 25 pontos
3º lugar correto: 15 pontos
4º lugar correto: 10 pontos
```

## 22. Desempate do ranking
1. mais placares exatos nos 72 jogos de grupos;
2. mais resultados V/E/D corretos nos 72 jogos de grupos;
3. acertou campeão;
4. acertou vice;
5. mais semifinalistas corretos;
6. mais classificados entre 32;
7. envio mais cedo.

## 23. Ranking
Exibir:
- posição;
- participante;
- pontos atuais;
- pontos perdidos;
- pontos possíveis;
- teto máximo;
- campeão previsto;
- status do campeão;
- última atualização.

## 24. Visualização dos palpites
Antes da trava:
- nome, status, percentual, enviado em.
Não mostrar placares, classificados, mata-mata ou campeão.

Depois da trava:
- palpite completo;
- grupos;
- mata-mata;
- campeão/vice/3º/4º;
- comparação entre participantes.

## 25. Admin Copa
Separado do Admin Brasileirão:
- listar participantes;
- resetar PIN;
- ativar/desativar;
- ver incompletos;
- corrigir resultados;
- indicar vencedor em mata-mata;
- forçar atualização;
- recalcular ranking;
- exportar backup;
- logs.

## 26. Auditoria
Registrar:
- criação;
- edição;
- envio;
- trava;
- reset PIN;
- correção de resultado;
- recálculo;
- alteração de configuração.

## 27. Backups
De 05/06/2026 a 20/07/2026:
- backup diário;
- retenção mínima de 30 backups;
- JSON obrigatório;
- CSV/Excel opcional.

## 28. Testes obrigatórios
Testar cadastro, login, nome duplicado, PIN errado, reset PIN, placar inválido, empate grupo, empate mata-mata, classificação, empate triplo, seed, terceiros, chaveamento, propagação, trava, liberação, pontuação atual/perdida/possível, admin, backup e retorno pós-Copa.

## 29. Mensagens sugeridas
- “Informe apenas números de 0 a 9.”
- “No mata-mata não pode haver empate. Altere o placar para indicar quem avança.”
- “Ainda há jogos sem placar. Complete todos os jogos antes de enviar.”
- “O prazo para editar palpites terminou em 10/06/2026.”
- “Não foi possível salvar agora. Verifique sua conexão e tente novamente.”
