"""One bounded read-only audit of public domain; no redirects, APIs, auth or retries."""
import argparse,json,urllib.request,urllib.error
from pathlib import Path
from certification import sha,validate_core,repository_core
BASE="https://formuladogol.com.br/"
PATHS=("dados-br/af-core-manifest.json","dados-br/af-core-snapshot.json","dados-br/probabilidades-jogos.json","index.html","acuracia.html","tabela/","resultados/","dados-br/af-core-manifest.json")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kw):return None
def run(out):
    opener=urllib.request.build_opener(NoRedirect);items=[];docs={}
    for i,path in enumerate(PATHS):
        try:
            req=urllib.request.Request(BASE+path,headers={"User-Agent":"FDG-E12-readonly-audit/1.0","Cache-Control":"no-cache","Accept":"application/json" if path.endswith(".json") else "text/html"})
            with opener.open(req,timeout=12) as res:
                b=res.read(12_000_001);assert len(b)<=12_000_000
                item={"path":path,"status":res.status,"sha256":sha(b),"bytes":len(b)}
                if path.endswith(".json"):
                    j=json.loads(b);docs[i]=j
                else:item["html"]=b"<html" in b.lower() or b"<!doctype html" in b.lower()
            items.append(item)
        except Exception as e:items.append({"path":path,"status":getattr(e,"code",None),"error":type(e).__name__})
    result={"requests_attempted":len(PATHS),"observations":items,"consistent_public_core":False,"matches_repo_revision":False,"public_af13":False,"deep_links_ok":False,"new_release_deployed":False}
    try:
        assert docs[0]==docs[7]
        q=validate_core(docs[0],docs[1]);result["core"]=q;result["consistent_public_core"]=True;result["matches_repo_revision"]=q["revision"]==repository_core()["revision"]
        result["public_af13"]=docs[2]["temporada"]==2026 and docs[2]["versao_modelo"]=="AF-Previsão 1.3"
        result["standalone_forecast_matches_bundle"]=docs[2]==docs[1]["files"]["dados-br/probabilidades-jogos.json"]
    except Exception as e:result["core_error"]=type(e).__name__
    result["deep_links_ok"]=all(items[i].get("status")==200 and items[i].get("html") for i in (3,4,5,6))
    out.write_text(json.dumps(result,sort_keys=True)+"\n");print("E12 PUBLIC READONLY",json.dumps(result,sort_keys=True))
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("out",type=Path);run(p.parse_args().out)
