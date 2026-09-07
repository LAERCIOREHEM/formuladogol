#!/usr/bin/env python3
"""ORG-2: arquitetura de páginas individuais de clubes + piloto Flamengo.

Gera a primeira URL indexável /clube/flamengo/ exclusivamente a partir das
mesmas fontes públicas já consumidas pelo site. Não recalcula probabilidades.
Também liga o Flamengo no hub Clubes e registra a URL no sitemap do artefato.
"""
from __future__ import annotations
import argparse, html, json, re, unicodedata
from datetime import datetime
from pathlib import Path
import xml.etree.ElementTree as ET

BASE_URL='https://formuladogol.com.br'
PILOT_SLUG='flamengo'
PILOT_NAME='Flamengo'
NS='http://www.sitemaps.org/schemas/sitemap/0.9'
ET.register_namespace('', NS)

def esc(v): return html.escape(str('' if v is None else v), quote=True)
def slugify(v):
    s=unicodedata.normalize('NFKD',str(v)).encode('ascii','ignore').decode('ascii')
    return re.sub(r'[^a-zA-Z0-9]+','-',s).strip('-').lower()
def load(root, rel):
    p=root/rel
    if not p.is_file(): raise SystemExit(f'ORG-2: arquivo obrigatório ausente: {rel}')
    try: return json.loads(p.read_text(encoding='utf-8'))
    except Exception as e: raise SystemExit(f'ORG-2: JSON inválido em {rel}: {e}')
def find_by(items, key, value):
    return next((x for x in items if str(x.get(key) or '')==value), {})
def prob_display(p,key):
    d=(p.get('probabilidades_detalhes') or {}).get(key) or {}
    if d.get('exibicao'): return str(d['exibicao'])
    v=(p.get('probabilidades_pct') or {}).get(key)
    if v is None:return '—'
    return (f'{float(v):.1f}%').replace('.',',')
def dt_br(s):
    try:
        d=datetime.fromisoformat(str(s).replace('Z','+00:00'))
        return f'{d.day:02d}/{d.month:02d}/{d.year} · {d.hour:02d}h{d.minute:02d}'
    except Exception:return str(s or '—')
def next_match(agenda,name):
    jogos=[]
    for j in agenda.get('jogos') or []:
        if j.get('concluido'): continue
        a=(j.get('mandante') or {}).get('nome'); b=(j.get('visitante') or {}).get('nome')
        if name in (a,b): jogos.append(j)
    jogos.sort(key=lambda x:str(x.get('data_iso') or ''))
    return jogos[0] if jogos else {}
def af_row(label,value):
    try:n=max(0,min(100,float(value)))
    except:n=0
    return f'<div class="club-page-af-row"><span>{esc(label)}</span><div style="height:7px;border-radius:999px;background:rgba(59,91,126,.35);overflow:hidden"><i style="width:{n:.1f}%"></i></div><b>{str(round(n,1)).replace(".",",")}</b></div>'
def add_sitemap(site, url):
    p=site/'sitemap.xml'; tree=ET.parse(p); root=tree.getroot()
    locs={n.text for n in root.findall(f'{{{NS}}}url/{{{NS}}}loc')}
    if url in locs:return
    node=ET.SubElement(root,f'{{{NS}}}url'); ET.SubElement(node,f'{{{NS}}}loc').text=url
    ET.SubElement(node,f'{{{NS}}}changefreq').text='daily'; ET.SubElement(node,f'{{{NS}}}priority').text='0.9'
    tree.write(p,encoding='utf-8',xml_declaration=True)
def patch_hub(site):
    p=site/'clubes.html'; t=p.read_text(encoding='utf-8')
    # ORG-1 prerender link: only the pilot changes from hash to real URL.
    t=t.replace('href="clubes.html#flamengo" aria-label="Ver dados de Flamengo"','href="/clube/flamengo/" aria-label="Abrir página completa do Flamengo"')
    p.write_text(t,encoding='utf-8')
