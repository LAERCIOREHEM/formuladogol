#!/usr/bin/env python3
"""
Script que busca os próximos jogos do Brasileirão e salva em jogos.json.

Roda no GitHub Actions, sem CORS, sem token.
Fluxo:
1. Pega o número da rodada atual em api.globoesporte.globo.com
2. Busca os jogos da rodada atual
3. Filtra: apenas jogos que ainda não aconteceram (status agendado, ou data >= hoje)
4. Se a rodada atual já acabou completamente, busca a próxima
5. Sempre tenta também a próxima rodada para mostrar o que vem por aí
6. Salva em jogos.json
"""

import json
import sys
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta


# ============================================================================
# CONFIGURAÇÕES
# ============================================================================

FUSO_BRASILIA = timezone(timedelta(hours=-3))

# UUID do Brasileirão Série A (mesmo usado pelo próprio site do GloboEsporte)
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

STATUS_AGENDADOS = {
    "AGENDADO", "PRE_JOGO", "PRÉ_JOGO", "SCHEDULED", "PRE_MATCH",
    "ADIADO",  # Jogo adiado também aparece como próximo
}

STATUS_FINALIZADOS = {
    "FIM_DE_JOGO", "ENCERRADO", "FINISHED", "FT", "ENCERRADA",
    "TERMINADO", "FINALIZADO",
}


# ============================================================================
# UTILITÁRIOS
# ============================================================================

def agora_brasilia():
    return datetime.now(FUSO_BRASILIA)


