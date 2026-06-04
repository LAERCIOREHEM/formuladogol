# CHECKLIST DE IMPLEMENTAÇÃO — BOLÃO COPA 2026

## Arquitetura
- [ ] Criar `/copa2026/`
- [ ] Isolar lógica da Copa
- [ ] Integrar aba no `index.html`
- [ ] Criar `CONTEXTO.md`
- [ ] Criar `DOCUMENTAÇÃO.md`

## Navegação
- [ ] Abrir Bolão Copa entre 05/06 e 20/07
- [ ] Ocultar Ranking Brasileirão nesse período
- [ ] Restaurar Ranking após 20/07

## Usuários
- [ ] Nome + PIN 6 dígitos
- [ ] Hash do PIN
- [ ] Bloquear duplicados
- [ ] Reset PIN admin

## Palpites
- [ ] 72 jogos de grupos
- [ ] 32, oitavas, quartas, semis, 3º e final
- [ ] Campos numéricos 0–9
- [ ] Empate grupos
- [ ] Bloqueio empate mata-mata
- [ ] Salvar rascunho
- [ ] Enviar completo
- [ ] Bloquear incompleto

## UX
- [ ] Grupos em cards
- [ ] Progresso geral
- [ ] Progresso por grupo
- [ ] Salvamento visível
- [ ] Revisão final
- [ ] Mobile amigável
- [ ] Mensagens simples

## Engines
- [ ] Classificação grupos
- [ ] Seed desempate
- [ ] Melhores terceiros
- [ ] `copa2026_terceiros_map.json`
- [ ] Chaveamento
- [ ] Propagação
- [ ] Limpeza em cascata

## Ranking
- [ ] Pontos atuais
- [ ] Pontos perdidos
- [ ] Pontos possíveis
- [ ] Teto máximo
- [ ] Desempates

## Resultados
- [ ] `teams_map.json`
- [ ] `copa2026_resultados.json`
- [ ] Script atualização
- [ ] `avancou_id`
- [ ] Correção manual

## Segurança
- [ ] Supabase RLS
- [ ] Trava server-side
- [ ] Admin separado
- [ ] Auditoria

## Backup
- [ ] Diário de 05/06 a 20/07
- [ ] Retenção 30
- [ ] JSON
- [ ] Export CSV opcional

## Testes
- [ ] Cadastro/login
- [ ] Nomes duplicados
- [ ] Placar inválido
- [ ] Empates
- [ ] Grupos
- [ ] Terceiros
- [ ] Chaveamento
- [ ] Pontuação
- [ ] Trava
- [ ] Liberação
- [ ] Pós-Copa
