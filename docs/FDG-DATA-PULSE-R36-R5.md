# R36-R5 — Etapa A: FDG Data Pulse

Componente compartilhado de apresentação, sem consultas, polling ou dependência externa.
API: FDGDataPulse.model(input), render(input), mount(element,input).
Carregar css/br-data-pulse.css e js/br-data-pulse.js na integração da Etapa B.

Contrato: updatedAt ISO 8601 com fuso; processed/expected inteiros não negativos, expected vem de referência independente; certified só true após validação da revisão esportiva. pending, live e late são sinais explícitos do consumidor. Precedência: atraso, pendência, ao vivo, certificado, desconhecido. seasonCompleted/seasonTotal são progresso da temporada, não cobertura. metrics é lista de {label,value,detail}; note é texto simples. Sem timestamp válido ou cobertura certificada, não há verde de atualizado. Todos os textos são escapados.

Etapa A inclui assets, contrato, testes e inclusão no pacote Pages. Etapa B integra cada seção. Etapas D–G ligam certificação, manifesto e latência reais. Nenhuma alteração no AF, Cloudflare ou polling nesta etapa.

## Etapa B
Integração nos sete submenus, Tabela, Resultados e Acurácia. Horários próprios, amostra histórica sem denominador inventado. Verde apenas com certificação explícita; a certificação integral de versões permanece na Etapa D. Sem polling adicional.

## Etapa C
Container queries, mobile 2 colunas (1 abaixo de 260 px úteis), tablet 3, desktop 4–6 conforme métricas. Fonte adaptável 18–24 px, sem rolagem horizontal própria, impressão e contraste forçado. Teste de navegador separado do deploy, sem dependências no cliente. Correção do mapeamento artilheiros → artilharia. Nenhuma alteração de polling.

## Etapa D — Real Coverage Certification
- Referência: resultados oficiais únicos por ID e par mandante/visitante, conciliados com os 20 clubes da tabela (J, GP, GC, V, E, D, P).
- Estatísticas: cobertura global independente de filtros; auditoria, escalações, autorias, boxscores e totais por clube; campeonato com dimensões separadas de estatísticas, público e renda. Sem evidência suficiente, não há selo verde.
- Acurácia: E3 deve auditar todos os resultados oficiais; E4 deve corresponder exatamente à amostra elegível com ID, placar, commit e prova temporal pré-jogo. Jogos sem prova são excluídos, jamais reconstruídos. A amostra V/E/D é exibida separadamente da amostra de placares.
- Cache: JS com versão 20261124-r36r5d; CSS C preservado.
- Testes: tests/test-br-data-pulse-certification.mjs e tests/test-br-data-pulse-integration.mjs, executados no workflow Data Pulse Responsive Intelligence antes da matriz Playwright.
- Sem novos timers ou alterações no AF. A Acurácia faz uma consulta inicial de resultados, tabela e E3 para conciliação; a otimização de transferência por manifesto permanece na Etapa E.
- Validação direta no código do repositório em 24/11/2026 UTC: 359 finais e 20 clubes conciliados, E3/E4 177/177, 182 sem prova, duplicidades e registros faltantes rejeitados. A confirmação do deploy e do navegador em produção depende da execução do CI e da versão efetivamente servida.

## Etapa E — Unified Data Manifest & Selective Refresh
O manifesto é gerado no pacote final do Pages (25 JSONs públicos), validado por SHA-256 antes do upload e publicado junto com os dados. Não é um feed adicional no Cloudflare. Estatísticas reutiliza cache em memória por hash e mantém o único ciclo estático de 30 segundos e o AF Core Snapshot prioritário. Bases já carregadas são revalidadas seletivamente; uma falha preserva a última base válida e o selo não certifica revisão pendente. Tabela, Resultados e Acurácia preservam os seus caminhos atuais: o manifesto inventaria também suas bases, sem acrescentar polling a essas páginas. O deploy executa as regressões anteriores e o teste E; o smoke público verifica manifesto e consumidor. F/G ficam reservadas a mudanças de cadência e gatilhos.

## R36-R5 FINAL — F/G/H
Os loops existentes de atualização estática em Estatísticas e de revisão AF em Jogos/Tabela/Resultados usam o scheduler compartilhado. Janela ativa ou FINAL pendente: alvo de 12 s por ciclo; fora de janela: 60 s. Um FINAL real novo identificado pelo ESPN existente aciona verificação imediata sujeita ao limite mínimo; repetição do mesmo evento não multiplica requisições. Retomada por visibilidade/rede; pausa em aba oculta. AF mantém prioridade da publicação canônica e 2 milhões de simulações; verificação urgente do manifesto core limitada a 12 s; sem alteração de Worker ou D1. Os hashes da Etapa E continuam selecionando apenas bases alteradas; a Acurácia continua aferição histórica carregada ao abrir a página. Alvos são cadência de consulta, não garantia de latência da fonte, cálculo ou deploy. Regressões de scheduler e smoke público no pipeline existente.

## R36-R6 FINAL — visual hierarchy
Camada de apresentação: DD/MM dominante, hora BRT secundária, data completa e ISO acessíveis no elemento time; agenda possui indicador próprio, sem declarar certificação que não existe. Tipografia fluida por contêiner, números indivisíveis, 2 colunas no mobile e reflow em contêiner estreito, menos espaço no topo das estatísticas. Preservação por identificador dos detalhes abertos e scroll horizontal nas áreas conhecidas. Nenhum ajuste no AF, hashes, cron, Worker ou D1. Matriz de 16 larguras x 25 combinações sintéticas e regressão de semântica. A homologação visual dessas combinações não equivale a medição de todos os conteúdos reais em produção.
