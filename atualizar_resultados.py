#!/usr/bin/env python3
"""
Script que busca TODOS os jogos já realizados do Brasileirão e salva em resultados.json.

Estratégia:
1. Lê tabela.json para descobrir qual a rodada atual (otimização: não precisa varrer 1 a 38).
2. Busca jogos das rodadas 1 até a rodada atual (inclusive).
3. Filtra apenas os que TÊM placar definido (oposto de atualizar_jogos.py).
4. Ordena do mais recente para o mais antigo.
5. Salva em resultados.json.
"""

import json
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta


FUSO_BRASILIA = timezone(timedelta(hours=-3))
TUUID_BRASILEIRAO = "d1a37fa4-e948-43a6-ba53-ab24ab3a45b1"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
}


def agora_brasilia():
    return datetime.now(FUSO_BRASILIA)


def fetch_json(url, timeout=20):
    sep = "&" if "?" in url else "?"
    url_full = f"{url}{sep}_={int(datetime.now().timestamp())}"
    req = urllib.request.Request(url_full, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        raw = resp.read().decode(charset, errors="replace")
        return json.loads(raw)


def descobrir_ultima_rodada_jogada():
    """
    Lê tabela.json para descobrir até qual rodada foi jogada (max de jogos disputados).
    Retorna o numero da última rodada com jogos.
    """
    try:
        with open("tabela.json", "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return 38  # fallback: varre tudo

    tabela = data.get("tabela") or []
    if not tabela:
        return 38

    jogos_disputados = []
    for t in tabela:
        j = t.get("jogos")
        if isinstance(j, int):
            jogos_disputados.append(j)

    if not jogos_disputados:
        return 38

    max_jogos = max(jogos_disputados)
    print(f"  tabela.json: max de jogos disputados = {max_jogos}")
    # Última rodada possivelmente com jogos = max_jogos
    return max_jogos


def buscar_jogos_da_rodada(ano, num_rodada):
    url = (
        f"https://api.globoesporte.globo.com/tabela/{TUUID_BRASILEIRAO}/"
        f"fase/fase-unica-campeonato-brasileiro-{ano}/"
        f"rodada/{num_rodada}/jogos/"
    )
    return fetch_json(url)


def extrair_data_iso(jogo):
    candidatos = [
        jogo.get("data_realizacao_iso"),
        jogo.get("data_realizacao"),
        jogo.get("data"),
    ]
    for c in candidatos:
        if c:
            return c
    return None


def extrair_time(equipe_dict):
    if not equipe_dict:
        return {"nome": "?", "escudo": "", "sigla": ""}
    nome = (
        equipe_dict.get("nome_popular")
        or equipe_dict.get("nome")
        or equipe_dict.get("sigla")
        or "?"
    )
    escudo = ""
    escudos = equipe_dict.get("escudos") or {}
    if isinstance(escudos, dict):
        for key in ("svg", "60x60", "30x30", "default", "url"):
            val = escudos.get(key)
            if val:
                escudo = val
                break
    if not escudo:
        escudo = equipe_dict.get("escudo") or ""
    return {
        "nome": nome,
        "escudo": escudo,
        "sigla": equipe_dict.get("sigla", ""),
    }


def extrair_estadio(jogo):
    candidatos = [
        (jogo.get("sede") or {}).get("nome_popular"),
        (jogo.get("sede") or {}).get("nome"),
        jogo.get("estadio"),
        (jogo.get("local") or {}).get("nome"),
    ]
    for c in candidatos:
        if c:
            return c
    return ""


def extrair_placar(jogo):
    """Retorna (mandante, visitante) ou (None, None) se não tem placar."""
    placar = jogo.get("placar_oficial")
    if isinstance(placar, dict):
        m = placar.get("mandante")
        v = placar.get("visitante")
        if m is not None and v is not None:
            return m, v

    pm = jogo.get("placar_oficial_mandante")
    pv = jogo.get("placar_oficial_visitante")
    if pm is not None and pv is not None:
        return pm, pv

    return None, None


def normalizar_jogo(jogo, num_rodada):
    equipes = jogo.get("equipes") or {}
    mandante = extrair_time(equipes.get("mandante") or jogo.get("mandante"))
    visitante = extrair_time(equipes.get("visitante") or jogo.get("visitante"))
    pm, pv = extrair_placar(jogo)

    return {
        "rodada": num_rodada,
        "data_iso": extrair_data_iso(jogo),
        "mandante": mandante,
        "visitante": visitante,
        "estadio": extrair_estadio(jogo),
        "placar_mandante": pm,
        "placar_visitante": pv,
    }


def main():
    inicio = agora_brasilia()
    ano = inicio.year

    print("=" * 70)
    print("Atualizacao dos resultados do Brasileirao")
    print("=" * 70)
    print(f"Inicio: {inicio.strftime('%d/%m/%Y %H:%M:%S BRT')}")
    print()

    print("Descobrindo ate qual rodada ja foi jogada:")
    ultima_rodada = descobrir_ultima_rodada_jogada()

    # Vai buscar de 1 a ultima_rodada (inclusive)
    rodadas_a_buscar = list(range(1, ultima_rodada + 1))
    if not rodadas_a_buscar:
        rodadas_a_buscar = [1]
    print(f"\nRodadas a buscar: 1 a {ultima_rodada} (total: {len(rodadas_a_buscar)} rodadas)")
    print()

    todos_resultados = []
    rodadas_ok = []

    for num in rodadas_a_buscar:
        try:
            crus = buscar_jogos_da_rodada(ano, num)
            if not isinstance(crus, list):
                print(f"  Rodada {num}: formato inesperado")
                continue

            disputados_da_rodada = 0
            for jogo_cru in crus:
                pm, pv = extrair_placar(jogo_cru)
                if pm is None or pv is None:
                    continue  # sem placar = ainda nao foi jogado
                normalizado = normalizar_jogo(jogo_cru, num)
                todos_resultados.append(normalizado)
                disputados_da_rodada += 1

            print(f"  Rodada {num}: {disputados_da_rodada} jogos com placar")
            rodadas_ok.append(num)

        except urllib.error.HTTPError as e:
            print(f"  Rodada {num}: HTTPError {e.code}")
        except Exception as e:
            print(f"  Rodada {num}: erro {type(e).__name__}: {e}")

    # Ordena do mais recente para o mais antigo (data decrescente)
    def chave(j):
        return j.get("data_iso") or "0000"
    todos_resultados.sort(key=chave, reverse=True)

    print()
    print(f"Total de jogos com resultado: {len(todos_resultados)}")

    # Lista de times únicos pro filtro do site
    times_unicos = set()
    for j in todos_resultados:
        if j["mandante"]["nome"]:
            times_unicos.add(j["mandante"]["nome"])
        if j["visitante"]["nome"]:
            times_unicos.add(j["visitante"]["nome"])

    fim = agora_brasilia()
    output = {
        "atualizado_em": fim.isoformat(),
        "atualizado_em_br": fim.strftime("%d/%m/%Y %H:%M BRT"),
        "fonte": "GloboEsporte",
        "ultima_rodada_disputada": ultima_rodada,
        "rodadas_consultadas": rodadas_ok,
        "total_resultados": len(todos_resultados),
        "times": sorted(list(times_unicos)),
        "resultados": todos_resultados,
    }

    with open("resultados.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print()
    print("=" * 70)
    print("resultados.json salvo com sucesso")
    print("=" * 70)
    print(f"Atualizado em: {output['atualizado_em_br']}")
    print(f"Ultima rodada disputada: {ultima_rodada}")
    print(f"Total de jogos com resultado: {len(todos_resultados)}")
    print(f"Times encontrados: {len(times_unicos)}")
    print()

    if todos_resultados:
        print("5 jogos mais recentes:")
        for j in todos_resultados[:5]:
            mand = j["mandante"]["nome"]
            visi = j["visitante"]["nome"]
            data = j.get("data_iso", "?")
            placar = f"{j['placar_mandante']} x {j['placar_visitante']}"
            print(f"  R{j['rodada']:>2} | {data} | {mand} {placar} {visi}")


if __name__ == "__main__":
    main()
