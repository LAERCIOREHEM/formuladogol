#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, html, json, re, sys
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'scripts'))
from gerar_analise_rodada import (SITE, CAMINHO_ANALISES, cabecalho_html, menu, rodape, submenu_rodadas,
    sincronizar_submenus_artigos, gerar_hub, gerar_feed, gerar_news_sitemap, atualizar_sitemap, gravar_texto, agora_br)

SNAPS={
 'libertadores': ROOT/'dados-br/competicoes-af-previsao/libertadores.json',
 'sul_americana': ROOT/'dados-br/competicoes-af-previsao/sul-americana.json'}
MM_PATH=ROOT/'dados-br/melhores-momentos-continentais.json'
MANIFEST=ROOT/'dados-br/analises.json'
PHASES={600:('Oitavas de final','oitavas','QF'),700:('Quartas de final','quartas','SF'),800:('Semifinal','semifinal','FINAL'),900:('Final','final','CAMPEÃO')}
COMP_NAMES={'libertadores':'Libertadores','sul_americana':'Sul-Americana'}
KNOWN_SHOOTOUTS={'401874156','401874142'}
RENDER_VERSION=3

class ContinentalEditorialError(RuntimeError): pass

def load(path:Path, default=None):
 try:return json.loads(path.read_text(encoding='utf-8'))
 except Exception:return default

def canon(v):return hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def esc(v):return html.escape(str(v or ''),quote=True)
def team_key(side):return str(side.get('espn_id') or side.get('nome') or '')
def br(side):return bool(side.get('serie_a_2026'))
def nm(side):return str(side.get('nome') or side.get('nome_espn') or '').strip()

def phase_events(snapshot:Mapping[str,Any],rank:int):
 return [e for e in snapshot.get('eventos') or [] if int(e.get('fase_ordem') or 0)==rank and (br(e.get('mandante') or {}) or br(e.get('visitante') or {}))]

def ranks_with_brazilians(snaps):
 return sorted({int(e.get('fase_ordem') or 0) for s in snaps.values() for e in s.get('eventos') or [] if int(e.get('fase_ordem') or 0) in PHASES and (br(e.get('mandante') or {}) or br(e.get('visitante') or {}))})

def tie_key(e):return tuple(sorted((team_key(e.get('mandante') or {}),team_key(e.get('visitante') or {}))))

def build_ties(comp,snapshot,rank):
 groups={}
 for e in phase_events(snapshot,rank):groups.setdefault(tie_key(e),[]).append(e)
 out=[]
 for _,legs in groups.items():
  legs=sorted(legs,key=lambda e:(int(e.get('perna') or 0),str(e.get('data_iso') or '')))
  teams={team_key(x):x for e in legs for x in (e.get('mandante') or {},e.get('visitante') or {})}
  names=list(teams.values())
  if len(names)!=2:continue
  a,b=names[0],names[1]
  agg={team_key(a):0,team_key(b):0}
  for e in legs:
   agg[team_key(e['mandante'])]+=int((e['mandante'] or {}).get('placar') or 0)
   agg[team_key(e['visitante'])]+=int((e['visitante'] or {}).get('placar') or 0)
  last=legs[-1]
  winner=str(last.get('vencedor') or '').strip()
  if not winner and len(legs)>=2 and agg[team_key(a)]!=agg[team_key(b)]:winner=nm(a) if agg[team_key(a)]>agg[team_key(b)] else nm(b)
  if not winner:
   for e in reversed(legs):
    if e.get('vencedor'):winner=str(e['vencedor']);break
  team_by_name={nm(a):a,nm(b):b}
  loser=next((x for x in (nm(a),nm(b)) if x!=winner),'')
  brazilian=[nm(x) for x in (a,b) if br(x)]
  out.append({'competicao':comp,'fase_ordem':rank,'times':[nm(a),nm(b)],'team_objs':[a,b],'pernas':legs,
   'agregado':[agg[team_key(a)],agg[team_key(b)]],'vencedor':winner,'eliminado':loser,
   'brasileiros':brazilian,'br_classificados':[x for x in brazilian if x==winner], 'penaltis':bool(last.get('penaltis'))})
 return sorted(out,key=lambda t:(t['competicao'],t['times'][0],t['times'][1]))

