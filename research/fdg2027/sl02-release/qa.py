"""Offline release QA against the assembled operational candidate; no network delivery."""
from __future__ import annotations
import asyncio,functools,hashlib,json,re,shutil,sys,tempfile,threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
from abrir_previa import Handler
from overlay import snapshot,rollback,sha,match_projection,fact_value,valid_highlight
LABELS=["Estatísticas","Jogos","Ao vivo","Análises","Clubes","Mais"]
ICONS=["📊","⚽","🔴","📰","🛡️","☰"]
WIDTHS=(320,360,390,430,768,1024,1440)
ROUTES=["stats/prob","stats/table","stats/performance","stats/players","stats/accuracy","games/next","games/results","articles","clubs","more","more/museum","more/sim","more/method"]
NATIVE=["/jogos","/resultados","/tabela","/aovivo.html","/acuracia.html","/clubes.html","/analises/","/museu.html","/agenda.html","/alertas.html","/sobre.html","/copa2026/","/estatisticas-completas.html"]
def display_probability(d):
    from decimal import Decimal, ROUND_HALF_UP
    n=d.get("percentual_estimado")
    if not isinstance(n,(int,float)) or not 0<=n<=100:return d.get("exibicao","—")
    if d.get("impossivel_estruturalmente") and n==0:return "0%"
    if d.get("certeza_estrutural") and n==100:return "100%"
    if n<0.001:return "~0%"
    v=Decimal(str(n)).quantize(Decimal("0.01" if n<1 else "0.1"),rounding=ROUND_HALF_UP)
    if v>=100:return "~100%"
    s=format(v,".2f" if n<1 else ".1f")
    if n>=1:s=s.rstrip("0").rstrip(".")
    return s.replace(".",",")+"%"

def readj(site,rel):return json.loads((site/rel).read_text())
def player_key(name,club):
    import unicodedata
    def norm(s):
        return " ".join("".join(c for c in unicodedata.normalize("NFD",s) if not unicodedata.combining(c)).lower().split())
    return norm(name),norm(club)

def player_totals(leaders):
    assert leaders["status"]=="valido" and leaders["temporada"]==2026
    rows={}
    for group,field,idx in (("artilharia","gols",0),("assistencias","assistencias",1)):
        seen=set()
        for p in leaders[group]:
            k=player_key(p["nome"],p["time"])
            assert k not in seen and type(p[field]) is int and p[field]>=0,("invalid player identity",group,k)
            seen.add(k)
            rows.setdefault(k,[0,0])[idx]=p[field]
    return {k:(v[0],v[1],sum(v)) for k,v in rows.items()}

def verify_player_archive(site):
    leaders=readj(site,"dados-br/lideres-jogadores.json")
    archive=readj(Path(__file__).resolve().parents[3],"dados-br/jogadores.json")
    assert archive["temporada"]==leaders["temporada"]
    assert archive["artilharia"]==leaders["artilharia"] and archive["assistencias"]==leaders["assistencias"],"Player archive/public leaders out of sync"
    expected={player_key(p["nome"],p["time"]):(p["gols"],p["assistencias"],p["participacoes"]) for p in archive["participacoes_gol"]}
    assert len(expected)==len(archive["participacoes_gol"])
    assert player_totals(leaders)==expected,"G+A public source must match the internal validated archive"
    print("UX-HF1 PLAYER SOURCE PASS:",len(expected),"records; no new public dependency",flush=True)
    return expected
def normalize_space(v):return " ".join(str(v).split())
def match_source(site):
    results={str(g["event_id"]):g for g in readj(site,"resultados.json")["resultados"]}
    details=readj(site,"sl02/match-summary.json")["jogos"]
    highlights=readj(site,"dados-br/melhores-momentos.json").get("jogos",{})
    return results,details,highlights
def verify_native_media(soup,g,detail,highlight):
    assert soup.select_one(".game-hero-card .ux-native-facts")
    for k in ("publico","renda"):
        elem=soup.select_one('.ux-native-facts [data-match-fact="'+k+'"]')
        assert elem and normalize_space(elem.get_text())==normalize_space(fact_value(detail.get(k),k=="renda")),("native fact",g["event_id"],k)
    box=soup.select_one(".ux-native-video[data-fdg-video]")
    assert box and not box.select("iframe"),("native eager video",g["event_id"])
    h=valid_highlight(g,highlight)
    a=box.select_one(".ux-video-actions a[href]")
    assert a
    if h:assert a["href"]==h["url"],("native highlight",g["event_id"])
    else:assert a["href"].startswith("https://www.youtube.com/results?search_query=")
    play=box.select_one("[data-fdg-play]")
    if h and h.get("embeddable") is True:assert play and play["data-fdg-play"]==h["video_id"]
    else:assert play is None
