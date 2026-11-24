"""Certify exact AF revision on the public domain."""
import argparse,json,hashlib,time,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("--site-root",type=Path,required=True)
root=p.parse_args().site_root
manifest=json.loads((root/"dados-br/af-core-manifest.json").read_bytes())
n=manifest["concluidos"]
paths=("dados-br/af-core-manifest.json","resultados.json","tabela.json","dados-br/probabilidades-brasileirao.json")
for path in paths:
    expected=(root/path).read_bytes()
    for attempt in range(5):
        try:
            url="https://formuladogol.com.br/"+path+"?revision="+manifest["revision"]
            with urllib.request.urlopen(urllib.request.Request(url,headers={"Cache-Control":"no-cache","User-Agent":"FDG-R37-R1"}),timeout=20) as r:
                data=r.read()
            if hashlib.sha256(data).digest()==hashlib.sha256(expected).digest():break
            last="revision mismatch"
        except Exception as e:last=str(e)
        if attempt<4:time.sleep(3*(attempt+1))
    else:raise RuntimeError(f"AF Pages {path}: {last}")
prob=json.loads((root/paths[-1]).read_bytes())
assert prob["hash_entrada"]==manifest["hash_entrada"] and prob["calculado_em"]==manifest["calculado_em"]
assert prob["base_corrente"]["partidas_concluidas"]==n and prob["simulacao"]["quantidade"]==2000000
assert len(json.loads((root/"resultados.json").read_bytes())["resultados"])==n
print(f"PASS R37-R1 PAGES: {n}/{n} FINALs; 2,000,000 simulations; exact revision {manifest['revision']}")
