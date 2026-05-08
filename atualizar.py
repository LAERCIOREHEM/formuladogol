#!/usr/bin/env python3
"""
Script que busca a tabela do Brasileirão e salva em tabela.json.
Roda no servidor do GitHub Actions, sem CORS, sem proxy.
Tenta múltiplas fontes em ordem de preferência.
"""
import json
import sys
from datetime import datetime, timezone, timedelta
import urllib.request
import urllib.error
import re
from html.parser import HTMLParser


# Headers para parecer um navegador normal (alguns sites bloqueiam Python sem isso)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
}


def fetch(url, timeout=30, max_tentativas=3):
    """
    Baixa o conteúdo de uma URL com headers de navegador.
    Faz até max_tentativas (padrão 3) com timeout aumentado a cada falha.
    Resolve instabilidade transitória de sites como o Terra.
    """
    import time
    ultimo_erro = None
    for tentativa in range(1, max_tentativas + 1):
        try:
            timeout_atual = timeout + (tentativa - 1) * 10  # 30s, 40s, 50s
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout_atual) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as e:
            ultimo_erro = e
            if tentativa < max_tentativas:
                print(f"  Tentativa {tentativa}/{max_tentativas} falhou ({type(e).__name__}: {e}). Aguardando...")
                time.sleep(2 * tentativa)  # 2s, 4s
                continue
    raise ultimo_erro


# ============================================================================
# FONTE 1: Terra (mesmo formato da macro original)
# ============================================================================
class TerraParser(HTMLParser):
    """Parser do HTML do Terra para extrair a tabela do Brasileirão."""
    def __init__(self):
        super().__init__()
        self.in_tbody = False
        self.in_td = False
        self.current_row = []
        self.current_cell = ""
        self.tables = []
        self.current_table = []
        self.in_table = False

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.in_table = True
            self.current_table = []
        elif tag == "tbody" and self.in_table:
            self.in_tbody = True
        elif tag == "tr" and self.in_tbody:
            self.current_row = []
        elif tag == "td" and self.in_tbody:
            self.in_td = True
            self.current_cell = ""

    def handle_endtag(self, tag):
        if tag == "td" and self.in_td:
            self.in_td = False
            self.current_row.append(self.current_cell.strip())
        elif tag == "tr" and self.in_tbody and self.current_row:
            self.current_table.append(self.current_row)
            self.current_row = []
        elif tag == "tbody":
            self.in_tbody = False
        elif tag == "table":
            if self.current_table:
                self.tables.append(self.current_table)
            self.in_table = False

    def handle_data(self, data):
        if self.in_td:
            self.current_cell += data


def buscar_terra():
    """Busca a tabela no Terra. Retorna lista de dicts ou None se falhar."""
    url = "https://www.terra.com.br/esportes/futebol/brasileiro-serie-a/tabela/"
    html = fetch(url)
    parser = TerraParser()
    parser.feed(html)

    # Procura a tabela com 20 linhas (a tabela de classificação)
    tabela_certa = None
    for t in parser.tables:
        if len(t) == 20:
            tabela_certa = t
            break

    if not tabela_certa:
        # Pega a maior tabela disponível
        tabela_certa = max(parser.tables, key=len, default=None)
        if not tabela_certa or len(tabela_certa) < 20:
            raise Exception(f"Tabela do Terra com formato inesperado ({len(tabela_certa) if tabela_certa else 0} linhas)")

    resultado = []
    for linha in tabela_certa:
        # Estrutura típica: pos | (img) | nome | tendência | P | J | V | E | D | GP | GC | SG | %
        if len(linha) < 12:
            continue
        try:
            pos = int(linha[0])
        except (ValueError, IndexError):
            continue

        # Nome do time: limpa lixo como ">>" e espaços
        nome = re.sub(r"[>«»]+", "", linha[2]).strip()
        if not nome:
            nome = re.sub(r"[>«»]+", "", linha[1]).strip()

        # Os últimos 9 valores numéricos são: P, J, V, E, D, GP, GC, SG, %
        nums = []
        for c in linha:
            try:
                nums.append(int(c))
            except (ValueError, TypeError):
                pass

        if len(nums) < 9:
            continue

        # Ordem dos números (do final pra trás): %, SG, GC, GP, D, E, V, J, P
        # Pegando da posição -9 em diante:
        relevantes = nums[-9:]
        p, j, v, e, d, gp, gc, sg, perc = relevantes

        resultado.append({
            "pos": pos,
            "time": nome,
            "pontos": p,
            "jogos": j,
            "vitorias": v,
            "empates": e,
            "derrotas": d,
            "gp": gp,
            "gc": gc,
            "sg": sg,
            "aproveitamento": perc,
        })

    if len(resultado) != 20:
        raise Exception(f"Esperava 20 times, obtive {len(resultado)}")

    # Ordena por posição
    resultado.sort(key=lambda x: x["pos"])
    return resultado


