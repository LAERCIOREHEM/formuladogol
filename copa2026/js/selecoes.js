/* BRFIX 20260703 — correção Danilo Santos/Casemiro/Rayan
   ========================================================================= */
/* =========================================================================
   selecoes.js — Aba SELEÇÕES
   Lê dados/selecoes.json (países/ranking/iso2), dados/paises.json
   (curiosidades), dados/elencos.json (elenco + fotos) e reaproveita
   dados/estatisticas.json + scoreboard ESPN para montar o raio-x de cada país.
   Degrada com elegância: se um feed falhar, mostra apenas o que estiver seguro.
   ========================================================================= */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };

  var API_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  }
  function flagUrl(iso2, w) {
    if (!iso2) return "";
    return "https://flagcdn.com/w" + (w || 80) + "/" + String(iso2).toLowerCase() + ".png";
  }

  function flagEmoji(iso2) {
    var raw = String(iso2 || "").toLowerCase();
    if (raw === "gb-eng") return "EN";
    if (raw === "gb-sct") return "SC";
    iso2 = String(iso2 || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2)) return "";
    return iso2.replace(/./g, function (c) {
      return String.fromCodePoint(127397 + c.charCodeAt(0));
    });
  }
  var PAL_AVATAR = ["#3b5bdb", "#2f9e44", "#e8590c", "#9c36b5", "#1098ad", "#c2255c", "#0c8599", "#5c7cfa"];
  function corAvatar(nome) {
    var s = norm(nome), h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return PAL_AVATAR[h % PAL_AVATAR.length];
  }
  function iniciais(nome) {
    var t = norm(nome).split(" ").filter(Boolean);
    if (!t.length) return "?";
    if (t.length >= 2) return (t[0][0] + t[t.length - 1][0]).toUpperCase();
    return t[0].slice(0, 2).toUpperCase();
  }
  function avatar(nome) {
    return '<span class="sel-face sel-face-ini" style="background:' + corAvatar(nome) + '" aria-hidden="true">' +
      esc(iniciais(nome)) + "</span>";
  }

  function previewAttrs(src, titulo, subtitulo) {
    if (!src) return "";
    return ' data-image-preview="' + esc(src) + '"' +
      ' data-preview-title="' + esc(titulo || "") + '"' +
      ' data-preview-subtitle="' + esc(subtitulo || "") + '"' +
      ' tabindex="0" role="button"';
  }

  var SEL = [], PAISES = {}, ELENCOS = {}, DADOS = {}, JOGOS = [];
  var RANKING_DESEMPENHO = { ranking: [] };
  var CORRECOES_JOGADORES = {};
  var STATS_CARREGADAS = false;
  var ID_ATUAL = "";

  function rankingLabel(s) {
    var r = s && s.seed;
    return r ? ("Ranking FIFA #" + r) : "Ranking FIFA —";
  }

  function cardHTML(s) {
    var pa = PAISES[s.id] || {};
    var copas = pa.copas ? '<span class="sel-card-copas" title="Títulos mundiais">' + "★".repeat(Math.min(pa.copas, 5)) + "</span>" : "";
    return '<button class="sel-card" type="button" data-id="' + esc(s.id) + '">' +
      '<img class="sel-flag" src="' + flagUrl(s.iso2, 80) + '" alt="" loading="lazy" width="48" height="32">' +
      '<span class="sel-card-nome">' + esc(s.nome) + "</span>" +
      '<span class="sel-card-meta">' + esc(rankingLabel(s)) + copas + "</span>" +
      "</button>";
  }

  function menuPaisHTML(s) {
    return '<option value="' + esc(s.id) + '">' +
      esc(flagEmoji(s.iso2) + " " + s.nome + " (" + s.id + ")") +
    '</option>';
  }

  function renderMenuPaises() {
    var el = $("#sel-menu-paises");
    if (!el) return;
    el.innerHTML = '<option value="">🌎 Escolha uma seleção</option>' +
      (SEL.length ? SEL.map(menuPaisHTML).join("") : '<option value="">Não foi possível carregar os países</option>');
  }

  function marcaPaisAtivo(id) {
    var el = $("#sel-menu-paises");
    if (!el) return;
    el.value = id || "";
  }

  function renderLista() {
    var el = $("#sel-scroller");
    el.innerHTML = SEL.length ? SEL.map(cardHTML).join("") : '<div class="sel-vazio">Não foi possível carregar as seleções.</div>';
  }

  function pluralJogadores(n) {
    return n === 1 ? "1 jogador" : n + " jogadores";
  }


  function aplicarCorrecoesJogadores(cj) {
    CORRECOES_JOGADORES = cj || {};
    var lista = (CORRECOES_JOGADORES && CORRECOES_JOGADORES.jogadores) || [];
    if (!lista.length || !ELENCOS || !ELENCOS.times) return;

    lista.forEach(function (corr) {
      var sid = String(corr.selecao || "").toUpperCase();
      var arr = ELENCOS.times[sid] || [];
      if (!arr.length) return;

      var alvo = null;
      if (corr.id) {
        alvo = arr.find(function (p) { return String(p.id || "") === String(corr.id); });
      }
      if (!alvo && corr.nome) {
        var nn = norm(corr.nome);
        alvo = arr.find(function (p) { return norm(p.nome) === nn; });
      }
      if (!alvo) return;

      Object.keys(corr).forEach(function (k) {
        if (["selecao"].indexOf(k) >= 0) return;
        if (k === "id" || k === "nome") return;
        alvo[k] = corr[k];
      });
    });
  }

  function clubeJogador(p, id) {
    var v = p && (p.clube || p.club || p.time || p.equipe || p.team || p.currentTeam || p.current_team || "");
    if (v && typeof v === "object") v = v.nome || v.name || v.displayName || v.shortDisplayName || "";
    v = v ? String(v).trim() : "";
    if (!v) return "";
    var nv = norm(v);
    var ns = norm(nomeSelecao(id));
    var sid = norm(id || "");
    if (nv === ns || nv === sid) return "";
    if (nv.indexOf(" national ") >= 0 || nv.indexOf("national football team") >= 0 || nv.indexOf("national team") >= 0) return "";
    if (nv.indexOf("selecao") >= 0 || nv.indexOf("seleccion") >= 0) return "";
    return v;
  }

  function squadHTML(id) {
    var lista = (ELENCOS.times && ELENCOS.times[id]) || [];
    if (!lista.length) {
      return '<section class="sel-roster-section" aria-label="Elenco da seleção">' +
        '<div class="sel-roster-head"><div><b>Elenco da seleção</b><span>Elenco em breve — atualiza automaticamente a partir da ESPN.</span></div></div>' +
        '<div class="sel-squad-vazio">Quando os dados estiverem disponíveis, os jogadores aparecerão aqui com foto ou avatar de iniciais.</div>' +
      '</section>';
    }
    lista = lista.slice().sort(function (a, b) {
      var ordem = { GOL: 1, GK: 1, DEF: 2, ZAG: 2, LAT: 2, MEI: 3, MID: 3, ATA: 4, FWD: 4, AT: 4 };
      var pa = ordem[String(a.pos || "").toUpperCase()] || 9;
      var pb = ordem[String(b.pos || "").toUpperCase()] || 9;
      var na = parseInt(a.num, 10), nb = parseInt(b.num, 10);
      if (isNaN(na)) na = 999; if (isNaN(nb)) nb = 999;
      return pa - pb || na - nb || String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    });
    return '<section class="sel-roster-section" aria-label="Elenco da seleção">' +
      '<div class="sel-roster-head"><div><b>Elenco da seleção</b><span>' + esc(pluralJogadores(lista.length)) + ' com fotos quando disponíveis</span></div></div>' +
      '<div class="sel-roster-grid">' + lista.map(function (p) {
        var face = p.foto ? '<span class="sel-roster-face"><img src="' + esc(p.foto) + '" alt="" loading="lazy"></span>' : '<span class="sel-roster-face sel-face-ini" style="background:' + corAvatar(p.nome) + '" aria-hidden="true">' + esc(iniciais(p.nome)) + '</span>';
        var clube = clubeJogador(p, id);
        var linha1 = [p.pos, p.num ? ("#" + p.num) : ""].filter(Boolean).join(" · ");
        var subPreview = [nomeSelecao(id), linha1, clube].filter(Boolean).join(" • ");
        var attrs = p.foto ? previewAttrs(p.foto, p.nome || "Jogador", subPreview) : "";
        return '<article class="sel-roster-card ' + (p.foto ? 'sel-previewable' : '') + '"' + attrs + ' aria-label="Ampliar foto de ' + esc(p.nome || "jogador") + '">' + face +
          '<strong>' + esc(p.nome || "—") + '</strong>' +
          (linha1 ? '<span class="sel-roster-meta">' + esc(linha1) + '</span>' : '') +
          (clube ? '<small class="sel-roster-club">' + esc(clube) + '</small>' : '') +
        '</article>';
      }).join("") + '</div>' +
    '</section>';
  }

  function fact(label, val) {
    return val ? '<div class="sel-fact"><span>' + esc(label) + "</span><b>" + esc(val) + "</b></div>" : "";
  }

  function nomeSelecao(sigla) {
    if (window.COPA_TIMES && COPA_TIMES.nome) return COPA_TIMES.nome(sigla);
    var achou = SEL.find(function (x) { return x.id === sigla; });
    return achou ? achou.nome : (sigla || "—");
  }
  function siglaSelecao(valor) {
    if (!valor) return "";
    if (window.COPA_TIMES && COPA_TIMES.sigla) return COPA_TIMES.sigla(valor) || valor;
    return valor;
  }
  function flagEquipe(sigla) {
    var src = window.COPA_TIMES && COPA_TIMES.flag ? COPA_TIMES.flag(sigla, 80) : "";
    if (!src) {
      var s = SEL.find(function (x) { return x.id === sigla; });
      src = s ? flagUrl(s.iso2, 80) : "";
    }
    return src ? '<img src="' + esc(src) + '" alt="" loading="lazy">' : "";
  }
  function getPath(o, path, fb) {
    var x = o;
    for (var i = 0; i < path.length; i++) {
      if (x == null) return fb;
      x = x[path[i]];
    }
    return x == null ? fb : x;
  }
  function numPlacar(v) {
    if (v == null || v === "") return null;
    var n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
    return isNaN(n) ? null : n;
  }
  function scoreCompetidor(c) {
    var vals = [c && c.score, c && c.displayScore, c && c.curScore, c && c.currentScore, getPath(c, ["score", "value"], null)];
    for (var i = 0; i < vals.length; i++) {
      var n = numPlacar(vals[i]);
      if (n != null) return n;
    }
    var ls = c && c.linescores;
    if (ls && ls.length) {
      var ultimo = ls[ls.length - 1] || {};
      var n2 = numPlacar(ultimo.value != null ? ultimo.value : ultimo.displayValue);
      if (n2 != null) return n2;
    }
    return null;
  }
  function placarPenaltiCompetidor(c) {
    var vals = [c && c.shootoutScore, c && c.shootoutDisplayScore, c && c.penaltyScore, c && c.penalties, c && c.shootout];
    for (var i = 0; i < vals.length; i++) {
      var n = numPlacar(vals[i]);
      if (n != null) return n;
    }
    return null;
  }
  function compOf(ev) { return (ev && ev.competitions && ev.competitions[0]) || {}; }
  function teamOf(ev, side) {
    var cs = compOf(ev).competitors || [];
    return cs.filter(function (c) { return c.homeAway === side; })[0] || (side === "home" ? cs[0] : cs[1]) || {};
  }
  function teamSigla(c) {
    return siglaSelecao((c.team && (c.team.abbreviation || c.team.shortDisplayName || c.team.displayName)) || "");
  }
  function venueOf(ev) {
    var v = compOf(ev).venue;
    return v ? (v.fullName + (v.address && v.address.city ? " · " + v.address.city : "")) : "";
  }
  function faseLabel(slug) {
    var map = {
      "group-stage": "Fase de grupos",
      "round-of-32": "Segunda fase",
      "round-of-16": "Oitavas",
      "quarterfinals": "Quartas",
      "semifinals": "Semifinal",
      "third-place": "Disputa de 3º",
      "final": "Final"
    };
    return map[slug] || "Copa do Mundo";
  }
  function vencedorPorPenaltis(home, away, penHome, penAway) {
    if (home && home.winner) return teamSigla(home);
    if (away && away.winner) return teamSigla(away);
    if (penHome != null && penAway != null) {
      if (penHome > penAway) return teamSigla(home);
      if (penAway > penHome) return teamSigla(away);
    }
    return "";
  }
  function normalizarJogo(ev) {
    var comp = compOf(ev), st = ((comp.status || {}).type || {}), home = teamOf(ev, "home"), away = teamOf(ev, "away");
    var sgHome = teamSigla(home), sgAway = teamSigla(away);
    var penHome = placarPenaltiCompetidor(home), penAway = placarPenaltiCompetidor(away);
    return {
      id: String(ev.id || ""),
      date: ev.date || "",
      fase: (ev.season && ev.season.slug) || "",
      fase_nome: faseLabel((ev.season && ev.season.slug) || ""),
      state: st.state || "",
      shortDetail: st.shortDetail || "",
      home: { sigla: sgHome, nome: nomeSelecao(sgHome), score: scoreCompetidor(home) },
      away: { sigla: sgAway, nome: nomeSelecao(sgAway), score: scoreCompetidor(away) },
      penA: penHome,
      penB: penAway,
      vencedor: vencedorPorPenaltis(home, away, penHome, penAway),
      venue: venueOf(ev)
    };
  }
  function fmtJogo(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }) +
        '<span class="sel-match-sep">•</span>' +
        d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return iso; }
  }
  function statusBadge(j) {
    if (j.state === "in") return '<span class="sel-match-badge live">Ao vivo' + (j.shortDetail ? " · " + esc(j.shortDetail) : "") + "</span>";
    if (j.state === "pre") return '<span class="sel-match-badge pre">Agendado</span>';
    var extra = (j.penA != null && j.penB != null) || (j.shortDetail && /pen/i.test(j.shortDetail)) ? " (pên.)" : "";
    return '<span class="sel-match-badge">Encerrado' + extra + "</span>";
  }
  function linhaPenaltis(j) {
    if (!j || j.state !== "post" || j.penA == null || j.penB == null) return "";
    var vencedor = j.vencedor ? nomeSelecao(j.vencedor) : "";
    return '<div class="sel-match-pen">pênaltis ' + esc(j.penA) + "-" + esc(j.penB) +
      (vencedor ? " · <b>" + esc(vencedor) + "</b> venceu" : "") +
    "</div>";
  }
  function jogosDaSelecao(id) {
    return (JOGOS || []).filter(function (j) {
      return (j.home && j.home.sigla === id) || (j.away && j.away.sigla === id);
    }).sort(function (a, b) { return new Date(b.date).getTime() - new Date(a.date).getTime(); });
  }
  function jogoCard(j, id) {
    var pre = j.state === "pre";
    var placar = pre ? "×" : ((j.home.score == null ? "—" : j.home.score) + " × " + (j.away.score == null ? "—" : j.away.score));
    var stats = (!pre && window.COPA_JOGO_STATS && COPA_JOGO_STATS.bloco)
      ? COPA_JOGO_STATS.bloco({ eventId: j.id, homeId: j.home.sigla, awayId: j.away.sigla, homeName: j.home.nome, awayName: j.away.nome })
      : "";
    return '<article class="sel-match-card">' +
      '<div class="sel-match-top"><span class="sel-match-fase">' + esc(j.fase_nome) + "</span>" + statusBadge(j) + "</div>" +
      '<div class="sel-match-line">' +
        '<div class="sel-match-team ' + (j.home.sigla === id ? "sel-match-team-on" : "") + '">' + flagEquipe(j.home.sigla) + '<span>' + esc(j.home.nome) + "</span></div>" +
        '<div class="sel-match-mid"><div class="sel-match-score">' + esc(placar) + '</div><div class="sel-match-date">' + fmtJogo(j.date) + "</div></div>" +
        '<div class="sel-match-team dir ' + (j.away.sigla === id ? "sel-match-team-on" : "") + '"><span>' + esc(j.away.nome) + "</span>" + flagEquipe(j.away.sigla) + "</div>" +
      "</div>" +
      linhaPenaltis(j) +
      (j.venue ? '<div class="sel-match-venue">' + esc(j.venue) + "</div>" : "") +
      stats +
    "</article>";
  }

  function itemPorEquipe(arr, id) {
    return (arr || []).map(function (x) {
      var y = Object.assign({}, x || {});
      y.equipe = siglaSelecao(y.equipe);
      return y;
    }).filter(function (x) { return x.equipe === id; });
  }
  function statsSelecao(id) {
    var por = itemPorEquipe(DADOS.por_selecao || [], id)[0] || {};
    var artilheiros = itemPorEquipe(DADOS.artilheiros || [], id).sort(function (a, b) {
      return (b.gols || 0) - (a.gols || 0) || String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    });
    var assists = itemPorEquipe(DADOS.assistencias || [], id).sort(function (a, b) {
      return (b.assistencias || 0) - (a.assistencias || 0) || String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    });
    var cartoesLista = itemPorEquipe(DADOS.cartoes || [], id);
    var cartoes = (por && (por.amarelos != null || por.vermelhos != null)) ? por : cartoesLista.reduce(function (acc, x) {
      acc.amarelos += x.amarelos || 0;
      acc.vermelhos += x.vermelhos || 0;
      return acc;
    }, { amarelos: 0, vermelhos: 0 });
    return { por: por, artilheiros: artilheiros, assists: assists, cartoes: cartoes };
  }
  function campanhaSelecao(id) {
    var jogos = jogosDaSelecao(id), c = { jogos: 0, v: 0, e: 0, d: 0, gm: 0, gs: 0, vPen: 0, dPen: 0, proximos: 0, aoVivo: 0 };
    jogos.forEach(function (j) {
      if (j.state === "pre") { c.proximos++; return; }
      if (j.state === "in") { c.aoVivo++; return; }
      var ehHome = j.home && j.home.sigla === id;
      var gf = ehHome ? j.home.score : j.away.score;
      var ga = ehHome ? j.away.score : j.home.score;
      if (gf == null || ga == null) return;
      c.jogos++; c.gm += gf; c.gs += ga;
      if (gf > ga) c.v++;
      else if (gf < ga) c.d++;
      else if (j.vencedor) {
        if (j.vencedor === id) { c.v++; c.vPen++; }
        else { c.d++; c.dPen++; }
      } else c.e++;
    });
    c.saldo = c.gm - c.gs;
    return c;
  }
  function fmtNum(n) {
    return n == null || n === "" || isNaN(n) ? "—" : String(n);
  }
  function saldo(n) {
    if (n == null || isNaN(n)) return "—";
    return n > 0 ? "+" + n : String(n);
  }
  function topLabel(item, campo, unidade) {
    if (!item || !item.nome) return "—";
    var v = item[campo] || 0;
    return item.nome + (v ? " — " + v + " " + unidade : "");
  }
  function chaveNomeJogador(nome) {
    return norm(nome).replace(/[^a-z0-9]+/g, " ").replace(/\b(jr|junior|sr|filho|neto)\b/g, "").replace(/\s+/g, " ").trim();
  }
  function jogadorElenco(id, nome) {
    var lista = (ELENCOS.times && ELENCOS.times[id]) || [];
    if (!lista.length || !nome) return null;
    var alvo = chaveNomeJogador(nome);
    var direto = lista.filter(function (p) { return chaveNomeJogador(p.nome) === alvo; })[0];
    if (direto) return direto;
    return lista.filter(function (p) {
      var k = chaveNomeJogador(p.nome);
      return k && alvo && (k.indexOf(alvo) >= 0 || alvo.indexOf(k) >= 0);
    })[0] || null;
  }
  function faceMarcador(id, nome) {
    var p = jogadorElenco(id, nome);
    var foto = p && p.foto;
    if (foto) {
      return '<span class="sel-scorer-face"><img src="' + esc(foto) + '" alt="" loading="lazy"></span>';
    }
    return '<span class="sel-scorer-face sel-face-ini" style="background:' + corAvatar(nome) + '" aria-hidden="true">' + esc(iniciais(nome)) + '</span>';
  }
  function previewMarcadorAttrs(id, nome) {
    var p = jogadorElenco(id, nome);
    if (!p || !p.foto) return "";
    var clube = clubeJogador(p, id);
    var linha1 = [nomeSelecao(id), p.pos, p.num ? ("#" + p.num) : "", clube].filter(Boolean).join(" • ");
    return previewAttrs(p.foto, nome || p.nome || "Goleador", linha1);
  }
  function golsLabel(n) {
    n = n || 0;
    return n === 1 ? "gol" : "gols";
  }
  function jogosLabelDeLista(jogos) {
    var n = Array.isArray(jogos) ? jogos.length : 0;
    if (!n) return "Copa 2026";
    return n === 1 ? "1 jogo" : n + " jogos";
  }
  function curiosidadesHTML(id, pa) {
    pa = pa || {};
    var facts = fact("Capital", pa.capital) +
      fact("População", pa.populacao) +
      fact("Língua", pa.lingua) +
      fact("Continente", pa.continente);
    return '<section class="sel-curios-section" aria-label="Curiosidades da seleção">' +
      '<div class="sel-section-title">Curiosidades</div>' +
      '<div class="sel-facts">' + facts + '</div>' +
      (pa.curiosidade ? '<div class="sel-curio"><b>Você sabia?</b> ' + esc(pa.curiosidade) + '</div>' : '') +
    '</section>';
  }
  function momentoTexto(id, campanha, stats, jogos) {
    if (!STATS_CARREGADAS && !jogos.length) return "Carregando desempenho da seleção…";
    if (campanha.aoVivo) return "Tem jogo ao vivo agora.";
    if (campanha.jogos && campanha.d === 0 && campanha.e === 0) return "100% de aproveitamento até aqui.";
    if (campanha.jogos && campanha.d === 0) return "Invicta até aqui.";
    if (jogos.some(function (j) { return j.state === "pre"; })) return "Próximo jogo definido.";
    if ((stats.por && stats.por.gols) || campanha.jogos) return "Dados consolidados com o que já está disponível.";
    return "Aguardando dados oficiais da seleção.";
  }
  function desempenhoHTML(id) {
    var stats = statsSelecao(id), camp = campanhaSelecao(id), jogos = jogosDaSelecao(id);
    var golsMarcados = camp.jogos ? camp.gm : (stats.por.gols || 0);
    var golsSofridos = camp.jogos ? camp.gs : null;
    var jogosDisputados = camp.jogos || stats.por.jogos || 0;
    var media = jogosDisputados ? (golsMarcados / jogosDisputados) : 0;
    var topGol = stats.artilheiros[0], topAss = stats.assists[0];
    var amarelos = (stats.cartoes && stats.cartoes.amarelos) || 0;
    var vermelhos = (stats.cartoes && stats.cartoes.vermelhos) || 0;
    var penNota = [];
    if (camp.vPen) penNota.push(camp.vPen + (camp.vPen === 1 ? " vitória nos pênaltis" : " vitórias nos pênaltis"));
    if (camp.dPen) penNota.push(camp.dPen + (camp.dPen === 1 ? " derrota nos pênaltis" : " derrotas nos pênaltis"));

    var html = '<section class="sel-performance" aria-label="Desempenho da seleção na Copa">' +
      '<div class="sel-perf-head"><div><b>Desempenho na Copa</b><span>' + esc(momentoTexto(id, camp, stats, jogos)) + '</span></div></div>' +
      '<div class="sel-perf-grid">' +
        '<div class="sel-perf-card destaque"><span>Campanha</span><b>' + fmtNum(camp.v) + 'V ' + fmtNum(camp.e) + 'E ' + fmtNum(camp.d) + 'D</b><small>' + fmtNum(jogosDisputados) + ' jogo' + (jogosDisputados === 1 ? "" : "s") + '</small></div>' +
        '<div class="sel-perf-card"><span>Gols</span><b>' + fmtNum(golsMarcados) + '</b><small>marcados</small></div>' +
        '<div class="sel-perf-card"><span>Sofridos</span><b>' + fmtNum(golsSofridos) + '</b><small>gols contra</small></div>' +
        '<div class="sel-perf-card"><span>Saldo</span><b>' + saldo(camp.jogos ? camp.saldo : null) + '</b><small>diferença</small></div>' +
        '<div class="sel-perf-card"><span>Média</span><b>' + (jogosDisputados ? media.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—") + '</b><small>gols/jogo</small></div>' +
        '<div class="sel-perf-card"><span>Cartões</span><b>' + fmtNum(amarelos) + '/' + fmtNum(vermelhos) + '</b><small>amarelos/vermelhos</small></div>' +
      '</div>' +
      (penNota.length ? '<div class="sel-perf-note">Obs.: campanha considera ' + esc(penNota.join(" e ")) + ' no mata-mata.</div>' : "") +
      '<div class="sel-leaders">' +
        '<div><span>⚽ Artilheiro</span><b>' + esc(topLabel(topGol, "gols", "gols")) + '</b></div>' +
        '<div><span>🎯 Assistências</span><b>' + esc(topLabel(topAss, "assistencias", "assist.")) + '</b></div>' +
      '</div>' +
    '</section>';
    return html;
  }

  function fmtRankingDecimal(v) {
    var n = Number(v);
    if (!isFinite(n)) return "—";
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  function rankingItemSelecao(id) {
    var lista = (RANKING_DESEMPENHO && RANKING_DESEMPENHO.ranking) || [];
    return lista.find(function (x) { return String(x.equipe || "").toUpperCase() === String(id || "").toUpperCase(); }) || null;
  }
  function rankingBar(label, valor) {
    var n = Number(valor);
    var pct = isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    return '<div class="sel-rank-line">' +
      '<div class="sel-rank-line-top"><span>' + esc(label) + '</span><b>' + esc(fmtRankingDecimal(valor)) + '</b></div>' +
      '<div class="sel-rank-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
    '</div>';
  }
  function rankingDesempenhoHTML(id) {
    if (!STATS_CARREGADAS) {
      return '<section class="sel-ranking-desempenho sel-ranking-loading" aria-label="Ranking de desempenho da seleção">' +
        '<div class="sel-rank-head"><div><b>Ranking de Desempenho</b><span>Carregando índice da seleção…</span></div></div>' +
      '</section>';
    }
    var r = rankingItemSelecao(id);
    if (!r) return "";
    var pos = r.posicao ? (r.posicao + "º") : "—";
    var situ = r.situacao || "";
    var jogos = r.jogos || r.jogos_com_estatisticas || 0;
    return '<section class="sel-ranking-desempenho" aria-label="Ranking de desempenho da seleção">' +
      '<div class="sel-rank-head">' +
        '<div><b>Ranking de Desempenho</b><span>Índice próprio do site · não oficial</span></div>' +
        '<div class="sel-rank-score"><strong>' + esc(fmtRankingDecimal(r.indice_final)) + '</strong><small>índice</small></div>' +
      '</div>' +
      '<div class="sel-rank-main">' +
        '<div class="sel-rank-pos"><span>' + esc(pos) + '</span><small>posição geral</small></div>' +
        '<div class="sel-rank-meta"><b>' + esc(r.nome || nomeSelecao(id)) + '</b><span>' + esc(id) + (jogos ? ' · ' + esc(jogos) + ' jogo' + (jogos === 1 ? '' : 's') : '') + '</span></div>' +
        (situ ? '<div class="sel-rank-situacao">' + esc(situ) + '</div>' : '') +
      '</div>' +
      '<div class="sel-rank-bars">' +
        rankingBar("Ataque", r.ataque) +
        rankingBar("Domínio", r.dominio) +
        rankingBar("Defesa", r.defesa) +
        rankingBar("Eficiência", r.eficiencia) +
        rankingBar("Disciplina", r.disciplina) +
      '</div>' +
      '<div class="sel-rank-mini">' +
        '<div><span>Posse</span><b>' + esc(fmtRankingDecimal(r.posse_media)) + '%</b></div>' +
        '<div><span>Fin./jogo</span><b>' + esc(fmtRankingDecimal(r.finalizacoes_jogo)) + '</b></div>' +
        '<div><span>Chutes gol</span><b>' + esc(fmtRankingDecimal(r.chutes_gol_jogo)) + '</b></div>' +
        '<div><span>Gols/jogo</span><b>' + esc(fmtRankingDecimal(r.gols_jogo)) + '</b></div>' +
      '</div>' +
    '</section>';
  }

  function marcadoresHTML(id) {
    var stats = statsSelecao(id), lista = stats.artilheiros || [], total = stats.por.gols || 0;
    var soma = lista.reduce(function (acc, x) { return acc + (x.gols || 0); }, 0);
    var resto = Math.max(0, total - soma);
    var subtitulo = total ? (total + " " + golsLabel(total) + " da seleção") : "dados do feed oficial";
    if (!STATS_CARREGADAS && !lista.length && !resto) {
      return '<section class="sel-scorers-section" aria-label="Goleadores">' +
        '<div class="sel-scorers-head"><div><b>Goleadores</b><span>Carregando gols da seleção…</span></div></div>' +
        '<div class="sel-vazio">Carregando marcadores…</div>' +
      '</section>';
    }
    if (!lista.length && !resto) {
      return '<section class="sel-scorers-section" aria-label="Goleadores">' +
        '<div class="sel-scorers-head"><div><b>Goleadores</b><span>Ainda sem gols registrados para esta seleção.</span></div></div>' +
      '</section>';
    }
    var linhas = lista.map(function (x, i) {
      var gols = x.gols || 0;
      var pPrevAttrs = previewMarcadorAttrs(id, x.nome || "");
      return '<article class="sel-scorer-card ' + (i === 0 ? 'lider ' : '') + (pPrevAttrs ? 'sel-previewable' : '') + '"' + pPrevAttrs + ' aria-label="Ampliar foto de ' + esc(x.nome || "goleador") + '">' +
        '<span class="sel-scorer-rank">' + (i + 1) + 'º</span>' +
        faceMarcador(id, x.nome || "") +
        '<div class="sel-scorer-info">' +
          '<strong>' + esc(x.nome || "—") + '</strong>' +
          '<span>' + flagEquipe(id) + '<em>' + esc(nomeSelecao(id)) + '</em><small>•</small><em>' + esc(jogosLabelDeLista(x.jogos)) + '</em></span>' +
        '</div>' +
        '<div class="sel-scorer-goals"><b>' + esc(gols) + '</b><small>' + esc(golsLabel(gols)) + '</small></div>' +
      '</article>';
    });
    if (resto) {
      linhas.push('<article class="sel-scorer-card extra">' +
        '<span class="sel-scorer-rank">+</span>' +
        '<span class="sel-scorer-face sel-scorer-flag">' + flagEquipe(id) + '</span>' +
        '<div class="sel-scorer-info"><strong>Gol contra a favor / não identificado</strong>' +
        '<span><em>Diferença entre gols da seleção e autores identificados no feed</em></span></div>' +
        '<div class="sel-scorer-goals"><b>' + esc(resto) + '</b><small>' + esc(golsLabel(resto)) + '</small></div>' +
      '</article>');
    }
    return '<section class="sel-scorers-section" aria-label="Goleadores">' +
      '<div class="sel-scorers-head"><div><b>Goleadores</b><span>' + esc(subtitulo) + '</span></div></div>' +
      '<div class="sel-scorers-list">' + linhas.join("") + '</div>' +
    '</section>';
  }
  function jogosHTML(id) {
    var jogos = jogosDaSelecao(id);
    if (!STATS_CARREGADAS && !jogos.length) {
      return '<section class="sel-matches"><div class="sel-section-title">Jogos da seleção</div><div class="sel-vazio">Carregando jogos da seleção…</div></section>';
    }
    if (!jogos.length) {
      return '<section class="sel-matches"><div class="sel-section-title">Jogos da seleção</div><div class="sel-vazio">Ainda não há jogos disponíveis para esta seleção.</div></section>';
    }
    return '<section class="sel-matches"><div class="sel-section-title">Jogos da seleção</div><div class="sel-match-list">' +
      jogos.map(function (j) { return jogoCard(j, id); }).join("") +
    '</div></section>';
  }

  function abreFicha(id) {
    var s = SEL.find(function (x) { return x.id === id; });
    if (!s) return;
    ID_ATUAL = id;
    marcaPaisAtivo(id);
    var pa = PAISES[id] || {};
    var trofeus = pa.copas ? '<div class="sel-det-copas"><span class="sel-det-trofeus" title="Títulos mundiais">' +
      "🏆".repeat(Math.min(pa.copas, 5)) + " <small>" + pa.copas + (pa.copas > 1 ? " títulos mundiais" : " título mundial") + "</small></span></div>" : "";
    var html =
      '<button class="sel-voltar" type="button">‹ Todas as seleções</button>' +
      '<div class="sel-det-head">' +
        '<img class="sel-det-flag" src="' + flagUrl(s.iso2, 160) + '" alt="Bandeira: ' + esc(s.nome) + '" width="72" height="48">' +
        '<div class="sel-det-id"><div class="sel-det-nome">' + esc(s.nome) + "</div>" +
          (pa.apelido ? '<div class="sel-det-apelido">"' + esc(pa.apelido) + '"</div>' : "") + "</div>" +
        '<div class="sel-det-grupo sel-det-ranking">' + esc(rankingLabel(s)) + "</div>" +
      "</div>" +
      trofeus +
      curiosidadesHTML(id, pa) +
      marcadoresHTML(id) +
      squadHTML(id) +
      desempenhoHTML(id) +
      rankingDesempenhoHTML(id) +
      jogosHTML(id);
    var det = $("#sel-detalhe");
    det.innerHTML = html; det.hidden = false;
    $("#sel-scroller").hidden = true; $("#sel-hint").hidden = true;
    if (window.COPA_JOGO_STATS && COPA_JOGO_STATS.bind) COPA_JOGO_STATS.bind(det);
    if (window.history && history.replaceState) { try { history.replaceState(null, "", "#" + id); } catch (e) {} }
    window.scrollTo(0, 0);
  }

  function reabreFichaAtual() {
    if (!ID_ATUAL) return;
    var det = $("#sel-detalhe");
    if (det && !det.hidden) abreFicha(ID_ATUAL);
  }

  function voltar() {
    ID_ATUAL = "";
    var det = $("#sel-detalhe"); det.hidden = true; det.innerHTML = "";
    marcaPaisAtivo("");
    $("#sel-scroller").hidden = false; $("#sel-hint").hidden = false;
    if (window.history && history.replaceState) { try { history.replaceState(null, "", location.pathname); } catch (e) {} }
  }

  function ligar() {
    $("#sel-scroller").addEventListener("click", function (e) {
      var b = e.target.closest(".sel-card"); if (b) abreFicha(b.getAttribute("data-id"));
    });
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-creditos]")) { e.preventDefault(); mostrarCreditos(); }
    });
    var menu = $("#sel-menu-paises");
    if (menu) {
      menu.addEventListener("change", function () {
        if (menu.value) abreFicha(menu.value);
      });
    }
    $("#sel-detalhe").addEventListener("click", function (e) {
      if (e.target.closest(".sel-voltar")) voltar();
    });
    window.addEventListener("hashchange", function () {
      var h = (location.hash || "").replace("#", "").toUpperCase();
      if (h && SEL.find(function (x) { return x.id === h; })) abreFicha(h); else voltar();
    });
  }

  var CRED_CARREGADO = false;
  function mostrarCreditos() {
    var box = document.getElementById("sel-creditos");
    if (!box) return;
    if (box.hidden) { box.hidden = false; } else { box.hidden = true; return; }
    if (CRED_CARREGADO) return;
    CRED_CARREGADO = true;
    box.innerHTML = '<div class="sel-cred-tit">Créditos das imagens</div><div class="sel-cred-load">Carregando…</div>';
    getJSON("dados/rostos_creditos.json").then(function (cj) {
      var itens = ((cj && cj.creditos) || []).slice();
      var extras = (CORRECOES_JOGADORES && CORRECOES_JOGADORES.creditos) || [];
      extras.forEach(function (x) {
        var existe = itens.some(function (i) {
          return norm(i.nome) === norm(x.nome) && String(i.selecao || "").toUpperCase() === String(x.selecao || "").toUpperCase();
        });
        if (!existe) itens.push(x);
      });
      var html = '<div class="sel-cred-tit">Créditos das imagens</div>';
      html += '<p class="sel-cred-intro">Fotos: ESPN, Wikipedia e Wikimedia Commons quando disponíveis; quando não há fonte segura, exibimos um avatar com as iniciais.</p>';
      if (itens.length) {
        html += '<ul class="sel-cred-lista">' + itens.map(function (c) {
          var aut = c.autor ? esc(c.autor) : (c.fonte || "");
          var lic = c.licenca ? " — " + esc(c.licenca) : "";
          return "<li><b>" + esc(c.nome || "") + "</b> (" + esc(c.selecao || "") + "): " + aut + lic + "</li>";
        }).join("") + "</ul>";
      } else {
        html += '<p class="sel-cred-intro">Ainda não há imagens licenciadas registradas (o robô preenche ao rodar).</p>';
      }
      box.innerHTML = html;
    });
  }

  function getJSON(u) {
    return fetch(u).then(function (r) { if (!r.ok) throw 0; return r.json(); }).catch(function () { return null; });
  }
  function getJSONTimeout(u, ms) {
    var done = false;
    return new Promise(function (resolve) {
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms || 8000);
      fetch(u).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
        if (!done) { done = true; clearTimeout(t); resolve(j); }
      }).catch(function () {
        if (!done) { done = true; clearTimeout(t); resolve(null); }
      });
    });
  }
  function carregarDesempenho() {
    var dadosReq = getJSON("dados/estatisticas.json?v=" + Date.now()).then(function (j) {
      DADOS = j || { artilheiros: [], assistencias: [], cartoes: [], por_selecao: [] };
    });
    var rankingReq = getJSON("dados/ranking-desempenho.json?v=" + Date.now()).then(function (j) {
      RANKING_DESEMPENHO = j || { ranking: [] };
    });
    var jogosReq = getJSONTimeout(API_SCOREBOARD + "&_=" + Date.now(), 8000).then(function (j) {
      JOGOS = j && j.events ? j.events.map(normalizarJogo) : [];
    });
    return Promise.all([dadosReq, rankingReq, jogosReq]).then(function () {
      STATS_CARREGADAS = true;
      reabreFichaAtual();
    }).catch(function () {
      STATS_CARREGADAS = true;
      reabreFichaAtual();
    });
  }

  Promise.all([getJSON("dados/selecoes.json"), getJSON("dados/paises.json"), getJSON("dados/elencos.json"), getJSON("dados/correcoes-jogadores.json?v=20260704clubes-bra-v1")])
    .then(function (res) {
      var sj = res[0] || {}, pj = res[1] || {}, ej = res[2] || {}, cj = res[3] || {};
      SEL = ((sj.selecoes) || []).map(function (s) { return { id: s.id, nome: s.nome, grupo: s.grupo, seed: s.seed, iso2: s.iso2 }; });
      SEL.sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome), "pt-BR"); });
      PAISES = (pj.paises) || {};
      ELENCOS = ej || {};
      aplicarCorrecoesJogadores(cj);
      if (!SEL.length) { $("#sel-scroller").innerHTML = '<div class="sel-vazio">Não foi possível carregar as seleções.</div>'; return; }
      renderMenuPaises(); ligar(); renderLista();
      var h = (location.hash || "").replace("#", "").toUpperCase();
      if (h && SEL.find(function (x) { return x.id === h; })) abreFicha(h);
      try { if (window.COPA_TIMES && COPA_TIMES.carregar) window.COPA_TIMES.carregar().then(carregarDesempenho); else carregarDesempenho(); }
      catch (e) { carregarDesempenho(); }
    });
})();
