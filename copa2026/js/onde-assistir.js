/* onde-assistir.js — lista de jogos da Copa com data, hora (Brasília) e canais.
   Fonte: feed ESPN (datas/horários reais) cruzado com dados/transmissoes.json.
   Inclui geração de calendário .ics e botão de compartilhar. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  var TV_CAT = {
    globo: ["Globo", "#0a7cff"], sbt: ["SBT", "#00a651"], sportv: ["SporTV", "#ff7a00"],
    getv: ["ge tv", "#06aa48"], gplay: ["Globoplay", "#fb0234"], caze: ["CazéTV", "#f7d116"]
  };
  var SEL = {}, ISO = {}, TVS = {}, MM = {}, JOGOS = [];

  function fmtData(d) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit" }).format(d);
  }
  function fmtHora(d) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(d);
  }
  function diaChave(d) {
    var p = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
    var o = {}; p.forEach(function (x) { if (x.type !== "literal") o[x.type] = x.value; });
    return o.year + "-" + o.month + "-" + o.day;
  }
  function flag(id) {
    var c = ISO[id]; return c ? '<img class="oa-flag" src="https://flagcdn.com/w40/' + c + '.png" alt="" onerror="this.style.display=\'none\'">' : "";
  }
  function momento(aId, bId) {
    var k = [aId, bId].sort().join("-");
    return MM[k] || null;
  }
  function chips(aId, bId) {
    var k = [aId, bId].sort().join("-");
    var extras = (TVS.jogos && TVS.jogos[k]) || [];
    var lista = Object.keys(TV_CAT).filter(function (c) { return c === "caze" || extras.indexOf(c) !== -1; });
    return lista.map(function (c) {
      return '<span class="tvchip" style="background:' + TV_CAT[c][1] + ';color:' + (c === "caze" ? "#3a2a00" : "#fff") + '">' + TV_CAT[c][0] + "</span>";
    }).join("");
  }

  function render() {
    if (!JOGOS.length) { $("#lista").innerHTML = '<p class="vazio">Não consegui carregar os jogos agora. Tente recarregar a página.</p>'; return; }
    JOGOS.sort(function (a, b) { return a.date - b.date; });
    var html = "", diaAtual = "";
    JOGOS.forEach(function (j) {
      var dk = diaChave(j.date);
      if (dk !== diaAtual) {
        diaAtual = dk;
        html += '<div class="dia-cab">' + fmtData(j.date) + "</div>";
      }
      var estado = j.state === "post" ? '<span class="oa-fim">encerrado</span>' : j.state === "in" ? '<span class="oa-vivo">🔴 ao vivo</span>' : '<span class="oa-hora">' + fmtHora(j.date) + "</span>";
      var m = (j.state === "post") ? momento(j.a, j.b) : null;
      html += '<div class="oa-jogo">' +
        '<div class="oa-times">' + flag(j.a) + '<span>' + (j.an || j.a) + "</span><b>×</b><span>" + (j.bn || j.b) + "</span>" + flag(j.b) + "</div>" +
        '<div class="oa-info">' + estado + (j.venue ? ' · <span class="oa-loc">' + j.venue + "</span>" : "") + "</div>" +
        (m && m.url ? '<a class="oa-assista" href="' + m.url + '" target="_blank" rel="noopener">▶️ Assista como foi (melhores momentos)</a>'
                    : '<div class="oa-tv">📺 ' + chips(j.a, j.b) + "</div>") +
        "</div>";
    });
    $("#lista").innerHTML = html;
  }

  function baixarICS() {
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    function dt(d) { // UTC para o .ics
      return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00Z";
    }
    var linhas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bolao Copa 2026//PT-BR", "CALSCALE:GREGORIAN"];
    JOGOS.forEach(function (j) {
      var fim = new Date(j.date.getTime() + 2 * 3600 * 1000);
      linhas.push("BEGIN:VEVENT");
      linhas.push("UID:" + j.id + "@brasileirao2026almoco");
      linhas.push("DTSTAMP:" + dt(new Date()));
      linhas.push("DTSTART:" + dt(j.date));
      linhas.push("DTEND:" + dt(fim));
      linhas.push("SUMMARY:" + (j.an || j.a) + " x " + (j.bn || j.b) + " — Copa 2026");
      if (j.venue) linhas.push("LOCATION:" + j.venue.replace(/,/g, "\\,"));
      linhas.push("DESCRIPTION:Copa do Mundo 2026. Assista na CazéTV e acompanhe o bolão em brasileirao2026almoco.com.br/copa2026");
      linhas.push("END:VEVENT");
    });
    linhas.push("END:VCALENDAR");
    var blob = new Blob([linhas.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "copa-2026-jogos.ics";
    document.body.appendChild(a); a.click(); a.remove();
  }

  function compartilhar() {
    var url = "https://brasileirao2026almoco.com.br/copa2026/onde-assistir.html";
    var texto = "Onde assistir todos os jogos da Copa 2026 (horário de Brasília) 🏆⚽";
    if (navigator.share) {
      navigator.share({ title: "Copa 2026 — Onde assistir", text: texto, url: url }).catch(function () {});
    } else {
      var wa = "https://wa.me/?text=" + encodeURIComponent(texto + " " + url);
      window.open(wa, "_blank");
    }
  }

  function init() {
    Promise.all([
      fetch("dados/selecoes.json").then(function (r) { return r.json(); }),
      fetch("dados/transmissoes.json").then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetch(API + "?dates=20260611-20260719&limit=200").then(function (r) { return r.json(); }),
      fetch("dados/melhores-momentos.json?t=" + Date.now()).then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      MM = (res[3] && res[3].jogos) || {};
      (res[0].selecoes || []).forEach(function (s) { SEL[s.id] = s.nome; ISO[s.id] = s.iso2; });
      TVS = res[1] || {};
      (res[2].events || []).forEach(function (ev) {
        var c = ev.competitions[0]; if (!c) return;
        var cs = c.competitors || [];
        var h = cs.find(function (x) { return x.homeAway === "home"; }) || cs[0];
        var a = cs.find(function (x) { return x.homeAway === "away"; }) || cs[1];
        if (!h || !a) return;
        var aId = (h.team || {}).abbreviation, bId = (a.team || {}).abbreviation;
        JOGOS.push({
          id: ev.id, date: new Date(ev.date), state: c.status.type.state,
          a: aId, b: bId, an: SEL[aId], bn: SEL[bId],
          venue: (c.venue && c.venue.fullName) || ""
        });
      });
      render();
      var bi = $("#btn-ics"); if (bi) bi.onclick = baixarICS;
      var bc = $("#btn-share"); if (bc) bc.onclick = compartilhar;
    }).catch(function () {
      $("#lista").innerHTML = '<p class="vazio">Não consegui carregar os jogos agora. Tente recarregar.</p>';
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