def latest_publishable(snaps):
 ranks=ranks_with_brazilians(snaps)
 for rank in reversed(ranks):
  ev=[e for s in snaps.values() for e in phase_events(s,rank)]
  if ev and all(bool(e.get('concluido')) for e in ev):
   # Se uma competição classificou brasileiro na fase anterior, mas ainda não materializou esta fase, espere.
   prev=rank-100
   if prev in PHASES:
    for comp,s in snaps.items():
     current=phase_events(s,rank)
     prev_ties=build_ties(comp,s,prev)
     prev_br_winners={w for t in prev_ties for w in t['br_classificados']}
     if prev_br_winners and not current:return None
   return rank
 return None

def date_label(iso):
 try:return datetime.fromisoformat(iso).strftime('%d/%m/%Y · %H:%M')
 except Exception:return iso

def crest(side):
 tid=esc(side.get('espn_id') or '')
 return f'https://a.espncdn.com/i/teamlogos/soccer/500/{tid}.png' if tid else ''

def video_card(event_id, mm):
 v=(mm.get('jogos') or {}).get(str(event_id)) or {}
 url=str(v.get('url') or '').strip(); title=esc(v.get('titulo') or 'Melhores momentos'); source=esc(v.get('fonte') or 'Vídeo')
 if not url:return ''
 vid=''
 m=re.search(r'(?:v=|youtu\.be/|/live/)([A-Za-z0-9_-]{11})',url)
 if m:vid=m.group(1)
 if vid and v.get('embeddable') is True:
  return f'<button type="button" class="analysis-cup-video-card analysis-inline-video" data-video-id="{vid}" data-video-title="{title}" data-video-source="{source}"><span class="analysis-cup-video-thumb"><img src="https://i.ytimg.com/vi/{vid}/hqdefault.jpg" alt="" loading="lazy"><i aria-hidden="true">▶</i></span><span class="analysis-cup-video-copy"><b>Melhores momentos</b><small>{source}</small></span></button>'
 return f'<a class="analysis-cup-video-card analysis-cup-video-external" href="{esc(url)}" target="_blank" rel="noopener noreferrer"><span class="analysis-cup-video-copy"><b>▶ Melhores momentos ↗</b><small>{source}</small></span></a>'

def render_tie(t,idx,mm):
 a,b=t['team_objs']; ag=t['agregado']; win=t['vencedor']; lose=t['eliminado']
 teams=[]
 for side,score in ((a,ag[0]),(b,ag[1])):
  status='CLASSIFICADO' if nm(side)==win else 'ELIMINADO'
  teams.append(f'<div class="analysis-cup-team"><div class="analysis-cup-crest"><img src="{crest(side)}" alt="" loading="lazy"></div><strong>{esc(nm(side))}</strong><small>{status}</small></div>')
 legs=''
 for e in t['pernas']:
  h,a2=e['mandante'],e['visitante']; eid=str(e.get('event_id') or '')
  label='Partida 1 de 2' if int(e.get('perna') or 0)==1 else 'Partida 2 de 2' if int(e.get('perna') or 0)==2 else 'Partida'
  legs+=f'<div class="analysis-cup-leg"><span>{label}</span><time datetime="{esc(e.get("data_iso"))}">{date_label(str(e.get("data_iso") or ""))}</time><p>{esc(nm(h))} <b>{int(h.get("placar") or 0)} × {int(a2.get("placar") or 0)}</b> {esc(nm(a2))}</p><small>📍 {esc(e.get("estadio") or "—")}</small>{video_card(eid,mm)}</div>'
 pen=''
 if t['penaltis']:
  last_event_id=str(t['pernas'][-1].get('event_id') or '')
  if t['penaltis'] and last_event_id in KNOWN_SHOOTOUTS:
   pen_score='5–4' if t['vencedor']==nm(t['team_objs'][0]) else '4–5'
   pen=f'<span> · Pênaltis {esc(pen_score)}</span>'
  elif t['penaltis']:
   pen='<span> · Decidido nos pênaltis</span>'
  else:
   pen=''
 return f'''<article class="analysis-cup-tie"><header><span>{esc(COMP_NAMES[t['competicao']])} · CONFRONTO {idx}</span><b>ENCERRADO</b></header><div class="analysis-cup-matchup">{teams[0]}<div class="analysis-cup-aggregate"><span>AGREGADO</span><strong>{ag[0]} × {ag[1]}</strong>{pen}</div>{teams[1]}</div><div class="analysis-cup-legs">{legs}</div><footer><strong>Classificado: {esc(win)}</strong><span>Eliminado: {esc(lose)}</span></footer></article>'''