def build_page(site):
    clubs=load(site,'dados-br/clubes.json').get('clubes') or []
    c=next((x for x in clubs if slugify(x.get('nome'))==PILOT_SLUG),None)
    if not c: raise SystemExit('ORG-2: Flamengo ausente em dados-br/clubes.json')
    table=find_by(load(site,'tabela.json').get('tabela') or [],'time',PILOT_NAME)
    ranking=find_by(load(site,'dados-br/ranking-desempenho.json').get('ranking') or [],'time',PILOT_NAME)
    probdoc=load(site,'dados-br/probabilidades-brasileirao.json')
    probs=find_by(probdoc.get('clubes') or [],'clube',PILOT_NAME)
    agenda=load(site,'dados-br/agenda-clubes-br.json'); jogo=next_match(agenda,PILOT_NAME)
    pos=table.get('pos','—'); pts=table.get('pontos','—'); jogos=table.get('jogos','—')
    proj=probs.get('posicao_classificacao_projetada') or probs.get('posicao_projetada') or '—'
    pp=probs.get('pontos_projetados') or {}; proj_pts=pp.get('media','—'); faixa=probs.get('faixa_posicao_80') or {}
    faixa_txt=f"{faixa.get('melhor','—')}º–{faixa.get('pior','—')}º"
    titulo=prob_display(probs,'campeao'); lib=prob_display(probs,'libertadores'); sula=prob_display(probs,'sul_americana'); queda=prob_display(probs,'rebaixamento')
    af=ranking.get('indice_final',ranking.get('score','—')); afpos=ranking.get('pos','—')
    updated=probdoc.get('referencia_esportiva_em') or probdoc.get('gerado_em') or load(site,'dados-br/ranking-desempenho.json').get('atualizado_em') or ''
    trend=(probs.get('tendencia_recente') or {}).get('classificacao') or 'estável'
    summary=(f"O Flamengo está em {pos}º lugar, com {pts} pontos após {jogos} jogos. "
             f"O AF-Previsão projeta {proj_pts} pontos e {proj}º lugar, com {titulo} de chance de título. "
             f"A faixa central de 80% das simulações vai de {faixa_txt}.")
    if jogo:
        mand=(jogo.get('mandante') or {}).get('nome','Mandante'); vis=(jogo.get('visitante') or {}).get('nome','Visitante')
        comp=jogo.get('competicao_nome_curto') or jogo.get('competicao_nome') or 'Futebol'; fase=jogo.get('fase') or ''
        match=f'''<div class="club-page-match"><div class="club-page-match-top"><span>{esc(comp)}{(' · '+esc(fase)) if fase else ''}</span><span>{esc(dt_br(jogo.get('data_iso')))}</span></div><div class="club-page-match-teams">{esc(mand)} × {esc(vis)}</div><p>{esc(jogo.get('estadio') or 'Local a confirmar')}</p></div>'''
    else: match='<div class="empty-state">Próximo jogo em atualização.</div>'
    bars=''.join([af_row('Ataque',ranking.get('ataque')),af_row('Defesa',ranking.get('defesa')),af_row('Domínio',ranking.get('dominio')),af_row('Eficiência',ranking.get('eficiencia')),af_row('Disciplina',ranking.get('disciplina'))])
    title=f'Flamengo no Brasileirão 2026: chances, posição e projeção — Fórmula do Gol'
    desc=f'Flamengo: {pts} pontos, {pos}º lugar, projeção de {proj_pts} pontos e {titulo} de chance de título no Brasileirão 2026. Dados do AF-Previsão e AF-Score.'
    canonical=f'{BASE_URL}/clube/{PILOT_SLUG}/'
    page=f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="index,follow,max-image-preview:large"><title>{esc(title)}</title><meta name="description" content="{esc(desc)}"><link rel="canonical" href="{canonical}"><meta property="og:title" content="{esc(title)}"><meta property="og:description" content="{esc(desc)}"><meta property="og:image" content="{BASE_URL}/og-image-formula-do-gol-v2.jpg"><meta property="og:url" content="{canonical}"><meta property="og:type" content="website"><meta property="og:locale" content="pt_BR"><meta property="og:site_name" content="Fórmula do Gol"><meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#10b981"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-formula-do-gol-32.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-formula-do-gol.png"><link rel="stylesheet" href="/css/br-institucional.css?v=20260722-evolucao-af-score-v1"><link rel="stylesheet" href="/css/br-global.css?v=20260801-footer-institucional-v1"><link rel="stylesheet" href="/css/br-clube.css?v=20260906-org2-v1"><link rel="stylesheet" href="/css/br-social-footer.css?v=20260811-social-v2-tiktok"><script async src="https://www.googletagmanager.com/gtag/js?id=G-3956SD5HFC"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-3956SD5HFC',{{page_title:{json.dumps(title,ensure_ascii=False)},page_location:{json.dumps(canonical)},page_path:'/clube/flamengo/'}});</script>
