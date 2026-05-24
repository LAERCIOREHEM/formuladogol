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


def descobrir_rodada_a_partir_do_tabela_json():
    """
    Lê tabela.json (gerado pelo outro workflow) para descobrir a rodada atual.
    Mais confiável que chamar a API porque tabela.json sai do Terra.
    """
    try:
        with open("tabela.json", "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise Exception("tabela.json não encontrado")

    tabela = data.get("tabela") or []
    if not tabela:
        raise Exception("tabela.json sem dados")

    jogos_disputados = []
    for t in tabela:
        j = t.get("jogos")
        if isinstance(j, int):
            jogos_disputados.append(j)

    if not jogos_disputados:
        raise Exception("tabela.json não tem campo 'jogos' nos times")

    max_jogos = max(jogos_disputados)
    min_jogos = min(jogos_disputados)
    print(f"  tabela.json: jogos disputados min={min_jogos}, max={max_jogos}")

    if min_jogos == max_jogos:
        rodada = max_jogos + 1
        print(f"  Todos com {max_jogos} jogos -> proxima rodada a buscar = {rodada}")
    else:
        rodada = max_jogos
        print(f"  Diferenca {min_jogos}-{max_jogos} -> rodada em curso = {rodada}")

    return rodada


def descobrir_rodada_escaneando(ano):
    """
    Fallback final: escaneia da rodada 1 até a 38 e identifica a primeira
    em que TODOS os jogos ainda não foram disputados (ou pelo menos um).
    Isto é mais lento mas sempre funciona.
    """
    print("  Iniciando escaneamento (fallback final)...")
    for r in range(1, 39):
        try:
            jogos = buscar_jogos_da_rodada(ano, r)
            if not isinstance(jogos, list) or not jogos:
                continue
            disputados = sum(1 for j in jogos if tem_placar_definido(j))
            pendentes = len(jogos) - disputados
            print(f"  Rodada {r}: {disputados} disputados, {pendentes} pendentes")
            if pendentes > 0:
                # Achei a primeira rodada com pelo menos 1 jogo pendente
                return r
        except Exception as e:
            print(f"  Rodada {r}: erro ({type(e).__name__}: {e})")
            continue
    raise Exception("Escaneamento não achou rodadas com jogos pendentes (campeonato pode ter terminado)")


def buscar_rodada_atual(ano):
    """
    Determina a rodada atual em ordem de preferência:
    1. Lendo o tabela.json local (mais confiável)
    2. Via API de classificação (pode falhar)
    3. Escaneando rodadas até achar uma com jogo pendente (mais lento)
    """
    # Tentativa 1: tabela.json local
    try:
        return descobrir_rodada_a_partir_do_tabela_json()
    except Exception as e:
        print(f"  Falha ao usar tabela.json: {e}")

    # Tentativa 2: API classificacao
    try:
        url = (
            f"https://api.globoesporte.globo.com/tabela/{TUUID_BRASILEIRAO}/"
            f"fase/fase-unica-campeonato-brasileiro-{ano}/classificacao/"
        )
        classificacao = fetch_json(url)
        if isinstance(classificacao, list) and classificacao:
            jogos_disp = [int(it.get("jogos") or 0) for it in classificacao]
            if jogos_disp:
                max_j = max(jogos_disp)
                min_j = min(jogos_disp)
                print(f"  API classificacao: min={min_j}, max={max_j}")
                return (max_j + 1) if min_j == max_j else max_j
    except Exception as e:
        print(f"  Falha na API classificacao: {e}")

    # Tentativa 3: escaneamento
    return descobrir_rodada_escaneando(ano)


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
    Retorna True se o jogo tem placar gravado.
    ATENCAO: ter placar NAO significa que o jogo acabou — um jogo em
    andamento ja tem placar (ex: 1x0 no primeiro tempo). Para saber se
    o jogo realmente encerrou, use jogo_ja_encerrado().
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


# Tolerancia: tempo apos o INICIO do jogo a partir do qual consideramos
# que ele certamente ja terminou. Um jogo de futebol dura ~2h com
# intervalo, acrescimos e relatorio. 2h15 cobre com folga.
# Antes desse tempo, o jogo (mesmo com placar parcial) continua
# aparecendo em "Proximos Jogos" para o usuario saber que esta rolando.
TOLERANCIA_FIM_JOGO = timedelta(hours=2, minutes=15)


def parse_data_jogo(data_iso):
    """
    Converte a data ISO do jogo em datetime com fuso de Brasilia.
    Retorna None se nao conseguir interpretar.
    """
    if not data_iso:
        return None
    txt = str(data_iso).strip()
    # Formatos possiveis vindos da API
    formatos = [
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ]
    # Normaliza 'Z' (UTC) para +00:00
    txt_norm = txt.replace("Z", "+00:00")
    for fmt in formatos:
        try:
            dt = datetime.strptime(txt_norm, fmt)
            # Se veio sem fuso, assume horario de Brasilia
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=FUSO_BRASILIA)
            return dt.astimezone(FUSO_BRASILIA)
        except ValueError:
            continue
    # Tentativa final: fromisoformat
    try:
        dt = datetime.fromisoformat(txt_norm)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=FUSO_BRASILIA)
        return dt.astimezone(FUSO_BRASILIA)
    except (ValueError, TypeError):
        return None


def jogo_ja_encerrado(jogo_cru):
    """
    Decide se um jogo JA TERMINOU (e portanto deve sair de Proximos Jogos).

    Regra:
      - Se faz MAIS de 2h15 desde o inicio do jogo -> encerrado.
      - Se o jogo ainda esta dentro da janela de 2h15 (em andamento
        ou recem-acabado) -> NAO encerrado, continua em Proximos Jogos.
      - Se nao tem placar nenhum -> nao comecou, continua em Proximos.
      - Se nao foi possivel ler a data, cai no criterio antigo
        (tem placar = considera encerrado) para nao travar a lista.
    """
    tem_placar = tem_placar_definido(jogo_cru)

    # Sem placar: jogo nao comecou. Continua em Proximos Jogos.
    if not tem_placar:
        return False

    # Tem placar: precisa saber ha quanto tempo o jogo comecou.
    data_iso = extrair_data_iso(jogo_cru)
    inicio_jogo = parse_data_jogo(data_iso)

    if inicio_jogo is None:
        # Nao deu pra ler a data: usa o criterio antigo (tem placar = encerrado).
        return True

    agora = agora_brasilia()
    tempo_decorrido = agora - inicio_jogo

    # Passou da janela de 2h15 desde o inicio -> jogo encerrado.
    if tempo_decorrido >= TOLERANCIA_FIM_JOGO:
        return True

    # Ainda dentro da janela: jogo em andamento ou recem-acabado.
    # Mantem em Proximos Jogos para o usuario ver que esta rolando.
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
            encerrados = 0
            em_andamento = 0

            for jogo_cru in crus:
                # Um jogo so SAI de "Proximos Jogos" se ja terminou de verdade
                # (passou 2h15 do inicio). Jogo em andamento continua na lista.
                if jogo_ja_encerrado(jogo_cru):
                    encerrados += 1
                    continue
                normalizado = normalizar_jogo(jogo_cru, num)
                todos_jogos.append(normalizado)
                futuros += 1
                # Conta quantos dos que ficaram ja tem placar (estao rolando)
                if tem_placar_definido(jogo_cru):
                    em_andamento += 1

            print(f"  Rodada {num}: {encerrados} encerrados, "
                  f"{futuros} em Proximos Jogos ({em_andamento} em andamento)")
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
