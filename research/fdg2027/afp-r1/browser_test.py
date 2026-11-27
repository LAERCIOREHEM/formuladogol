import asyncio,json,sys,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from functools import partial
from pathlib import Path
from playwright.async_api import async_playwright
async def run(root):
    src=json.loads((root/"ranking.json").read_text())
    server=ThreadingHTTPServer(("127.0.0.1",0),partial(SimpleHTTPRequestHandler,directory=str(root)))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    count=0
    try:
        async with async_playwright() as p:
            b=await p.chromium.launch()
            for w in (320,390,768,1024,1440):
                for theme in ("dark","light"):
                    page=await b.new_page(viewport={"width":w,"height":920});errors=[];external=[]
                    page.on("pageerror",lambda exc:errors.append(str(exc)))
                    async def block(route):
                        if not route.request.url.startswith(f"http://127.0.0.1:{server.server_port}/"):external.append(route.request.url);await route.abort()
                        else:await route.continue_()
                    await page.route("**/*",block)
                    await page.goto(f"http://127.0.0.1:{server.server_port}/")
                    await page.wait_for_function("document.querySelector('#status').textContent.startsWith('Prévia privada')")
                    if theme=="light":await page.locator("#theme").click()
                    s=src["seasons"]["2026"];expected=[r for r in s["rows"] if r["eligible"] and r["season_minutes"]>=450]
                    assert await page.locator("#rows tr").count()==len(expected)
                    if expected:
                        await page.locator("#rows button").first.click()
                        assert await page.locator(".detail").count()==1
                        await page.locator("#rows button").first.click()
                        assert await page.locator(".detail").count()==0
                    await page.locator("#position").select_option("G")
                    assert await page.locator("#rows tr").count()==sum(r["position"]=="G" for r in expected)
                    await page.locator("#season").select_option("2022")
                    assert await page.locator("#rows tr").count()==0
                    await page.locator("#scope").select_option("all")
                    assert await page.locator("#rows tr").count()==sum(r["position"]=="G" and r["season_minutes"]>=450 for r in src["seasons"]["2022"]["rows"])
                    assert await page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
                    assert not errors and not external
                    await page.close();count+=1
            await b.close()
    finally:server.shutdown()
    print("AFP browser PASS:",count,"viewport/theme cases; zero external calls")
if __name__=="__main__":asyncio.run(run(Path(sys.argv[1]).resolve()))