def fetch_json(url, timeout=20):
    """Baixa JSON de uma URL com headers de navegador."""
    separador = "&" if "?" in url else "?"
    url_anticache = f"{url}{separador}_={int(datetime.now().timestamp())}"

    req = urllib.request.Request(url_anticache, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        raw = resp.read().decode(charset, errors="replace")
        return json.loads(raw)


# ============================================================================
# BUSCA: rodada atual
# ============================================================================

def buscar_rodada_atual(ano):
    """
    Busca a rodada atualmente em curso no campeonato.
    Retorna o número da rodada (int).
    """
    url = (
        f"https://api.globoesporte.globo.com/tabela/{TUUID_BRASILEIRAO}/"
        f"fase/fase-unica-campeonato-brasileiro-{ano}/"
    )
    data = fetch_json(url)

    # A API retorna a rodada atual em "rodada_atual" ou similar.
    # Estrutura conhecida: data["rodada"] tem o número, ou data["fase"]["rodada_atual"]
    rodada = (
        data.get("rodada_atual")
        or data.get("rodada")
        or (data.get("fase") or {}).get("rodada_atual")
    )

    if isinstance(rodada, dict):
        rodada = rodada.get("numero") or rodada.get("rodada")

    if not rodada:
        # Fallback: tentar inferir pela tabela de classificação
        url_class = url + "classificacao/"
        try:
            classificacao = fetch_json(url_class)
            if isinstance(classificacao, list) and classificacao:
                jogos_disputados = [
                    int(item.get("jogos") or 0) for item in classificacao
                ]
                # Aproximação: rodada atual = max de jogos disputados
                rodada = max(jogos_disputados) if jogos_disputados else 1
                # Adiciona 1 se rodada já acabou (todos jogaram esse número)
                if jogos_disputados and min(jogos_disputados) == max(jogos_disputados):
                    rodada += 1
        except Exception:
            pass

    if not rodada:
        raise Exception("Não foi possível determinar a rodada atual")

    return int(rodada)


# ============================================================================
# BUSCA: jogos de uma rodada específica
# ============================================================================

def buscar_jogos_da_rodada(ano, numero_rodada):
    """
    Busca todos os jogos de uma rodada específica.
    Retorna a lista bruta de jogos da API.
    """
    url = (
        f"https://api.globoesporte.globo.com/tabela/{TUUID_BRASILEIRAO}/"
        f"fase/fase-unica-campeonato-brasileiro-{ano}/"
        f"rodada/{numero_rodada}/jogos/"
    )
    return fetch_json(url)


# ============================================================================
# NORMALIZAÇÃO de um jogo da API para nosso formato
# ============================================================================

def extrair_data_iso(jogo):
    """Tenta achar a data ISO do jogo em diferentes campos."""
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
    """Extrai nome e escudo de uma equipe."""
    if not equipe_dict:
        return {"nome": "?", "escudo": ""}

    nome = (
        equipe_dict.get("nome_popular")
        or equipe_dict.get("nome")
        or equipe_dict.get("sigla")
        or "?"
    )

    escudo = ""
    escudos = equipe_dict.get("escudos") or {}
    if isinstance(escudos, dict):
        # Tenta diferentes tamanhos
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
    """Tenta extrair o nome do estádio."""
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
    """Extrai informações de transmissão (TV/streaming)."""
    transmissao = jogo.get("transmissao") or {}

    # Lista de canais/streams
    canais = []

    # Pode estar em "label", "broadcast" ou similar
    label = transmissao.get("label") or transmissao.get("broadcast")
    if label:
        canais.append(label.strip())

    # Pode ter lista de "broadcasters"
    broadcasters = transmissao.get("broadcasters") or []
    if isinstance(broadcasters, list):
        for b in broadcasters:
            if isinstance(b, dict):
                nome = b.get("name") or b.get("nome")
                if nome:
                    canais.append(nome.strip())
            elif isinstance(b, str):
                canais.append(b.strip())

    # Remove duplicatas mantendo ordem
    seen = set()
    canais_unicos = []
    for c in canais:
        if c and c not in seen:
            seen.add(c)
            canais_unicos.append(c)

    return ", ".join(canais_unicos) if canais_unicos else ""


def extrair_status(jogo):
    """Extrai status do jogo, normalizado em maiúsculas."""
    status = (
        jogo.get("transmissao", {}).get("periodo")
        or jogo.get("status")
        or jogo.get("placar_oficial_visitante", None) is None and "AGENDADO"
        or "DESCONHECIDO"
    )
    if isinstance(status, str):
        return status.strip().upper().replace(" ", "_")
    return "DESCONHECIDO"


def jogo_ja_aconteceu(jogo_normalizado):
    """Decide se um jogo já aconteceu (não deve aparecer em 'próximos')."""
    status = jogo_normalizado["status"]
    if status in STATUS_FINALIZADOS:
        return True

    # Se tem placar definido, considera finalizado
    if jogo_normalizado.get("placar_mandante") is not None and jogo_normalizado.get("placar_visitante") is not None:
        # Mas só se a data já passou (jogos no futuro com placar 0x0 vazio são raros)
        return True

    # Se a data do jogo já passou há mais de 3 horas, considera finalizado
    data_iso = jogo_normalizado.get("data_iso")
    if data_iso:
        try:
            dt = datetime.fromisoformat(data_iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=FUSO_BRASILIA)
            agora = agora_brasilia()
            # Se o jogo começou há mais de 3 horas, considera que acabou
            if dt < agora - timedelta(hours=3):
                return True
        except Exception:
            pass

    return False


def normalizar_jogo(jogo, numero_rodada):
    """Converte um jogo cru da API no nosso formato simplificado."""
    equipes = jogo.get("equipes") or {}
    mandante = extrair_time(equipes.get("mandante") or jogo.get("mandante"))
    visitante = extrair_time(equipes.get("visitante") or jogo.get("visitante"))

    placar = jogo.get("placar_oficial") or {}
    placar_mandante = placar.get("mandante") if isinstance(placar, dict) else None
    placar_visitante = placar.get("visitante") if isinstance(placar, dict) else None

    # Tentar pegar placar de outros campos se não achou acima
    if placar_mandante is None:
        placar_mandante = jogo.get("placar_oficial_mandante")
    if placar_visitante is None:
        placar_visitante = jogo.get("placar_oficial_visitante")

    return {
        "rodada": numero_rodada,
        "data_iso": extrair_data_iso(jogo),
        "mandante": mandante,
        "visitante": visitante,
        "estadio": extrair_estadio(jogo),
        "transmissao": extrair_transmissao(jogo),
        "status": extrair_status(jogo),
        "placar_mandante": placar_mandante,
        "placar_visitante": placar_visitante,
    }


# ============================================================================
# MAIN
# ============================================================================

def main():
    inicio = agora_brasilia()
    ano = inicio.year

    print("=" * 70)
    print("Atualização dos próximos jogos do Brasileirão")
    print("=" * 70)
    print(f"Início em Brasília: {inicio.strftime('%d/%m/%Y %H:%M:%S BRT')}")
    print(f"Ano: {ano}")
    print()

    try:
        rodada_atual = buscar_rodada_atual(ano)
        print(f"Rodada atual identificada: {rodada_atual}")
    except Exception as e:
        print(f"AVISO: erro ao buscar rodada atual: {e}")
        print("Tentando rodada 1 como fallback")
        rodada_atual = 1

    rodadas_a_buscar = [rodada_atual, rodada_atual + 1]
    print(f"Rodadas a buscar: {rodadas_a_buscar}")
    print()

    todos_jogos = []
    rodadas_ok = []

    for num_rodada in rodadas_a_buscar:
        if num_rodada > 38:
            continue
        try:
            print(f"Buscando jogos da rodada {num_rodada}...")
            crus = buscar_jogos_da_rodada(ano, num_rodada)
            if not isinstance(crus, list):
                print(f"  Resposta inesperada (não é lista): {type(crus).__name__}")
                continue

            for jogo_cru in crus:
                normalizado = normalizar_jogo(jogo_cru, num_rodada)
                if not jogo_ja_aconteceu(normalizado):
                    todos_jogos.append(normalizado)

            rodadas_ok.append(num_rodada)
            print(f"  Rodada {num_rodada}: {len(crus)} jogos brutos")
        except urllib.error.HTTPError as e:
            print(f"  Erro HTTP {e.code} na rodada {num_rodada}")
        except Exception as e:
            print(f"  Erro na rodada {num_rodada}: {type(e).__name__}: {e}")

    # Ordena por data
    def chave_ordenacao(j):
        d = j.get("data_iso") or "9999"
        return d
    todos_jogos.sort(key=chave_ordenacao)

    print()
    print(f"Total de jogos futuros encontrados: {len(todos_jogos)}")

    # Monta o JSON final
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
    print(f"Rodada atual: {rodada_atual}")
    print(f"Rodadas consultadas: {rodadas_ok}")
    print(f"Total de jogos futuros: {len(todos_jogos)}")
    print()

    if todos_jogos:
        print("Próximos 5 jogos:")
        for j in todos_jogos[:5]:
            data = j.get("data_iso", "?")
            mand = j["mandante"]["nome"]
            visi = j["visitante"]["nome"]
            print(f"  R{j['rodada']:>2} | {data} | {mand} x {visi}")

    print()
    print("Concluído.")


if __name__ == "__main__":
    main()
