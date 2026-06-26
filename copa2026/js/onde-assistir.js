/* onde-assistir.js — lista de jogos da Copa com data, hora (Brasília), canais,
   placar, gols, melhores momentos e preparo para jogo completo.
   Fonte principal: feed ESPN. Lances são carregados sob demanda via summary para
   não pesar a página. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  var SUMMARY_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary";
  var TV_CAT = {
    globo: ["Globo", "#0a7cff"], sbt: ["SBT", "#00a651"], sportv: ["SporTV", "#ff7a00"],
    getv: ["ge tv", "#06aa48"], gplay: ["Globoplay", "#fb0234"], caze: ["CazéTV", "#f7d116"]
  };
  var SEL = {}, ISO = {}, TVS = {}, MM = {}, JC = {}, JOGOS = [], LANCES_CACHE = {};

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch];
    });
  }
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
    var c = ISO[id];
    return c ? '<img class="oa-flag" src="https://flagcdn.com/w40/' + c + '.png" alt="" onerror="this.style.display=\'none\'">' : "";
  }
  function chave(aId, bId) { return [aId, bId].filter(Boolean).sort().join("-"); }
  function momento(aId, bId) {
    var k = chave(aId, bId);
    return MM[k] || null;
  }
  function jogoCompleto(aId, bId) {
    var k = chave(aId, bId);
    return JC[k] || null;
  }
  function chips(aId, bId) {
    var k = chave(aId, bId);
    var extras = (TVS.jogos && TVS.jogos[k]) || [];
    var lista = Object.keys(TV_CAT).filter(function (c) { return c === "caze" || extras.indexOf(c) !== -1; });
    return lista.map(function (c) {
      return '<span class="tvchip" style="background:' + TV_CAT[c][1] + ';color:' + (c === "caze" ? "#3a2a00" : "#fff") + '">' + TV_CAT[c][0] + "</span>";
    }).join("");
  }

  function getPath(obj, path, def) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      var p = path[i];
      if (cur && typeof cur === "object" && p in cur) cur = cur[p];
      else return def;
    }
    return cur == null ? def : cur;
  }
  function scoreNum(v) {
    if (v == null || v === "") return null;
    var n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
    return isNaN(n) ? null : n;
  }
  function scoreCompetidor(c) {
    var vals = [c && c.score, c && c.displayScore, c && c.curScore, c && c.currentScore, getPath(c, ["score", "value"], null)];
    for (var i = 0; i < vals.length; i++) {
      var n = scoreNum(vals[i]);
      if (n != null) return n;
    }
    var ls = c && c.linescores;
    if (Array.isArray(ls) && ls.length) {
      var ultimo = ls[ls.length - 1];
      var n2 = scoreNum(ultimo && (ultimo.value != null ? ultimo.value : ultimo.displayValue));
      if (n2 != null) return n2;
    }
    return null;
  }
  function textoTipo(o) {
    var t = o && o.type;
    if (!t) return "";
    if (typeof t === "string") return t;
    if (typeof t === "object") return [t.id, t.text, t.name, t.displayName, t.abbreviation].filter(Boolean).join(" ");
    return String(t);
  }
  function textoLance(o) {
    return String((o && (o.text || o.description || o.shortText || o.displayText || o.headline)) || "");
  }
  function nomeAtleta(a) {
    if (!a || typeof a !== "object") return "";
    if (a.athlete) return nomeAtleta(a.athlete);
    return String(a.displayName || a.fullName || a.shortName || a.name || "").replace(/\s+/g, " ").trim();
  }
  function jogadorDoLance(o) {
    if (!o || typeof o !== "object") return "";
    var chaves = ["athlete", "player", "scorer"];
    for (var i = 0; i < chaves.length; i++) { var n = nomeAtleta(o[chaves[i]]); if (n) return n; }
    var listas = ["athletes", "participants", "athletesInvolved", "players"];
    for (var j = 0; j < listas.length; j++) {
      var arr = o[listas[j]];
      if (Array.isArray(arr)) for (var k = 0; k < arr.length; k++) { var n2 = nomeAtleta(arr[k]); if (n2) return n2; }
    }
    return String(o.displayName || o.athleteDisplayName || o.name || "").replace(/\s+/g, " ").trim();
  }
  function minutoDoLance(o) {
    var v = getPath(o, ["clock", "displayValue"], "") || getPath(o, ["time", "displayValue"], "") || o.displayClock || o.clock || o.minute || "";
    v = String(v || "").trim();
    if (!v) return "";
    if (/^\d+$/.test(v)) return v + "'";
    return v.replace(/\s+/g, " ");
  }
  function golDoTexto(txt) {
    if (!txt) return "";
    var pats = [
      /Goal!.*?\.\s*([^\.]+?)\s*\((?:[^)]*)\)/i,
      /Gol!.*?\.\s*([^\.]+?)\s*\((?:[^)]*)\)/i,
      /^\s*([^\.]+?)\s+\((?:[^)]*)\)\s*(?:right|left|header|converts|marca|finaliza|chuta)/i
    ];
    for (var i = 0; i < pats.length; i++) {
      var m = txt.match(pats[i]);
      if (m && m[1] && m[1].length <= 60) return m[1].replace(/\s+/g, " ").trim();
    }
    return "";
  }
  function ehGolContra(lance) {
    var raw = (textoTipo(lance) + " " + textoLance(lance)).toLowerCase();
    return /own goal|gol contra|autogol/.test(raw);
  }
  function nomeGolContraDoTexto(txt) {
    txt = String(txt || "");
    var pats = [/own goal by\s+([^,.]+)(?:[,\.]|$)/i, /gol contra de\s+([^,.]+)(?:[,\.]|$)/i, /autogol de\s+([^,.]+)(?:[,\.]|$)/i];
    for (var i = 0; i < pats.length; i++) { var m = txt.match(pats[i]); if (m && m[1]) return m[1].replace(/\s+/g, " ").trim(); }
    return "";
  }
  function dpNorm(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
  function siglaTimeTexto(txt) {
    var n = dpNorm(txt);
    if (!n) return "";
    for (var k in SEL) if (dpNorm(SEL[k]) === n || dpNorm(k) === n) return k;
    return "";
  }
  function timeDoTexto(txt) {
    if (!txt) return "";
    var pats = [/Goal!.*?\.\s*[^\.]+?\s*\(([^)]+)\)/i, /Gol!.*?\.\s*[^\.]+?\s*\(([^)]+)\)/i, /^\s*[^\.]+?\s+\(([^)]+)\)/i];
    for (var i = 0; i < pats.length; i++) {
      var m = txt.match(pats[i]);
      if (m && m[1]) return siglaTimeTexto(m[1]) || m[1].replace(/\s+/g, " ").trim();
    }
    return "";
  }
  function scoreDoLance(o) {
    var pares = [["homeScore", "awayScore"], ["home_score", "away_score"], ["homeTeamScore", "awayTeamScore"], ["home", "away"]];
    for (var i = 0; i < pares.length; i++) {
      var h = pares[i][0], a = pares[i][1];
      if (!o || !(h in o) || !(a in o)) continue;
      var hs = scoreNum(o[h]), as = scoreNum(o[a]);
      if (hs != null && as != null) return { home: hs, away: as };
    }
    var sh = getPath(o, ["score", "home"], null), sa = getPath(o, ["score", "away"], null);
    var hs2 = scoreNum(sh), as2 = scoreNum(sa);
    if (hs2 != null && as2 != null) return { home: hs2, away: as2 };
    return null;
  }
  function arraysLances(summary) {
    var out = [];
    [["scoringPlays"], ["competitions", 0, "scoringPlays"], ["header", "competitions", 0, "scoringPlays"]].forEach(function (p) {
      var arr = getPath(summary, p, []); if (Array.isArray(arr)) out = out.concat(arr);
    });
    return out;
  }
  function arraysComentario(summary) {
    var out = [];
    [["commentary"], ["plays"], ["competitions", 0, "details"]].forEach(function (p) {
      var arr = getPath(summary, p, []);
      if (arr && !Array.isArray(arr) && typeof arr === "object") arr = arr.items || arr.plays || [];
      if (Array.isArray(arr)) out = out.concat(arr);
    });
    return out;
  }
  function siglaObjTime(o) {
    if (!o || typeof o !== "object") return "";
    var cand = [o.team, o.scoringTeam, o.competitor, o.participant, o.club];
    for (var i = 0; i < cand.length; i++) {
      var t = cand[i]; if (!t || typeof t !== "object") continue;
      var sig = siglaTimeTexto(t.abbreviation) || siglaTimeTexto(t.shortDisplayName) || siglaTimeTexto(t.displayName) || siglaTimeTexto(t.name);
      if (sig) return sig;
    }
    return siglaTimeTexto(timeDoTexto(textoLance(o)));
  }
  function extrairLances(summary, j) {
    var gols = [], usados = new Set(), ultimoScore = { home: 0, away: 0 };
    var finalHome = j.scoreA, finalAway = j.scoreB;

    function ladoDoGol(lance) {
      var og = ehGolContra(lance);
      if (!og) {
        var sig = siglaObjTime(lance);
        if (sig && sig === j.a) return "home";
        if (sig && sig === j.b) return "away";
      }
      var sc = scoreDoLance(lance);
      if (sc) {
        if (sc.home > ultimoScore.home && sc.away === ultimoScore.away) return "home";
        if (sc.away > ultimoScore.away && sc.home === ultimoScore.home) return "away";
      }
      return "";
    }
    function ordemMinuto(g) {
      var m = String(g.minuto || "").match(/\d+/);
      return m ? parseInt(m[0], 10) : 999;
    }
    function registrarGol(lance) {
      var og = ehGolContra(lance), txt = textoLance(lance);
      var nome = og ? (nomeGolContraDoTexto(txt) || jogadorDoLance(lance) || golDoTexto(txt)) : (jogadorDoLance(lance) || golDoTexto(txt));
      if (!nome) return;
      var min = minutoDoLance(lance);
      var key = min + "|" + nome.toLowerCase() + "|" + (og ? "OG" : "GOL");
      if (usados.has(key)) return;
      usados.add(key);
      gols.push({ minuto: min, nome: nome, lado: ladoDoGol(lance), og: og });
      var sc = scoreDoLance(lance); if (sc) ultimoScore = sc;
    }

    arraysLances(summary).forEach(function (sp) {
      var raw = (textoTipo(sp) + " " + textoLance(sp)).toLowerCase();
      if (/shootout|penalty shootout|disputa de p[eê]naltis/.test(raw)) return;
      if (!(raw.indexOf("goal") >= 0 || raw.indexOf("gol") >= 0 || parseInt(sp.scoreValue || "0", 10) === 1)) return;
      registrarGol(sp);
    });
    arraysComentario(summary).forEach(function (ev2) {
      var raw = (textoTipo(ev2) + " " + textoLance(ev2)).toLowerCase();
      if (/shootout|penalty shootout|disputa de p[eê]naltis/.test(raw)) return;
      if (!(raw.indexOf("goal") >= 0 || raw.indexOf("gol!") >= 0 || ehGolContra(ev2))) return;
      registrarGol(ev2);
    });

    if (finalHome != null && finalAway != null) {
      var h = gols.filter(function (g) { return g.lado === "home"; }).length;
      var a = gols.filter(function (g) { return g.lado === "away"; }).length;
      gols.filter(function (g) { return !g.lado; }).sort(function (x, y) { return ordemMinuto(x) - ordemMinuto(y); }).forEach(function (g) {
        var faltaH = Math.max(0, finalHome - h), faltaA = Math.max(0, finalAway - a);
        if (faltaH > 0 && faltaA <= 0) { g.lado = "home"; h++; }
        else if (faltaA > 0 && faltaH <= 0) { g.lado = "away"; a++; }
        else if (faltaH >= faltaA && faltaH > 0) { g.lado = "home"; h++; }
        else if (faltaA > 0) { g.lado = "away"; a++; }
      });
    }
    gols = gols.sort(function (x, y) { return ordemMinuto(x) - ordemMinuto(y); });
    return { gols: gols, golsHome: gols.filter(function (g) { return g.lado === "home"; }), golsAway: gols.filter(function (g) { return g.lado === "away"; }) };
  }
  function chipGol(g) {
    var og = g && g.og ? ' <span class="og-tag" title="Gol contra">OG</span>' : "";
    return '<span class="gol-chip">⚽ ' + (g.minuto ? esc(g.minuto) + " " : "") + esc(g.nome) + og + '</span>';
  }
  function htmlLances(dados) {
    if (!dados || !dados.gols || !dados.gols.length) return "";
    return '<div class="oa-gols-grid"><div class="gols-time gols-home">' + (dados.golsHome || []).map(chipGol).join("") + '</div><div class="gols-centro"></div><div class="gols-time gols-away">' + (dados.golsAway || []).map(chipGol).join("") + '</div></div>';
  }
  async function carregarLancesJogo(j) {
    var el = document.getElementById("oa-gols-" + j.id);
    if (!el || j.state === "pre") return;
    try {
      var c = LANCES_CACHE[j.id];
      var ttl = j.state === "in" ? 25000 : 6 * 60 * 60 * 1000;
      var dados;
      if (c && (Date.now() - c.ts) < ttl) dados = c.dados;
      else {
        var url = SUMMARY_API + "?event=" + encodeURIComponent(j.id) + (j.state === "in" ? "&_=" + Date.now() : "");
        var summary = await fetch(url).then(function (r) { return r.json(); });
        dados = extrairLances(summary, j);
        LANCES_CACHE[j.id] = { ts: Date.now(), dados: dados };
      }
      el.innerHTML = htmlLances(dados);
    } catch (e) {}
  }
  function observarLances() {
    var itens = document.querySelectorAll("[data-lances-id]");
    if (!("IntersectionObserver" in window)) {
      Array.prototype.slice.call(itens, 0, 12).forEach(function (el) {
        var j = JOGOS.find(function (x) { return String(x.id) === String(el.dataset.lancesId); });
        if (j) carregarLancesJogo(j);
      });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        io.unobserve(el);
        var j = JOGOS.find(function (x) { return String(x.id) === String(el.dataset.lancesId); });
        if (j) carregarLancesJogo(j);
      });
    }, { rootMargin: "240px 0px" });
    itens.forEach(function (el) { io.observe(el); });
  }

  function placarHTML(j) {
    if (j.scoreA == null || j.scoreB == null || j.state === "pre") return '<b>×</b>';
    return '<span class="oa-score"><b>' + j.scoreA + '</b><em>×</em><b>' + j.scoreB + '</b></span>';
  }
  function statusHTML(j) {
    if (j.state === "post") return '<span class="oa-fim">encerrado</span>';
    if (j.state === "in") return '<span class="oa-vivo">🔴 ao vivo</span>';
    return '<span class="oa-hora">' + fmtHora(j.date) + '</span>';
  }
  function botoesPosJogo(j) {
    var m = j.state === "post" ? momento(j.a, j.b) : null;
    var jc = j.state === "post" ? jogoCompleto(j.a, j.b) : null;
    var out = "";
    if (m && m.url) out += '<a class="oa-assista" href="' + esc(m.url) + '" target="_blank" rel="noopener">▶️ Assista como foi (melhores momentos)</a>';
    if (jc && jc.url) out += '<a class="oa-completo" href="' + esc(jc.url) + '" target="_blank" rel="noopener">🎥 JOGO COMPLETO — assista como foi</a>';
    return out;
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
      var botoes = botoesPosJogo(j);
      html += '<div class="oa-jogo">' +
        '<div class="oa-matchline">' +
          '<div class="oa-team oa-home">' + flag(j.a) + '<span>' + esc(j.an || j.a) + '</span></div>' +
          placarHTML(j) +
          '<div class="oa-team oa-away"><span>' + esc(j.bn || j.b) + '</span>' + flag(j.b) + '</div>' +
        '</div>' +
        '<div id="oa-gols-' + esc(j.id) + '" class="oa-gols-wrap" data-lances-id="' + esc(j.id) + '"></div>' +
        '<div class="oa-info">' + statusHTML(j) + (j.venue ? ' · <span class="oa-loc">' + esc(j.venue) + "</span>" : "") + "</div>" +
        (botoes || '<div class="oa-tv">📺 ' + chips(j.a, j.b) + "</div>") +
        "</div>";
    });
    $("#lista").innerHTML = html;
    observarLances();
  }

  function baixarICS() {
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    function dt(d) { return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00Z"; }
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
      linhas.push("DESCRIPTION:Copa do Mundo 2026. Assista na CazéTV e acompanhe em brasileirao2026almoco.com.br/copa2026");
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
    var texto = "Acompanhe a Copa 2026: jogos, horários, onde assistir, placares, melhores momentos e jogos completos 🏆⚽";
    if (navigator.share) navigator.share({ title: "Copa 2026 — jogos e onde assistir", text: texto, url: url }).catch(function () {});
    else window.open("https://wa.me/?text=" + encodeURIComponent(texto + " " + url), "_blank");
  }

  function init() {
    Promise.all([
      fetch("dados/selecoes.json").then(function (r) { return r.json(); }),
      fetch("dados/transmissoes.json").then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetch(API + "?dates=20260611-20260719&limit=200&_=" + Date.now()).then(function (r) { return r.json(); }),
      fetch("dados/melhores-momentos.json?t=" + Date.now()).then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetch("dados/jogos-completos.json?t=" + Date.now()).then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      MM = (res[3] && res[3].jogos) || {};
      JC = (res[4] && res[4].jogos) || {};
      (res[0].selecoes || []).forEach(function (s) { SEL[s.id] = s.nome; ISO[s.id] = s.iso2; });
      TVS = res[1] || {};
      (res[2].events || []).forEach(function (ev) {
        var c = ev.competitions && ev.competitions[0]; if (!c) return;
        var cs = c.competitors || [];
        var h = cs.find(function (x) { return x.homeAway === "home"; }) || cs[0];
        var a = cs.find(function (x) { return x.homeAway === "away"; }) || cs[1];
        if (!h || !a) return;
        var aId = (h.team || {}).abbreviation, bId = (a.team || {}).abbreviation;
        JOGOS.push({
          id: ev.id, date: new Date(ev.date), state: getPath(c, ["status", "type", "state"], "pre"),
          a: aId, b: bId, an: SEL[aId] || getPath(h, ["team", "shortDisplayName"], aId), bn: SEL[bId] || getPath(a, ["team", "shortDisplayName"], bId),
          scoreA: scoreCompetidor(h), scoreB: scoreCompetidor(a),
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
