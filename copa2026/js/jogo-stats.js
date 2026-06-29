/* =========================================================================
   jogo-stats.js — Estatísticas recolhíveis por partida (Copa 2026)
   Fase 1: usado em index.html e onde-assistir.html.
   Lê dados/jogos-detalhes.json; se faltar o jogo, tenta o summary público da ESPN
   somente quando o usuário abre o botão.
   ========================================================================= */
(function () {
  "use strict";

  const STATIC_URL = "dados/jogos-detalhes.json";
  const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=";
  let staticCache = null;
  let loadedCSS = false;
  const reqCache = new Map();

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }
  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function injectCSS() {
    if (loadedCSS || document.getElementById("jogo-stats-css")) return;
    loadedCSS = true;
    const st = document.createElement("style");
    st.id = "jogo-stats-css";
    st.textContent = `
      .jstats{margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:9px}
      .jstats-btn{width:100%;border:1px solid rgba(244,197,66,.38);background:linear-gradient(180deg,rgba(244,197,66,.14),rgba(244,197,66,.08));color:#f7d35b;border-radius:14px;padding:10px 12px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;letter-spacing:.2px}
      .jstats-btn:hover{background:rgba(244,197,66,.18)}.jstats-btn:disabled{opacity:.7;cursor:wait}
      .jstats-panel{display:none;margin-top:9px;background:rgba(7,27,51,.72);border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:10px}
      .jstats.open .jstats-panel{display:block}
      .jstats-title{display:flex;justify-content:space-between;gap:8px;align-items:center;color:#f4c542;font-weight:900;text-transform:uppercase;font-size:12px;letter-spacing:.7px;margin-bottom:8px}
      .jstats-source{color:#9fb0c7;font-size:11px;text-transform:none;letter-spacing:0;font-weight:800}
      .jstats-head,.jstats-row{display:grid;grid-template-columns:minmax(72px,1fr) minmax(105px,1.2fr) minmax(72px,1fr);gap:8px;align-items:center}
      .jstats-head{color:#cbd8ea;font-size:12px;font-weight:900;margin:2px 0 6px}.jstats-head div:nth-child(2){text-align:center;color:#f4c542}
      .jstats-row{border-top:1px solid rgba(255,255,255,.07);padding:7px 0;font-size:13px}
      .jstats-row:first-of-type{border-top:0}.jstats-row .metric{text-align:center;color:#cbd8ea;font-weight:800;font-size:12px}.jstats-row .metric small{color:#f4c542;font-size:10px;margin-left:3px}.jstats-row .val{font-weight:900;color:#fff}.jstats-row .right{text-align:right}
      .jstats-bar{height:4px;background:rgba(255,255,255,.10);border-radius:999px;margin-top:4px;overflow:hidden}.jstats-bar span{display:block;height:100%;background:#f4c542;border-radius:999px}
      .jstats-msg{color:#cbd8ea;font-size:13px;line-height:1.35;text-align:center;padding:9px}.jstats-msg.err{color:#ffb3ad}
      .jstats-more{margin-top:8px;color:#9fb0c7;font-size:11px;line-height:1.35;text-align:center}
      @media(max-width:640px){
        .jstats{margin-top:8px;padding-top:8px}.jstats-btn{border-radius:13px;padding:9px 10px;font-size:13px}
        .jstats-panel{border-radius:14px;padding:9px}.jstats-head,.jstats-row{grid-template-columns:minmax(58px,.8fr) minmax(90px,1.25fr) minmax(58px,.8fr);gap:6px}
        .jstats-row{font-size:12px;padding:6px 0}.jstats-row .metric{font-size:11px}.jstats-title{font-size:11px}
      }
    `;
    document.head.appendChild(st);
  }

  function bloco(opts) {
    injectCSS();
    const eventId = esc(opts.eventId || "");
    return `<div class="jstats" data-jstats="${eventId}" data-home-id="${esc(opts.homeId || "")}" data-away-id="${esc(opts.awayId || "")}" data-home-name="${esc(opts.homeName || opts.homeId || "Mandante")}" data-away-name="${esc(opts.awayName || opts.awayId || "Visitante")}">
      <button class="jstats-btn" type="button" data-jstats-btn>📊 Estatísticas do jogo ▾</button>
      <div class="jstats-panel" data-jstats-panel><div class="jstats-msg">Toque para carregar o raio-x da partida.</div></div>
    </div>`;
  }

  async function loadStatic() {
    if (staticCache !== null) return staticCache;
    try {
      const r = await fetch(STATIC_URL + "?v=" + Date.now());
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      staticCache = data.jogos || data.events || data || {};
    } catch (e) {
      staticCache = {};
    }
    return staticCache;
  }
  function byEvent(data, eventId) {
    if (!data || !eventId) return null;
    if (data[eventId]) return data[eventId];
    if (Array.isArray(data)) return data.find(x => String(x.event_id || x.eventId || x.id) === String(eventId)) || null;
    if (data.jogos && data.jogos[eventId]) return data.jogos[eventId];
    if (data.eventos && Array.isArray(data.eventos)) return data.eventos.find(x => String(x.event_id || x.eventId || x.id) === String(eventId)) || null;
    return null;
  }
  async function getStats(eventId) {
    if (reqCache.has(eventId)) return reqCache.get(eventId);
    const p = (async () => {
      const data = await loadStatic();
      const stat = byEvent(data, eventId);

      // Se o workflow já gerou JSON estático, usa ele.
      // Mas, se por qualquer razão o normalizador não entender o formato,
      // NÃO bloqueia o botão: tenta o summary da ESPN como fallback.
      if (stat && stat.stats && stat.stats.length) {
        const normalizado = normalizarRegistro(stat);
        if (normalizado.stats && normalizado.stats.length) return normalizado;
      }

      try {
        const r = await fetch(SUMMARY + encodeURIComponent(eventId));
        if (!r.ok) throw new Error("summary HTTP " + r.status);
        return parseSummary(await r.json());
      } catch (e) {
        return { stats: [], fonte: "ESPN", erro: true };
      }
    })();
    reqCache.set(eventId, p);
    return p;
  }

  const METRIC_RULES = [
    { keys:["expected goals","expectedgoals","xg"], label:"xG", order:1, note:"gols esperados" },
    { keys:["possession pct","possession percent","possession percentage","possessionpct","possession","posse"], label:"Posse", order:2, percent:true },
    { keys:["total shots","totalshots","shots total","finalizacoes","finalizações"], label:"Finalizações", order:3 },
    { keys:["shots on goal","shots on target","shotsongoal","shotsontarget","chutes no gol"], label:"Chutes no gol", order:4 },
    { keys:["shots off target","shotsofftarget"], label:"Chutes para fora", order:5 },
    { keys:["blocked shots","blockedshots"], label:"Chutes bloqueados", order:6 },
    { keys:["shot pct","shot percent","shot percentage","shotpct","shooting percentage","aproveitamento dos chutes"], label:"Aproveitamento dos chutes", order:7, percent01:true, note:"chutes no gol ÷ finalizações" },
    { keys:["big chances created","bigchancescreated"], label:"Grandes chances", order:8 },
    { keys:["big chances missed","bigchancesmissed"], label:"Chances perdidas", order:9 },
    { keys:["corner kicks","cornerkicks","won corners","woncorners","corners"], label:"Escanteios", order:10 },
    { keys:["fouls committed","foulscommitted","fouls"], label:"Faltas", order:11 },
    { keys:["yellow cards","yellowcards"], label:"Amarelos", order:12 },
    { keys:["red cards","redcards"], label:"Vermelhos", order:13 },
    { keys:["offsides","offside"], label:"Impedimentos", order:14 },
    { keys:["saves","goalkeeper saves"], label:"Defesas", order:15 },
    { keys:["accurate passes","accuratepasses"], label:"Passes certos", order:16 },
    { keys:["pass pct","pass percent","pass percentage","pass accuracy","passpct","passaccuracy"], label:"Precisão de passe", order:17, percent01:true },
    { keys:["duels won","duelswon"], label:"Duelos vencidos", order:18 }
  ];

  function camelSpaces(s) {
    return String(s || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/\bpct\b/ig, " pct");
  }
  function metricKey(s) {
    return norm(camelSpaces(s));
  }
  function metricKeyCompact(s) {
    return metricKey(s).replace(/\s+/g, "");
  }
  function ruleOf(name) {
    const k = metricKey(name);
    const kc = metricKeyCompact(name);

    // 1) Aceita nomes já traduzidos/normalizados no JSON estático
    //    ex.: "Posse", "Finalizações", "Chutes no gol".
    for (const r of METRIC_RULES) {
      const lk = norm(r.label);
      const lkc = lk.replace(/\s+/g, "");
      if (k === lk || kc === lkc) return r;
    }

    // 2) Aceita nomes crus da ESPN
    //    ex.: possessionPct, totalShots, shotsOnTarget, shotPct.
    for (const r of METRIC_RULES) {
      if (r.keys.some(x => k === norm(x) || kc === norm(x).replace(/\s+/g, ""))) return r;
    }

    // 3) Correspondência parcial só para métrica específica.
    //    Nunca para "Finalizações", para não transformar shotsOnTarget,
    //    shotsOffTarget e blockedShots tudo em "Finalizações".
    for (const r of METRIC_RULES) {
      if (r.label === "Finalizações") continue;
      const lk = norm(r.label);
      const lkc = lk.replace(/\s+/g, "");
      if (k.includes(lk) || kc.includes(lkc)) return r;
      if (r.keys.some(x => k.includes(norm(x)) || kc.includes(norm(x).replace(/\s+/g, "")))) return r;
    }
    return null;
  }
  function statName(s) {
    return s.displayName || s.shortDisplayName || s.name || s.label || s.abbreviation || "";
  }
  function statVal(s) {
    return s.displayValue != null ? s.displayValue : (s.value != null ? String(s.value) : (s.v != null ? String(s.v) : ""));
  }
  function numeric(v) {
    if (v == null) return NaN;
    const s = String(v).replace(",", ".").replace("%", "").match(/-?\d+(\.\d+)?/);
    return s ? parseFloat(s[0]) : NaN;
  }
  function formatMetricValue(rule, raw) {
    if (raw == null || raw === "") return "";
    let s = String(raw).trim().replace(",", ".");
    const n = numeric(s);
    if ((rule.percent || rule.percent01) && !/%/.test(s) && !isNaN(n)) {
      if (rule.percent01 && n >= 0 && n <= 1) return Math.round(n * 100) + "%";
      return (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10)) + "%";
    }
    return String(raw).trim();
  }
  function normalizarRegistro(reg) {
    if (!reg || !reg.stats || !Array.isArray(reg.stats)) return { stats: [], fonte: (reg && reg.fonte) || "arquivo" };
    const porLabel = new Map();
    reg.stats.forEach(x => {
      const rawName = x.nome || x.name || x.label || x.displayName || x.shortDisplayName || "";
      const rule = ruleOf(rawName);
      if (!rule) return;
      const item = {
        nome: rule.label,
        home: formatMetricValue(rule, x.home ?? x.mandante),
        away: formatMetricValue(rule, x.away ?? x.visitante),
        order: rule.order,
        note: rule.note || ""
      };
      const old = porLabel.get(rule.label);
      if (!old || item.order < old.order) porLabel.set(rule.label, item);
    });
    return { stats: [...porLabel.values()].sort((a,b) => a.order - b.order), fonte: reg.fonte || "arquivo" };
  }
  function parseSummary(json) {
    const teams = (((json || {}).boxscore || {}).teams || []);
    if (teams.length < 2) return { stats: [], fonte: "ESPN" };
    const a = teams[0], b = teams[1];
    const arrA = a.statistics || a.stats || [];
    const arrB = b.statistics || b.stats || [];
    const mapB = new Map();
    arrB.forEach(s => {
      const rule = ruleOf(statName(s));
      if (!rule) return;
      mapB.set(rule.label, { rule, val: statVal(s) });
    });
    const porLabel = new Map();
    arrA.forEach(s => {
      const rule = ruleOf(statName(s));
      if (!rule) return;
      const mb = mapB.get(rule.label);
      const home = formatMetricValue(rule, statVal(s));
      const away = formatMetricValue(rule, mb ? mb.val : "");
      if (home === "" && away === "") return;
      const item = { nome: rule.label, home, away, order: rule.order, note: rule.note || "" };
      const old = porLabel.get(rule.label);
      if (!old || item.order < old.order) porLabel.set(rule.label, item);
    });
    return { stats: [...porLabel.values()].sort((x, y) => x.order - y.order), fonte: "ESPN" };
  }

  function rowHTML(s) {
    const a = numeric(s.home), b = numeric(s.away);
    let pa = 50, pb = 50;
    if (!isNaN(a) && !isNaN(b) && (a + b) > 0) { pa = Math.round(a / (a + b) * 100); pb = 100 - pa; }
    const note = s.note ? `<small title="${esc(s.note)}">ⓘ</small>` : "";
    return `<div class="jstats-row">
      <div class="val">${esc(s.home || "—")}<div class="jstats-bar"><span style="width:${pa}%"></span></div></div>
      <div class="metric">${esc(s.nome)} ${note}</div>
      <div class="val right">${esc(s.away || "—")}<div class="jstats-bar"><span style="width:${pb}%"></span></div></div>
    </div>`;
  }

  function render(data, host) {
    const panel = host.querySelector("[data-jstats-panel]");
    const homeName = host.dataset.homeName || host.dataset.homeId || "Mandante";
    const awayName = host.dataset.awayName || host.dataset.awayId || "Visitante";
    if (!data || !data.stats || !data.stats.length) {
      panel.innerHTML = '<div class="jstats-msg">📊 Estatísticas detalhadas ainda não disponíveis para este jogo.</div>';
      return;
    }
    const stats = data.stats.filter(s => s && s.nome && (s.home != null || s.away != null)).slice(0, 12);
    panel.innerHTML = `<div class="jstats-title"><span>Raio-X da partida</span><span class="jstats-source">${esc(data.fonte || "ESPN")}</span></div>
      <div class="jstats-head"><div>${esc(homeName)}</div><div>comparativo</div><div style="text-align:right">${esc(awayName)}</div></div>
      ${stats.map(rowHTML).join("")}
      <div class="jstats-more">Mostramos somente métricas disponíveis na fonte. ⓘ Aproveitamento dos chutes = chutes no gol ÷ finalizações. O site não inventa estatísticas ausentes.</div>`;
  }
  function bind(root) {
    injectCSS();
    (root || document).querySelectorAll("[data-jstats-btn]").forEach(btn => {
      if (btn.dataset.ready) return;
      btn.dataset.ready = "1";
      btn.addEventListener("click", async () => {
        const host = btn.closest("[data-jstats]");
        const panel = host.querySelector("[data-jstats-panel]");
        const open = host.classList.toggle("open");
        btn.innerHTML = open ? "📊 Ocultar estatísticas ▴" : "📊 Estatísticas do jogo ▾";
        if (!open || host.dataset.loaded) return;
        btn.disabled = true;
        panel.innerHTML = '<div class="jstats-msg">Carregando estatísticas da partida…</div>';
        const data = await getStats(host.dataset.jstats);
        render(data, host);
        host.dataset.loaded = "1";
        btn.disabled = false;
      });
    });
  }

  window.COPA_JOGO_STATS = { bloco, bind, _parseSummary: parseSummary, _normalizarRegistro: normalizarRegistro, _getStats: getStats };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => bind());
  else bind();
})();