def verify_static(base,site,backup):
    b=snapshot(base);c=snapshot(site);ledger=readj(backup,"rollback.json")
    assert all(c[k]==v for k,v in b.items() if not k.endswith(".html"))
    assert set(b)<=set(c)
    for rel in ["manifest.webmanifest","sw.js","robots.txt","sitemap.xml","news-sitemap.xml","CNAME","js/br-data-pulse.js","js/br-data-refresh.js","js/br-af-core-snapshot.js","js/br-data-manifest.js","js/br-pwa.js","js/br-push.js","js/br-aovivo.js","js/br-estatisticas.js","js/br-acuracia.js","dados-br/af-core-manifest.json"]:assert b[rel]==c[rel],rel
    original_details=readj(site,"dados-br/jogos-detalhes.json")
    projection=readj(site,"sl02/match-summary.json")
    assert projection==match_projection(original_details,sha(site/"dados-br/jogos-detalhes.json"))
    assert (site/"sl02/match-summary.json").stat().st_size<(site/"dados-br/jogos-detalhes.json").stat().st_size
    matches,details,highlights=match_source(site)
    checked_finals=set()
    for rel in [k for k in b if k.endswith(".html")]:
        old=BeautifulSoup((base/rel).read_text(),"html.parser")
        new=BeautifulSoup((site/rel).read_text(),"html.parser")
        oldcan=[x.get("href") for x in old.select('link[rel=canonical]')]
        newcan=[x.get("href") for x in new.select('link[rel=canonical]')]
        assert oldcan==newcan,("canonical",rel,oldcan,newcan)
        if rel!="estatisticas.html":
            old_scripts=[x.get("src") for x in old.select("script[src]")]
            new_scripts=[x.get("src") for x in new.select("script[src]") if "sl02/shell.js" not in x.get("src","")]
            assert old_scripts==new_scripts,("script preserved",rel)
        if rel not in ("jogos/index.html","tabela/index.html","resultados/index.html"):
            assert len(new.select("[data-fdg-release-shell], [data-fdg-shell]"))==1,("one global shell",rel)
            for nav in new.select("nav.nav,nav.menu"):
                assert nav.has_attr("data-fdg-oldnav"),("legacy global menu visible",rel)
        if rel=="agenda.html" or rel.startswith("jogo/"):
            assert new.body.has_attr("data-fdg-match-hf2"),rel
            assert not new.select('header.hero img[src*="header-formula-do-gol-v2.png"]'),("duplicate native logo",rel)
            if rel=="agenda.html":
                for selector in ("#agenda-competition-filters","#agenda-month-filters","#agenda-app"):assert new.select_one(selector),selector
            else:
                slot=new.select_one("[data-fdg-game-alert-slot][data-event-id]")
                if slot and str(slot["data-event-id"]) in matches:
                    eid=str(slot["data-event-id"])
                    verify_native_media(new,matches[eid],details.get(eid,{ }),highlights.get(eid))
                    checked_finals.add(eid)
                elif slot:assert not new.select(".ux-native-video,.ux-native-facts"),("premature final UI",rel)
    assert checked_finals==set(matches),("missing final detail routes",sorted(set(matches)-checked_finals))
    print("UX-HF2 NATIVE MATCH PASS",len(checked_finals),"FINAL pages; source-projected facts and safe media",flush=True)
    verify_player_archive(site)
    p=readj(site,"dados-br/probabilidades-brasileirao.json")
    audit=readj(site,"dados-br/auditoria-probabilidades.json")
    m=readj(site,"dados-br/af-core-manifest.json")
    r=readj(site,"resultados.json")["resultados"];t=readj(site,"tabela.json")["tabela"]
    assert p["temporada"]==2026 and "1.3" in p["versao_modelo"]
    assert p["hash_entrada"]==audit["hash_entrada"]==m["hash_entrada"]
    assert len(t)==20 and len(r)==m["concluidos"] and sum(x["jogos"] for x in t)==2*len(r)
    assert len(p["clubes"])==20 and p["simulacao"]["quantidade"]==2000000
    extremes=0
    for club in p["clubes"]:
        for k,d in club["probabilidades_detalhes"].items():
            if d["exibicao"]=="0%":assert d["impossivel_estruturalmente"] is True and d["motivo_impossibilidade"];extremes+=1
            elif d["exibicao"]=="100%":assert d["certeza_estrutural"] is True and d["motivo_certeza"];extremes+=1
    manifest=readj(site,"dados-br/fdg-data-pulse.json")
    assert all(sha(site/k)==v["sha256"] for k,v in manifest["files"].items())
    assert readj(site,"sl02/history-slim.json")["source_sha256"]==sha(site/"dados-br/historico-probabilidades.json")
    assert (site/"copa2026/index.html").is_file() and (site/"museu.html").is_file()
    assert (site/"estatisticas-completas.html").is_file()
    # Demonstrate rollback with a synthetic newer public data revision, never
    # mutate the deliverable or claim these test fixture bytes are real data.
    with tempfile.TemporaryDirectory() as td:
        rt=Path(td)/"site";shutil.copytree(site,rt)
        fixture=rt/"dados-br/status-atualizacao.json"
        j=json.loads(fixture.read_text());j["_sl02_rollback_test_only"]="newer data retained"
        fixture.write_text(json.dumps(j));new_hash=sha(fixture)
        rollback(rt,backup)
        after=snapshot(rt)
        assert sha(fixture)==new_hash
        assert all(after[k]==v for k,v in b.items() if k!="dados-br/status-atualizacao.json")
        assert set(after)==set(b)
    return {"public_files_before":len(b),"public_files_after":len(c),"protected_unchanged":ledger["protected_count"],"html_original_paths":sum(k.endswith(".html") for k in b),"canonical_preserved":True,"native_script_lists_preserved":True,"finals":len(r),"remaining":m["restantes"],"probability_indicators":sum(len(x["probabilidades_detalhes"]) for x in p["clubes"]),"structural_extremes":extremes,"data_manifest_entries":len(manifest["files"]),"rollback_newer_data_preserved":True,"source_revision":m["revision"],"hf2_final_pages":len(checked_finals),"hf2_projected_bytes":(site/"sl02/match-summary.json").stat().st_size,"hf2_full_detail_bytes":(site/"dados-br/jogos-detalhes.json").stat().st_size}
MEASURE="""()=>{const n=document.querySelector('.fdg-nav');if(!n)return null;const labels=[...n.querySelectorAll('.nav-label')].map(x=>{const t=document.createRange();t.selectNodeContents(x);const a=t.getBoundingClientRect(),b=x.parentElement.getBoundingClientRect();return{text:x.textContent,icon:x.previousElementSibling.textContent,inside:a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1,above:x.previousElementSibling.getBoundingClientRect().bottom<=x.getBoundingClientRect().top+1}});return{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,navClient:n.clientWidth,navScroll:n.scrollWidth,columns:getComputedStyle(n).gridTemplateColumns.split(' ').length,labels,active:n.querySelectorAll('[aria-current=page]').length,visibleMenus:[...document.querySelectorAll('.fdg-nav,nav.nav,nav.menu')].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none').length}}"""

