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
