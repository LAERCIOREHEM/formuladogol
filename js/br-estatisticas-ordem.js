(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BREstatisticasOrdem = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LABELS = Object.freeze([
    "Posse",
    "Finalizações",
    "Chutes no gol",
    "Chutes bloqueados",
    "Aproveitamento dos chutes",
    "Faltas",
    "Defesas",
    "Passes",
    "Passes certos",
    "Precisão de passe",
    "Desarmes",
    "Interceptações",
    "Cruzamentos",
    "Cortes",
    "Escanteios",
    "Amarelos",
    "Vermelhos",
    "Impedimentos",
  ]);

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  const aliases = new Map();
  LABELS.forEach((label, index) => aliases.set(normalize(label), { label, index }));
  aliases.set("precisao de passes", aliases.get("precisao de passe"));

  function canonical(value) {
    return aliases.get(normalize(value)) || null;
  }

  function sortStats(stats, options) {
    const keepUnknown = Boolean(options && options.keepUnknown);
    return (Array.isArray(stats) ? stats : [])
      .map((stat, originalIndex) => {
        const raw = stat && (stat.nome || stat.label || stat.name || "");
        const match = canonical(raw);
        return { stat, originalIndex, match };
      })
      .filter((item) => keepUnknown || item.match)
      .sort((a, b) => {
        if (a.match && b.match) return a.match.index - b.match.index || a.originalIndex - b.originalIndex;
        if (a.match) return -1;
        if (b.match) return 1;
        return a.originalIndex - b.originalIndex;
      })
      .map((item) => item.stat);
  }

  return { LABELS, normalize, canonical, sortStats };
});
