#!/usr/bin/env python3
from __future__ import annotations
import argparse, html, json, math, os, re
from pathlib import Path
from datetime import datetime

SITE='https://formuladogol.com.br'
CLUB_ID='flamengo'; CLUB_NAME='Flamengo'

def load(p, fallback):
    try:return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:return fallback

def pct(v):
    try:v=float(v)
    except:return '—'
    if v==0:return '~0%'
    if 0<v<0.001:return '<0,001%'
    if v>=99.9995:return '~100%'
    if v<0.1:return f'{v:.3f}%'.replace('.',',')
    return f'{v:.1f}%'.replace('.',',')

def esc(v):return html.escape(str(v or ''), quote=True)
def fmt_date(iso):
    try:return datetime.fromisoformat(iso.replace('Z','+00:00')).strftime('%d/%m/%Y · %H:%M')
    except:return 'Data a confirmar'

def team_name(g,side):
    x=g.get(side,{})
    return x.get('nome') if isinstance(x,dict) else str(x or '')

def result_games(root):
    d=load(root/'resultados.json',{})
    arr=d.get('jogos') if isinstance(d,dict) else d
    if not isinstance(arr,list): return []
    out=[]
    for g in arr:
      if CLUB_NAME.lower() in str(g).lower(): out.append(g)
    return out[-5:][::-1]

