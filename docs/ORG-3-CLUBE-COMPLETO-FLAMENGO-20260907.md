# ORG-3 — Clube completo: Flamengo

Entrega a página piloto completa `/clube/flamengo/` como composição das fontes já existentes do Fórmula do Gol, sem recalcular probabilidades nem remover informações das páginas originais.

Inclui: resumo atual, probabilidades, distribuição das 20 posições, jogos e alertas do clube, artilheiros, assistências, G+A, campanha, AF-Score, marcos do AF-Previsão, público/renda, acurácia, análises relacionadas e identidade do clube. Mantém o botão **← Voltar para Clubes** e o menu principal com apenas **Clubes**.

A página é pré-renderizada pelo build e continua usando o sistema real de alertas via `data-fdg-team-alert-slot`. O gerador também atualiza o `lastmod` da URL do Flamengo usando as fontes agregadas que efetivamente alimentam a página.

## Gate ORG-3
- um único H1;
- canonical `/clube/flamengo/`;
- `max-image-preview:large`;
- `SportsTeam` + `BreadcrumbList`;
- 20 posições pré-renderizadas;
- AF-Score e AF-Previsão presentes;
- jogadores, público/renda, acurácia e análises presentes;
- CTA de alertas do Flamengo;
- responsividade sem overflow não intencional.
