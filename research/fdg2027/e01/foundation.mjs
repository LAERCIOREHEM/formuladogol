// E01 offline JS mirror. Never imported by the live site or workers in this release.
import { readFileSync } from 'node:fs';
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
export const REG = freeze(JSON.parse(readFileSync(new URL('./season-registry.json', import.meta.url),'utf8')));
const COMP = REG.competition, own = (o,k) => Object.hasOwn(o,k);
function token(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) || /[\r\n]/.test(v)) throw new Error('invalid token');
  return v;
}
export function season(v) {
  if (typeof v === 'number' && Number.isInteger(v)) v=String(v);
  if (typeof v !== 'string' || !own(REG.seasons,v)) throw new Error('unknown season');
  return v;
}
export function public_season(v = REG.default_season) {
  const y=season(v); if (!REG.seasons[y].public_read) throw new Error('season not public'); return y;
}
export function season_from_url(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) throw new Error('local path required');
  const values=new URL(url,'https://fdg.invalid').searchParams.getAll('temporada');
  if (values.length>1) throw new Error('ambiguous season');
  return public_season(values.length?values[0]:undefined);
}
export function legacy_read_path(y,a) {
  public_season(y); if (!own(REG.legacy_assets,a)) throw new Error('unknown legacy asset'); return REG.legacy_assets[a];
}
export function private_key(y,a) {
  y=season(y); if (!REG.private_assets.includes(a)) throw new Error('unknown private asset');
  return 'fdg2027/'+COMP+'/'+y+'/'+a+'.json';
}
export function identity(k,p,id,y=null) {
  if (!REG.identity_kinds.includes(k)||!REG.providers.includes(p)) throw new Error('unknown identity type/provider');
  token(id);
  if(k==='fixture') {if(y===null) throw new Error('fixture season required'); return COMP+':'+season(y)+':fixture:'+p+':'+id;}
  if(y!==null) throw new Error('club/player identity is stable across seasons');
  return COMP+':'+k+':'+p+':'+id;
}
export function namespace(y,d,n) {
  if(!REG.namespace_domains.includes(d)) throw new Error('unknown namespace');
  return 'fdg:v1:'+COMP+':'+season(y)+':'+d+':'+token(n);
}
export function validate_envelope(y,p) {
  y=season(y); if(!p||typeof p!=='object'||Array.isArray(p)||p.competition!==COMP||season(p.season)!==y) throw new Error('cross-season or competition mismatch');
  return p;
}
export function continental_rule_state(y) {return REG.seasons[season(y)].continental_rules;}