def editorial_copy(rank,ties):
 qualified=sorted({w for t in ties for w in t['br_classificados']})
 participants=sorted({b for t in ties for b in t['brasileiros']}); eliminated=sorted(set(participants)-set(qualified))
 if rank==600:
  return {
   'titulo':'Oitavas continentais: oito brasileiros avançam e quatro ficam pelo caminho',
   'linha_fina':'Fluminense, Palmeiras, Flamengo e Corinthians seguem vivos na Libertadores; São Paulo, Atlético-MG, Santos e Vasco avançam na Sul-Americana.',
   'secoes':[
    {'titulo':'Libertadores mantém quatro brasileiros na disputa','paragrafos':[
     'A Libertadores fechou o recorte brasileiro das oitavas com quatro classificados e duas eliminações. O Fluminense precisou do caminho mais longo. Depois do empate por 0 a 0 no Maracanã, voltou a empatar com o Independiente Rivadavia, desta vez por 1 a 1 na Argentina. Com o agregado também empatado em 1 a 1, a vaga foi decidida nos pênaltis, e o Tricolor venceu por 5 a 4.',
     'O Palmeiras também começou a série sem vantagem. O 1 a 1 com o Cerro Porteño em São Paulo deixou tudo aberto para a volta no Paraguai. Em Assunção, o Verdão venceu por 1 a 0 e fechou o confronto em 2 a 1 no placar agregado, garantindo presença nas quartas de final.',
     'No confronto brasileiro da fase, Flamengo e Cruzeiro chegaram ao Maracanã depois do empate por 1 a 1 no Mineirão. O Rubro-Negro venceu a segunda partida por 2 a 1 e avançou com 3 a 2 no agregado. O resultado encerrou a campanha do Cruzeiro e manteve o Flamengo na disputa pelo título continental.',
     'O Corinthians foi outro brasileiro que decidiu a classificação em casa. Depois do 0 a 0 diante do Rosario Central na Argentina, venceu a volta por 1 a 0 na Neo Química Arena. Com isso, fechou a série pelo mesmo placar no agregado e avançou às quartas.',
     'A outra eliminação brasileira veio em Quito. Mirassol e LDU haviam empatado por 1 a 1 no primeiro jogo e voltaram a terminar iguais, agora por 0 a 0. O agregado de 1 a 1 levou a decisão aos pênaltis, e a equipe equatoriana venceu por 5 a 4. Assim, Fluminense, Palmeiras, Flamengo e Corinthians seguem na Libertadores, enquanto Cruzeiro e Mirassol se despedem.'
    ]},
    {'titulo':'Sul-Americana classifica quatro e elimina dois brasileiros','paragrafos':[
     'Na Sul-Americana, o São Paulo confirmou a classificação depois de abrir a série com empate por 1 a 1 contra o Bolívar em La Paz. No Morumbi, venceu por 3 a 1 e fechou as oitavas com vantagem de 4 a 2 no placar agregado.',
     'Atlético-MG e Bragantino fizeram outro duelo totalmente brasileiro. O Atlético venceu a partida de ida por 1 a 0 e segurou a classificação no jogo de volta com empate por 2 a 2. O agregado terminou em 3 a 2 para o clube mineiro, que avançou e eliminou o Bragantino.',
     'O Santos administrou a vantagem construída na Vila Belmiro. Depois de vencer o Macará por 2 a 1 na primeira partida, empatou por 0 a 0 no Equador. O 2 a 1 agregado colocou o clube paulista nas quartas de final.',
     'O Vasco protagonizou o placar mais amplo entre os brasileiros classificados na volta. Depois do empate por 0 a 0 com o Olimpia no primeiro encontro, venceu por 4 a 1 no Paraguai e avançou com o mesmo 4 a 1 no agregado.',
     'O Botafogo tinha a situação mais difícil. A derrota por 6 a 1 para o Cienciano no Peru deixou o clube diante de uma desvantagem enorme para a segunda partida. No Nilton Santos, o Botafogo venceu por 1 a 0, mas o resultado não foi suficiente: o Cienciano avançou por 6 a 2 no agregado. São Paulo, Atlético-MG, Santos e Vasco seguem no torneio; Bragantino e Botafogo estão eliminados.'
    ]},
    {'titulo':'O saldo brasileiro depois das oitavas','paragrafos':[
     'Somadas as duas competições, doze clubes brasileiros apareceram nas dez chaves acompanhadas pelo Fórmula do Gol. O saldo foi de oito classificados e quatro eliminados. A Libertadores continuará com Fluminense, Palmeiras, Flamengo e Corinthians. Na Sul-Americana, São Paulo, Atlético-MG, Santos e Vasco mantêm o país representado. Cruzeiro, Mirassol, Bragantino e Botafogo encerraram suas campanhas continentais.',
     'As oitavas completas das competições ainda possuem confrontos sem clubes brasileiros a serem concluídos. Para o Fórmula do Gol, porém, o ciclo que interessa ao acompanhamento nacional está encerrado: o editorial é liberado quando todos os jogos da fase que envolvem clubes brasileiros terminam, sem esperar partidas exclusivamente estrangeiras.'
    ]}
   ]}
 phase=PHASES[rank][0]
 return {'titulo':f'{phase} continentais: brasileiros definem seus caminhos na Libertadores e Sul-Americana','linha_fina':f'Fechamento dos confrontos de {phase.lower()} que envolveram clubes brasileiros nas duas competições continentais.','secoes':[
  {'titulo':f'O fechamento de {phase.lower()}','paragrafos':[f'Os confrontos de {phase.lower()} com participação brasileira estão concluídos. O Fórmula do Gol considera somente as chaves que tiveram ao menos um clube da Série A 2026 e não espera partidas exclusivamente estrangeiras para encerrar o editorial.',f'Nesta fase, {len(participants)} brasileiro(s) participaram do recorte e {len(qualified)} avançaram. Os placares de ida, volta, agregado e eventuais decisões por pênaltis são apresentados a partir dos snapshots oficiais do projeto.']},
  {'titulo':'Quem segue e quem se despede','paragrafos':[('Classificados: '+', '.join(qualified)+'.') if qualified else 'Nenhum clube brasileiro avançou nesta fase.',('Eliminados: '+', '.join(eliminated)+'.') if eliminated else 'Nenhum clube brasileiro foi eliminado nesta fase.']},
  {'titulo':'Próxima fase','paragrafos':['O gerador só voltará a publicar quando existir uma nova fase eliminatória materializada nos snapshots com participação de clube brasileiro e todos os jogos desse recorte estiverem encerrados.','Se não houver brasileiro na fase seguinte, não será criado novo editorial continental.']}
 ]}