def render(site_dir:Path, repo_root:Path):
    data=site_dir/'dados-br' if (site_dir/'dados-br').exists() else repo_root/'dados-br'
    clubes=load(data/'clubes.json',{}).get('clubes',[])
    club=next((x for x in clubes if x.get('id')==CLUB_ID or x.get('nome')==CLUB_NAME),{})
    probs=load(data/'probabilidades-brasileirao.json',{})
    prob=next((x for x in probs.get('clubes',[]) if x.get('clube')==CLUB_NAME),{})
    ranking=load(data/'ranking-desempenho.json',{})
    rank=next((x for x in ranking.get('ranking',[]) if x.get('time')==CLUB_NAME),{})
    hist=load(data/'historico-ranking-desempenho.json',{}).get('snapshots',[])
    marcos=load(data/'marcos-af-previsao.json',{}).get('marcos',[])
    agenda=[g for g in load(data/'agenda-clubes-br.json',{}).get('jogos',[]) if CLUB_NAME.lower() in str(g).lower()]
    leaders=load(data/'lideres-jogadores.json',{})
    estat=load(data/'estatisticas-competicao.json',{})
    acc=load(data/'acuracia-af-previsao.json',{})
    analyses=load(data/'analises.json',{}).get('artigos',[])
    shield=club.get('escudo','/img/escudo-neutro.svg')
    titlep=prob.get('probabilidades_detalhes',{}).get('campeao',{}).get('exibicao') or pct(prob.get('probabilidades_pct',{}).get('campeao'))
    libp=prob.get('probabilidades_detalhes',{}).get('libertadores',{}).get('exibicao') or pct(prob.get('probabilidades_pct',{}).get('libertadores'))
    sudp=prob.get('probabilidades_detalhes',{}).get('sul_americana',{}).get('exibicao') or pct(prob.get('probabilidades_pct',{}).get('sul_americana'))
    rebp=prob.get('probabilidades_detalhes',{}).get('rebaixamento',{}).get('exibicao') or pct(prob.get('probabilidades_pct',{}).get('rebaixamento'))
    proj=prob.get('pontos_projetados',{}).get('media',prob.get('pontos_projetados','—'))
    posproj=prob.get('posicao_projetada','—')
    faixa=prob.get('faixa_posicao_80',{})
    faixa_txt=f"{faixa.get('melhor','—')}º–{faixa.get('pior','—')}º"
    dist=prob.get('distribuicao_posicoes_pct',[]) or []
    poscells=''.join(f'<div class="position-cell"><span class="pos-num">{i}º</span><span class="pos-bar"><i style="width:{min(100,max(0,float(v or 0)))}%"></i></span><span class="pos-pct">{pct(v)}</span></div>' for i,v in enumerate(dist[:20],1))
    # AF milestones
    cards=[]
    for target in (5,10,15,20):
        s=next((s for s in hist if int(s.get('jogos_por_clube') or 0)==target),None)
        if not s: continue
        rr=next((x for x in s.get('ranking',[]) if x.get('time')==CLUB_NAME),{})
        score=rr.get('indice_final',rr.get('score','—'))
        cards.append((f'APÓS {target} JOGOS',rr.get('pos','—'),score))
    cards.append((f'ATUAL · {rank.get("jogos",prob.get("jogos_atuais","—"))} JOGOS',rank.get('pos','—'),rank.get('indice_final',rank.get('score','—'))))
    timeline=''.join(f'<div class="timeline-card{" current" if i==len(cards)-1 else ""}"><small>{esc(lbl)}</small><strong>{esc(pos)}º · {esc(score)}</strong><span>posição · AF-Score</span></div>' for i,(lbl,pos,score) in enumerate(cards))
    # AF previsão table
    rows=[]
    for m in marcos:
        ff=next((x for x in m.get('clubes',[]) if x.get('clube')==CLUB_NAME),None)
        if ff:
            rows.append((m.get('rotulo','—'),m.get('referencia_em',''),ff.get('posicao_projetada'),ff.get('pontos_projetados'),ff.get('exibicao',{}).get('campeao',pct(ff.get('campeao_pct'))),ff.get('exibicao',{}).get('libertadores',pct(ff.get('libertadores_pct'))),ff.get('exibicao',{}).get('sul_americana',pct(ff.get('sul_americana_pct'))),ff.get('exibicao',{}).get('rebaixamento',pct(ff.get('rebaixamento_pct')))))
    rows.append(('ATUAL',probs.get('referencia_esportiva_em') or probs.get('gerado_em',''),posproj,proj,titlep,libp,sudp,rebp))
    previs=''.join(f'<tr class="{"current" if r[0]=="ATUAL" else ""}"><td><strong>{esc(r[0])}</strong><br><span class="club-subtle">{esc(str(r[1])[:10])}</span></td><td>{esc(r[2])}º</td><td>{esc(r[3])}</td><td>{esc(r[4])}</td><td>{esc(r[5])}</td><td>{esc(r[6])}</td><td>{esc(r[7])}</td></tr>' for r in rows)
    # games
    upcoming=[g for g in agenda if not g.get('concluido')][:6]
    games_html=''.join(f'<div class="game-card"><div class="game-meta">{esc(g.get("competicao_nome_curto") or g.get("competicao_nome"))} · {esc(fmt_date(g.get("data_iso","")))}</div><div class="game-match"><span>{esc(team_name(g,"mandante"))}</span><span>×</span><span>{esc(team_name(g,"visitante"))}</span></div><div class="game-actions"><a class="club-btn secondary" href="/jogos">Ver jogos</a><span data-fdg-game-alert-slot data-event-id="{esc(g.get("event_id"))}"></span></div></div>' for g in upcoming)
    # players
    arts=[x for x in leaders.get('artilharia',[]) if x.get('time')==CLUB_NAME][:5]
    assists=[x for x in leaders.get('assistencias',[]) if x.get('time')==CLUB_NAME][:5]
    amap={x.get('nome'):x for x in assists}
    people={x.get('nome'):{'g':x.get('gols',0),'a':amap.get(x.get('nome'),{}).get('assistencias',0),'j':x.get('jogos',0)} for x in arts}
    for x in assists:
        people.setdefault(x.get('nome'),{'g':0,'a':x.get('assistencias',0),'j':x.get('jogos',0)})
    topga=sorted(people.items(),key=lambda kv:kv[1]['g']+kv[1]['a'],reverse=True)[:5]
    player_col=lambda arr,key: ''.join(f'<div class="player-card"><strong>{esc(x.get("nome"))}</strong><span>{esc(x.get("jogos","—"))} jogos</span><em>{esc(x.get(key,0))}</em></div>' for x in arr)
    gahtml=''.join(f'<div class="player-card"><strong>{esc(n)}</strong><span>{v["g"]} G · {v["a"]} A</span><em>{v["g"]+v["a"]}</em></div>' for n,v in topga)
    # publico/renda filtered games
    pubrows=[x for x in estat.get('publico',{}).get('ranking',[]) if CLUB_NAME.lower() in str(x).lower()]
    total_pub=sum(int(x.get('publico') or x.get('publico_total') or 0) for x in pubrows)
    vals=[int(x.get('publico') or x.get('publico_total') or 0) for x in pubrows if (x.get('publico') or x.get('publico_total'))]
    rendas=[float(x.get('renda') or 0) for x in pubrows if x.get('renda')]
    media_pub=round(total_pub/len(vals)) if vals else 0
    # accuracy
    tl=acc.get('timeline_clubes',{}).get(CLUB_NAME,[]) if isinstance(acc.get('timeline_clubes'),dict) else []
    lasttl=tl[-1] if tl else {}
    # analyses
    rel=[a for a in analyses if CLUB_NAME.lower() in str(a).lower()][:5]
    analyses_html=''.join(f'<div class="analysis-card"><a href="{esc(a.get("url") or ("/analises/"+a.get("slug","")))}">{esc(a.get("titulo"))}</a><p>{esc(a.get("linha_fina",""))}</p></div>' for a in rel)
    answer=f'{CLUB_NAME} está em {prob.get("posicao_atual","—")}º lugar com {prob.get("pontos_atuais","—")} pontos após {prob.get("jogos_atuais","—")} jogos. O AF-Previsão projeta {proj} pontos, {posproj}º lugar e {titlep} de chance de título. A chance consolidada de Libertadores é {libp}.'
    # current live
    live=next((g for g in agenda if g.get('estado')=='in'),None)
    live_html=''
    if live:
        live_html=f'<div data-club-live-box data-event-id="{esc(live.get("event_id"))}" data-state="in"><a class="club-btn" href="/aovivo.html?event={esc(live.get("event_id"))}">🔴 Acompanhar ao vivo</a></div>'
    canon=f'{SITE}/clube/{CLUB_ID}/'
    description=f'Flamengo no Brasileirão 2026: posição, pontos, chances de título, Libertadores, AF-Score, AF-Previsão, jogos, jogadores, público, renda e evolução do modelo.'
    nav='''<nav class="nav" data-br-auth-menu aria-label="Menu principal"><a href="/estatisticas.html">📈 Estatísticas</a><a href="/jogos">⚽ Jogos</a><a href="/aovivo.html">🔴 Ao vivo</a><a href="/tabela">📊 Tabela</a><a href="/resultados">✅ Resultados</a><a href="/analises/">📰 Análises</a><a href="/clubes.html" class="active" aria-current="page">🛡️ Clubes</a><a href="/museu.html">🏛️ Museu</a><a href="/copa2026/">🌎 Copa 2026</a></nav>'''
    page=f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flamengo 2026: chances, projeção e jogos | Fórmula do Gol</title><meta name="description" content="{esc(description)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="{canon}"><meta property="og:type" content="website"><meta property="og:title" content="Flamengo 2026: chances, projeção e jogos"><meta property="og:description" content="{esc(description)}"><meta property="og:url" content="{canon}"><meta property="og:image" content="{SITE}/og-image-formula-do-gol-v2.jpg"><meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#10b981"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/css/br-institucional.css?v=20260722-evolucao-af-score-v1"><link rel="stylesheet" href="/css/br-global.css?v=20260801-footer-institucional-v1"><link rel="stylesheet" href="/css/br-alertas.css?v=20260905-push-resiliencia-v1"><link rel="stylesheet" href="/css/br-clube.css?v=20260907-org3-v1"><script type="application/ld+json">{json.dumps({'@context':'https://schema.org','@graph':[{'@type':'SportsTeam','@id':canon+'#team','name':CLUB_NAME,'url':canon,'logo':shield,'sport':'Football','memberOf':{'@type':'SportsOrganization','name':'Campeonato Brasileiro Série A'}},{'@type':'BreadcrumbList','itemListElement':[{'@type':'ListItem','position':1,'name':'Fórmula do Gol','item':SITE+'/'},{'@type':'ListItem','position':2,'name':'Clubes','item':SITE+'/clubes.html'},{'@type':'ListItem','position':3,'name':CLUB_NAME,'item':canon}]}]},ensure_ascii=False)}</script></head><body><div class="container"><header class="hero"><img src="/img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>{nav}<main class="club-page"><a class="club-back" href="/clubes.html">← Voltar para Clubes</a><section class="club-hero-card"><div class="club-identity"><img class="club-shield" src="{esc(shield)}" alt="Escudo do Flamengo"><div><div class="club-name-row"><h1>Flamengo</h1></div><div class="club-now"><span>{prob.get('posicao_atual','—')}º lugar</span><span>{prob.get('pontos_atuais','—')} pts</span><span>{prob.get('jogos_atuais','—')} jogos</span><span>AF-Score {rank.get('indice_final',rank.get('score','—'))}</span></div></div><div class="club-projection"><small>Projeção final</small><strong>{esc(proj)} pts</strong><span>posição projetada: {esc(posproj)}º · faixa 80%: {esc(faixa_txt)}</span></div></div></section><nav class="club-nav" aria-label="Atalhos da página"><a data-club-anchor href="#resumo">Resumo</a><a data-club-anchor href="#jogos">Jogos</a><a data-club-anchor href="#probabilidades">Probabilidades</a><a data-club-anchor href="#jogadores">Jogadores</a><a data-club-anchor href="#evolucao">Evolução</a><a data-club-anchor href="#mais">Mais</a></nav><section id="resumo" class="club-section section-anchor"><div class="club-section-head"><div><div class="club-kicker">Resumo rápido</div><h2>Como está o Flamengo agora?</h2></div>{live_html}</div><p class="club-answer"><strong>{esc(answer)}</strong></p><div class="club-grid" style="margin-top:12px"><div class="club-metric"><small>Campeão</small><strong class="accent">{esc(titlep)}</strong></div><div class="club-metric"><small>Posição projetada</small><strong class="accent">{esc(posproj)}º</strong></div><div class="club-metric"><small>Faixa provável</small><strong>{esc(faixa_txt)}</strong></div><div class="club-metric"><small>Libertadores</small><strong>{esc(libp)}</strong></div><div class="club-metric"><small>Sul-Americana</small><strong>{esc(sudp)}</strong></div><div class="club-metric"><small>Rebaixamento</small><strong>{esc(rebp)}</strong></div></div></section><section id="probabilidades" class="club-section section-anchor"><div class="club-section-head"><div><div class="club-kicker">AF-Previsão</div><h2>Distribuição das 20 posições</h2></div><span class="club-subtle">projeção: {esc(posproj)}º · mediana: {esc(prob.get('posicao_projetada_mediana','—'))}º</span></div><div class="positions-grid">{poscells}</div></section><section id="jogos" class="club-section section-anchor"><div class="club-section-head"><div><div class="club-kicker">Agenda</div><h2>Próximos jogos do Flamengo</h2></div><a class="club-btn secondary" href="/jogos">Ver agenda completa</a></div><div class="game-list">{games_html or '<div class="club-subtle">Nenhum jogo futuro disponível.</div>'}</div><div class="alert-box" style="margin-top:14px"><div><h3>🔔 Receba os gols do Flamengo</h3><p>Ative gols, pré-jogo, fim de partida e demais alertas essenciais deste clube neste aparelho.</p></div><div data-fdg-team-alert-slot data-team-id="flamengo" data-team-name="Flamengo"></div></div></section><section id="jogadores" class="club-section section-anchor"><div class="club-section-head"><div><div class="club-kicker">Jogadores</div><h2>Artilheiros, garçons e participações em gols</h2></div></div><div class="club-three"><div><h3>Artilheiros</h3>{player_col(arts,'gols')}</div><div><h3>Garçons</h3>{player_col(assists,'assistencias')}</div><div><h3>Gols + assistências</h3>{gahtml}</div></div></section><section id="evolucao" class="club-section section-anchor"><div class="club-section-head"><div><div class="club-kicker">AF-Score · Flamengo</div><h2>Evolução do Ranking de Desempenho</h2></div></div><div class="timeline-cards">{timeline}</div></section><section class="club-section"><div class="club-section-head"><div><div class="club-kicker">AF-Previsão · Flamengo</div><h2>Evolução da previsão</h2></div><span class="club-subtle">marcos fechados + cálculo atual</span></div><div class="table-scroll"><table class="club-table"><thead><tr><th>Referência</th><th>Pos.</th><th>Pts</th><th>Título</th><th>Libertadores</th><th>Sul-Americana</th><th>Queda</th></tr></thead><tbody>{previs}</tbody></table></div></section><section id="mais" class="club-section section-anchor"><div class="club-section-head"><div><div class="club-kicker">Campanha</div><h2>Desempenho do Flamengo</h2></div></div><div class="club-grid"><div class="club-metric"><small>Jogos</small><strong>{rank.get('jogos','—')}</strong></div><div class="club-metric"><small>Pontos</small><strong>{rank.get('pontos','—')}</strong></div><div class="club-metric"><small>Gols pró</small><strong>{rank.get('gp','—')}</strong></div><div class="club-metric"><small>Gols contra</small><strong>{rank.get('gc','—')}</strong></div><div class="club-metric"><small>Saldo</small><strong>{rank.get('sg','—')}</strong></div><div class="club-metric"><small>Aproveitamento</small><strong>{rank.get('aproveitamento','—')}%</strong></div></div></section><section class="club-section"><div class="club-section-head"><div><div class="club-kicker">Torcida no estádio</div><h2>Público e renda</h2></div></div><div class="club-grid"><div class="club-metric"><small>Jogos com público</small><strong>{len(vals)}</strong></div><div class="club-metric"><small>Público total</small><strong>{total_pub:,}</strong></div><div class="club-metric"><small>Média</small><strong>{media_pub:,}</strong></div><div class="club-metric"><small>Maior público</small><strong>{max(vals) if vals else '—'}</strong></div><div class="club-metric"><small>Renda total</small><strong>R$ {sum(rendas):,.0f}</strong></div><div class="club-metric"><small>Maior renda</small><strong>R$ {max(rendas):,.0f}</strong></div></div></section><section class="club-section"><div class="club-section-head"><div><div class="club-kicker">Acurácia</div><h2>Evolução do modelo para o Flamengo</h2></div><a class="club-btn secondary" href="/acuracia.html">Ver acurácia completa</a></div><p class="club-answer">A linha histórica preserva as projeções publicadas do clube ao longo da temporada. O registro atual aponta {esc(lasttl.get('posicao_projetada',posproj))}º lugar projetado e {esc(pct(lasttl.get('probabilidades_pct',{}).get('campeao',prob.get('probabilidades_pct',{}).get('campeao'))))} de chance de título.</p></section><section class="club-section"><div class="club-section-head"><div><div class="club-kicker">Análises</div><h2>Conteúdo relacionado ao Flamengo</h2></div><a class="club-btn secondary" href="/analises/">Todas as análises</a></div><div class="analysis-list">{analyses_html or '<div class="club-subtle">Sem análises relacionadas no momento.</div>'}</div></section><section class="club-section"><div class="club-section-head"><div><div class="club-kicker">Identidade</div><h2>Sobre o Flamengo</h2></div></div><div class="club-identity-facts"><div class="fact"><small>Nome completo</small><strong>{esc(club.get('nome_completo'))}</strong></div><div class="fact"><small>Cidade</small><strong>{esc(club.get('cidade'))} · {esc(club.get('uf'))}</strong></div><div class="fact"><small>Estádio</small><strong>{esc(club.get('estadio'))}</strong></div><div class="fact"><small>Fundação</small><strong>{esc(club.get('fundacao'))}</strong></div></div></section></main><footer class="site-footer br-disclaimer"><nav class="br-footer-links"><a href="/sobre.html">ⓘ Sobre o Fórmula do Gol</a></nav><div class="br-footer-copy">Fórmula do Gol — site independente, informativo e sem fins lucrativos. Dados esportivos organizados a partir de fontes públicas; modelos, projeções e apresentação são próprios.</div></footer></div><script src="/js/br-config.js?v=20260723-copa-publica-v1"></script><script src="/js/br-menu.js?v=20260901-alertas-v1"></script><script src="/js/br-clube.js?v=20260907-org3-v1" defer></script><script src="/js/br-push.js?v=20260905-push-resiliencia-v1" defer></script><script src="/js/br-alertas.js?v=20260905-push-resiliencia-v1" defer></script></body></html>'''
    out=site_dir/'clube'/CLUB_ID/'index.html'; out.parent.mkdir(parents=True,exist_ok=True); out.write_text(page,encoding='utf-8')
    # Patch club hub link if present.
    hub=site_dir/'clubes.html'
    if hub.exists():
        t=hub.read_text(encoding='utf-8')
        t=re.sub(r'href=["\'](?:/)?clubes\.html#flamengo["\']', 'href="/clube/flamengo/"', t, flags=re.I)
        hub.write_text(t,encoding='utf-8')
    # Update sitemap lastmod without duplicating URL.
    sm=site_dir/'sitemap.xml'
    if sm.exists():
        text=sm.read_text(encoding='utf-8')
        latest=max([p.stat().st_mtime for p in [data/'probabilidades-brasileirao.json',data/'ranking-desempenho.json',data/'marcos-af-previsao.json',data/'lideres-jogadores.json',data/'estatisticas-competicao.json',data/'acuracia-af-previsao.json',data/'analises.json',data/'agenda-clubes-br.json'] if p.exists()] or [datetime.now().timestamp()])
        last=datetime.fromtimestamp(latest).astimezone().isoformat(timespec='seconds')
        entry=f'<url><loc>{canon}</loc><lastmod>{last}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>'
        if canon in text:
            text=re.sub(r'<url>\s*<loc>'+re.escape(canon)+r'</loc>.*?</url>',entry,text,flags=re.S)
        else:text=text.replace('</urlset>',entry+'\n</urlset>')
        sm.write_text(text,encoding='utf-8')
    # structural gates
    txt=out.read_text(encoding='utf-8')
    checks={'one_h1':txt.count('<h1>')==1,'canonical':canon in txt,'back':'Voltar para Clubes' in txt,'20_positions':txt.count('position-cell')>=20,'alerts':'data-fdg-team-alert-slot' in txt,'afscore':'Evolução do Ranking de Desempenho' in txt,'afprev':'Evolução da previsão' in txt,'players':'Artilheiros, garçons' in txt,'public':'Público e renda' in txt,'accuracy':'Evolução do modelo' in txt}
    bad=[k for k,v in checks.items() if not v]
    if bad: raise SystemExit('ORG-3 validation failed: '+', '.join(bad))
    print('ORG-3 PASS:', ', '.join(checks))

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--site-dir',default='_site'); ap.add_argument('--repo-root',default='.')
    a=ap.parse_args(); render(Path(a.site_dir).resolve(),Path(a.repo_root).resolve())
