/* =========================================================================
   resultados.js — Resultados das partidas (Copa 2026), direto da ESPN
   Navegador puxa o feed público da ESPN (sem chave, CORS liberado).
   Navegação por dia + atualização automática a cada 60s para os jogos ao vivo.
   ========================================================================= */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const START = "20260611", END = "20260719";

  const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const SEM = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

  function hojeYMD() {
    const d = new Date();
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
    return "" + y + m + dd;
  }
  function clamp(ymd) { return ymd < START ? START : (ymd > END ? END : ymd); }
  function ymdToDate(ymd) { return new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12, 0, 0); }
  function dateToYMD(d) { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0"); return "" + y + m + dd; }
  function rotuloDia(ymd) { const d = ymdToDate(ymd); return `${SEM[d.getDay()]}, ${d.getDate()} de ${["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"][d.getMonth()]}`; }
  function horaBR(iso) { try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }); } catch (e) { return ""; } }

  let dia = clamp(hojeYMD());
  let timer = null;

  async function carregar() {
    $("#dia-rotulo").textContent = rotuloDia(dia);
    $("#prev").disabled = dia <= START;
    $("#next").disabled = dia >= END;
    let data;
    try {
      const r = await fetch(`${API}?dates=${dia}&limit=60`);
      data = await r.json();
    } catch (e) {
      $("#lista").innerHTML = '<p class="vazio">Não consegui buscar os jogos agora. Verifique a conexão e tente recarregar.</p>';
      return;
    }
    const evs = (data.events || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!evs.length) { $("#lista").innerHTML = '<p class="vazio">Nenhum jogo neste dia.</p>'; return; }
    $("#lista").innerHTML = evs.map(card).join("");
  }

  function card(ev) {
    const comp = ev.competitions[0];
    const st = comp.status.type;            // state: pre | in | post
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === "home") || cs[0] || {};
    const away = cs.find(c => c.homeAway === "away") || cs[1] || {};
    const fase = faseLabel(ev);
    const venue = comp.venue ? (comp.venue.fullName + (comp.venue.address && comp.venue.address.city ? " · " + comp.venue.address.city : "")) : "";

    let meio, badge;
    if (st.state === "pre") {
      meio = `<div class="hora">${horaBR(ev.date)}</div>`;
      badge = `<span class="badge ag">Agendado</span>`;
    } else if (st.state === "in") {
      meio = `<div class="placar"><span class="g">${home.score ?? ""}</span><span class="x">×</span><span class="g">${away.score ?? ""}</span></div>`;
      badge = `<span class="badge live"><span class="pulse"></span> ${st.shortDetail || "Ao vivo"}</span>`;
    } else { // post
      meio = `<div class="placar"><span class="g">${home.score ?? ""}</span><span class="x">×</span><span class="g">${away.score ?? ""}</span></div>`;
      badge = `<span class="badge fim">Encerrado${st.shortDetail && /pen/i.test(st.shortDetail) ? " (pên.)" : ""}</span>`;
    }
    const vencH = home.winner ? "venc" : "", vencA = away.winner ? "venc" : "";
    return `<div class="jogo">
      <div class="topo"><span class="fase">${fase}</span>${badge}</div>
      <div class="linha">
        <div class="lado ${vencH}">${escudo(home)}<span class="t">${teamNome(home)}</span></div>
        ${meio}
        <div class="lado f ${vencA}"><span class="t">${teamNome(away)}</span>${escudo(away)}</div>
      </div>
      ${venue ? `<div class="venue">${venue}</div>` : ""}
    </div>`;
  }

  function teamNome(c) { return (c.team && (c.team.shortDisplayName || c.team.displayName || c.team.abbreviation)) || "—"; }
  function escudo(c) {
    const logo = c.team && c.team.logo;
    return logo ? `<img src="${logo}" alt="" title="${(c.team.displayName) || ""}" onerror="this.style.visibility='hidden'">` : "";
  }
  function faseLabel(ev) {
    const slug = (ev.season && ev.season.slug) || "";
    const map = { "group-stage": "Fase de grupos", "round-of-32": "Segunda fase", "round-of-16": "Oitavas", "quarterfinals": "Quartas", "semifinals": "Semifinal", "third-place": "Disputa de 3º", "final": "Final" };
    return map[slug] || "Copa do Mundo";
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#prev").onclick = () => { dia = clamp(dateToYMD(new Date(ymdToDate(dia).getTime() - 864e5))); carregar(); };
    $("#next").onclick = () => { dia = clamp(dateToYMD(new Date(ymdToDate(dia).getTime() + 864e5))); carregar(); };
    carregar();
    timer = setInterval(carregar, 60000); // atualiza sozinho (jogos ao vivo)
  });
})();
