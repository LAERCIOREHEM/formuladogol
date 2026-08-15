(function (window, document) {
  "use strict";

  var DATA_URL = "dados-br/acuracia-af-previsao.json";
  var MIN_BIN = 5;        // amostra mínima para o bin valer leitura
  var MOBILE_MAX = 560;   // abaixo disso, SVG vira lista
  var state = { data: null, club: "", metric: "posicao" };

  function el(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>'"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c];
    });
  }
  function number(v, d) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("pt-BR", { minimumFractionDigits: d || 0, maximumFractionDigits: d == null ? 1 : d });
  }
  function pct(v, d) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return number(n, d == null ? 1 : d) + "%";
  }
  function dateLabel(v) {
    if (!v) return "";
    var d = new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }
  function shortHash(v) { return v ? String(v).slice(0, 10) : ""; }
  function isMobile() { return window.innerWidth <= MOBILE_MAX; }

  function createSvg(w, h) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 " + w + " " + h);
    s.setAttribute("preserveAspectRatio", "xMidYMid meet");
    return s;
  }
  function svgNode(name, attrs, text) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function straightPath(points) {
    return points.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2); }).join(" ");
  }
  function smoothLinePath(points) {
    if (!points.length) return "";
    if (points.length === 1) return "M" + points[0][0].toFixed(2) + " " + points[0][1].toFixed(2);
    var d = "M" + points[0][0].toFixed(2) + " " + points[0][1].toFixed(2);
    for (var i = 0; i < points.length - 1; i += 1) {
      var a = points[i], b = points[i + 1];
      d += " Q" + a[0].toFixed(2) + " " + a[1].toFixed(2) + " " + ((a[0] + b[0]) / 2).toFixed(2) + " " + ((a[1] + b[1]) / 2).toFixed(2);
    }
    var last = points[points.length - 1];
    return d + " T" + last[0].toFixed(2) + " " + last[1].toFixed(2);
  }
  function bandPath(upper, lower) {
    if (!upper.length || upper.length !== lower.length) return "";
    var top = upper.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2); }).join(" ");
    var bottom = lower.slice().reverse().map(function (p) { return "L" + p[0].toFixed(2) + " " + p[1].toFixed(2); }).join(" ");
    return top + " " + bottom + " Z";
  }
  function chartEmpty(target, message) {
    target.innerHTML = '<div class="empty-state" style="margin:12px">' + esc(message) + "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* Tooltip: fica dentro do quadro nos dois eixos e vira para baixo     */
  /* quando o ponto está no topo. O container não pode ter overflow      */
  /* hidden — é o que cortava a caixa antes.                             */
  /* ------------------------------------------------------------------ */
  function tipNode(target) {
    var n = target.querySelector(".af-tip");
    if (!n) { n = document.createElement("div"); n.className = "af-tip"; target.appendChild(n); }
    return n;
  }
  function bindTip(target, node, html) {
    function show(event) {
      event.stopPropagation();
      var box = tipNode(target), rect = target.getBoundingClientRect();
      var pt = event.touches && event.touches[0] ? event.touches[0] : event;
      box.innerHTML = html;
      box.classList.add("is-on");
      var bw = box.offsetWidth, bh = box.offsetHeight;
      var x = pt.clientX - rect.left, y = pt.clientY - rect.top;
      var below = y - bh - 14 < 0;
      box.classList.toggle("is-below", below);
      var left = Math.min(Math.max(x, bw / 2 + 6), rect.width - bw / 2 - 6);
      var topPos = below ? y + 16 : y - 14;
      topPos = Math.min(topPos, rect.height - (below ? bh + 6 : 6));
      box.style.left = left + "px";
      box.style.top = Math.max(topPos, below ? 6 : bh + 6) + "px";
    }
    node.addEventListener("mouseenter", show);
    node.addEventListener("mousemove", show);
    node.addEventListener("touchstart", show, { passive: true });
    node.addEventListener("mouseleave", function () { tipNode(target).classList.remove("is-on"); });
  }
  function closeTips() {
    Array.prototype.forEach.call(document.querySelectorAll(".af-tip"), function (n) { n.classList.remove("is-on"); });
  }
  document.addEventListener("click", closeTips);
  document.addEventListener("touchstart", closeTips, { passive: true });

  /* ------------------------------------------------------------------ */
  /* Chips: mesmo componente já usado na linha "Jogos: 22 · Posição..."  */
  /* ------------------------------------------------------------------ */
  function renderGameChips() {
    var games = (state.data || {}).jogos || {};
    var fav = games.maior_probabilidade || {};
    var tech = games.metricas_tecnicas || {};
    var badge = el("accuracy-games-badge");
    if (badge) badge.textContent = games.jogos_avaliados ? number(games.jogos_avaliados, 0) + " jogos avaliados" : "Coleta iniciada";
    var chips = el("accuracy-games-chips");
    if (!chips) return;
    chips.innerHTML = [
      ["Jogos avaliados", number(games.jogos_avaliados, 0)],
      ["Favorito venceu", number(fav.confirmadas, 0) + " de " + number(fav.amostra, 0)],
      ["Brier", number(tech.brier_multiclasse_medio, 3)],
      ["Log Loss", number(tech.log_loss_medio, 3)]
    ].map(function (i) { return "<span>" + esc(i[0]) + ": <b>" + esc(i[1]) + "</b></span>"; }).join("");
  }

  /* Escopo da apuração: quando começou, quanto já foi apurado e até quando vai.
     Sem isso o leitor não sabe se 10 jogos é o total ou o começo. */
  var RODADAS_TOTAL = 38;
  var JOGOS_POR_RODADA = 10;

  function renderScope() {
    var target = el("accuracy-scope");
    if (!target) return;
    var games = (state.data || {}).jogos || {};
    var scope = (state.data || {}).escopo_publico || {};
    var rounds = games.por_rodada || [];
    var firstRound = rounds.length ? Number(rounds[0].rodada) : null;
    var avaliados = Number(games.jogos_avaliados) || 0;
    var previsoes = (games.calibracao || []).reduce(function (acc, b) { return acc + (Number(b.amostra) || 0); }, 0);
    var previstos = firstRound ? (RODADAS_TOTAL - firstRound + 1) * JOGOS_POR_RODADA : null;
    var progresso = previstos ? Math.min(100, avaliados / previstos * 100) : 0;

    target.innerHTML =
      '<div class="af-scope">' +
        '<div class="af-scope-line">' +
          '<div><span>Início da apuração</span><b>' +
            (firstRound ? "Rodada " + firstRound : "—") + "</b><small>" +
            (dateLabel(scope.inicio_historico_jogos) || "—") + "</small></div>" +
          '<div><span>Apurado até agora</span><b>' + number(avaliados, 0) + " jogos</b><small>" +
            number(previsoes, 0) + " previsões (3 por jogo)</small></div>" +
          '<div><span>Fim da apuração</span><b>Rodada ' + RODADAS_TOTAL + "</b><small>encerramento do Brasileirão</small></div>" +
        "</div>" +
        '<div class="af-scope-bar"><i style="width:' + progresso.toFixed(1) + '%"></i></div>' +
        '<div class="af-scope-foot"><span>' + number(avaliados, 0) + " de " +
          (previstos ? number(previstos, 0) : "—") + " jogos previstos para esta apuração</span><b>" +
          number(progresso, 1) + "%</b></div>" +
      "</div>";
  }

  function renderSeal() {
    var integ = (state.data || {}).integridade || {};
    var seal = el("accuracy-seal-body");
    if (!seal) return;
    seal.innerHTML =
      '<div class="af-seal-grid">' +
        '<div><span>Registros de previsão pré-jogo</span><b>' + number(integ.historico_pre_jogo_total, 0) + "</b><em>cada partida é registrada novamente a cada atualização até ser disputada</em></div>" +
        '<div><span>Snapshots da temporada</span><b>' + number(integ.snapshots_temporada, 0) + "</b></div>" +
        '<div><span>Último elo da cadeia</span><b><code>' + esc(shortHash(integ.hash_pre_jogo)) + "…</code></b></div>" +
      "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* Calibração em barras comparadas — HTML, não SVG.                   */
  /* Duas barras lado a lado é a comparação mais fácil de ler que        */
  /* existe, e resolve o mobile por construção.                          */
  /* ------------------------------------------------------------------ */
  function renderCalibration() {
    var target = el("accuracy-calibration");
    var bins = ((state.data.jogos || {}).calibracao || []).filter(function (r) { return Number(r.amostra) > 0; });
    if (!bins.length) {
      chartEmpty(target, "A calibração aparecerá automaticamente assim que houver partidas com previsão pré-jogo registrada e resultado final.");
      el("accuracy-calibration-note").textContent = "Nenhuma previsão passada é reconstruída: a série começa apenas com probabilidades realmente registradas antes do jogo.";
      renderTechnical();
      return;
    }

    var rows = bins.map(function (row) {
      var n = Number(row.amostra);
      var said = Number(row.probabilidade_media_pct);
      var happened = Number(row.frequencia_observada_pct);
      var weak = n < MIN_BIN;
      var gap = Math.abs(said - happened);
      return '<article class="af-bin' + (weak ? " af-bin-weak" : "") + '">' +
        '<header><b>' + row.faixa_pct[0] + "–" + row.faixa_pct[1] + "%</b>" +
          '<span class="af-bin-n">' + number(n, 0) + (n === 1 ? " previsão" : " previsões") +
          (weak ? ' · <i>amostra pequena</i>' : "") + "</span></header>" +
        '<div class="af-bin-bars">' +
          '<div class="af-bin-row"><span>modelo disse</span>' +
            '<div class="af-track"><i class="af-said" style="width:' + said.toFixed(1) + '%"></i></div>' +
            "<b>" + pct(said, 1) + "</b></div>" +
          '<div class="af-bin-row"><span>aconteceu</span>' +
            '<div class="af-track"><i class="af-happened" style="width:' + happened.toFixed(1) + '%"></i></div>' +
            "<b>" + pct(happened, 1) + "</b></div>" +
        "</div>" +
        (weak ? "" : '<footer class="af-bin-gap">diferença de ' + number(gap, 1) + " pontos percentuais</footer>") +
        "</article>";
    }).join("");

    target.innerHTML = '<div class="af-bins">' + rows + "</div>";

    var strong = bins.filter(function (r) { return Number(r.amostra) >= MIN_BIN; });
    var weakCount = bins.length - strong.length;
    el("accuracy-calibration-note").innerHTML =
      '<span class="accuracy-legend">' +
        '<span><i class="said"></i>probabilidade que o modelo indicou</span>' +
        '<span><i></i>frequência com que aconteceu</span>' +
        (weakCount ? '<span><i class="weak"></i>faixa com menos de ' + MIN_BIN + " previsões</span>" : "") +
      "</span>";
    renderTechnical();
  }

  function renderTechnical() {
    var t = ((state.data.jogos || {}).metricas_tecnicas || {});
    var scope = (state.data || {}).escopo_publico || {};
    el("accuracy-technical").innerHTML = '<div class="accuracy-technical-grid">' +
      "<div><strong>Brier multiclasse médio</strong><br>" + esc(number(t.brier_multiclasse_medio, 4)) + "<br><small>Mede acerto e honestidade da probabilidade ao mesmo tempo. Quanto menor, melhor.</small></div>" +
      "<div><strong>Log Loss médio</strong><br>" + esc(number(t.log_loss_medio, 4)) + "<br><small>Penaliza previsão confiante que não se confirma.</small></div>" +
      "<div><strong>Início do histórico de jogos</strong><br>" + esc(dateLabel(scope.inicio_historico_jogos) || "—") + "<br><small>" + esc(scope.observacao || "") + "</small></div>" +
      "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* Evolução por clube                                                  */
  /* ------------------------------------------------------------------ */
  function clubRows() { return (((state.data || {}).timeline_clubes || {})[state.club] || []); }

  function setClubOptions() {
    var clubs = Object.keys((state.data || {}).timeline_clubes || {}).sort(function (a, b) { return a.localeCompare(b, "pt-BR"); });
    var select = el("accuracy-club-select");
    select.innerHTML = clubs.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + "</option>"; }).join("");
    state.club = clubs[0] || "";
    select.value = state.club;
    select.addEventListener("change", function () { state.club = select.value; renderTimeline(); });
  }

  function renderCurrent(rows) {
    var cur = rows[rows.length - 1];
    if (!cur) { el("accuracy-timeline-current").innerHTML = ""; return; }
    var p = cur.faixa_posicao_80 || {}, pt = cur.faixa_pontos_80 || {};
    el("accuracy-timeline-current").innerHTML = [
      ["Jogos", cur.jogos_atuais],
      ["Posição atual", cur.posicao_atual ? cur.posicao_atual + "º" : "—"],
      ["Projetada", cur.posicao_projetada ? cur.posicao_projetada + "º" : "—"],
      ["Faixa 80%", p.melhor && p.pior ? p.melhor + "º–" + p.pior + "º" : "—"],
      ["Pontos projetados", cur.pontos_projetados == null ? "—" : cur.pontos_projetados],
      ["Faixa pontos 80%", pt.min != null && pt.max != null ? pt.min + "–" + pt.max : "—"]
    ].map(function (i) { return "<span>" + esc(i[0]) + ": <b>" + esc(i[1]) + "</b></span>"; }).join("");
  }

  function bounds(values, fbMin, fbMax, minSpan) {
    var f = values.map(Number).filter(Number.isFinite);
    if (!f.length) return [fbMin, fbMax];
    var min = Math.min.apply(null, f), max = Math.max.apply(null, f), span = max - min;
    if (minSpan && span < minSpan) { var g = (minSpan - span) / 2; min -= g; max += g; }
    var pad = Math.max(0.6, (max - min) * 0.12);
    return [min - pad, max + pad];
  }

  function timelineBase(rows, yMin, yMax, invertY, yFmt) {
    // margem direita maior: os rótulos das séries ficam na ponta da linha,
    // o que dispensa legenda embaixo do gráfico.
    var width = 880, height = 350, left = 58, right = 128, top = 26, bottom = 52;
    var w = width - left - right, h = height - top - bottom;
    function x(i) { return rows.length <= 1 ? left + w / 2 : left + w * i / (rows.length - 1); }
    function y(v) {
      var r = (Number(v) - yMin) / (yMax - yMin || 1);
      if (invertY) r = 1 - r;
      return top + h - h * r;
    }
    var svg = createSvg(width, height);
    for (var i = 0; i <= 4; i += 1) {
      var value = yMin + (yMax - yMin) * i / 4, yy = y(value);
      svg.appendChild(svgNode("line", { x1: left, y1: yy, x2: left + w, y2: yy, class: "grid" }));
      svg.appendChild(svgNode("text", { x: left - 10, y: yy + 4, "text-anchor": "end" }, yFmt(value)));
    }
    svg.appendChild(svgNode("line", { x1: left, y1: height - bottom, x2: left + w, y2: height - bottom, class: "axis" }));
    svg.appendChild(svgNode("line", { x1: left, y1: top, x2: left, y2: height - bottom, class: "axis" }));

    var idx = [];
    if (rows.length <= 6) { for (var j = 0; j < rows.length; j += 1) idx.push(j); }
    else { idx = [0, Math.round((rows.length - 1) / 3), Math.round(2 * (rows.length - 1) / 3), rows.length - 1]; }
    var used = {}, seen = {};
    idx.forEach(function (i2) {
      if (used[i2]) return; used[i2] = 1;
      var row = rows[i2];
      var label = row.rodada_referencia != null ? "R" + row.rodada_referencia : number(row.jogos_atuais, 0) + " jogos";
      if (seen[label]) label = dateLabel(row.gerado_em) || label;
      seen[label] = 1;
      svg.appendChild(svgNode("text", { x: x(i2), y: height - bottom + 21, "text-anchor": "middle" }, label));
    });
    return { svg: svg, width: width, height: height, left: left, right: right, top: top, bottom: bottom, w: w, h: h, x: x, y: y };
  }

  function addBand(svg, base, rows, lowAcc, highAcc) {
    var upper = [], lower = [];
    rows.forEach(function (row, i) {
      var lo = lowAcc(row), hi = highAcc(row);
      if (lo == null || hi == null) return;
      var a = Number(lo), b = Number(hi);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      upper.push([base.x(i), base.y(b)]);
      lower.push([base.x(i), base.y(a)]);
    });
    if (upper.length < 2) return;
    // Preenchimento chapado e discreto. O gradiente e as bordas tracejadas
    // roubavam a atenção das linhas, que são a informação principal.
    svg.appendChild(svgNode("path", { d: bandPath(upper, lower), class: "area-80" }));
  }

  function addSeries(target, svg, base, rows, acc, lineClass, dotClass, label, digits, suffix, endLabel, labelClass) {
    // base.height / base.bottom usados no posicionamento do rótulo
    var points = [];
    rows.forEach(function (row, i) {
      var raw = acc(row);
      if (raw == null || raw === "") return;
      var v = Number(raw);
      if (Number.isFinite(v)) points.push([base.x(i), base.y(v), row, v]);
    });
    if (!points.length) return;
    if (points.length > 1) {
      svg.appendChild(svgNode("path", { d: smoothLinePath(points.map(function (p) { return [p[0], p[1]]; })), class: lineClass }));
    }
    points.forEach(function (p) {
      var c = svgNode("circle", { cx: p[0], cy: p[1], r: 4.2, class: dotClass });
      bindTip(target, c,
        "<b>" + esc(label) + ": " + number(p[3], digits == null ? 1 : digits) + (suffix || "") + "</b><br>" +
        "Após " + number(p[2].jogos_atuais, 0) + " jogos · " + dateLabel(p[2].gerado_em) +
        (p[2].hash_previsao_clube ? '<br><span class="af-tip-hash">🔒 ' + esc(shortHash(p[2].hash_previsao_clube)) + "…</span>" : ""));
      svg.appendChild(c);
    });
    // Rótulo na ponta da linha, no lugar da legenda. Quando duas séries
    // terminam no mesmo valor os rótulos se sobrepõem, então empilha.
    var last = points[points.length - 1];
    var used = svg.__labelYs || (svg.__labelYs = []);
    var ly = last[1] + 4;
    for (var guard = 0; guard < 12; guard += 1) {
      var clash = used.some(function (v) { return Math.abs(v - ly) < 15; });
      if (!clash) break;
      ly += 15;
    }
    if (ly > base.height - base.bottom) ly = last[1] + 4 - 15 * used.length;
    used.push(ly);
    svg.appendChild(svgNode("text", { x: last[0] + 12, y: ly, class: "series-label " + labelClass }, endLabel));
    if (Math.abs(ly - (last[1] + 4)) > 1) {
      svg.appendChild(svgNode("line", {
        x1: last[0] + 5, y1: last[1], x2: last[0] + 9, y2: ly - 4, class: "label-leader " + labelClass
      }));
    }
  }

  function mobileTable(rows, columns) {
    var slice = rows.slice(-8);
    return '<div class="af-mtable"><table><thead><tr><th>Rodada</th>' +
      columns.map(function (c) { return "<th>" + esc(c[0]) + "</th>"; }).join("") +
      "</tr></thead><tbody>" +
      slice.map(function (row) {
        return "<tr><td>" + (row.rodada_referencia != null ? "R" + row.rodada_referencia : number(row.jogos_atuais, 0) + "J") + "</td>" +
          columns.map(function (c) { return "<td>" + esc(c[1](row)) + "</td>"; }).join("") + "</tr>";
      }).join("") +
      "</tbody></table></div>";
  }

  function renderPosition(rows, target) {
    if (isMobile()) {
      target.innerHTML = mobileTable(rows, [
        ["Projetada", function (r) { return r.posicao_projetada != null ? r.posicao_projetada + "º" : "—"; }],
        ["Real", function (r) { return r.posicao_atual != null ? r.posicao_atual + "º" : "—"; }]
      ]);
      el("accuracy-timeline-legend").innerHTML = "";
      return;
    }
    var values = [];
    rows.forEach(function (r) {
      var f = r.faixa_posicao_80 || {};
      values.push(r.posicao_atual, r.posicao_projetada, f.melhor, f.pior);
    });
    var b = bounds(values, 1, 20, 6);
    var yMin = Math.max(1, Math.floor(b[0])), yMax = Math.min(20, Math.ceil(b[1]));
    var base = timelineBase(rows, yMin, yMax, true, function (v) { return Math.round(v) + "º"; }), svg = base.svg;
    addBand(svg, base, rows, function (r) { return (r.faixa_posicao_80 || {}).pior; }, function (r) { return (r.faixa_posicao_80 || {}).melhor; });
    addSeries(target, svg, base, rows, function (r) { return r.posicao_atual; }, "line-secondary", "dot-secondary", "Posição real", 0, "º", "posição real", "lbl-secondary");
    addSeries(target, svg, base, rows, function (r) { return r.posicao_projetada; }, "line-main", "dot-main", "Posição projetada", 0, "º", "nossa projeção", "lbl-main");
    target.appendChild(svg);
    el("accuracy-timeline-legend").innerHTML = '<span><i class="area"></i>faixa central de 80% da projeção</span>';
  }

  function renderPoints(rows, target) {
    if (isMobile()) {
      target.innerHTML = mobileTable(rows, [
        ["Projetados", function (r) { return r.pontos_projetados != null ? number(r.pontos_projetados, 0) : "—"; }],
        ["Atuais", function (r) { return r.pontos_atuais != null ? number(r.pontos_atuais, 0) : "—"; }]
      ]);
      el("accuracy-timeline-legend").innerHTML = "";
      return;
    }
    var values = [];
    rows.forEach(function (r) { var f = r.faixa_pontos_80 || {}; values.push(r.pontos_atuais, r.pontos_projetados, f.min, f.max); });
    var b = bounds(values, 0, 114, 12);
    var base = timelineBase(rows, Math.max(0, b[0]), Math.min(114, b[1]), false, function (v) { return String(Math.round(v)); }), svg = base.svg;
    addBand(svg, base, rows, function (r) { return (r.faixa_pontos_80 || {}).min; }, function (r) { return (r.faixa_pontos_80 || {}).max; });
    addSeries(target, svg, base, rows, function (r) { return r.pontos_atuais; }, "line-secondary", "dot-secondary", "Pontos acumulados", 0, "", "pontos hoje", "lbl-secondary");
    addSeries(target, svg, base, rows, function (r) { return r.pontos_projetados; }, "line-main", "dot-main", "Pontos finais projetados", 0, "", "nossa projeção", "lbl-main");
    target.appendChild(svg);
    el("accuracy-timeline-legend").innerHTML = '<span><i class="area"></i>faixa central de 80% da projeção</span>';
  }

  function renderProbabilities(rows, target) {
    if (isMobile()) {
      target.innerHTML = mobileTable(rows, [
        ["Título", function (r) { return pct((r.probabilidades_pct || {}).campeao, 1); }],
        ["Liberta", function (r) { return pct((r.probabilidades_pct || {}).libertadores, 1); }],
        ["Sula", function (r) { return pct((r.probabilidades_pct || {}).sul_americana, 1); }]
      ]);
      el("accuracy-timeline-legend").innerHTML = "";
      return;
    }
    var values = [];
    rows.forEach(function (r) { var p = r.probabilidades_pct || {}; values.push(p.campeao, p.libertadores, p.sul_americana); });
    var b = bounds(values, 0, 100, 25);
    var base = timelineBase(rows, Math.max(0, b[0]), Math.min(100, b[1]), false, function (v) { return Math.round(v) + "%"; }), svg = base.svg;
    addSeries(target, svg, base, rows, function (r) { return (r.probabilidades_pct || {}).sul_americana; }, "line-secondary", "dot-secondary", "Sul-Americana", 1, "%", "Sul-Americana", "lbl-secondary");
    addSeries(target, svg, base, rows, function (r) { return (r.probabilidades_pct || {}).campeao; }, "line-gold", "dot-gold", "Campeão", 1, "%", "título", "lbl-gold");
    addSeries(target, svg, base, rows, function (r) { return (r.probabilidades_pct || {}).libertadores; }, "line-main", "dot-main", "Libertadores", 1, "%", "Libertadores", "lbl-main");
    target.appendChild(svg);
    el("accuracy-timeline-legend").innerHTML = "";
  }

  function renderTimeline() {
    var target = el("accuracy-timeline"), rows = clubRows();
    target.innerHTML = "";
    renderCurrent(rows);
    if (!rows.length) { chartEmpty(target, "Ainda não há histórico auditável para este clube."); el("accuracy-timeline-legend").innerHTML = ""; return; }
    if (state.metric === "pontos") renderPoints(rows, target);
    else if (state.metric === "probabilidades") renderProbabilities(rows, target);
    else renderPosition(rows, target);
  }

  function wireTabs() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-accuracy-metric]"), function (button) {
      button.addEventListener("click", function () {
        state.metric = button.getAttribute("data-accuracy-metric") || "posicao";
        Array.prototype.forEach.call(document.querySelectorAll("[data-accuracy-metric]"), function (other) {
          var active = other === button;
          other.classList.toggle("active", active);
          other.setAttribute("aria-selected", active ? "true" : "false");
        });
        renderTimeline();
      });
    });
  }

  function milestoneHtml(rows) {
    if (!rows || !rows.length) return "";
    return '<div class="accuracy-milestones">' + rows.slice(-6).map(function (row) {
      return '<div class="accuracy-milestone"><span>Após ' + number(row.apos_jogos, 0) + " jogos</span>" +
        '<div class="accuracy-milestone-track"><i style="width:' + Math.max(0, Math.min(100, Number(row.cobertura_pct) || 0)) + '%"></i></div>' +
        "<b>" + pct(row.cobertura_pct, 1) + "</b></div>";
    }).join("") + "</div>";
  }

  function renderRange() {
    var range = (((state.data.classificacao || {}).faixa_80) || {}), target = el("accuracy-range-cards"), history = el("accuracy-range-history");
    if (range.status !== "concluido") {
      target.innerHTML = '<div class="accuracy-waiting" style="grid-column:1/-1"><strong>Em acompanhamento.</strong><br>A posição e a pontuação finais ainda não existem; o painel preserva as faixas publicadas agora e fará a aferição automaticamente no encerramento do Brasileirão.</div>';
      history.innerHTML = ""; return;
    }
    var position = (range.posicao || {}).destaque || {}, points = (range.pontos || {}).destaque || {};
    target.innerHTML = '<article class="accuracy-range-card"><span>Posição final dentro da faixa</span><strong>' + pct(position.cobertura_pct, 1) + "</strong><small>Referência: após " + number(position.apos_jogos, 0) + " jogos · amostra " + number(position.amostra, 0) + " clubes</small></article>" +
      '<article class="accuracy-range-card"><span>Pontuação final dentro da faixa</span><strong>' + pct(points.cobertura_pct, 1) + "</strong><small>Referência: após " + number(points.apos_jogos, 0) + " jogos · amostra " + number(points.amostra, 0) + " clubes</small></article>";
    history.innerHTML = '<div class="accuracy-note"><strong>Evolução da cobertura por estágio</strong></div>' + milestoneHtml((range.posicao || {}).marcos || []);
  }

  function eventLabel(k) { return { campeao: "Campeão", libertadores: "Libertadores", sul_americana: "Sul-Americana" }[k] || k; }

  function renderSeasonEvents() {
    var section = state.data.eventos_temporada || {}, target = el("accuracy-season-events");
    if (section.status !== "concluido") {
      target.innerHTML = '<div class="accuracy-waiting" style="grid-column:1/-1"><strong>Em acompanhamento.</strong><br>' + esc(section.mensagem || "Os desfechos ainda não estão definidos.") + "</div>";
      return;
    }
    var events = section.eventos || {};
    target.innerHTML = ["campeao", "libertadores", "sul_americana"].map(function (key) {
      var high = (events[key] || {}).alta_confianca_80 || {};
      return '<article class="accuracy-event-card"><span>' + esc(eventLabel(key)) + " · confiança ≥80%</span><strong>" + pct(high.taxa_confirmacao_pct, 1) + "</strong><small>" +
        (high.amostra ? number(high.confirmadas, 0) + " confirmações em " + number(high.amostra, 0) + " previsões de alta confiança" : "Sem amostra ≥80%") + "</small></article>";
    }).join("");
  }

  function renderAll() {
    renderGameChips(); renderScope(); renderSeal(); renderCalibration();
    setClubOptions(); wireTabs(); renderTimeline(); renderRange(); renderSeasonEvents();
  }

  var resizeTimer = null, lastMobile = null;
  window.addEventListener("resize", function () {
    if (!state.data) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      var m = isMobile();
      if (m !== lastMobile) { lastMobile = m; renderTimeline(); }
    }, 180);
  });

  async function init() {
    try {
      var response = await fetch(DATA_URL + "?_=" + Date.now(), { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var data = await response.json();
      if (!data || data.status !== "ok") throw new Error("JSON de acurácia inválido");
      state.data = data;
      lastMobile = isMobile();
      renderAll();
    } catch (error) {
      el("accuracy-app").insertAdjacentHTML("afterbegin", '<div class="accuracy-error"><strong>Não foi possível carregar a acurácia agora.</strong><br>' + esc(error && error.message ? error.message : "Falha desconhecida") + "</div>");
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(window, document);