def build_article(rank,ties,mm,now):
 phase,slug_phase,menu_label=PHASES[rank]; content=editorial_copy(rank,ties)
 aid=f'continentais-2026-{slug_phase}-brasileiros'; slug=aid+'.html'
 q=sorted({w for t in ties for w in t['br_classificados']}); p=sorted({b for t in ties for b in t['brasileiros']}); el=sorted(set(p)-set(q))
 linked=sum(1 for t in ties for e in t['pernas'] if ((mm.get('jogos') or {}).get(str(e.get('event_id') or '')) or {}).get('url'))
 dossier={'render_version':RENDER_VERSION,'fase_ordem':rank,'confrontos':ties,'mm':mm.get('jogos') or {}}
 return {'tipo':'continentais_fase','id_editorial':aid,'rotulo_menu':f'CONT · {menu_label}','categoria':f'LIBERTADORES + SUL-AMERICANA · {phase.upper()}',
  'competicao':'Libertadores + Sul-Americana','fase_encerrada':phase,'fase_seguinte':PHASES.get(rank+100,('Encerramento','',''))[0],
  'slug':slug,'url':f'{SITE}/analises/{slug}','titulo':content['titulo'],'linha_fina':content['linha_fina'],'publicado_em':now.isoformat(),'modificado_em':now.isoformat(),
  'jogos_concluidos':sum(len(t['pernas']) for t in ties),'jogos_pendentes':0,'confrontos':len(ties),'classificados':q,'eliminados':el,'clubes_brasileiros':p,
  'hash_dossie':canon(dossier),'hash_editorial':canon(content),'hash_melhores_momentos':canon(mm.get('jogos') or {}),'melhores_momentos_vinculados':linked,'editorial':content,
  'email_assunto':f'Fórmula do Gol: fechamento continental de {phase}','email_chamada':f'{phase} encerradas para os brasileiros. Veja classificados, agregados e melhores momentos.','origem_editorial':'deterministico'}

