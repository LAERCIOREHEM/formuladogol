#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
atualizar_copa.py
-----------------
Busca os resultados OFICIAIS da Copa 2026 e grava dados/copa2026_resultados.json,
consumido pela aba "Resultados" e pelo motor de pontuação.

Segue o mesmo padrão do site Brasileirão Almoço (API pública do GloboEsporte),
para rodar via GitHub Actions em cron. Você precisa descobrir o UUID e o slug
de fase da Copa do Mundo 2026 no GE (passos no COMO-COLOCAR-PARA-FUNCIONAR.md).

Como rodar:
    pip install requests
    python3 atualizar_copa.py
"""

import json
import os
import sys

try:
    import requests
except ImportError:
    print("Instale: pip install requests")
    sys.exit(1)

SAIDA = os.path.join(os.path.dirname(__file__), "..", "dados", "copa2026_resultados.json")

# >>> PREENCHER: descubra no DevTools da tabela da Copa no ge.globo.com <<<
UUID_COPA = "COLOQUE_O_UUID_DA_COPA_AQUI"
BASE = "https://api.globoesporte.globo.com/tabela/{uuid}/fase/{fase}/rodada/{rod}/jogos/"

# Slugs de fase da Copa no GE (confirmar nomes exatos no DevTools):
FASES = {
    "grupos":   {"slug": "fase-de-grupos-copa-do-mundo-2026", "rodadas": 3},
    "r32":      {"slug": "16-avos-de-final-copa-do-mundo-2026", "rodadas": 1},
    "oitavas":  {"slug": "oitavas-de-final-copa-do-mundo-2026", "rodadas": 1},
    "quartas":  {"slug": "quartas-de-final-copa-do-mundo-2026", "rodadas": 1},
    "semis":    {"slug": "semifinais-copa-do-mundo-2026", "rodadas": 1},
    "final":    {"slug": "final-copa-do-mundo-2026", "rodadas": 1},
}

HEADERS = {"User-Agent": "Mozilla/5.0 (bolao-copa-almoco)"}


def buscar_fase(slug, rodadas):
    jogos = []
    for r in range(1, rodadas + 1):
        url = BASE.format(uuid=UUID_COPA, fase=slug, rod=r)
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            resp.raise_for_status()
            jogos.extend(resp.json())
        except Exception as e:
            print(f"  falhou {slug} rodada {r}: {e}")
    return jogos


def normalizar(jogo, fase):
    """Converte o JSON do GE no formato do bolão. Ajuste os campos conforme
    o retorno real da API (nomes podem variar)."""
    casa = jogo.get("equipes", {}).get("mandante", {})
    fora = jogo.get("equipes", {}).get("visitante", {})
    placar = jogo.get("placar_oficial_mandante"), jogo.get("placar_oficial_visitante")
    # avancou_id: quem a FIFA registrou como classificado (inclui pênaltis).
    # No mata-mata, prefira o campo de vencedor/penaltis da API; aqui é placeholder.
    return {
        "fase": fase,
        "time_a": casa.get("sigla") or casa.get("nome"),
        "time_b": fora.get("sigla") or fora.get("nome"),
        "gols_a": placar[0],
        "gols_b": placar[1],
        "encerrado": jogo.get("transmissao", {}).get("status") == "finalizado",
        "avancou_id": None,  # TODO: preencher no mata-mata a partir do vencedor/pênaltis
    }


def main():
    if UUID_COPA.startswith("COLOQUE"):
        print("Defina UUID_COPA antes de rodar. Veja COMO-COLOCAR-PARA-FUNCIONAR.md.")
        sys.exit(1)

    resultado = {"atualizado_em": None, "jogos": []}
    for chave, cfg in FASES.items():
        print(f"Buscando {chave}...")
        for j in buscar_fase(cfg["slug"], cfg["rodadas"]):
            resultado["jogos"].append(normalizar(j, chave))

    import datetime
    resultado["atualizado_em"] = datetime.datetime.utcnow().isoformat() + "Z"

    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(resultado, f, ensure_ascii=False, indent=2)
    print(f"OK: {len(resultado['jogos'])} jogos em {os.path.normpath(SAIDA)}")


if __name__ == "__main__":
    main()
