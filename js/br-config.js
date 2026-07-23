/* ==========================================================================
   br-config.js — Configuração pública do Fórmula do Gol
   --------------------------------------------------------------------------
   A chave abaixo é a ANON/PUBLISHABLE do Supabase. Ela pode ficar no navegador.
   A proteção real deve ficar nas policies/RLS criadas pelo SQL entregue nesta
   execução. Nunca coloque SERVICE_ROLE no front.
   ========================================================================== */
(function (global) {
  "use strict";

  global.BR_CFG = {
    temporada: 2026,
    recursos: {
      login: false,
      modulosPrivados: false,
      copa2026: false
    },
    rodadaInicialApostas: 20,
    supabase: {
      url: "https://pdetjrsvmnuglskvytro.supabase.co",
      key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkZXRqcnN2bW51Z2xza3Z5dHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1Mjk0MzIsImV4cCI6MjA5NjEwNTQzMn0.KdlwR_BR4z4gQxlGn_b-GpzW1if0BKLf_T4EzDTkd8g",
      tabelaPalpites: "br_palpites",
      versaoApostas: 2
    },
    arquivos: {
      jogos: "jogos.json",
      resultados: "resultados.json",
      eventos: "espn_eventos.json",
      membros: "membros.json",
      apuracao: "dados-br/apuracao.json",
      configRodadas: "dados-br/apostas-config.json"
    },
    janelaPadrao: {
      // Regra definida: abre geralmente na quinta-feira e fecha no sábado às 10h.
      abreDiaSemana: 4, // quinta, JS: domingo=0 ... sábado=6
      abreHora: 0,
      fechaDiaSemana: 6, // sábado
      fechaHora: 10,
      fechaMinuto: 0
    },
    pontuacao: {
      placarExato: 5,
      resultadoSaldo: 3,
      resultado: 2,
      erro: 0
    }
  };
})(window);