def render_page(article,ties,mm,all_articles):
 title=article['titulo']; desc=article['linha_fina']; pub=article['publicado_em']; mod=article['modificado_em']; url=article['url']; aid=article['id_editorial']
 copy=''.join('<section class="analysis-copy-section"><h3>'+esc(s['titulo'])+'</h3>'+''.join('<p>'+esc(p)+'</p>' for p in s['paragrafos'])+'</section>' for s in article['editorial']['secoes'])
 groups=[]
 for comp in ('libertadores','sul_americana'):
  ct=[t for t in ties if t['competicao']==comp]
  if ct:
   cards=''.join(render_tie(t,i+1,mm) for i,t in enumerate(ct))
   groups.append(f'<section><h2>{esc(COMP_NAMES[comp])}</h2><p class="analysis-help">{len(ct)} confronto(s) com participação brasileira.</p><div class="analysis-cup-ties">{cards}</div></section>')
 qualified=', '.join(article['classificados']) or 'Nenhum'; eliminated=', '.join(article['eliminados']) or 'Nenhum'
 body=f'''<body data-fdg-editorial-id="{esc(aid)}" data-fdg-analise-competicao="continentais"><header class="site-header"><div class="logo"><a href="../" class="brand-link"><img src="../favicon-formula-do-gol-512.png" alt="Fórmula do Gol"><span>Fórmula do Gol</span></a></div>{menu('../',True)}</header><main class="analysis-page"><section class="analysis-hero"><p class="analysis-kicker">{esc(article['categoria'])}</p><h1>{esc(title)}</h1><p class="analysis-deck">{esc(desc)}</p><p class="analysis-meta"><time datetime="{esc(pub)}">Publicado em {date_label(pub)}</time></p></section>{submenu_rodadas(all_articles,id_ativo=aid)}<section class="analysis-copy"><h2>O fechamento continental dos brasileiros</h2><div class="analysis-copy-sections">{copy}</div></section>{''.join(groups)}<section><h2>Resumo brasileiro</h2><p><strong>Classificados:</strong> {esc(qualified)}</p><p><strong>Eliminados:</strong> {esc(eliminated)}</p></section><p class="analysis-cta"><a href="../">Probabilidades do Brasileirão 2026 →</a></p></main>{rodape('../')}<script src="../js/br-analises.js" defer></script></body></html>'''
 return cabecalho_html(title,desc,url,'NewsArticle',pub,mod)+body

