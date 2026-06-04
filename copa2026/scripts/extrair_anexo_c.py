# -*- coding: utf-8 -*-
"""
extrair_anexo_c.py — (RE)gera dados/terceiros_map.json a partir da tabela
oficial das 495 combinações do Anexo C (Wikipedia / Regulamento FIFA 2026).

IMPORTANTE: o arquivo dados/terceiros_map.json JÁ VEM PRONTO E VALIDADO no
pacote. Você só precisa rodar isto se quiser reconferir ou regerar.

POR QUE QUEBRAVA (HTTP 403): o pandas.read_html(URL) baixa a página com o
"User-Agent" padrão do Python, e a Wikipedia recusa esse agente (403 Forbidden).
A correção é baixar o HTML com 'requests' usando um User-Agent de navegador e
só então entregar o HTML ao pandas.

COMO RODAR (no Terminal, dentro de copa2026/scripts):
    pip install requests pandas lxml
    python extrair_anexo_c.py
    # (no Windows pode ser 'py' no lugar de 'python')

SEM INTERNET? Abra a página no navegador, salve como .html e rode:
    python extrair_anexo_c.py pagina_salva.html
"""

import sys, re, json, io, os

URL = "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage"
SAIDA = os.path.join(os.path.dirname(__file__), "..", "dados", "terceiros_map.json")

# Ordem das colunas de vaga no Anexo C (esquerda -> direita)
SLOTS = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"]
# Elegibilidade de cada vaga (de qual grupo pode vir o 3º colocado)
ELEG = {
    "1A": set("CEFHI"), "1B": set("EFGIJ"), "1D": set("BEFIJ"), "1E": set("ABCDF"),
    "1G": set("AEHIJ"), "1I": set("CDFGH"), "1K": set("DEIJL"), "1L": set("EHIJK"),
}


def baixar_html():
    """Baixa o HTML da Wikipedia com User-Agent de navegador (evita o 403)."""
    import requests
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/124.0 Safari/537.36",
        "Accept-Language": "en;q=0.9",
    }
    print("Baixando:", URL)
    r = requests.get(URL, headers=headers, timeout=30)
    r.raise_for_status()
    return r.text


def carregar_html():
    """Usa um arquivo local se passado como argumento; senão baixa da web."""
    if len(sys.argv) > 1:
        caminho = sys.argv[1]
        print("Lendo arquivo local:", caminho)
        with open(caminho, encoding="utf-8") as f:
            return f.read()
    return baixar_html()


def achar_tabela(html):
    """Acha a tabela das 495 combinações dentro do HTML."""
    import pandas as pd
    # match= filtra para a tabela que contém esse texto
    tabelas = pd.read_html(io.StringIO(html), match="Third-placed teams advance")
    if not tabelas:
        tabelas = pd.read_html(io.StringIO(html))
    # escolhe a maior (a do Anexo C tem ~495 linhas)
    return max(tabelas, key=len)


def parse_tabela(df):
    """Converte cada linha em {chave_de_8_grupos: {vaga: grupo_do_3o}}."""
    mapa, erros = {}, []
    for _, linha in df.iterrows():
        celulas = [str(c).strip() for c in linha.tolist()]
        grupos, atrib = [], []
        for c in celulas:
            if re.fullmatch(r"[A-L]", c):
                grupos.append(c)
            else:
                m = re.fullmatch(r"3\s*([A-L])", c)
                if m:
                    atrib.append(m.group(1))
        if len(grupos) != 8 or len(atrib) != 8:
            continue  # linha de cabeçalho ou ruído
        gset = set(grupos)
        if len(gset) != 8 or set(atrib) != gset:
            erros.append(f"linha inconsistente: {grupos} -> {atrib}")
            continue
        d = {}
        for slot, g in zip(SLOTS, atrib):
            if g not in ELEG[slot]:
                erros.append(f"{slot}=3{g} fora da elegibilidade")
            d[slot] = g
        mapa["".join(sorted(gset))] = d
    return mapa, erros


def main():
    try:
        html = carregar_html()
    except Exception as e:
        print("\nERRO ao obter a página:", e)
        print("Sem internet? Salve a página como .html e rode:")
        print("   python extrair_anexo_c.py pagina_salva.html")
        sys.exit(1)

    df = achar_tabela(html)
    mapa, erros = parse_tabela(df)

    print("Combinações lidas:", len(mapa))
    print("Erros de validação:", len(erros))
    for e in erros[:15]:
        print("  -", e)

    if len(mapa) != 495 or erros:
        print("\nNÃO gravei: esperava 495 combinações sem erros.")
        print("Confira a fonte. (O terceiros_map.json que já vem no pacote está validado.)")
        sys.exit(1)

    out = {
        "_nota": "Anexo C oficial (495 combinações), validado por bijeção e elegibilidade.",
        "_ordem_vagas": SLOTS,
        "mapa": mapa,
    }
    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("\nOK: 495 combinações gravadas em", os.path.normpath(SAIDA))


if __name__ == "__main__":
    main()