async def live_layout(page,width,fixture=False):
    """Measure the rendered live header, including actual runtime selection.
    The optional synthetic fixture tests state transitions without live APIs."""
    await page.locator(".fdg-nav").wait_for(timeout=20000)
    measure="""()=>{const visible=e=>!!(e&&e.getClientRects().length&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'),rect=e=>e?.getBoundingClientRect(),s=document.querySelector('.fdg-release-shell'),r=document.querySelector('.live-freshness-row'),a=document.querySelector('#fdg-live-alert-action'),g=document.querySelector('.live-score-grid'),c=document.querySelector('#hf2-live-context'),source=document.querySelector('#live-app .live-round-row'),b=document.querySelector('#live-update-badge'),score=document.querySelector('.live-score,.live-vs'),nav=document.querySelector('.fdg-nav');return {logos:[...document.querySelectorAll('img[src*="header-formula-do-gol-v2.png"]')].filter(visible).length,legacy:document.querySelectorAll('.container>header.hero').length,contextVisible:visible(c),contextText:c?.textContent,sourceText:source?.textContent,sourceVisible:visible(source),sourcePresent:!!source,badgeCount:document.querySelectorAll('#live-update-badge').length,badgeInside:r?.contains(b),badgeBorder:getComputedStyle(b).borderTopWidth,badgeBackground:getComputedStyle(b).backgroundColor,badgeText:b?.textContent,headerBottom:rect(s)?.bottom,contextTop:rect(r)?.top,contextBottom:rect(r)?.bottom,alertVisible:visible(a),alertTop:rect(a)?.top,scoreTop:rect(score)?.top??rect(g)?.top??null,scoreBottom:rect(score)?.bottom??null,viewport:innerHeight,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,columns:getComputedStyle(nav).gridTemplateColumns.split(' ').length}}"""
    m=await page.evaluate(measure)
    def check(v):
        assert v["logos"]==1 and v["legacy"]==0,v
        assert v["badgeCount"]==1 and v["badgeInside"] and v["badgeBorder"]=="0px",v
        assert v["contextTop"]-v["headerBottom"]<=16 and v["contextTop"]>=v["headerBottom"]-1,v
        assert v["overflow"]<=1 and v["columns"]==(6 if width>=900 else 3 if width>=291 else 2 if width>=191 else 1),v
        if v["sourcePresent"]:
            assert v["contextVisible"] and not v["sourceVisible"],v
            assert v["contextText"]==v["sourceText"],v
        if v["scoreTop"] is not None:
            assert v["scoreTop"]<=520 and v["scoreBottom"]<=v["viewport"],v
        if v["alertVisible"]:
            assert v["alertTop"]>=v["contextBottom"]-1,v
    check(m)
    if not fixture:return m
    # Exercise the presentation event with a controlled scorecard, using the
    # real page CSS and the same selectors as the original runtime.
    fixture_html='<section class="live-main-card"><div class="live-card-inner"><div class="live-round-row"><span class="live-round-badge">Rodada 37</span><span class="live-state-badge live">Ao vivo</span></div><div class="live-score-grid"><div class="live-team"><div class="live-team-name">Clube A</div></div><div class="live-score-center"><div class="live-score">1 × 0</div><div class="live-clock">23′</div></div><div class="live-team"><div class="live-team-name">Clube B</div></div></div></div></section>'
    # Synchronous DOM exercise and measurement prevents an async real render
    # from racing the fixture. Restore the exact original markup afterwards.
    states=await page.evaluate("""({html})=>{const inspect="""+measure+""",app=document.getElementById('live-app'),badge=document.getElementById('live-update-badge'),original=app.innerHTML,oldBadge=badge.textContent,oldClass=badge.className;const slot=document.getElementById('fdg-live-alert-action'),oldSlot=slot.innerHTML,oldHidden=slot.hidden;const emit=()=>document.dispatchEvent(new CustomEvent('fdg:live-game-changed',{detail:{eventId:''}}));try{app.innerHTML=html;emit();slot.hidden=false;slot.innerHTML='<div class="fdg-live-goal-status is-warning">Você não selecionou alertas para esta partida. <button type="button" class="fdg-alert-button">Receber alertas</button></div>';badge.textContent='ESPN · 20:19:16 · 10s';badge.classList.add('is-live');const live=inspect();app.querySelector('.live-state-badge').className='live-state-badge post';app.querySelector('.live-state-badge').textContent='Finalizado';emit();const post=inspect();app.innerHTML='<div class="live-empty">Sem partida</div>';emit();const empty=inspect();return {live,post,empty}}finally{app.innerHTML=original;badge.textContent=oldBadge;badge.className=oldClass;emit();slot.innerHTML=oldSlot;slot.hidden=oldHidden}}""",{"html":fixture_html})
    check(states["live"]);check(states["post"]);check(states["empty"])
    assert states["live"]["contextText"]=="Rodada 37Ao vivo" and states["post"]["contextText"]=="Rodada 37Finalizado"
    assert not states["empty"]["contextVisible"] and states["empty"]["badgeInside"]
    return {"actual":m,"fixture":states}

async def match_header(page,w):
    await page.locator(".fdg-nav").wait_for(timeout=15000)
    v=await page.evaluate("""()=>{const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'),header=document.querySelector('.fdg-release-shell'),main=document.querySelector('main'),img=header.querySelector('.brandline img');return {logos:[...document.querySelectorAll('img[src*="header-formula-do-gol-v2.png"]')].filter(visible).length,legacy:document.querySelectorAll('header.hero img[src*="header-formula-do-gol-v2.png"]').length,active:header.querySelector('[aria-current=page]')?.dataset.section,headerHeight:header.getBoundingClientRect().height,logoHeight:img.getBoundingClientRect().height,mainTop:main.getBoundingClientRect().top,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}}""")
    assert v["logos"]==1 and v["legacy"]==0 and v["active"]=="games",v
    assert v["overflow"]<=1 and v["logoHeight"]<=(109 if w>=900 else 59),v
    return v

