#!/usr/bin/env python3
"""
Script que busca os próximos jogos do Brasileirão e salva em jogos.json.

Estratégia:
1. Descobre a rodada atual via classificação (max de jogos disputados).
2. Busca jogos das rodadas: atual, atual+1 e atual+2.
3. Considera jogo "futuro" se NÃO tem placar definido (independente do status).
4. Loga o JSON cru das primeiras respostas pra debug em caso de falha.
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
    """Baixa JSON com headers de navegador e anti-cache."""
    sep = "&" if "?" in url else "?"
    url_full = f"{url}{sep}_={int(datetime.now().timestamp())}"
    req = urllib.request.Request(url_full, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        raw = resp.read().decode(charset, errors="replace")
        return json.loads(raw)


def buscar_rodada_atual(ano):
    """
    Determina a rodada atual a partir da classificação.
    """
    url = (
        f"https://api.globoesporte.globo.com/tabela/{TUUID_BRASILEIRAO}/"
        f"fase/fase-unica-campeonato-brasileiro-{ano}/classificacao/"
    )
    classificacao = fetch_json(url)

    if not isinstance(classificacao, list) or not classificacao:
        raise Exception("Classificação retornou vazia ou em formato inesperado")

    jogos_disputados = []
    for item in classificacao:
        j = item.get("jogos") or 0
        try:
            jogos_disputados.append(int(j))
        except (ValueError, TypeError):
            pass

    if not jogos_disputados:
        raise Exception("Nenhum dado de jogos disputados na classificação")

    max_jogos = max(jogos_disputados)
    min_jogos = min(jogos_disputados)

    print(f"  Jogos disputados: min={min_jogos}, max={max_jogos}")

    # Se todos jogaram o mesmo número, a rodada acabou e já entramos na próxima.
    if min_jogos == max_jogos:
        rodada_atual = max_jogos + 1
        print(f"  Todos com {max_jogos} jogos disputados -> rodada atual = {rodada_atual}")
    else:
        rodada_atual = max_jogos
        print(f"  Diferenca entre {min_jogos} e {max_jogos} -> rodada atual = {rodada_atual}")

    return rodada_atual


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
        (jogo.get("transmissao") or {}).get("data"),
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


def extrair_transmissao(jogo):
    transmissao = jogo.get("transmissao") or {}
    canais = []
    label = transmissao.get("label") or transmissao.get("broadcast")
    if label:
        canais.append(label.strip())
    broadcasters = transmissao.get("broadcasters") or []
    if isinstance(broadcasters, list):
        for b in broadcasters:
            if isinstance(b, dict):
                nome = b.get("name") or b.get("nome")
                if nome:
                    canais.append(nome.strip())
            elif isinstance(b, str):
                canais.append(b.strip())
    seen = set()
    out = []
    for c in canais:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return ", ".join(out)


def tem_placar_definido(jogo):
    """
    Retorna True se o jogo tem placar gravado (já foi disputado).
    """
    placar = jogo.get("placar_oficial")
    if isinstance(placar, dict):
        m = placar.get("mandante")
        v = placar.get("visitante")
        if m is not None and v is not None:
            return True

    pm = jogo.get("placar_oficial_mandante")
    pv = jogo.get("placar_oficial_visitante")
    if pm is not None and pv is not None:
        return True

    equipes = jogo.get("equipes") or {}
    m_equipe = equipes.get("mandante") or {}
    v_equipe = equipes.get("visitante") or {}
    if (m_equipe.get("placar_oficial") is not None
            and v_equipe.get("placar_oficial") is not None):
        return True

    return False


def normalizar_jogo(jogo, num_rodada):
    equipes = jogo.get("equipes") or {}
    mandante = extrair_time(equipes.get("mandante") or jogo.get("mandante"))
    visitante = extrair_time(equipes.get("visitante") or jogo.get("visitante"))

    placar = jogo.get("placar_oficial") or {}
    pm = placar.get("mandante") if isinstance(placar, dict) else None
    pv = placar.get("visitante") if isinstance(placar, dict) else None
    if pm is None:
        pm = jogo.get("placar_oficial_mandante")
    if pv is None:
        pv = jogo.get("placar_oficial_visitante")

    return {
        "rodada": num_rodada,
        "data_iso": extrair_data_iso(jogo),
        "mandante": mandante,
        "visitante": visitante,
        "estadio": extrair_estadio(jogo),
        "transmissao": extrair_transmissao(jogo),
        "status": jogo.get("status") or "",
        "placar_mandante": pm,
        "placar_visitante": pv,
    }


def main():
    inicio = agora_brasilia()
    ano = inicio.year

    print("=" * 70)
    print("Atualização dos próximos jogos do Brasileirão")
    print("=" * 70)
    print(f"Início: {inicio.strftime('%d/%m/%Y %H:%M:%S BRT')}")
    print()

    try:
        print("Descobrindo rodada atual via classificação:")
        rodada_atual = buscar_rodada_atual(ano)
    except Exception as e:
        print(f"ERRO ao descobrir rodada atual: {type(e).__name__}: {e}")
        print("Tentando rodada 1 como fallback")
        rodada_atual = 1

    rodadas = [r for r in (rodada_atual, rodada_atual + 1, rodada_atual + 2) if 1 <= r <= 38]
    print(f"\nRodadas a buscar: {rodadas}")
    print()

    todos_jogos = []
    rodadas_ok = []
    primeiro_jogo_logado = False

    for num in rodadas:
        try:
            print(f"Buscando rodada {num}...")
            crus = buscar_jogos_da_rodada(ano, num)

            if not isinstance(crus, list):
                print(f"  Formato inesperado: {type(crus).__name__}")
                continue

            print(f"  {len(crus)} jogos brutos retornados")

            # Loga estrutura do primeiro jogo (DEBUG)
            if not primeiro_jogo_logado and crus:
                primeiro_jogo_logado = True
                print(f"  Estrutura do 1o jogo bruto (debug):")
                texto = json.dumps(crus[0], ensure_ascii=False, indent=2)
                if len(texto) > 2500:
                    texto = texto[:2500] + "...[truncado]"
                for linha in texto.split("\n"):
                    print("  " + linha)

            futuros = 0
            disputados = 0

            for jogo_cru in crus:
                if tem_placar_definido(jogo_cru):
                    disputados += 1
                    continue
                normalizado = normalizar_jogo(jogo_cru, num)
                todos_jogos.append(normalizado)
                futuros += 1

            print(f"  Rodada {num}: {disputados} ja disputados, {futuros} pendentes")
            rodadas_ok.append(num)

        except urllib.error.HTTPError as e:
            print(f"  HTTPError {e.code} na rodada {num}")
        except Exception as e:
            print(f"  Erro na rodada {num}: {type(e).__name__}: {e}")

    def chave(j):
        return j.get("data_iso") or "9999"
    todos_jogos.sort(key=chave)

    print()
    print(f"Total de jogos pendentes encontrados: {len(todos_jogos)}")

    fim = agora_brasilia()
    output = {
        "atualizado_em": fim.isoformat(),
        "atualizado_em_br": fim.strftime("%d/%m/%Y %H:%M BRT"),
        "fonte": "GloboEsporte",
        "rodada_atual": rodada_atual,
        "rodadas_consultadas": rodadas_ok,
        "total_jogos": len(todos_jogos),
        "jogos": todos_jogos,
    }

    with open("jogos.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print()
    print("=" * 70)
    print("jogos.json salvo com sucesso")
    print("=" * 70)
    print(f"Atualizado em: {output['atualizado_em_br']}")
    print(f"Rodada atual identificada: {rodada_atual}")
    print(f"Rodadas consultadas: {rodadas_ok}")
    print(f"Total de jogos pendentes: {len(todos_jogos)}")
    print()

    if todos_jogos:
        print("Proximos 5 jogos:")
        for j in todos_jogos[:5]:
            mand = j["mandante"]["nome"]
            visi = j["visitante"]["nome"]
            data = j.get("data_iso", "?")
            print(f"  R{j['rodada']:>2} | {data} | {mand} x {visi}")
    else:
        print("AVISO: Nenhum jogo pendente foi encontrado.")
        print("Verifique a estrutura do '1o jogo bruto' nos logs acima.")


if __name__ == "__main__":
    main()
