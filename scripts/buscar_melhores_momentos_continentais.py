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
OFFICIAL_CHANNEL_IDS={'libertadores':'UCyuLjFPzlkMSYJpIpY8M6qA','sul_americana':'UCFHE5FRBeksxt7YoFPGeKPw'}

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
def team_key(side_obj):
 return str((side_obj or {}).get('espn_id') or norm((side_obj or {}).get('nome') or (side_obj or {}).get('nome_espn') or ''))
def tie_key(e):
 return tuple(sorted((team_key(e.get('mandante')),team_key(e.get('visitante')))))
def event_dt(e):
 try:return dt.datetime.fromisoformat(str(e.get('data_iso') or '').replace('Z','+00:00'))
 except Exception:return None
def effective_phase_rank(snapshot,e):
 raw=int(e.get('fase_ordem') or 0)
 if int(e.get('perna') or 0)!=2:return raw
 when=event_dt(e)
 if when is None:return raw
 key=tie_key(e);c=[]
 for other in snapshot.get('eventos') or []:
  if other is e or int(other.get('perna') or 0)!=1 or tie_key(other)!=key:continue
  rank=int(other.get('fase_ordem') or 0);ow=event_dt(other)
  if rank not in {600,700,800} or ow is None or ow>=when or when-ow>dt.timedelta(days=35):continue
  c.append((ow,rank))
 return max(c,key=lambda x:x[0])[1] if c else raw
def completed_brazilian_events(snapshot,phase_rank=0):
 ranks=sorted({effective_phase_rank(snapshot,e) for e in snapshot.get('eventos') or [] if is_br(e) and effective_phase_rank(snapshot,e)>=600})
 if not ranks:return []
 rank=int(phase_rank or ranks[-1])
 return [e for e in snapshot.get('eventos') or [] if effective_phase_rank(snapshot,e)==rank and is_br(e) and e.get('concluido')]
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
def stored_entry_ok(video,e,comp):
 if not isinstance(video,Mapping):return False
 if video.get('manual_verificado') is True:return bool(str(video.get('url') or '').strip())
 title=str(video.get('titulo') or '')
 cid=str(video.get('channel_id') or '')
 return bool(str(video.get('url') or '').strip()) and candidate_ok(title,e,comp) and cid==OFFICIAL_CHANNEL_IDS.get(comp)
def run(key,dry=False,phase_rank=0):
 old=load(OUT,{'schema_version':1,'temporada':2026,'competicoes':['libertadores','sul_americana'],'jogos':{}});games=dict(old.get('jogos') or {})
 channels={c:resolve_channel(key,h) for c,(h,_) in CHANNELS.items()}
 if not all(channels.values()):raise RuntimeError('não foi possível resolver os canais oficiais da CONMEBOL')
 found=0
 for comp,p in SNAPS.items():
  snap=load(p,{})
  for e in completed_brazilian_events(snap,phase_rank):
   eid=str(e.get('event_id') or '')
   current=games.get(eid) or {}
   # Override manual explicitamente verificado permanece soberano. Para vínculos
   # automáticos, qualquer incompatibilidade de clubes/competição/canal elimina
   # o item antes de nova pesquisa; nunca publicamos um vídeo só porque o event_id bateu.
   if current.get('manual_verificado') is True:
    continue
   if current and not stored_entry_ok(current,e,comp):
    games.pop(eid,None)
   cand=search_one(key,channels[comp],e,comp)
   if cand:
    games[eid]=cand;found+=1
 payload={'schema_version':1,'temporada':2026,'competicoes':['libertadores','sul_americana'],'atualizado_em':dt.datetime.now(dt.timezone.utc).isoformat(),'canais_oficiais':{c:{'handle':CHANNELS[c][0],'channel_id':channels[c]} for c in channels},'jogos':games}
 if dry:print(json.dumps(payload,ensure_ascii=False,indent=2));return 0
 OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(f'OK: {found} novo(s) vínculo(s) oficial(is); {len(games)} total.');return 0
def self_test():
 e={'mandante':{'nome':'Flamengo','serie_a_2026':True,'espn_id':'819'},'visitante':{'nome':'Cruzeiro','serie_a_2026':True,'espn_id':'4771'}}
 assert candidate_ok('FLAMENGO X CRUZEIRO | MELHORES MOMENTOS | CONMEBOL LIBERTADORES 2026',e,'libertadores')
 assert not candidate_ok('FLAMENGO X CRUZEIRO | MELHORES MOMENTOS | BRASILEIRÃO 2026',e,'libertadores')
 assert not candidate_ok('PALMEIRAS X CERRO PORTEÑO | MELHORES MOMENTOS | CONMEBOL LIBERTADORES 2026',e,'libertadores')
 assert stored_entry_ok({'url':'https://youtube.com/watch?v=abcdefghijk','titulo':'FLAMENGO X CRUZEIRO | MELHORES MOMENTOS | CONMEBOL LIBERTADORES 2026','channel_id':OFFICIAL_CHANNEL_IDS['libertadores']},e,'libertadores')
 assert not stored_entry_ok({'url':'https://youtube.com/watch?v=abcdefghijk','titulo':'PALMEIRAS X CRUZEIRO | MELHORES MOMENTOS | CONMEBOL LIBERTADORES 2026','channel_id':OFFICIAL_CHANNEL_IDS['libertadores']},e,'libertadores')
 ida={'event_id':'a','fase_ordem':700,'perna':1,'data_iso':'2026-09-09T19:00:00-03:00','mandante':{'espn_id':'2029','nome':'Palmeiras','serie_a_2026':True},'visitante':{'espn_id':'4816','nome':'Liga de Quito','serie_a_2026':False},'concluido':True}
 volta={'event_id':'b','fase_ordem':900,'perna':2,'data_iso':'2026-09-16T19:00:00-03:00','mandante':{'espn_id':'4816','nome':'Liga de Quito','serie_a_2026':False},'visitante':{'espn_id':'2029','nome':'Palmeiras','serie_a_2026':True},'concluido':True}
 snap={'eventos':[ida,volta]}
 assert effective_phase_rank(snap,volta)==700
 assert {x['event_id'] for x in completed_brazilian_events(snap,700)}=={'a','b'}
 print('OK: self-test coletor continental.')
def main():
 p=argparse.ArgumentParser();p.add_argument('--dry-run',action='store_true');p.add_argument('--self-test',action='store_true');p.add_argument('--fase-ordem',type=int,default=0);a=p.parse_args()
 if a.self_test:self_test();return 0
 key=os.environ.get('YOUTUBE_API_KEY','').strip()
 if not key:raise SystemExit('YOUTUBE_API_KEY ausente')
 return run(key,a.dry_run,a.fase_ordem)
if __name__=='__main__':raise SystemExit(main())