async def match_cards(page,site,final,w):
    all_games=readj(site,"resultados.json" if final else "jogos.json")["resultados" if final else "jogos"]
    pred={str(x["event_id"]):x for x in readj(site,"dados-br/probabilidades-jogos.json")["jogos"]}
    matches,details,highlights=match_source(site)
    if final:ordered=sorted(all_games,key=lambda g:str(g.get("finalizado_em") or g.get("data_iso") or ""),reverse=True)
    else:ordered=sorted(all_games,key=lambda g:str(g.get("data_iso") or "9999"))
    cards=page.locator(".ux-match[data-match-id]")
    await cards.first.wait_for(timeout=15000)
    async def check(expected):
        assert await cards.count()==len(expected)
        actual=await cards.evaluate_all("""cards=>cards.map(c=>({id:c.dataset.matchId,score:c.querySelector('.score').textContent,facts:Object.fromEntries([...c.querySelectorAll('[data-match-fact]')].map(e=>[e.dataset.matchFact,e.textContent])),prob:Object.fromEntries([...c.querySelectorAll('[data-match-prob]')].map(e=>[e.dataset.matchProb,e.querySelector('strong').textContent])),video:c.querySelector('.ux-video-actions a')?.getAttribute('href'),play:c.querySelector('[data-fdg-play]')?.dataset.fdgPlay,details:c.querySelector('.ux-match-primary')?.getAttribute('href'),crests:[...c.querySelectorAll('.crest')].map(e=>e.getBoundingClientRect().width)}))""")
        assert [r["id"] for r in actual]==[str(g["event_id"]) for g in expected]
        for row,g in zip(actual,expected):
            eid=row["id"]
            assert len(row["crests"])==2 and min(row["crests"])>=46,(eid,row["crests"])
            if not g.get("data_definir") and g.get("data_iso"):assert row["details"] and (site/row["details"].strip("/")/"index.html").is_file(),(eid,row.get("details"))
            if final:
                assert row["score"]==f'{g["placar_mandante"]} × {g["placar_visitante"]}',(eid,row)
                for k in ("publico","renda"):assert normalize_space(row["facts"][k])==normalize_space(fact_value(details.get(eid,{}).get(k),k=="renda")),(eid,k,row["facts"])
                h=valid_highlight(g,highlights.get(eid))
                if h:assert row["video"]==h["url"] and row.get("play")== (h["video_id"] if h.get("embeddable") is True else None),(eid,row)
                else:assert row["video"].startswith("https://www.youtube.com/results?search_query=") and not row.get("play"),(eid,row)
            else:
                assert not row["facts"] and not row.get("video"),(eid,row)
                if eid in pred:assert row["prob"]=={k:pred[eid]["exibicao"][k] for k in ("mandante","empate","visitante")},(eid,row)
        assert await page.locator(".ux-match iframe").count()==0
        return actual
    await check(ordered[:12])
    assert await page.locator(".ux-agenda-link").get_attribute("href")=="/agenda.html"
    if final and w in (390,1440):
        more=page.get_by_role("button",name="Mostrar mais partidas")
        if len(ordered)>12:
            await more.click()
            await page.locator("#fdg-main[aria-busy=false]").wait_for()
            await check(ordered[:24])
        # Exact round filter retains all matching records and resets pagination.
        selected=str(ordered[0]["rodada"])
        await page.locator("select[data-change=round]").select_option(selected)
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        await check([g for g in ordered if str(g["rodada"])==selected][:12])
        await page.locator("select[data-change=round]").select_option("")
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        # Explicit embed mounts only after a user click, and closes cleanly.
        # Loopback CSP blocks all frames; this asserts integration, not playback.
        button=page.locator(".ux-match [data-fdg-play]").first
        if await button.count():
            video=await button.get_attribute("data-fdg-play")
            await button.click()
            await page.locator(".ux-match iframe").wait_for()
            assert await page.locator(".ux-match iframe").get_attribute("src")==f"https://www.youtube-nocookie.com/embed/{video}?autoplay=1&rel=0"
            await page.locator("[data-fdg-video-close]").click()
            assert await page.locator(".ux-match iframe").count()==0
    return {"final":final,"total":len(ordered),"cards":await cards.count()}

