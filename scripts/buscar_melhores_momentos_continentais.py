#!/usr/bin/env python3
from __future__ import annotations
import argparse, copy, datetime as dt, json, os, re, unicodedata, urllib.parse, urllib.request
from pathlib import Path
from typing import Any, Mapping

ROOT=Path(__file__).resolve().parent.parent
SNAPS={'libertadores':ROOT/'dados-br/competicoes-af-previsao/libertadores.json','sul_americana':ROOT/'dados-br/competicoes-af-previsao/sul-americana.json'}
OUT=ROOT/'dados-br/melhores-momentos-continentais.json'
YT='https://www.googleapis.com/youtube/v3'
CHANNELS={'libertadores':('@LibertadoresBR','CONMEBOL Libertadores'),'sul_americana':('@SudamericanaBR','CONMEBOL Sudamericana')}

def load(p,default=None):
 try:return json.loads(p.read_text(encoding='utf-8'))
 except Exception:return copy.deepcopy(default)
def norm(v):
 s=unicodedata.normalize('NFD',str(v or '').lower());s=''.join(c for c in s if unicodedata.category(c)!='Mn');return re.sub(r'\s+',' ',re.sub(r'[^a-z0-9]+',' ',s)).strip()
def api(key,endpoint,**params):
 params['key']=key;url=YT+'/'+endpoint+'?'+urllib.parse.urlencode(params)
 with urllib.request.urlopen(url,timeout=25) as r:return json.loads(r.read().decode())
def resolve_channel(key,handle):
 d=api(key,'channels',part='id',forHandle=handle.lstrip('@'));items=d.get('items') or [];return str(items[0].get('id') or '') if items else ''
def side(e,k):return str(((e.get(k) or {}).get('nome') or (e.get(k) or {}).get('nome_espn') or '')).strip()
def is_br(e):return bool((e.get('mandante') or {}).get('serie_a_2026') or (e.get('visitante') or {}).get('serie_a_2026'))
def aliases(name):
 base=norm(name); vals={base}
 repl={'vasco da gama':'vasco','atletico mg':'atletico mineiro','bragantino':'red bull bragantino','liga de quito':'ldu','club olimpia':'olimpia','cienciano del cusco':'cienciano','rosario central':'rosario'}
 if base in repl: vals.add(repl[base])
 return vals
def has_team(title,name):
 t=' '+norm(title)+' ';return any(' '+a+' ' in t for a in aliases(name))
def candidate_ok(title,e,comp):
 n=norm(title)
 return ('melhores momentos' in n or 'highlights' in n) and '2026' in n and has_team(title,side(e,'mandante')) and has_team(title,side(e,'visitante')) and (('libertadores' in n) if comp=='libertadores' else ('sudamericana' in n or 'sul americana' in n))
def completed_brazilian_events(snapshot):
 ranks=sorted({int(e.get('fase_ordem') or 0) for e in snapshot.get('eventos') or [] if is_br(e) and int(e.get('fase_ordem') or 0)>=600})
 if not ranks:return []
 rank=ranks[-1]
 return [e for e in snapshot.get('eventos') or [] if int(e.get('fase_ordem') or 0)==rank and is_br(e) and e.get('concluido')]
def search_one(key,cid,e,comp):
 when=dt.datetime.fromisoformat(str(e.get('data_iso')).replace('Z','+00:00'))
 after=(when-dt.timedelta(days=1)).astimezone(dt.timezone.utc).isoformat().replace('+00:00','Z')
 before=(when+dt.timedelta(days=4)).astimezone(dt.timezone.utc).isoformat().replace('+00:00','Z')
 q=f'{side(e,"mandante")} {side(e,"visitante")} melhores momentos 2026'
 d=api(key,'search',part='snippet',type='video',channelId=cid,q=q,maxResults=10,order='date',publishedAfter=after,publishedBefore=before)
 ids=[];snips={}
 for it in d.get('items') or []:
  vid=str((it.get('id') or {}).get('videoId') or '');title=str((it.get('snippet') or {}).get('title') or '')
  if vid and candidate_ok(title,e,comp):ids.append(vid);snips[vid]=it.get('snippet') or {}
 if not ids:return None
 vd=api(key,'videos',part='status,snippet',id=','.join(ids))
 for it in vd.get('items') or []:
  vid=str(it.get('id') or '');status=it.get('status') or {};snippet=it.get('snippet') or snips.get(vid,{})
  if str(status.get('privacyStatus') or '')!='public':continue
  return {'url':f'https://www.youtube.com/watch?v={vid}','video_id':vid,'titulo':str(snippet.get('title') or ''),'fonte':CHANNELS[comp][1],'channel_id':cid,'embeddable':bool(status.get('embeddable')),'manual_verificado':False}
 return None
def run(key,dry=False):
 old=load(OUT,{'schema_version':1,'temporada':2026,'competicoes':['libertadores','sul_americana'],'jogos':{}});games=dict(old.get('jogos') or {})
 channels={c:resolve_channel(key,h) for c,(h,_) in CHANNELS.items()}
 if not all(channels.values()):raise RuntimeError('não foi possível resolver os canais oficiais da CONMEBOL')
 found=0
 for comp,p in SNAPS.items():
  snap=load(p,{})
  for e in completed_brazilian_events(snap):
   eid=str(e.get('event_id') or '')
   # preserva override manual verificado; automação só preenche lacunas ou substitui item automático.
   if (games.get(eid) or {}).get('manual_verificado') is True:continue
   cand=search_one(key,channels[comp],e,comp)
   if cand:games[eid]=cand;found+=1
 payload={'schema_version':1,'temporada':2026,'competicoes':['libertadores','sul_americana'],'atualizado_em':dt.datetime.now(dt.timezone.utc).isoformat(),'canais_oficiais':{c:{'handle':CHANNELS[c][0],'channel_id':channels[c]} for c in channels},'jogos':games}
 if dry:print(json.dumps(payload,ensure_ascii=False,indent=2));return 0
 OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(f'OK: {found} novo(s) vínculo(s) oficial(is); {len(games)} total.');return 0
def self_test():
 e={'mandante':{'nome':'Flamengo','serie_a_2026':True},'visitante':{'nome':'Cruzeiro','serie_a_2026':True}}
 assert candidate_ok('FLAMENGO X CRUZEIRO | MELHORES MOMENTOS | CONMEBOL LIBERTADORES 2026',e,'libertadores')
 assert not candidate_ok('FLAMENGO X CRUZEIRO | MELHORES MOMENTOS | BRASILEIRÃO 2026',e,'libertadores')
 assert not candidate_ok('PALMEIRAS X CERRO PORTEÑO | MELHORES MOMENTOS | CONMEBOL LIBERTADORES 2026',e,'libertadores')
 print('OK: self-test coletor continental.')
def main():
 p=argparse.ArgumentParser();p.add_argument('--dry-run',action='store_true');p.add_argument('--self-test',action='store_true');a=p.parse_args()
 if a.self_test:self_test();return 0
 key=os.environ.get('YOUTUBE_API_KEY','').strip()
 if not key:raise SystemExit('YOUTUBE_API_KEY ausente')
 return run(key,a.dry_run)
if __name__=='__main__':raise SystemExit(main())
