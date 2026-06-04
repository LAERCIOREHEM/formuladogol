# PROPOSTA DE UX — BOLÃO COPA DO MUNDO 2026

## 1. Objetivo
O preenchimento de 104 resultados é naturalmente cansativo. A UX deve transformar esse processo em uma jornada guiada, visual e leve.

O usuário deve sentir: “são muitos jogos, mas o sistema me conduz”.

## 2. Princípios
- pouca informação por tela;
- grupos separados;
- botões grandes;
- texto legível;
- progresso visível;
- salvamento claro;
- erros simples;
- linguagem sem termos técnicos;
- excelente uso no celular;
- revisão antes de envio.

## 3. Tela inicial
Mostrar:
```text
🏆 Bolão Copa 2026
Preencha seus palpites da Copa inteira.
Você pode salvar e continuar depois.
Prazo final: 10/06/2026 às 23h59.
[Entrar no Bolão]
```

## 4. Login/cadastro
Primeiro acesso:
- Nome
- PIN de 6 dígitos
- Confirmar PIN
- Botão “Criar acesso”

Acesso existente:
- Nome
- PIN
- Botão “Entrar”
- Link “Esqueci meu PIN”

Mensagem: “Guarde seu PIN. Você usará esse número para voltar ao palpite.”

## 5. Meu Palpite
Tela central:
```text
Olá, Carlos!
Seu palpite está 38% preenchido.
40 de 104 jogos preenchidos.
Último salvamento: hoje às 14:32.
[Continuar de onde parei]
```

## 6. Etapas visuais
Mostrar status:
```text
✅ Grupos
🔓 Fase de 32
🔒 Oitavas
🔒 Quartas
🔒 Semifinais
🔒 Final
```

## 7. Grupos
Não mostrar 72 jogos de uma vez.

Card por grupo:
```text
Grupo A
4 de 6 jogos preenchidos
[Continuar]
```

Quando completo:
```text
Grupo A
Completo ✅
[Ver classificação]
```

## 8. Card de jogo
Modelo:
```text
Brasil        [ 2 ]  x  [ 1 ]        Marrocos
```

Características:
- escudo ou sigla;
- nomes legíveis;
- campos grandes;
- teclado numérico;
- validação imediata;
- foco no próximo campo.

## 9. Salvamento
Mostrar:
```text
Salvo automaticamente às 15:08.
```
Se falhar:
```text
Não foi possível salvar agora. Tente novamente.
```

## 10. Classificação do grupo
Após grupo completo:
```text
Classificação prevista — Grupo A
1º Brasil
2º Alemanha
3º Equador
4º Marrocos
[Editar placares]
[Próximo grupo]
```

## 11. Resumo após grupos
Mostrar:
- classificação de todos os grupos;
- melhores terceiros;
- 32 classificados;
- botão “Montar fase de 32”.

## 12. Mata-mata
No celular: cards por fase.
No desktop: opção de chave visual.

Card:
```text
Fase de 32
Brasil [2] x [0] Japão
Vencedor: Brasil ✅
```

Empate:
```text
No mata-mata não pode haver empate.
```

## 13. Revisão final
Antes de enviar:
```text
Campeão: Brasil
Vice: França
3º: Argentina
4º: Alemanha
Semifinalistas: Brasil, França, Argentina, Alemanha
Jogos preenchidos: 104 de 104
Prazo: 10/06/2026 às 23h59
[Voltar e editar]
[Confirmar envio]
```

## 14. Após envio
```text
Palpite enviado com sucesso!
Você pode revisar ou alterar até 10/06/2026 às 23h59.
```

## 15. Palpites dos participantes
Antes da trava:
```text
Participante | Status | Enviado em
Carlos | Enviado | 08/06/2026 20:14
Maria | Rascunho | -
```
Mensagem: “Os palpites completos serão liberados após a trava.”

Depois da trava:
- resumo;
- grupos;
- mata-mata;
- comparar participantes.

## 16. Ranking
Desktop: tabela.
Celular: cards.

Card:
```text
1º Carlos
Pontos atuais: 122
Ainda pode fazer: 210
Teto máximo: 332
Campeão: Brasil
```

## 17. Resultados
Mostrar:
- jogos de hoje;
- jogos finalizados;
- próximos jogos;
- placar;
- seleção que avançou no mata-mata.

## 18. Acessibilidade
- fonte legível;
- alto contraste;
- botões grandes;
- labels nos campos;
- navegação por teclado;
- não depender só de cor;
- mensagens simples.

## 19. Experiência ideal
O participante deve pensar:
```text
Consigo preencher aos poucos.
Se eu errar, o sistema avisa.
Não vou perder o que já fiz.
Antes de enviar, consigo revisar.
Depois da trava, posso ver o palpite de todos.
```