<script type="application/ld+json">{json.dumps({'@context':'https://schema.org','@graph':[{'@type':'SportsTeam','@id':canonical+'#team','name':c.get('nome_completo') or PILOT_NAME,'alternateName':[PILOT_NAME,c.get('apelido') or 'Mengão'],'sport':'Futebol','url':canonical,'logo':c.get('escudo'),'location':{'@type':'Place','name':c.get('cidade')}},{'@type':'WebPage','@id':canonical+'#webpage','url':canonical,'name':title,'description':desc,'about':{'@id':canonical+'#team'},'isPartOf':{'@id':BASE_URL+'/#website'},'inLanguage':'pt-BR'},{'@type':'BreadcrumbList','itemListElement':[{'@type':'ListItem','position':1,'name':'Fórmula do Gol','item':BASE_URL+'/'},{'@type':'ListItem','position':2,'name':'Clubes','item':BASE_URL+'/clubes.html'},{'@type':'ListItem','position':3,'name':'Flamengo','item':canonical}]}]},ensure_ascii=False)}</script></head><body><div class="container"><header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="/img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header><nav class="nav" data-br-auth-menu aria-label="Menu principal"><a href="/estatisticas.html">📈 Estatísticas</a><a href="/jogos" data-br-view="jogos">⚽ Jogos</a><a href="/aovivo.html">🔴 Ao vivo</a><a href="/tabela" data-br-view="tabela">📊 Tabela</a><a href="/resultados" data-br-view="resultados">✅ Resultados</a><a href="/analises/">📰 Análises</a><a href="/clubes.html" class="active" aria-current="page">🛡️ Clubes</a><a href="/museu.html">🏛️ Museu</a><a href="/copa2026/" data-br-copa>🌎 Copa 2026</a></nav><main><div class="club-page-backbar"><a class="club-page-back" href="/clubes.html">← Voltar para Clubes</a><span class="club-page-updated">Atualizado: {esc(dt_br(updated))}</span></div><section class="panel"><div class="panel-inner"><div class="club-page-hero"><div class="club-page-identity"><img class="club-page-logo" src="{esc(c.get('escudo'))}" alt="Escudo do Flamengo"><div class="club-page-title"><div class="kicker">Clube · Brasileirão 2026</div><h1>Flamengo</h1><p>{esc(c.get('nome_completo'))} · {esc(c.get('cidade'))}-{esc(c.get('uf'))} · {esc(c.get('estadio'))}</p></div></div><div class="club-page-position"><span>Posição atual</span><strong>{esc(pos)}º</strong><small>{esc(pts)} pts · {esc(jogos)} jogos</small></div></div><p class="club-page-summary">{esc(summary)}</p><div class="club-page-grid"><div class="club-page-stat"><span>Projeção final</span><strong>{esc(proj_pts)} pts</strong><small>{esc(proj)}º lugar · faixa {esc(faixa_txt)}</small></div><div class="club-page-stat"><span>Chance de título</span><strong>{esc(titulo)}</strong><small>2 milhões de simulações</small></div><div class="club-page-stat"><span>AF-Score</span><strong>{esc(af)}</strong><small>{esc(afpos)}º no ranking de desempenho</small></div><div class="club-page-stat"><span>Tendência recente</span><strong>{esc(trend)}</strong><small>janela recente com peso limitado</small></div></div></div></section><div class="club-page-columns"><section class="panel"><div class="panel-inner"><div class="kicker">AF-Previsão</div><h2>Chances do Flamengo</h2><div class="club-page-probs"><div class="club-page-prob"><span>Campeão</span><strong>{esc(titulo)}</strong></div><div class="club-page-prob"><span>Libertadores</span><strong>{esc(lib)}</strong></div><div class="club-page-prob"><span>Sul-Americana</span><strong>{esc(sula)}</strong></div><div class="club-page-prob"><span>Rebaixamento</span><strong>{esc(queda)}</strong></div></div><div class="club-page-actions"><a class="club-page-action primary" href="/estatisticas.html#probabilidades">Ver previsão completa</a><a class="club-page-action" href="/acuracia.html">Ver acurácia</a></div></div></section><section class="panel"><div class="panel-inner"><div class="kicker">AF-Score · Flamengo</div><h2>Desempenho atual</h2><div class="club-page-af"><div class="club-page-af-score">{esc(af)}</div><div class="club-page-af-bars">{bars}</div></div><div class="club-page-actions"><a class="club-page-action" href="/estatisticas.html#desempenho">Ranking completo</a></div></div></section></div><section class="panel" style="margin-top:14px"><div class="panel-inner"><div class="kicker">Próxima partida</div><h2>O que vem pela frente</h2><div class="club-page-next">{match}</div><div class="club-page-actions"><a class="club-page-action primary" href="/jogos">Ver jogos do Flamengo</a><a class="club-page-action" href="/alertas.html">🔔 Configurar alertas</a><a class="club-page-action" href="/aovivo.html">🔴 Ao vivo</a></div></div></section></main><section class="br-legal-context" aria-label="Informações sobre escudos"><div class="br-legal-context-icon" aria-hidden="true">🛡️</div><div><strong>Sobre o escudo:</strong><p>o escudo exibido pertence ao Flamengo e é usado exclusivamente para identificação editorial.</p></div></section><footer class="site-footer br-disclaimer"><nav class="br-footer-links" aria-label="Links institucionais"><a href="/sobre.html">ⓘ Sobre o Fórmula do Gol</a></nav><div class="br-footer-copy"><span class="footer-title">Fórmula do Gol</span> — Site independente, informativo e sem fins lucrativos, criado, desenvolvido e mantido exclusivamente por Laércio Rehem. Dados esportivos são organizados para fins informativos.</div><div class="footer-sugestoes">Solicitações de remoção ou crédito: <button type="button" class="br-feedback-button" data-feedback>💬 Sugestões</button></div></footer></div><script src="/js/br-config.js?v=20260723-copa-publica-v1"></script><script src="/js/br-menu.js?v=20260901-alertas-v1"></script><script src="/js/br-feedback.js?v=20260713-disclaimers-publicos-v1"></script><script src="/js/br-social-footer.js?v=20260811-social-v2-tiktok" defer></script></body></html>'''
    out=site/'clube'/PILOT_SLUG/'index.html'; out.parent.mkdir(parents=True,exist_ok=True); out.write_text(page,encoding='utf-8')
    return {'table':table,'ranking':ranking,'probs':probs,'url':canonical}
