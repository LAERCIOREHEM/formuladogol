(function (window, document) {
  "use strict";

  var DATA_URL = "dados-br/acuracia-af-previsao.json";
  var state = { data: null, club: "", metric: "posicao" };

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char];
    });
  }
  function number(value, digits) {
    var n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("pt-BR", { minimumFractionDigits: digits || 0, maximumFractionDigits: digits == null ? 1 : digits });
  }
  function pct(value, digits) {
    var n = Number(value);
    if (!Number.isFinite(n)) return "Em acompanhamento";
    return number(n, digits == null ? 1 : digits) + "%";
  }
  function dateLabel(value) {
    if (!value) return "";
    var d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  function createSvg(width, height) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    return svg;
  }
  function svgNode(name, attrs, text) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function smoothLinePath(points) {
    if (!points.length) return "";
    if (points.length === 1) return "M" + points[0][0].toFixed(2) + " " + points[0][1].toFixed(2);
    var d = "M" + points[0][0].toFixed(2) + " " + points[0][1].toFixed(2);
    for (var i = 0; i < points.length - 1; i += 1) {
      var p0 = points[i];
      var p1 = points[i + 1];
      var mx = (p0[0] + p1[0]) / 2;
      var my = (p0[1] + p1[1]) / 2;
      d += " Q" + p0[0].toFixed(2) + " " + p0[1].toFixed(2) + " " + mx.toFixed(2) + " " + my.toFixed(2);
    }
    var last = points[points.length - 1];
    d += " T" + last[0].toFixed(2) + " " + last[1].toFixed(2);
    return d;
  }
  function areaSmoothPath(upper, lower) {
    if (!upper.length || !lower.length || upper.length !== lower.length) return "";
    var lowerReversed = lower.slice().reverse();
    var top = smoothLinePath(upper);
    var bottom = smoothLinePath(lowerReversed).replace(/^M[^QTLCSAZ]*\s?/, 'L');
    return top + " " + bottom + " Z";
  }
  function addChartDefs(svg) {
    var defs = svgNode("defs");
    var areaGradient = svgNode("linearGradient", { id: "accuracyAreaGradient", x1: "0", y1: "0", x2: "0", y2: "1" });
    areaGradient.appendChild(svgNode("stop", { offset: "0%", "stop-color": "#a3e635", "stop-opacity": ".24" }));
    areaGradient.appendChild(svgNode("stop", { offset: "100%", "stop-color": "#a3e635", "stop-opacity": ".045" }));
    defs.appendChild(areaGradient);
    svg.appendChild(defs);
  }
  function linePath(points) {
    return points.map(function (point, index) { return (index ? "L" : "M") + point[0].toFixed(2) + " " + point[1].toFixed(2); }).join(" ");
  }
  function chartEmpty(target, message) {
    target.innerHTML = '<div class="empty-state" style="margin:12px">' + esc(message) + '</div>';
  }

  function renderSummary() {
    var games = (state.data || {}).jogos || {};
    el("accuracy-games-badge").textContent = games.jogos_avaliados ? number(games.jogos_avaliados,0) + " jogos avaliados" : "Coleta iniciada";
  }

  function renderCalibration() {
    var target = el("accuracy-calibration");
    var bins = ((state.data.jogos || {}).calibracao || []).filter(function (row) { return Number(row.amostra) > 0; });
    if (!bins.length) {
      chartEmpty(target, "A calibração aparecerá automaticamente assim que houver partidas com previsão pré-jogo registrada e resultado final.");
      el("accuracy-calibration-note").textContent = "Nenhuma previsão passada é reconstruída: a série começa apenas com probabilidades realmente registradas antes do jogo.";
      renderTechnical();
      return;
    }
    target.innerHTML = "";
    var width = 780, height = 330, left = 52, right = 24, top = 22, bottom = 50;
    var w = width - left - right, h = height - top - bottom;
    var svg = createSvg(width, height);
    addChartDefs(svg);
    [0,20,40,60,80,100].forEach(function (tick) {
      var x = left + w * tick / 100;
      var y = top + h - h * tick / 100;
      svg.appendChild(svgNode("line", { x1:left, y1:y, x2:width-right, y2:y, class:"grid" }));
      svg.appendChild(svgNode("line", { x1:x, y1:top, x2:x, y2:height-bottom, class:"grid" }));
      svg.appendChild(svgNode("text", { x:left-8, y:y+4, "text-anchor":"end" }, tick + "%"));
      svg.appendChild(svgNode("text", { x:x, y:height-bottom+20, "text-anchor":"middle" }, tick + "%"));
    });
    svg.appendChild(svgNode("line", { x1:left, y1:height-bottom, x2:width-right, y2:height-bottom, class:"axis" }));
    svg.appendChild(svgNode("line", { x1:left, y1:top, x2:left, y2:height-bottom, class:"axis" }));
    svg.appendChild(svgNode("path", { d:smoothLinePath([[left,height-bottom],[width-right,top]]), class:"ideal" }));
    var points = bins.map(function (row) {
      return [left + w * Number(row.probabilidade_media_pct) / 100, top + h - h * Number(row.frequencia_observada_pct) / 100, row];
    });
    svg.appendChild(svgNode("path", { d:smoothLinePath(points.map(function(p){return [p[0],p[1]];})), class:"line-main" }));
    points.forEach(function (point) {
      var circle = svgNode("circle", { cx:point[0], cy:point[1], r:5, class:"dot-main" });
      circle.appendChild(svgNode("title", {}, "Probabilidade média " + pct(point[2].probabilidade_media_pct,1) + " · ocorreu " + pct(point[2].frequencia_observada_pct,1) + " · amostra " + number(point[2].amostra,0)));
      svg.appendChild(circle);
    });
    svg.appendChild(svgNode("text", { x:left+w/2, y:height-7, "text-anchor":"middle" }, "Probabilidade indicada pelo AF"));
    var yLabel = svgNode("text", { x:14, y:top+h/2, transform:"rotate(-90 14 " + (top+h/2) + ")", "text-anchor":"middle" }, "Frequência observada");
    svg.appendChild(yLabel);
    target.appendChild(svg);
    el("accuracy-calibration-note").innerHTML = '<span class="accuracy-legend"><span><i></i>AF observado</span><span><i class="muted"></i>calibração perfeita</span></span>';
    renderTechnical();
  }

  function renderTechnical() {
    var technical = ((state.data.jogos || {}).metricas_tecnicas || {});
    el("accuracy-technical").innerHTML = '<div class="accuracy-technical-grid">' +
      '<div><strong>Brier multiclasse médio</strong><br>' + esc(number(technical.brier_multiclasse_medio,4)) + '<br><small>Quanto menor, melhor. Mantido como métrica técnica, não como headline.</small></div>' +
      '<div><strong>Log Loss médio</strong><br>' + esc(number(technical.log_loss_medio,4)) + '<br><small>Penaliza previsões excessivamente confiantes quando o evento não ocorre.</small></div>' +
      '</div>';
  }

  function clubRows() {
    return (((state.data || {}).timeline_clubes || {})[state.club] || []);
  }
  function setClubOptions() {
    var clubs = Object.keys((state.data || {}).timeline_clubes || {}).sort(function (a,b) { return a.localeCompare(b,"pt-BR"); });
    var select = el("accuracy-club-select");
    select.innerHTML = clubs.map(function (club) { return '<option value="' + esc(club) + '">' + esc(club) + '</option>'; }).join("");
    var preferred = clubs[0] || "";
    state.club = preferred;
    select.value = preferred;
    select.addEventListener("change", function () { state.club = select.value; renderTimeline(); });
  }

  function renderCurrent(rows) {
    var current = rows[rows.length - 1];
    if (!current) { el("accuracy-timeline-current").innerHTML = ""; return; }
    var interval = current.faixa_posicao_80 || {};
    var pointRange = current.faixa_pontos_80 || {};
    el("accuracy-timeline-current").innerHTML = [
      ["Jogos", current.jogos_atuais],
      ["Posição atual", current.posicao_atual ? current.posicao_atual + "º" : "—"],
      ["Projetada", current.posicao_projetada ? current.posicao_projetada + "º" : "—"],
      ["Faixa 80%", interval.melhor && interval.pior ? interval.melhor + "º–" + interval.pior + "º" : "—"],
      ["Pontos projetados", current.pontos_projetados == null ? "—" : current.pontos_projetados],
      ["Faixa pontos 80%", pointRange.min != null && pointRange.max != null ? pointRange.min + "–" + pointRange.max : "—"]
    ].map(function (item) { return '<span>' + esc(item[0]) + ': <b>' + esc(item[1]) + '</b></span>'; }).join("");
  }

  function bounds(values, fallbackMin, fallbackMax) {
    var filtered = values.map(Number).filter(Number.isFinite);
    if (!filtered.length) return [fallbackMin, fallbackMax];
    var min = Math.min.apply(null, filtered), max = Math.max.apply(null, filtered);
    if (min === max) { min -= 1; max += 1; }
    var pad = Math.max(1, (max-min)*.08);
    return [min-pad,max+pad];
  }

  function timelineBase(rows, yMin, yMax, invertY) {
    var width = 800, height = 350, left = 54, right = 22, top = 24, bottom = 54;
    var w = width-left-right, h=height-top-bottom;
    function x(index) { return rows.length <= 1 ? left+w/2 : left + w * index/(rows.length-1); }
    function y(value) {
      var ratio=(Number(value)-yMin)/(yMax-yMin || 1);
      if (invertY) ratio=1-ratio;
      return top+h-h*ratio;
    }
    var svg=createSvg(width,height);
    addChartDefs(svg);
    for(var i=0;i<=4;i+=1){
      var value=yMin+(yMax-yMin)*i/4;
      var yy=y(value);
      svg.appendChild(svgNode("line",{x1:left,y1:yy,x2:width-right,y2:yy,class:"grid"}));
      svg.appendChild(svgNode("text",{x:left-8,y:yy+4,"text-anchor":"end"}, state.metric === "posicao" ? Math.round(value)+"º" : Math.round(value)));
    }
    svg.appendChild(svgNode("line",{x1:left,y1:height-bottom,x2:width-right,y2:height-bottom,class:"axis"}));
    svg.appendChild(svgNode("line",{x1:left,y1:top,x2:left,y2:height-bottom,class:"axis"}));
    var labelIndexes=[];
    if(rows.length<=6){for(var j=0;j<rows.length;j+=1)labelIndexes.push(j);} else {labelIndexes=[0,Math.round((rows.length-1)/3),Math.round(2*(rows.length-1)/3),rows.length-1];}
    var used={};
    labelIndexes.forEach(function(index){if(used[index])return;used[index]=1;var row=rows[index];svg.appendChild(svgNode("text",{x:x(index),y:height-bottom+20,"text-anchor":"middle"},Number(row.jogos_atuais||0)+"J"));});
    return {svg:svg,width:width,height:height,left:left,right:right,top:top,bottom:bottom,w:w,h:h,x:x,y:y};
  }

  function addSeries(svg, base, rows, accessor, className, dotClass, label, valueDigits, valueSuffix) {
    var points=[];
    rows.forEach(function(row,index){
      var raw=accessor(row);
      if(raw==null||raw==="")return;
      var value=Number(raw);
      if(Number.isFinite(value))points.push([base.x(index),base.y(value),row,value]);
    });
    if(points.length>1){
      svg.appendChild(svgNode("path",{
        d:smoothLinePath(points.map(function(p){return[p[0],p[1]];})),
        class:className
      }));
    }
    points.forEach(function(p){
      svg.appendChild(svgNode("circle",{cx:p[0],cy:p[1],r:7,class:"point-halo"}));
      var c=svgNode("circle",{cx:p[0],cy:p[1],r:3.9,class:dotClass});
      var displayed=number(p[3], valueDigits == null ? 1 : valueDigits) + (valueSuffix || "");
      c.appendChild(svgNode("title",{},label+": "+displayed+" · após "+number(p[2].jogos_atuais,0)+" jogos · "+dateLabel(p[2].gerado_em)));
      svg.appendChild(c);
    });
  }

  function renderPosition(rows, target) {
    var base=timelineBase(rows,1,20,true), svg=base.svg;
    var upper=[], lower=[];
    rows.forEach(function(row,index){var range=row.faixa_posicao_80||{};if(range.melhor==null||range.pior==null)return;var best=Number(range.melhor),worst=Number(range.pior);if(Number.isFinite(best)&&Number.isFinite(worst)){upper.push([base.x(index),base.y(best)]);lower.push([base.x(index),base.y(worst)]);}});
    if(upper.length>1&&lower.length===upper.length){svg.appendChild(svgNode("path",{d:areaSmoothPath(upper,lower),class:"area-80"}));}
    addSeries(svg,base,rows,function(r){return r.posicao_projetada;},"line-main","dot-main","Posição projetada",0,"º");
    addSeries(svg,base,rows,function(r){return r.posicao_atual;},"line-secondary","dot-secondary","Posição real naquele momento",0,"º");
    target.appendChild(svg);
    el("accuracy-timeline-legend").innerHTML='<span><i class="area"></i>faixa central de 80%</span><span><i></i>posição projetada</span><span><i class="secondary"></i>posição real no momento</span>';
  }

  function renderPoints(rows,target){
    var values=[];rows.forEach(function(r){var range=r.faixa_pontos_80||{};values.push(r.pontos_atuais,r.pontos_projetados,range.min,range.max);});var b=bounds(values,0,114),base=timelineBase(rows,Math.max(0,b[0]),Math.min(114,b[1]),false),svg=base.svg;
    var upper=[],lower=[];rows.forEach(function(row,index){var range=row.faixa_pontos_80||{};if(range.min==null||range.max==null)return;var low=Number(range.min),high=Number(range.max);if(Number.isFinite(low)&&Number.isFinite(high)){upper.push([base.x(index),base.y(high)]);lower.push([base.x(index),base.y(low)]);}});if(upper.length>1&&lower.length===upper.length){svg.appendChild(svgNode("path",{d:areaSmoothPath(upper,lower),class:"area-80"}));}
    addSeries(svg,base,rows,function(r){return r.pontos_projetados;},"line-main","dot-main","Pontos finais projetados");
    addSeries(svg,base,rows,function(r){return r.pontos_atuais;},"line-secondary","dot-secondary","Pontos acumulados no momento");
    target.appendChild(svg);el("accuracy-timeline-legend").innerHTML='<span><i class="area"></i>faixa central de 80%</span><span><i></i>pontos finais projetados</span><span><i class="secondary"></i>pontos acumulados</span>';
  }

  function renderProbabilities(rows,target){
    var base=timelineBase(rows,0,100,false),svg=base.svg;
    addSeries(svg,base,rows,function(r){return (r.probabilidades_pct||{}).campeao;},"line-gold","dot-gold","Campeão");
    addSeries(svg,base,rows,function(r){return (r.probabilidades_pct||{}).libertadores;},"line-main","dot-main","Libertadores");
    addSeries(svg,base,rows,function(r){return (r.probabilidades_pct||{}).sul_americana;},"line-secondary","dot-secondary","Sul-Americana");
    target.appendChild(svg);el("accuracy-timeline-legend").innerHTML='<span><i class="gold"></i>campeão</span><span><i></i>Libertadores</span><span><i class="secondary"></i>Sul-Americana</span>';
  }

  function renderTimeline() {
    var target=el("accuracy-timeline"), rows=clubRows(); target.innerHTML=""; renderCurrent(rows);
    if(!rows.length){chartEmpty(target,"Ainda não há histórico auditável para este clube.");el("accuracy-timeline-legend").innerHTML="";return;}
    if(state.metric==="pontos")renderPoints(rows,target);else if(state.metric==="probabilidades")renderProbabilities(rows,target);else renderPosition(rows,target);
  }

  function wireTabs(){
    Array.prototype.forEach.call(document.querySelectorAll("[data-accuracy-metric]"),function(button){button.addEventListener("click",function(){state.metric=button.getAttribute("data-accuracy-metric")||"posicao";Array.prototype.forEach.call(document.querySelectorAll("[data-accuracy-metric]"),function(other){var active=other===button;other.classList.toggle("active",active);other.setAttribute("aria-selected",active?"true":"false");});renderTimeline();});});
  }

  function milestoneHtml(rows){
    if(!rows||!rows.length)return"";
    return '<div class="accuracy-milestones">'+rows.slice(-6).map(function(row){return '<div class="accuracy-milestone"><span>Após '+number(row.apos_jogos,0)+' jogos</span><div class="accuracy-milestone-track"><i style="width:'+Math.max(0,Math.min(100,Number(row.cobertura_pct)||0))+'%"></i></div><b>'+pct(row.cobertura_pct,1)+'</b></div>';}).join("")+'</div>';
  }

  function renderRange(){
    var range=(((state.data.classificacao||{}).faixa_80)||{}), target=el("accuracy-range-cards"), history=el("accuracy-range-history");
    if(range.status!=="concluido"){
      target.innerHTML='<div class="accuracy-waiting" style="grid-column:1/-1"><strong>Em acompanhamento.</strong><br>A posição e a pontuação finais ainda não existem; o painel preserva as faixas publicadas agora e fará a aferição automaticamente no encerramento do Brasileirão.</div>';history.innerHTML="";return;
    }
    var position=(range.posicao||{}).destaque||{}, points=(range.pontos||{}).destaque||{};
    target.innerHTML='<article class="accuracy-range-card"><span>Posição final dentro da faixa</span><strong>'+pct(position.cobertura_pct,1)+'</strong><small>Referência: após '+number(position.apos_jogos,0)+' jogos · amostra '+number(position.amostra,0)+' clubes</small></article><article class="accuracy-range-card"><span>Pontuação final dentro da faixa</span><strong>'+pct(points.cobertura_pct,1)+'</strong><small>Referência: após '+number(points.apos_jogos,0)+' jogos · amostra '+number(points.amostra,0)+' clubes</small></article>';
    history.innerHTML='<div class="accuracy-note"><strong>Evolução da cobertura por estágio</strong></div>'+milestoneHtml((range.posicao||{}).marcos||[]);
  }

  function eventLabel(key){return {campeao:"Campeão",libertadores:"Libertadores",sul_americana:"Sul-Americana"}[key]||key;}
  function renderSeasonEvents(){
    var section=state.data.eventos_temporada||{}, target=el("accuracy-season-events");
    if(section.status!=="concluido"){
      target.innerHTML='<div class="accuracy-waiting" style="grid-column:1/-1"><strong>Em acompanhamento.</strong><br>'+esc(section.mensagem||"Os desfechos ainda não estão definidos.")+'</div>';return;
    }
    var events=section.eventos||{};
    target.innerHTML=["campeao","libertadores","sul_americana"].map(function(key){var high=(events[key]||{}).alta_confianca_80||{};return '<article class="accuracy-event-card"><span>'+esc(eventLabel(key))+' · confiança ≥80%</span><strong>'+pct(high.taxa_confirmacao_pct,1)+'</strong><small>'+ (high.amostra ? number(high.confirmadas,0)+' confirmações em '+number(high.amostra,0)+' previsões de alta confiança' : 'Sem amostra ≥80%') +'</small></article>';}).join("");
  }

  function renderAll(){renderSummary();renderCalibration();setClubOptions();wireTabs();renderTimeline();renderRange();renderSeasonEvents();}

  async function init(){
    try{var response=await fetch(DATA_URL+"?_="+Date.now(),{cache:"no-store",headers:{Accept:"application/json"}});if(!response.ok)throw new Error("HTTP "+response.status);var data=await response.json();if(!data||data.status!=="ok")throw new Error("JSON de acurácia inválido");state.data=data;renderAll();}
    catch(error){el("accuracy-app").insertAdjacentHTML("afterbegin",'<div class="accuracy-error"><strong>Não foi possível carregar a acurácia agora.</strong><br>'+esc(error&&error.message?error.message:"Falha desconhecida")+'</div>');}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})(window,document);
