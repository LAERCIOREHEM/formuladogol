"""Read-only baseline of the exact existing production Pages archive.
No sport/API requests, no deploy, no credentials, no push/email. The screenshots
are a local reproduction; a green run does not mean that the old UX meets SL02.
"""
import asyncio
import functools
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import threading
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.async_api import async_playwright

EXPECTED = "298ce3a9f0feca9c8c4dc4ab325b20628a299e92bea8854bb3c15a2460763c20"
BASE = "0b2c5987da35a16691d221b9c8928acaa509e977"
ROUTES = {
    "home": "/", "estatisticas": "/estatisticas.html",
    "jogos": "/jogos/", "resultados": "/resultados/", "tabela": "/tabela/",
    "aovivo": "/aovivo.html", "analises": "/analises/", "clubes": "/clubes.html",
    "acuracia": "/acuracia.html", "museu": "/museu.html", "agenda": "/agenda.html",
    "alertas": "/alertas.html", "sobre": "/sobre.html", "copa2026": "/copa2026/",
}
WIDTHS = (320, 360, 390, 430, 768, 1024, 1440)
REQUIRED = ("index.html", "estatisticas.html", "aovivo.html", "dados-br/af-core-manifest.json",
            "dados-br/probabilidades-brasileirao.json", "manifest.webmanifest", "sw.js",
            "jogos/index.html", "resultados/index.html", "tabela/index.html", "analises/index.html")

def sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

MEASURE = """() => {
 const nav=document.querySelector('nav[data-br-auth-menu], nav.nav, nav[aria-label="Menu principal"], .br-nav');
 const r=x=>{const b=x.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,right:b.right}};
 const labels=nav?[...nav.querySelectorAll('a,button')].filter(x=>x.getClientRects().length).map(x=>{
   const range=document.createRange();range.selectNodeContents(x);
   const style=getComputedStyle(x);
   return {text:x.innerText.trim(),client:x.clientWidth,scroll:x.scrollWidth,
     rect:r(x),textRect:range.getBoundingClientRect().toJSON(),
     overflowX:style.overflowX,whiteSpace:style.whiteSpace,wordBreak:style.wordBreak,
     textOverflow:style.textOverflow,fontSize:style.fontSize};
 }):[];
 return {title:document.title,pathname:location.pathname,client:document.documentElement.clientWidth,
  scroll:document.documentElement.scrollWidth,nav:nav?{client:nav.clientWidth,scroll:nav.scrollWidth,
  rect:r(nav),labels}:null};
}"""

async def browser_checks(site, out, origin):
    results=[]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(headless=True)
        sem=asyncio.Semaphore(3)
        async def visit(name,path,width,zoom):
            async with sem:
                # Equivalent effective CSS viewport at 200%; not native browser zoom.
                css_width=width//2 if zoom else width
                context=await browser.new_context(viewport={"width":css_width,"height":900},
                    device_scale_factor=2 if zoom else 1,service_workers="block")
                blocked=set(); errors=[]
                async def route_handler(route):
                    u=route.request.url
                    if u.startswith(origin+"/") and route.request.method in ("GET","HEAD"):
                        await route.continue_()
                    else:
                        from urllib.parse import urlsplit
                        blocked.add(urlsplit(u).netloc or "non-http")
                        await route.abort()
                await context.route("**/*",route_handler)
                page=await context.new_page()
                page.on("pageerror",lambda e: errors.append(str(e)[:160]))
                row={"route":name,"requested_width":width,"effective_css_width":css_width,
                     "zoom_equivalent":200 if zoom else 100}
                try:
                    resp=await page.goto(origin+path,wait_until="domcontentloaded",timeout=20000)
                    await page.wait_for_timeout(1000)
                    row.update(await page.evaluate(MEASURE))
                    row["http"]=resp.status if resp else None
                    row["blocked_external_hosts"]=sorted(blocked)
                    row["page_errors"]=errors[:12]
                    screenshot=f"{name}-{width}"+("-effective200" if zoom else "")+".png"
                    await page.screenshot(path=str(out/screenshot),animations="disabled",timeout=15000)
                    row["screenshot"]=screenshot
                    row["screenshot_sha256"]=sha(out/screenshot)
                except Exception as e:
                    row["capture_error"]=str(e)[:500]
                finally:
                    await context.close()
                print(f"{name} {width} {row.get('zoom_equivalent')} HTTP {row.get('http')} "
                      f"scroll {row.get('scroll')} capture {row.get('screenshot','ERROR')}",flush=True)
                return row
        jobs=[visit(n,ROUTES[n],w,False) for n in ("home","estatisticas") for w in WIDTHS]
        jobs += [visit(n,p,w,False) for n,p in ROUTES.items() if n not in ("home","estatisticas") for w in (390,1440)]
        jobs += [visit(n,ROUTES[n],w,True) for n in ("home","estatisticas") for w in (320,1440)]
        results=await asyncio.gather(*jobs)
        await browser.close()
    return results

def main():
    archive=Path(sys.argv[1]); out=Path(sys.argv[2]); out.mkdir(parents=True,exist_ok=True)
    assert sha(archive)==EXPECTED,"Pages ZIP hash mismatch"
    with tempfile.TemporaryDirectory(prefix="fdg-sl01-pages-") as t:
        temp=Path(t); site=temp/"site"; site.mkdir()
        with zipfile.ZipFile(archive) as z:
            assert z.namelist()==["artifact.tar"],"unexpected artifact structure"
            z.extract("artifact.tar",temp)
        with tarfile.open(temp/"artifact.tar") as tar:
            tar.extractall(site,filter="data")
        missing=[x for x in REQUIRED if not (site/x).is_file()]
        files=[{"path":p.relative_to(site).as_posix(),"size":p.stat().st_size,"sha256":sha(p)}
               for p in sorted(site.rglob("*")) if p.is_file()]
        inventory={"base_commit":BASE,"source_run":45806559507,"source_artifact":15110286620,
                   "zip_sha256":EXPECTED,"files":files,"required_missing":missing,
                   "af_core_bundle_present":(site/"dados-br/af-core-snapshot.json").is_file()}
        (out/"inventory.json").write_text(json.dumps(inventory,ensure_ascii=False,indent=2))
        assert not missing, f"Missing required baseline assets: {missing}"
        http=ThreadingHTTPServer(("127.0.0.1",0),functools.partial(Quiet,directory=str(site)))
        threading.Thread(target=http.serve_forever,daemon=True).start()
        try:
            results=asyncio.run(browser_checks(site,out,f"http://127.0.0.1:{http.server_port}"))
        finally:
            http.shutdown();http.server_close()
        report={"scope":"local reproduction of immutable public Pages archive; external hosts blocked; 200% equivalent effective viewport, not native zoom",
                "base_commit":BASE,"baseline_only":True,"deploy":False,"capture_count":len(results),
                "results":results}
        (out/"measurements.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
        assert len(results)==42
        failed=[r["route"]+":"+str(r["requested_width"]) for r in results
                if "screenshot" not in r or r.get("http")!=200]
        assert not failed,f"Baseline evidence not captured: {failed}"
        print("SL01 BASELINE CAPTURE COMPLETE: 42 screenshots; existing UX defects are recorded, not fixed.")
if __name__=="__main__":
    main()
