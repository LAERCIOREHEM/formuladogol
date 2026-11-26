import argparse, contextlib, http.server, json, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
def main():
    p=argparse.ArgumentParser();p.add_argument("--site",type=Path,required=True);p.add_argument("--out",type=Path,required=True);a=p.parse_args()
    a.out.mkdir(exist_ok=False)
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(a.site),**kwargs)
        def log_message(self,*args):pass
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f"http://127.0.0.1:{server.server_port}/"
    tests=[]
    def ok(name,cond):
        assert cond,name
        tests.append(name)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for width,height in ((1440,1000),(390,844),(320,800)):
            ctx=browser.new_context(viewport={"width":width,"height":height},locale="pt-BR")
            page=ctx.new_page();errors=[];external=[]
            page.on("pageerror",lambda e:errors.append(str(e)))
            def route(r):
                if r.request.url.startswith(base):r.continue_()
                else:external.append(r.request.url);r.abort()
            page.route("**/*",route)
            def go(url):
                page.goto(base+url);page.wait_for_function("document.getElementById('content').getAttribute('aria-busy')==='false'")
            go("")
            ok(f"default-{width}",page.locator("#season").input_value()=="2026")
            ok(f"overview-{width}",page.locator("#content .big").count()==4)
            page.screenshot(path=str(a.out/f"overview-{width}.png"),full_page=True)
            go("?temporada=2026&view=forecast")
            ok(f"forecast-{width}",page.locator(".prob").count()>0)
            ok(f"no-overflow-{width}",page.evaluate("document.documentElement.scrollWidth<=innerWidth"))
            page.screenshot(path=str(a.out/f"forecast-{width}.png"),full_page=False)
            go("?temporada=2026&view=players");ok(f"players-{width}",page.locator("tbody tr").count()>0)
            count=page.locator("tbody tr").count();page.locator("#club").select_option(index=1)
            ok(f"filter-{width}",0<page.locator("tbody tr").count()<=count and page.locator("#position").is_disabled() and page.locator("#minutes").is_disabled())
            page.screenshot(path=str(a.out/f"players-{width}.png"),full_page=False)
            go("?temporada=2026&view=rosters");ok(f"roster-{width}",page.locator(".slot").count()==22 and page.evaluate("document.documentElement.scrollWidth<=innerWidth"));page.screenshot(path=str(a.out/f"roster-{width}.png"),full_page=False)
            go("?temporada=2026&view=manifest");ok(f"manifest-{width}","SHA-256" in page.locator("#content").inner_text())
            page.locator("#season").select_option("2027");page.wait_for_function("document.getElementById('content').innerText.includes('ainda não ativada')")
            ok(f"2027-empty-{width}",page.locator("tbody tr").count()==0 and "2027" in page.url)
            page.screenshot(path=str(a.out/f"2027-{width}.png"),full_page=False)
            go("");ok(f"preference-{width}",page.locator("#season").input_value()=="2027")
            go("?temporada=2026&view=standings");ok(f"explicit-url-{width}",page.locator("#season").input_value()=="2026" and page.locator("tbody tr").count()==20)
            go("?temporada=2027&temporada=2026");ok(f"invalid-url-{width}",page.locator("#season").input_value()=="2026" and "URL inválida" in page.locator("#status").inner_text())
            ok(f"no-errors-external-{width}",not errors and not external)
            ok(f"a11y-{width}",page.locator('html[lang="pt-BR"]').count()==1 and page.locator('label[for="season"]').count()==1 and page.locator('nav [aria-current="page"]').count()==1 and page.locator('meta[name="robots"]').get_attribute("content").startswith("noindex"))
            ctx.close()
        ctx=browser.new_context();page=ctx.new_page()
        page.route("**/data/2026/forecast.json",lambda r:r.fulfill(status=200,content_type="application/json",body='{"season":"2027"}'))
        page.goto(base+"?temporada=2026&view=forecast");page.wait_for_function("document.getElementById('content').getAttribute('aria-busy')==='false'")
        ok("tamper-rejected","integridade inválida" in page.locator("#status").inner_text() and page.locator(".prob").count()==0)
        ctx.close();browser.close()
    server.shutdown();report={"passed":len(tests),"tests":tests,"viewports":[1440,390,320],"screenshots":len(list(a.out.glob("*.png"))),"external_browser_requests":0,"scope":"Chromium automated; no manual visual or full WCAG certification"}
    (a.out/"browser-report.json").write_text(json.dumps(report,sort_keys=True)+"\n");print("E10 BROWSER",json.dumps(report,sort_keys=True))
if __name__=="__main__":main()
