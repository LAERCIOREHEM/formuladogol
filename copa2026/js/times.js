/* =========================================================================
   times.js — Tabela DE-PARA central de nomes de seleções (PT-BR)
   Fonte da verdade: dados/selecoes.json (id = sigla padrão, nome PT, iso2).
   Este módulo traduz QUALQUER sigla OU nome em inglês vindo da ESPN para
   o nosso português padronizado, e dá o código de bandeira (iso2).

   Uso (depois de incluir <script src="js/times.js">):
     COPA_TIMES.carregar().then(() => { ... });   // carrega selecoes.json 1x
     COPA_TIMES.nome("QAT")  -> "Catar"
     COPA_TIMES.nome("Switzerland") -> "Suíça"   (rede de segurança por nome EN)
     COPA_TIMES.iso("RSA")   -> "za"
     COPA_TIMES.flag("RSA")  -> URL do flagcdn
   ========================================================================= */
(function () {
  "use strict";
  var NOME = {};   // sigla -> nome PT
  var ISO = {};    // sigla -> iso2
  var ALIAS = {};  // texto normalizado (sigla OU nome EN/PT) -> sigla
  var carregado = false;

  // Nomes em inglês (como a ESPN costuma mandar) -> nossa sigla.
  // Rede de segurança: se a sigla não casar, casamos pelo nome.
  var EN2SIGLA = {
    "mexico": "MEX",
    "south africa": "RSA",
    "south korea": "KOR", "korea republic": "KOR", "korea": "KOR",
    "czechia": "CZE", "czech republic": "CZE",
    "canada": "CAN",
    "bosnia and herzegovina": "BIH", "bosnia": "BIH", "bosnia herzegovina": "BIH",
    "qatar": "QAT",
    "switzerland": "SUI",
    "brazil": "BRA",
    "morocco": "MAR",
    "haiti": "HAI",
    "scotland": "SCO",
    "united states": "USA", "usa": "USA",
    "paraguay": "PAR",
    "australia": "AUS",
    "turkey": "TUR", "türkiye": "TUR", "turkiye": "TUR",
    "germany": "GER",
    "curacao": "CUW", "curaçao": "CUW",
    "ivory coast": "CIV", "cote d'ivoire": "CIV", "côte d'ivoire": "CIV",
    "ecuador": "ECU",
    "netherlands": "NED",
    "japan": "JPN",
    "sweden": "SWE",
    "tunisia": "TUN",
    "belgium": "BEL",
    "egypt": "EGY",
    "iran": "IRN", "ir iran": "IRN", "iri": "IRN", "iran islamic republic": "IRN", "islamic republic of iran": "IRN",
    "new zealand": "NZL",
    "spain": "ESP",
    "cape verde": "CPV", "cabo verde": "CPV",
    "saudi arabia": "KSA",
    "uruguay": "URU",
    "france": "FRA",
    "senegal": "SEN",
    "iraq": "IRQ",
    "norway": "NOR",
    "argentina": "ARG",
    "algeria": "ALG",
    "austria": "AUT",
    "jordan": "JOR",
    "portugal": "POR",
    "dr congo": "COD", "congo dr": "COD", "democratic republic of the congo": "COD", "congo": "COD",
    "uzbekistan": "UZB",
    "colombia": "COL",
    "england": "ENG",
    "croatia": "CRO",
    "ghana": "GHA",
    "panama": "PAN"
  };

  function norm(s) {
    return String(s || "").toLowerCase()
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  function carregar() {
    if (carregado) return Promise.resolve();
    return fetch("dados/selecoes.json").then(function (r) { return r.json(); }).then(function (d) {
      (d.selecoes || []).forEach(function (x) {
        NOME[x.id] = x.nome;
        ISO[x.id] = x.iso2;
        ALIAS[norm(x.id)] = x.id;
        ALIAS[norm(x.nome)] = x.id;
      });
      Object.keys(EN2SIGLA).forEach(function (k) { ALIAS[norm(k)] = EN2SIGLA[k]; });
      carregado = true;
    });
  }

  // resolve qualquer entrada (sigla, nome EN ou PT) para a nossa sigla
  function sigla(qualquer) {
    if (!qualquer) return null;
    if (NOME[qualquer]) return qualquer;            // já é sigla conhecida
    var s = ALIAS[norm(qualquer)];
    return s || null;
  }

  function nome(qualquer) {
    var sg = sigla(qualquer);
    return sg ? NOME[sg] : (qualquer || "—");
  }
  function iso(qualquer) {
    var sg = sigla(qualquer);
    return sg ? ISO[sg] : "";
  }
  function flag(qualquer, largura) {
    var c = iso(qualquer);
    return c ? ("https://flagcdn.com/w" + (largura || 80) + "/" + c + ".png") : "";
  }

  window.COPA_TIMES = { carregar: carregar, sigla: sigla, nome: nome, iso: iso, flag: flag, _norm: norm };
})();
