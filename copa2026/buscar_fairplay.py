#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Calcula o fair play (cartões) de cada seleção na FASE DE GRUPOS e salva em dados/fairplay.json.
Roda via GitHub Actions ao fim de cada rodada. O site lê o JSON pronto (estável, rápido),
em vez de buscar 38 summaries ao vivo (que era lento e oscilava).

Critério FIFA (team conduct score): -1 por amarelo, -4 por vermelho direto.
Só fase de grupos: no mata-mata não existe esse critério de desempate.
"""
import os, json, urllib.request, urllib.parse

DIR = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.join(DIR, "dados", "fairplay.json")

SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary"

# DE-PARA das siglas da ESPN para as siglas do site (mesmo do resultados.js)
DEPARA = {
    "NED": "NED", "HOL": "NED", "SUI": "SUI", "SWE": "SWE", "USA": "USA", "US": "USA",
    "AUS": "AUS", "KOR": "KOR", "RSA": "RSA", "ZAF": "RSA", "CZE": "CZE", "CPV": "CPV",
    "KSA": "KSA", "URU": "URU", "POR": "POR", "COD": "COD", "CGO": "COD", "GHA": "GHA",
    "PAN": "PAN", "CRO": "CRO", "ENG": "ENG", "ECU": "ECU", "CIV": "CIV", "CUW": "CUW",
    "JPN": "JPN", "TUN": "TUN", "IRN": "IRN", "NZL": "NZL", "EGY": "EGY", "BEL": "BEL",
    "ARG": "ARG", "ALG": "ALG", "DZA": "ALG", "AUT": "AUT", "JOR": "JOR", "FRA": "FRA",
    "SEN": "SEN", "IRQ": "IRQ", "NOR": "NOR", "COL": "COL", "UZB": "UZB", "MEX": "MEX",
    "BRA": "BRA", "MAR": "MAR", "HAI": "HAI", "GER": "GER", "DEU": "GER", "CAN": "CAN",
    "QAT": "QAT", "SCO": "SCO", "TUR": "TUR", "TUR": "TUR",
}


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "bolao-copa-fairplay/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def sigla(ab):
    if not ab:
        return None
    return DEPARA.get(ab.upper(), ab.upper())


def main():
    # 1) pega os jogos da fase de grupos
    url = f"{SCOREBOARD}?dates=20260611-20260627&limit=120"
    try:
        sb = http_get(url)
    except Exception as e:
        print("Falha ao buscar scoreboard:", e)
        return
    eventos = sb.get("events", [])
    grupos = [e for e in eventos
              if ((e.get("season") or {}).get("slug") or "") == "group-stage"]
    encerrados = [e for e in grupos
                  if (((e.get("competitions") or [{}])[0].get("status") or {})
                      .get("type") or {}).get("state") == "post"]
    print(f"Jogos de grupo: {len(grupos)} | encerrados: {len(encerrados)}")

    # 2) para cada jogo encerrado, busca o summary e soma os cartões
    fp = {}
    for ev in encerrados:
        eid = ev.get("id")
        try:
            s = http_get(f"{SUMMARY}?event={eid}")
        except Exception as e:
            print(f"  summary {eid} falhou: {e}")
            continue
        teams = ((s.get("boxscore") or {}).get("teams") or [])
        for t in teams:
            ab = (t.get("team") or {}).get("abbreviation")
            sig = sigla(ab)
            if not sig:
                continue
            stats = t.get("statistics") or []

            def stat(nome):
                for st in stats:
                    if (st.get("name") or st.get("displayName")) == nome:
                        v = st.get("displayValue") or st.get("value") or "0"
                        try:
                            return int(v)
                        except Exception:
                            return 0
                return 0
            yc, rc = stat("yellowCards"), stat("redCards")
            fp[sig] = fp.get(sig, 0) + (yc * -1) + (rc * -4)

    # 3) salva
    saida = {
        "_comentario": "Fair play (conduta) por seleção na fase de grupos. "
                       "-1 por amarelo, -4 por vermelho. Gerado por buscar_fairplay.py. "
                       "Usado como critério de desempate (antes do ranking FIFA).",
        "atualizado_em": sb.get("day", {}).get("date", ""),
        "fairplay": fp
    }
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    json.dump(saida, open(SAIDA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"OK. Fair play de {len(fp)} seleções salvo em {SAIDA}.")
    # mostra os que têm cartões (debug)
    comCartao = {k: v for k, v in fp.items() if v != 0}
    print("Seleções com cartões:", json.dumps(comCartao, ensure_ascii=False))


if __name__ == "__main__":
    main()