async def run_browser(site,out,origin):
    rows=[];errors=[];fail=[];blocked=set();local_requests={}
    def validate(m,label,w=None,doc=True):
        if not m:fail.append("menu missing:"+label);return
        if [x["text"] for x in m["labels"]]!=LABELS or [x["icon"] for x in m["labels"]]!=ICONS or not all(x["inside"] and x["above"] for x in m["labels"]) or m["active"]!=1 or m["visibleMenus"]!=1 or m["navScroll"]>m["navClient"]+1:fail.append("menu:"+label)
        if w and m["columns"]!=(6 if w>=900 else 3 if w>=291 else 2 if w>=191 else 1):fail.append("columns:"+label)
        if doc and m["scroll"]>m["client"]+1:fail.append("document overflow:"+label)
    async with async_playwright() as p:
        browser=await p.chromium.launch()
        async def handle(r):
            u=r.request.url
            if u.startswith(origin+"/") and r.request.method in ("GET","HEAD"):
                k=u.split("?",1)[0].removeprefix(origin);local_requests[k]=local_requests.get(k,0)+1;await r.continue_()
            else:blocked.add(u.split("/")[2] if "://" in u else "other");await r.abort()
        async def one(route,w,theme="dark",native=False):
            ctx=await browser.new_context(viewport={"width":w,"height":920},service_workers="block")
            await ctx.route("**/*",handle)
            page=await ctx.new_page()
            # Legacy sources can report preexisting offline errors; separately
            # track app errors and native exceptions without treating them as proof of delivery.
            page.on("pageerror",lambda e:errors.append({"route":route,"message":str(e)[:220],"native":native}))
            url=origin+(route if native else "/estatisticas.html#"+route)
            try:
                await page.goto(url,wait_until="domcontentloaded",timeout=25000)
                await page.locator(".fdg-nav").wait_for(timeout=20000)
                if not native:await page.locator("#fdg-main[aria-busy=false]").wait_for(timeout=25000)
                if theme=="light":await page.get_by_role("button",name="Alternar tema").click()
                await page.wait_for_timeout(120)
                m=await page.evaluate(MEASURE)
                label=("native-" if native else "")+route.strip("/").replace("/","-").replace(".","-")+"-"+str(w)+"-"+theme
                validate(m,label,w,doc=not native)
                if native and route=='/aovivo.html':
                    m['hf2_live']=await live_layout(page,w,fixture=True)
                if native and (route=="/agenda.html" or route.startswith("/jogo/")):
                    m["hf2_native"]=await match_header(page,w)
                    if route=="/agenda.html":
                        await page.locator(".agenda-game").first.wait_for(timeout=15000)
                        assert await page.locator("#agenda-competition-filters button").count()>=1
                        assert await page.locator("#agenda-month-filters button").count()>=1
                        assert await page.locator(".agenda-team img").first.is_visible()
                        chips=page.locator("#agenda-competition-filters button")
                        if await chips.count()>1:
                            await chips.nth(1).click()
                            assert await chips.nth(1).get_attribute("aria-pressed")=="true"
                            await chips.first.click()
                    elif await page.locator(".ux-native-video").count():
                        assert await page.locator(".ux-native-facts [data-match-fact]").count()==2
                        assert not await page.locator(".ux-native-video iframe").count()
                        play=page.locator(".ux-native-video [data-fdg-play]")
                        if await play.count():
                            vid=await play.get_attribute("data-fdg-play")
                            await play.click()
                            assert await page.locator(".ux-native-video iframe").get_attribute("src")==f"https://www.youtube-nocookie.com/embed/{vid}?autoplay=1&rel=0"
                            await page.locator("[data-fdg-video-close]").click()
                            assert not await page.locator(".ux-native-video iframe").count()
                if not native:
                    if route in ("games/next","games/results"):
                        m["hf2_cards"]=await match_cards(page,site,route=="games/results",w)
                    if await page.locator("#fdg-main h1").text_content()=="Dados indisponíveis":fail.append("data:"+label+":"+await page.locator("#fdg-main").inner_text())
                    if route=="stats/table" and await page.locator("tbody tr[data-club]").count()!=20:fail.append("20 clubs:"+label)
                    if route=="stats/prob":
                        if not await page.locator("#sl02-pulse .fdg-pulse").count():fail.append("Data Pulse:"+label)
                        if await page.locator(".prob-metrics").count():fail.append("duplicated metrics:"+label)
                        default="Comparativa" if w>=900 else "Compacta"
                        if await page.get_by_role("button",name=default,exact=True).get_attribute("aria-pressed")!="true":fail.append("responsive default:"+label)
                        if await page.locator("#sl02-pulse-details").get_attribute("open") is not None:fail.append("pulse default:"+label)
                        if await page.locator("#sl02-freshness").is_visible():fail.append("duplicate freshness:"+label)
                        if await page.locator(".r1-prob-legend").get_attribute("open") is not None:fail.append("legend default:"+label)
                        labels=await page.locator(".r1-stats-tabs button,.r1-prob-mode button").evaluate_all("(els)=>els.map(e=>{let t=document.createRange();t.selectNodeContents(e);let a=t.getBoundingClientRect(),b=e.getBoundingClientRect();return {label:e.textContent,inside:a.left>=b.left+1&&a.right<=b.right-1&&a.top>=b.top&&a.bottom<=b.bottom}})")
                        if w>=320 and any(not x["inside"] for x in labels):fail.append("clipped secondary navigation:"+label+str(labels))
                        if w<900 and w>=320 and await page.locator(".r1-compact thead th:last-child").inner_text()!="Chance":fail.append("compact heading:"+label)
                        if w<900:
                            compact=page.locator(".r1-compact")
                            if await compact.locator("tbody tr[data-prob-club]").count()!=20:fail.append("compact rows:"+label)
                            source=readj(site,"dados-br/probabilidades-brasileirao.json")["clubes"]
                            rendered_compact=await compact.locator("tbody tr[data-prob-club]").evaluate_all("(rows)=>Object.fromEntries(rows.map(r=>[r.dataset.probClub,r.querySelector('.heat-cell').textContent]))")
                            if len(rendered_compact)!=20 or any(rendered_compact.get(c["clube"])!=display_probability(c["probabilidades_detalhes"]["libertadores"]) for c in source):fail.append("compact exact values:"+label)
                            if w==390 and theme=="dark":
                                for indicator in ("campeao","g4","g6","sul_americana","sem_competicao_continental","rebaixamento","libertadores"):
                                    await page.locator("select[data-change=indicator]").select_option(indicator)
                                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                                    cells=await page.locator(".r1-compact tbody tr[data-prob-club]").evaluate_all("(rows)=>Object.fromEntries(rows.map(r=>[r.dataset.probClub,r.querySelector('.heat-cell').textContent]))")
                                    if len(cells)!=20 or any(cells.get(c["clube"])!=display_probability(c["probabilidades_detalhes"][indicator]) for c in source):fail.append("compact indicator:"+indicator)
                                await page.locator(".r1-compact .hf-club-button").first.click()
                                await page.locator("#fdg-main[aria-busy=false]").wait_for()
                                if not await page.locator(".r1-detail-row").is_visible():fail.append("compact club detail")
                                await page.locator(".r1-compact .hf-club-button").first.click()
                                await page.locator("#fdg-main[aria-busy=false]").wait_for()
                                await page.evaluate("scrollTo(0,0)")
                                await page.locator("#r1-prob-legend summary").click()
                                if not await page.locator("#r1-prob-legend .hf-legend").is_visible():fail.append("legend expand")
                                await page.locator("#r1-prob-legend summary").click()
                                await page.evaluate("scrollTo(0,0)")
                            bounds=await page.locator(".r1-compact-scroll").evaluate("(e)=>({width:e.clientWidth,scroll:e.scrollWidth,top:e.getBoundingClientRect().top,first:e.querySelector('tbody tr').getBoundingClientRect().bottom,viewport:innerHeight,pulse:document.querySelector('#sl02-pulse').getBoundingClientRect().height})")
                            m["r1_density"]=bounds
                            if bounds["scroll"]>bounds["width"]+1:fail.append("compact horizontal overflow:"+label)
                            if w>=320 and bounds["first"]>bounds["viewport"]:fail.append("first row below fold:"+label)
                            await page.locator("#sl02-pulse-details summary").click()
                            if not await page.locator("#sl02-pulse .fdg-pulse-grid").is_visible():fail.append("expand pulse:"+label)
                            await page.locator("#sl02-pulse-details summary").click()
                            await page.get_by_role("button",name="Comparativa",exact=True).click()
                            await page.locator("#fdg-main[aria-busy=false]").wait_for()
                        if await page.locator(".hf-matrix .heat-cell").count()!=140:fail.append("seven indicators:"+label)
                        if await page.locator(".hf-matrix th[data-indicator]").count()!=7:fail.append("indicator columns:"+label)
                        if await page.locator(".hf-matrix th[data-indicator$='_base']").count():fail.append("base exposed:"+label)
                        if not await page.locator(".heat-cell[data-level=certain]").count() or not await page.locator(".heat-cell[data-level=zero]").count():fail.append("structural semantics:"+label)
                        palette=await page.locator(".hf-matrix tbody tr").first.locator(".heat-cell").evaluate_all("(els)=>els.map(e=>getComputedStyle(e).getPropertyValue('--rgb').trim())")
                        if len(set(palette))!=7:fail.append("semantic palette:"+label)
                        # Verify rendered rounding and exact original published labels separately.
                        expected=readj(site,"dados-br/probabilidades-brasileirao.json")["clubes"]
                        rendered=await page.locator(".hf-matrix tbody tr").evaluate_all("(rows)=>Object.fromEntries(rows.map(r=>[r.dataset.probClub,Object.fromEntries([...r.querySelectorAll('.heat-cell')].map(e=>[e.dataset.indicator,e.textContent]))]))")
                        if any(rendered.get(c["clube"],{}).get(k)!=display_probability(c["probabilidades_detalhes"][k]) for c in expected for k in rendered.get(c["clube"],{})) or len(rendered)!=20:fail.append("AF values:"+label)
                        original=await page.locator(".hf-matrix tbody tr[data-prob-club]").evaluate_all("(rows)=>Object.fromEntries(rows.map(r=>[r.dataset.probClub,Object.fromEntries([...r.querySelectorAll(\'.heat-cell\')].map(e=>[e.dataset.indicator,e.dataset.source]))]))")
                        if any(original.get(c["clube"],{}).get(k)!=c["probabilidades_detalhes"][k]["exibicao"] for c in expected for k in original.get(c["clube"],{})) or len(original)!=20:fail.append("original AF labels:"+label)
                    if route=="stats/table":
                        if await page.locator(".hf-standings thead th").count()!=10:fail.append("full classification:"+label)
                        if await page.locator(".hf-standings .wide-only").count():fail.append("hidden classification:"+label)
                        # Both ends of the internal scroll must remain usable; sticky identity stays visible.
                        sc=page.locator(".hf-table-scroll")
                        x=await sc.evaluate("(e)=>{const a=e.querySelector('tbody .hf-sticky');const b=a.getBoundingClientRect().left;e.scrollLeft=e.scrollWidth;return {before:b,after:a.getBoundingClientRect().left,max:e.scrollWidth-e.clientWidth,left:e.scrollLeft}}")
                        if abs(x["before"]-x["after"])>2 or abs(x["max"]-x["left"])>2:fail.append("classification sticky/scroll:"+label)
                        await sc.evaluate("(e)=>e.scrollLeft=0")
                    if w>=320:
                        brand=await page.locator(".brandline").evaluate("(e)=>{const a=e.querySelector('a').getBoundingClientRect(),b=e.querySelector('button').getBoundingClientRect();return {gap:b.left-a.right,width:a.width}}")
                        if brand["gap"]>15 or brand["gap"]<0 or brand["width"]<100:fail.append("banner width:"+label)
                m.update(route=route,width=w,theme=theme,native=native,url=page.url)
                rows.append(m)
                if route=="stats/prob" and w<900 and not native:
                    await page.get_by_role("button",name="Compacta",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                await page.screenshot(path=str(out/(label+".png")),animations="disabled")
                if route=="stats/table" and w==390 and theme=="dark" and not native:
                    for key in ("Turno","Returno","Mandante","Visitante","Últimos 5","Últimos 10","Geral"):
                        await page.get_by_role("button",name=key,exact=True).click()
                        await page.locator("#fdg-main[aria-busy=false]").wait_for()
                        if await page.locator("tbody tr[data-club]").count()!=20:fail.append("recorte:"+key)
                    await page.get_by_role("button",name="Série B · Em breve").click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    assert await page.get_by_role("tab").count()==1
                if route=="stats/prob" and w==390 and theme=="dark" and not native:
                    await page.get_by_role("button",name="Comparativa",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.locator(".heat-cell:visible").count()!=140:fail.append("compare mobile")
                    await page.locator(".hf-matrix .hf-club-button").first.click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if not await page.get_by_text("Raio-X completo",exact=True).count():fail.append("detail")
                    await page.get_by_role("button",name="Visão rápida",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.locator(".rank-button:visible").count()!=20:fail.append("quick mode")
                if route=="stats/prob" and w==1440 and theme=="dark" and not native:
                    await page.get_by_role("button",name="Comparativa",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.locator(".heat-cell:visible").count()!=140:fail.append("compare desktop")
                    await page.screenshot(path=str(out/"comparativa-integrada.png"))
                    await page.locator(".hf-matrix .hf-club-button").first.click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    assert await page.locator(".ux-comparative-detail .ux-club-intel").count()==1
                    assert await page.locator(".ux-comparative-detail .ux-chart-svg").count()==1
                    assert (await page.locator(".ux-chart-svg").bounding_box())["height"]<=211
                    await page.screenshot(path=str(out/"ux-hf1-club-expanded-desktop.png"))
                if route=="stats/players" and w in (390,1440) and theme=="dark" and not native:
                    leaders=readj(site,"dados-br/lideres-jogadores.json")
                    expected=player_totals(leaders)
                    for label_mode,group,field in (("Artilharia","artilharia","gols"),("Assistências","assistencias","assistencias")):
                        await page.get_by_role("button",name=label_mode,exact=True).click()
                        await page.locator("#fdg-main[aria-busy=false]").wait_for()
                        assert await page.locator(".ux-player-table tbody tr").count()==len(leaders[group])
                        assert await page.locator(".ux-player-primary").all_text_contents()==[str(p[field]) for p in leaders[group]]
                    await page.get_by_role("button",name="Participações em gols",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    rendered=await page.locator(".ux-player-table tbody tr").evaluate_all("(rows)=>rows.map(r=>({name:r.querySelector('.ux-player-name>strong').textContent,club:r.querySelector('.ux-player-name .team>span:last-child').textContent,values:[...r.querySelectorAll('td')].slice(1).map(t=>Number(t.textContent))}))")
                    actual={player_key(p["name"],p["club"]):tuple(p["values"]) for p in rendered}
                    assert len(rendered)==len(actual)==len(expected) and actual==expected
                    assert [p["values"][2] for p in rendered]==sorted([p["values"][2] for p in rendered],reverse=True)
                    assert await page.locator(".ux-player-podium .ux-player-leader").count()==3
                    await page.screenshot(path=str(out/f"ux-hf1-participacoes-{w}.png"))
                    club=rendered[0]["club"]
                    await page.locator("select[data-change=playerFilter]").select_option(club)
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    assert await page.locator(".ux-player-table tbody tr").count()==sum(p["club"]==club for p in rendered)
                    await page.locator("select[data-change=playerFilter]").select_option("")
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                if route=="clubs" and w==390 and not native:
                    await page.get_by_role("button",name="Bahia",exact=False).first.click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    await page.get_by_role("button",name="Definir Meu Clube",exact=False).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.evaluate("localStorage.getItem('fdg-sl02:club')")!="Bahia":fail.append("Meu Clube")
            except Exception as e:fail.append(route+"@"+str(w)+":"+str(e)[:1800 if route=="/aovivo.html" or route.startswith("/jogo/") or route.startswith("games/") or route=="/agenda.html" else 240])
            finally:await ctx.close()
        # All approved viewports; native shell measured separately from legacy
        # content layout (whose existing horizontal scroll remains visible in report).
        for route in ROUTES:
            for w in (390,1440):await one(route,w)
        for w in WIDTHS:
            if w not in (390,1440):
                for route in ("stats/prob","stats/table"):await one(route,w)
        for w in WIDTHS:
            for route in ("stats/prob","stats/table"):await one(route,w,"light")
        await one("stats/prob",160);await one("stats/prob",384);await one("stats/prob",720)
        for route in NATIVE:
            for w in (390,1440):await one(route,w,native=True)
        for w in WIDTHS:
            if w not in (390,1440):await one("/aovivo.html",w,native=True)
        # HF2 responsive matrix extends the complete HF1 suite, rather than replacing it.
        for w in WIDTHS:
            for theme in ("dark","light"):
                if w not in (390,1440) or theme=="light":
                    await one("games/next",w,theme)
                    await one("games/results",w,theme)
                    await one("/agenda.html",w,theme,native=True)
        # Pick real final pages for each media state and an upcoming match.
        games,_,highlights=match_source(site)
        pages={}
        for candidate in sorted((site/"jogo").rglob("index.html")):
            soup=BeautifulSoup(candidate.read_text(),"html.parser")
            slot=soup.select_one("[data-fdg-game-alert-slot][data-event-id]")
            if not slot:continue
            eid=str(slot["data-event-id"])
            g=games.get(eid)
            h=valid_highlight(g,highlights.get(eid)) if g else None
            kind="pre" if g is None else "embed" if h and h.get("embeddable") is True else "external" if h else "search"
            pages.setdefault(kind,"/"+candidate.relative_to(site).as_posix())
            if len(pages)==4:break
        assert set(pages)=={"embed","external","search","pre"},pages
        for w in WIDTHS:
            for theme in ("dark","light"):
                await one(pages["embed"],w,theme,native=True)
        for kind in ("external","search","pre"):
            for w in (390,1440):
                await one(pages[kind],w,native=True)
        # Representative generated club, match, article pages must retain native scripts and global shell.
        for rel in ("clube","jogo","analises"):
            candidates=sorted((site/rel).rglob("*.html"))
            selected=next((x for x in candidates if x.parent!=site/rel or x.name!="index.html"),None)
            if selected:await one("/"+selected.relative_to(site).as_posix(),390,native=True)
        # Actual keyboard activation, native SW registration at local origin and no permission grants.
        ctx=await browser.new_context(viewport={"width":390,"height":900},service_workers="allow",accept_downloads=True)
        await ctx.route("**/*",handle);page=await ctx.new_page()
        await page.goto(origin+"/estatisticas.html#stats/prob")
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        await page.get_by_role("tab",name="Probabilidades",exact=True).focus()
        await page.keyboard.press("ArrowRight")
        await page.wait_for_function("location.hash==='#stats/table'&&document.querySelector('#fdg-main[aria-busy=false]')")
        if await page.locator("tbody tr[data-club]").count()!=20:fail.append("keyboard tab")
        pwa=await page.evaluate("""async()=>{try{let r=await navigator.serviceWorker.getRegistration();if(!r)r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;return {scope:r.scope,script:r.active?.scriptURL||r.installing?.scriptURL,permission:Notification.permission}}catch(e){return {error:String(e)}}}""")
        if not pwa.get("scope","").startswith(origin+"/") or not pwa.get("script","").split("?")[0].endswith("/sw.js") or pwa.get("permission")=="granted":fail.append("local PWA registration")
        await page.goto(origin+"/estatisticas.html#clubs/Bahia")
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        try:
            async with page.expect_download(timeout=12000) as d:await page.get_by_role("button",name="Compartilhar card").first.click()
            await (await d.value).save_as(str(out/"card-bahia.png"))
            assert (out/"card-bahia.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
        except Exception as e:fail.append("share:"+str(e)[:140])
        await ctx.close()
        # A browser context changes revision with a mocked *local* manifest,
        # not an external API. A failed fetch must keep the last-good view.
        ctx=await browser.new_context(viewport={"width":390,"height":900},service_workers="block")
        toggle={"failed":False}
        async def fail_manifest(r):
            if toggle["failed"]:await r.fulfill(status=503,body="fixture outage")
            else:await handle(r)
        await ctx.route("**/*",handle);await ctx.route("**/dados-br/fdg-data-pulse.json*",fail_manifest)
        page=await ctx.new_page()
        await page.goto(origin+"/estatisticas.html#stats/prob")
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        await page.locator(".r1-compact tbody tr[data-prob-club]").first.wait_for()
        selector=".r1-compact tbody tr[data-prob-club]"
        before=await page.locator(selector).evaluate_all("(rows)=>rows.map(r=>[r.dataset.probClub,r.querySelector('.heat-cell').textContent])")
        source=readj(site,"dados-br/probabilidades-brasileirao.json")["clubes"]
        expected={c["clube"]:display_probability(c["probabilidades_detalhes"]["libertadores"]) for c in source}
        if len(before)!=20 or dict(before)!=expected:fail.append("last-good initial values")
        await page.locator("#sl02-pulse-details summary").click()
        await page.wait_for_timeout(300);toggle["failed"]=True
        await page.evaluate("window.dispatchEvent(new Event('online'))")
        try:
            await page.get_by_text("Sem certificação da revisão atual",exact=False).wait_for(timeout=12000)
            after=await page.locator(selector).evaluate_all("(rows)=>rows.map(r=>[r.dataset.probClub,r.querySelector('.heat-cell').textContent])")
            if len(after)!=20 or after!=before:fail.append("last-good compact values changed")
            if not await page.locator("#sl02-pulse-details").evaluate("(e)=>e.open"):fail.append("last-good pulse disclosure lost")
            if await page.locator("#sl02-pulse-details").evaluate("(e)=>e.classList.contains('fdg-pulse--synced')"):fail.append("last-good false freshness")
            await page.screenshot(path=str(out/"last-good-compact-stale.png"),animations="disabled")
        except Exception as e:fail.append("last-good status:"+str(e)[:100])
        await ctx.close()
        await browser.close()
        # Genuine browser zoom using Chromium extension API, not device scale factor.
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);ext=root/"ext";ext.mkdir()
            (ext/"manifest.json").write_text(json.dumps({"manifest_version":3,"name":"SL02 Zoom QA","version":"1.0","permissions":["tabs"],"background":{"service_worker":"bg.js"}}))
            (ext/"bg.js").write_text("chrome.runtime.onInstalled.addListener(()=>{});")
            ctx=await p.chromium.launch_persistent_context(str(root/"profile"),headless=True,channel="chromium",args=["--disable-extensions-except="+str(ext),"--load-extension="+str(ext)],viewport={"width":640,"height":900})
            try:
                worker=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker",timeout=12000)
                await ctx.route("**/*",handle);page=ctx.pages[0] if ctx.pages else await ctx.new_page()
                await page.goto(origin+"/estatisticas.html#stats/prob");await page.locator("#fdg-main[aria-busy=false]").wait_for()
                before=await page.evaluate("innerWidth")
                level=await worker.evaluate("""async url=>{let tab=(await chrome.tabs.query({})).find(t=>t.url===url);await chrome.tabs.setZoom(tab.id,2);return chrome.tabs.getZoom(tab.id)}""",page.url)
                await page.wait_for_timeout(350)
                zoom=await page.evaluate(MEASURE);validate(zoom,"native200",320)
                zoom.update(level=level,before=before)
                if level!=2 or zoom["client"]>before*.55:fail.append("native zoom")
                await page.screenshot(path=str(out/"zoom-nativo-200.png"))
            finally:await ctx.close()
    app_errors=[x for x in errors if not x["native"]]
    report={"measurements":rows,"captures":len(list(out.glob("*.png"))),"browser_cases":len(rows),"failures":fail,"app_errors":app_errors,"native_errors": [x for x in errors if x["native"]],"native_document_overflow":[{"route":x["route"],"width":x["width"],"overflow":x["scroll"]-x["client"]} for x in rows if x["native"] and x["scroll"]>x["client"]+1],"native_zoom":zoom,"pwa_local":pwa,"blocked_external_hosts":sorted(blocked),"local_request_counts":local_requests,"external_requests_delivered":0}
    return report
def main():
    base,site,backup,out=map(Path,sys.argv[1:]);out.mkdir(parents=True)
    static=verify_static(base,site,backup)
    server=ThreadingHTTPServer(("127.0.0.1",0),functools.partial(Handler,directory=str(site)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:browser=asyncio.run(run_browser(site,out,f"http://127.0.0.1:{server.server_port}"))
    finally:server.shutdown();server.server_close()
    report={"static":static,"browser":browser,"publication":False,"cost_real_verified":False}
    (out/"release-qa.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({"static":static,"browser":{k:v for k,v in browser.items() if k not in ("measurements","local_request_counts")}},ensure_ascii=False),flush=True)
    assert not browser["failures"],browser["failures"]
    assert not browser["app_errors"],browser["app_errors"]
if __name__=="__main__":main()
