import re, json

txt = open("relatorio-auditoria-copa2026__1_.txt", encoding="utf-8").read()
blocos = re.split(r'PARTICIPANTE:\s*', txt)[1:]

palpites = {}
for b in blocos:
    nome = b.split("\n")[0].strip()
    mhash = re.search(r'SHA-256\):\s*([a-f0-9]{64})', b)
    h = mhash.group(1) if mhash else None

    def lista(rotulo):
        m = re.search(rotulo + r'[^:]*:\s*([A-Z, ]+)', b)
        if not m: return []
        return [s.strip() for s in m.group(1).split(",") if s.strip()]

    c32 = lista(r'Classificados \(32\)')
    o16 = lista(r'Oitavas \(16\)')
    q8  = lista(r'Quartas \(8\)')
    s4  = lista(r'Semifinal \(4\)')
    f2  = lista(r'Final \(2\)')
    mp = re.search(r'PÓDIO:\s*1º\s*(\w+)\s*\|\s*2º\s*(\w+)\s*\|\s*3º\s*(\w+)\s*\|\s*4º\s*(\w+)', b)
    podio = list(mp.groups()) if mp else []

    # também extrai os melhores 3ºs (vem dos classificados que são 3º de grupo)
    # e os placares de grupo (pra derivar posições 1/2/3/4 e os 3ºs)
    grupos = {}
    for linha in re.findall(r'^\s*([A-L]):\s*(.+)$', b, re.MULTILINE):
        g, jogos_txt = linha
        jogos = []
        for j in jogos_txt.split("|"):
            mj = re.match(r'\s*(\w+)\s+(\d+)x(\d+)\s+(\w+)', j.strip())
            if mj:
                a, ga, gb, bb = mj.groups()
                jogos.append([a, int(ga), int(gb), bb])
        grupos[g] = jogos

    palpites[nome] = {
        "hash": h,
        "classificados32": c32,
        "avancam_oitavas": o16,
        "avancam_quartas": q8,
        "semifinalistas": s4,
        "finalistas": f2,
        "campeao": podio[0] if len(podio)==4 else None,
        "vice": podio[1] if len(podio)==4 else None,
        "terceiro": podio[2] if len(podio)==4 else None,
        "quarto": podio[3] if len(podio)==4 else None,
        "grupos": grupos
    }

# validação completa
print("=== VALIDAÇÃO DA EXTRAÇÃO ===")
problemas = 0
for nome, p in palpites.items():
    erros = []
    if len(p["classificados32"]) != 32: erros.append(f"c32={len(p['classificados32'])}")
    if len(p["avancam_oitavas"]) != 16: erros.append(f"o16={len(p['avancam_oitavas'])}")
    if len(p["avancam_quartas"]) != 8: erros.append(f"q8={len(p['avancam_quartas'])}")
    if len(p["semifinalistas"]) != 4: erros.append(f"s4={len(p['semifinalistas'])}")
    if len(p["finalistas"]) != 2: erros.append(f"f2={len(p['finalistas'])}")
    if not p["campeao"]: erros.append("sem campeao")
    if len(p["grupos"]) != 12: erros.append(f"grupos={len(p['grupos'])}")
    # consistência: campeão deve estar nos finalistas, finalistas nos semis, etc.
    if p["campeao"] and p["campeao"] not in p["finalistas"]: erros.append("campeao fora de finalistas")
    if p["vice"] and p["vice"] not in p["finalistas"]: erros.append("vice fora de finalistas")
    for f in p["finalistas"]:
        if f not in p["semifinalistas"]: erros.append(f"finalista {f} fora de semis")
    if erros:
        print(f"  ✗ {nome}: {', '.join(erros)}")
        problemas += 1
if problemas == 0:
    print(f"  ✓ TODOS os {len(palpites)} extraídos e consistentes")
    print(f"    (campeão∈finalistas∈semis, 32/16/8/4/2 corretos, 12 grupos)")

json.dump(palpites, open("/tmp/palpites_mata.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"\nArquivo gerado: palpites_mata.json ({len(palpites)} apostadores)")