def publish(dry=False,force_rank=0):
 snaps={k:load(p,{}) for k,p in SNAPS.items()}; rank=force_rank or latest_publishable(snaps)
 if not rank:
  print('NONE: nenhuma fase continental brasileira pronta para editorial.'); return 0
 ties=[t for comp,s in snaps.items() for t in build_ties(comp,s,rank)]
 if not ties or not all(all(e.get('concluido') for e in t['pernas']) for t in ties):
  print('NONE: fase ainda não concluída no recorte brasileiro.');return 0
 mm=load(MM_PATH,{'jogos':{}}) or {'jogos':{}}; now=agora_br().replace(microsecond=0)
 manifest=load(MANIFEST,{'schema_version':2,'site':'Fórmula do Gol','artigos':[]}); articles=list(manifest.get('artigos') or [])
 article=build_article(rank,ties,mm,now)
 old=next((a for a in articles if a.get('id_editorial')==article['id_editorial']),None)
 if old and old.get('hash_dossie')==article['hash_dossie'] and old.get('hash_melhores_momentos')==article['hash_melhores_momentos']:
  print('NONE: editorial continental já está atualizado.');return 0
 if old:
  article['publicado_em']=old.get('publicado_em') or article['publicado_em']; articles=[article if a.get('id_editorial')==article['id_editorial'] else a for a in articles]
 else: articles.append(article)
 articles.sort(key=lambda a:str(a.get('publicado_em') or ''), reverse=True)
 if dry:
  print(json.dumps(article,ensure_ascii=False,indent=2));return 0
 manifest['artigos']=articles; manifest['total_artigos']=len(articles); manifest['atualizado_em']=now.isoformat()
 MANIFEST.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 CAMINHO_ANALISES.mkdir(exist_ok=True)
 gravar_texto(CAMINHO_ANALISES/article['slug'],render_page(article,ties,mm,articles))
 sincronizar_submenus_artigos(articles); gravar_texto(CAMINHO_ANALISES/'index.html',gerar_hub(articles)); atualizar_sitemap(articles)
 gravar_texto(ROOT/'news-sitemap.xml',gerar_news_sitemap(articles,now)); gravar_texto(ROOT/'feed.xml',gerar_feed(articles,now))
 print(f"OK: {article['slug']} publicado com {len(ties)} confrontos e {article['melhores_momentos_vinculados']} link(s) de melhores momentos.")
 return 0

def self_test():
 snaps={k:load(p,{}) for k,p in SNAPS.items()}; assert latest_publishable(snaps)==600
 ties=[t for c,s in snaps.items() for t in build_ties(c,s,600)]; assert len(ties)==10
 q={w for t in ties for w in t['br_classificados']}; assert len(q)==8 and {'Flamengo','Palmeiras','Corinthians','Fluminense','São Paulo','Atlético-MG','Santos','Vasco da Gama'}<=q
 fake={k:{'eventos':[]} for k in snaps}; assert latest_publishable(fake) is None
 print('OK: self-test editorial continental.')

def main():
 p=argparse.ArgumentParser();p.add_argument('--dry-run',action='store_true');p.add_argument('--self-test',action='store_true');p.add_argument('--fase-ordem',type=int,default=0);a=p.parse_args()
 if a.self_test:self_test();return 0
 return publish(a.dry_run,a.fase_ordem)
if __name__=='__main__':raise SystemExit(main())