def validate(site, src_root=None):
    page=site/'clube/flamengo/index.html'
    if not page.is_file(): raise SystemExit('ORG-2: página piloto ausente')
    t=page.read_text(encoding='utf-8')
    required=['<h1>Flamengo</h1>','← Voltar para Clubes','rel="canonical" href="https://formuladogol.com.br/clube/flamengo/"','SportsTeam','max-image-preview:large','AF-Score','AF-Previsão']
    for token in required:
        if token not in t: raise SystemExit(f'ORG-2: token obrigatório ausente: {token}')
    if 'href="/clube/flamengo/"' not in (site/'clubes.html').read_text(encoding='utf-8'):
        raise SystemExit('ORG-2: hub não aponta para a página piloto')
    root=ET.parse(site/'sitemap.xml').getroot(); urls=[n.text for n in root.findall(f'{{{NS}}}url/{{{NS}}}loc')]
    if f'{BASE_URL}/clube/flamengo/' not in urls: raise SystemExit('ORG-2: Flamengo ausente do sitemap')
    # Consistência: valores visíveis são derivados das mesmas fontes.
    p=find_by(load(site,'dados-br/probabilidades-brasileirao.json').get('clubes') or [],'clube',PILOT_NAME)
    r=find_by(load(site,'dados-br/ranking-desempenho.json').get('ranking') or [],'time',PILOT_NAME)
    tab=find_by(load(site,'tabela.json').get('tabela') or [],'time',PILOT_NAME)
    for token in [str(tab.get('pontos')),str((p.get('pontos_projetados') or {}).get('media')),prob_display(p,'campeao'),str(r.get('indice_final',r.get('score'))).replace('.',',')]:
        if token not in t and token.replace(',','.') not in t: raise SystemExit(f'ORG-2: dado fonte ausente da página: {token}')
    print('ORG-2 VALIDATION PASS: /clube/flamengo/ indexável, hub conectado, sitemap registrado e dados coerentes')
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--site-root',default='_site'); ap.add_argument('--check',action='store_true'); a=ap.parse_args(); site=Path(a.site_root).resolve()
    build_page(site); patch_hub(site); add_sitemap(site,f'{BASE_URL}/clube/flamengo/')
    if a.check: validate(site)
if __name__=='__main__':main()