# ============================================================================
# FONTE 2: API do GloboEsporte (oficial, JSON, mas formato pode mudar)
# ============================================================================
def buscar_globoesporte():
    """Busca a tabela na API oficial do GloboEsporte. Tolera formatos lista e dict."""
    ano_atual = datetime.now().year
    url = f"https://api.globoesporte.globo.com/tabela/d1a37fa4-e948-43a6-ba53-ab24ab3a45b1/fase/fase-unica-campeonato-brasileiro-{ano_atual}/classificacao/"
    raw = fetch(url)
    data = json.loads(raw)

    # A API pode retornar uma lista direta, ou um dict com a lista dentro de alguma chave.
    # Tentamos várias estratégias para extrair a lista de clubes.
    lista_clubes = None

    if isinstance(data, list):
        lista_clubes = data
    elif isinstance(data, dict):
        # Procura nas chaves mais comuns onde a lista pode estar
        for chave in ("classificacao", "tabela", "items", "data", "results", "ranking"):
            if chave in data and isinstance(data[chave], list):
                lista_clubes = data[chave]
                print(f"  Lista encontrada em data['{chave}']")
                break
        # Fallback: pega a primeira lista de tamanho 20 que encontrar dentro do dict
        if lista_clubes is None:
            for chave, valor in data.items():
                if isinstance(valor, list) and len(valor) == 20:
                    lista_clubes = valor
                    print(f"  Lista de 20 clubes encontrada em data['{chave}']")
                    break

    if not isinstance(lista_clubes, list):
        chaves = list(data.keys()) if isinstance(data, dict) else []
        raise Exception(
            f"Formato inesperado da API GloboEsporte: tipo={type(data).__name__}, "
            f"chaves={chaves[:10]}"
        )

    if len(lista_clubes) != 20:
        raise Exception(f"Lista do GloboEsporte tem {len(lista_clubes)} itens, esperado 20")

    resultado = []
    for item in lista_clubes:
        # Estrutura típica do GE: cada item tem "equipe" ou "clube" com os dados do time
        clube = item.get("equipe", {}) or item.get("clube", {}) or item.get("time", {})
        nome = (
            clube.get("nome_popular")
            or clube.get("nome")
            or clube.get("sigla")
            or item.get("nome_popular")
            or item.get("nome")
            or ""
        )
        resultado.append({
            "pos": item.get("ordem") or item.get("posicao") or item.get("colocacao", 0),
            "time": nome,
            "pontos": item.get("pontos", 0),
            "jogos": item.get("jogos", 0),
            "vitorias": item.get("vitorias", 0),
            "empates": item.get("empates", 0),
            "derrotas": item.get("derrotas", 0),
            "gp": item.get("gols_pro", 0),
            "gc": item.get("gols_contra", 0),
            "sg": item.get("saldo_gols", 0),
            "aproveitamento": int(float(item.get("aproveitamento", 0) or 0)),
        })

    resultado.sort(key=lambda x: x["pos"])
    return resultado


# ============================================================================
# FONTE 3: ESPN Brasil (backup adicional)
# ============================================================================
def buscar_espn():
    """Busca via ESPN Brasil. Backup adicional."""
    url = "https://www.espn.com.br/futebol/classificacao/_/liga/bra.1"
    html = fetch(url)
    # Procurar JSON embutido com a tabela
    match = re.search(r'window\["__espnfitt__"\]\s*=\s*({.+?});</script>', html, re.DOTALL)
    if not match:
        raise Exception("Não encontrou dados embutidos na ESPN")
    data = json.loads(match.group(1))
    # Navegar até a tabela (estrutura interna varia, isto é uma tentativa)
    raise Exception("Parser da ESPN não implementado completamente")


# ============================================================================
# Normalização de nomes — para casar com os times escolhidos no bolão
# ============================================================================
NORMALIZACAO_NOMES = {
    "Atlético Mineiro": "Atlético-MG",
    "Atletico Mineiro": "Atlético-MG",
    "Atletico-MG": "Atlético-MG",
    "Athletico Paranaense": "Athletico-PR",
    "Athletico-PR": "Athletico-PR",
    "Atlético Paranaense": "Athletico-PR",
    "Red Bull Bragantino": "Bragantino",
    "RB Bragantino": "Bragantino",
    "Vasco": "Vasco da Gama",
    "São Paulo": "São Paulo",
    "Sao Paulo": "São Paulo",
    "Grêmio": "Grêmio",
    "Gremio": "Grêmio",
    "Vitória": "Vitória",
    "Vitoria": "Vitória",
    "Goiás": "Goiás",
    "Ceará": "Ceará",
    "Fortaleza": "Fortaleza",
    "Cuiabá": "Cuiabá",
    "Juventude": "Juventude",
}


def normalizar_nome(nome):
    """Normaliza nomes de times para um formato consistente."""
    nome = nome.strip()
    return NORMALIZACAO_NOMES.get(nome, nome)


# ============================================================================
# MAIN
# ============================================================================
def main():
    fontes = [
        ("Terra", buscar_terra),
        ("GloboEsporte", buscar_globoesporte),
    ]

    erros = []
    tabela = None
    fonte_usada = None

    for nome_fonte, fn in fontes:
        try:
            print(f"Tentando {nome_fonte}...")
            tabela = fn()
            fonte_usada = nome_fonte
            print(f"✓ Sucesso via {nome_fonte}: {len(tabela)} times")
            break
        except Exception as e:
            erro_str = f"{nome_fonte}: {type(e).__name__}: {e}"
            print(f"✗ {erro_str}")
            erros.append(erro_str)

    if not tabela:
        print("\nERRO: Todas as fontes falharam!")
        print("\n".join(erros))
        sys.exit(1)

    # Normaliza nomes de times
    for t in tabela:
        t["time"] = normalizar_nome(t["time"])

    # Monta o JSON final
    fuso_brasilia = timezone(timedelta(hours=-3))
    output = {
        "atualizado_em": datetime.now(fuso_brasilia).isoformat(),
        "fonte": fonte_usada,
        "tabela": tabela,
    }

    # Salva no arquivo tabela.json
    with open("tabela.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n✓ Arquivo tabela.json salvo com sucesso!")
    print(f"  Atualizado em: {output['atualizado_em']}")
    print(f"  Fonte: {fonte_usada}")
    print(f"  Times: {len(tabela)}")
    print(f"\n  Top 5:")
    for t in tabela[:5]:
        print(f"    {t['pos']}º {t['time']} - {t['pontos']} pts ({t['jogos']} jogos)")


if __name__ == "__main__":
    main()
