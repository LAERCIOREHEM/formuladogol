import { extractScoringPlays, mergeScoringPlayVariants, reconcileScoringPlays } from './sports-engine.js';

const LIVE_FACTS_CONTRACT_VERSION = 3;
const text = (value) => String(value == null ? '' : value).trim();
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const normalized = (value) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function finiteScore(value) { if (value == null || String(value).trim() === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; }
function personName(value) { const person = value?.athlete || value?.player || value?.person || value || {}; return text(person.shortName || person.shortDisplayName || person.displayName || person.fullName || person.name); }
function compactName(value) { return text(value).replace(/\s+/g, ' ').replace(/\s+\([^)]*\)\s*$/g, '').trim(); }
function scoreValue(competitor) { const raw = competitor?.score; return raw && typeof raw === 'object' ? num(raw.value ?? raw.displayValue ?? raw.score ?? raw.total, 0) : num(raw, 0); }
function competitionOf(summary) { return summary?.header?.competitions?.[0] || summary?.competitions?.[0] || summary?.competition || {}; }
function teamShape(competitor, fallbackSide) { const team = competitor?.team || competitor || {}; return { id: text(team.id || competitor?.id), name: text(team.displayName || team.shortDisplayName || team.name || team.location || team.abbreviation), abbreviation: text(team.abbreviation || competitor?.abbreviation), side: text(competitor?.homeAway || fallbackSide), score: scoreValue(competitor) }; }
function matchFromSummary(summary, eventId = '') { const competition = competitionOf(summary); const competitors = Array.isArray(competition?.competitors) ? competition.competitors : []; const homeRaw = competitors.find((row) => row?.homeAway === 'home') || competitors[0] || {}; const awayRaw = competitors.find((row) => row?.homeAway === 'away') || competitors[1] || {}; return { eventId: text(eventId || summary?.header?.id || competition?.id), home: teamShape(homeRaw, 'home'), away: teamShape(awayRaw, 'away') }; }
function eventMinute(item) { for (const key of ['clock','time','displayClock','timeDisplayValue','minute','minuto']) { const value=item?.[key]; if (value && typeof value==='object') { const v=value.displayValue??value.displayClock??value.text??value.value; if (v!=null && String(v).trim()) return text(v); } else if (value!=null && String(value).trim()) return text(value); } return ''; }
function rawScore(item,key) { const value=item?.[key]??item?.score?.[key]??item?.score?.[key==='homeScore'?'home':'away']; const n=Number(value); return Number.isFinite(n)&&n>=0?n:null; }
function isGoalLike(item) { if (!item||typeof item!=='object') return false; if (item.scoringPlay===true) return true; const descriptor=[item?.type?.text,item?.type?.name,item?.type?.description,item?.text,item?.description].filter(Boolean).join(' '); const n=normalized(descriptor); if (/attempt saved|shot saved|save made|shots on goal|shots on target|expected goals|goalkeeper|missed|blocked/.test(n) && !/goal!|gol!/.test(n)) return false; return /(^| )(goal|gol|own goal|gol contra)( |$)/.test(n); }
function goalNodes(summary) { const primary=Array.isArray(summary?.scoringPlays)?summary.scoringPlays:[]; if (primary.length) return primary.filter(isGoalLike); return (Array.isArray(summary?.plays)?summary.plays:[]).filter(isGoalLike); }
const eventId = (item) => text(item?.id || item?.playId || item?.uid);
function nodeTeamId(item) { return text(item?.team?.id || item?.teamId || item?.team_id || item?.competitor?.id || item?.competitorId || item?.club?.id || item?.clubId); }
function assistNamesFromText(value) { const source=text(value); if(!source) return []; const candidates=[]; const patterns=[/assisted by\s+([^.;]+?)(?=\s+(?:with|following|after|from)\b|[.;]|$)/ig,/assist(?:ência|encia)\s+(?:de|por)\s+([^.;]+?)(?=[.;]|$)/ig]; for(const regex of patterns){let match; while((match=regex.exec(source))){const name=compactName(match[1]); if(name)candidates.push(name);}} return [...new Map(candidates.map((name)=>[normalized(name),name])).values()]; }
function assistantsFromNode(item, scorerName) { const out=[]; for(const key of ['athletesInvolved','athletes','participants','players']){const rows=Array.isArray(item?.[key])?item[key]:[]; rows.forEach((entry,index)=>{const name=compactName(personName(entry)); if(!name||normalized(name)===normalized(scorerName))return; const role=normalized([typeof entry?.type==='object'?entry.type.text||entry.type.name||entry.type.description:entry?.type,typeof entry?.role==='object'?entry.role.text||entry.role.name||entry.role.description:entry?.role,entry?.position].filter(Boolean).join(' ')); if(/assist/.test(role)||(key==='athletesInvolved'&&index>0))out.push(name);});} const description=[item?.text,item?.description,item?.shortText,item?.headline].filter(Boolean).join(' '); out.push(...assistNamesFromText(description)); return [...new Map(out.map((name)=>[normalized(name),name])).values()]; }
function nodeCompatibleWithPlay(item, play) {
  if (!item || !play) return false;
  const itemTeam = nodeTeamId(item), playTeam = text(play.teamId);
  if (itemTeam && playTeam && itemTeam !== playTeam) return false;
  const ih=rawScore(item,'homeScore'), ia=rawScore(item,'awayScore');
  const ph=finiteScore(play.homeScoreAfter), pa=finiteScore(play.awayScoreAfter);
  if (ih!=null && ia!=null && ph!=null && pa!=null && (ih!==ph || ia!==pa)) return false;
  return true;
}
function nodeForPlay(nodes,play){
  const sourceId=text(play?.sourceId);
  if(sourceId){const exact=nodes.find((item)=>eventId(item)===sourceId && nodeCompatibleWithPlay(item,play)); if(exact)return exact;}
  const minute=normalized(play?.minute);
  return nodes.find((item)=>{
    if (!nodeCompatibleWithPlay(item,play)) return false;
    return !minute || normalized(eventMinute(item))===minute;
  })||null;
}
function extractAppearances(summary,match){const teamById=new Map([[text(match.home.id),match.home.name],[text(match.away.id),match.away.name]].filter(([id,name])=>id&&name)); const rows=[]; const blocks=[...(Array.isArray(summary?.rosters)?summary.rosters:[]),...(Array.isArray(summary?.lineups)?summary.lineups:[])]; for(const [index,block] of blocks.entries()){if(!block||typeof block!=='object')continue; const rawTeam=block.team||block.club||block.competitor||{}; const teamId=text(rawTeam.id||block.teamId); const teamName=teamById.get(teamId)||text(rawTeam.displayName||rawTeam.shortDisplayName||rawTeam.name)||(index===0?match.home.name:index===1?match.away.name:''); const entries=[]; for(const key of ['roster','athletes','players','lineup']) if(Array.isArray(block[key])) entries.push(...block[key]); for(const entry of entries){if(!entry||typeof entry!=='object'||entry.didNotPlay===true||entry.did_not_play===true||entry.dnp===true)continue; const rawMinutes=entry.minutes??entry.minutesPlayed??entry?.stats?.minutes; const minutes=Number(String(rawMinutes??'').replace(/[^0-9.]/g,'')); const played=entry.starter===true||entry.starting===true||entry.isStarter===true||entry.subbedIn===true||entry.subbed_in===true||entry.entered===true||entry.played===true||entry.appeared===true||entry.participated===true||(Number.isFinite(minutes)&&minutes>0); if(!played)continue; const name=compactName(personName(entry)); if(name&&teamName)rows.push({name,team:teamName,teamId}); }} const seen=new Set(); return rows.filter((row)=>{const key=`${normalized(row.team)}|${normalized(row.name)}`; if(!row.name||!row.team||seen.has(key))return false; seen.add(key); return true;}); }
function factsMathematicallyValid(facts) {
  if (!facts || typeof facts !== 'object') return false;
  const i=facts.integrity||{}, goals=Array.isArray(facts.goals)?facts.goals:[];
  const eh=finiteScore(i.expectedHome), ea=finiteScore(i.expectedAway), expected=finiteScore(i.expectedGoals);
  if (expected==null || goals.length > expected) return false;
  if (eh!=null && ea!=null && eh+ea!==expected) return false;
  for (const goal of goals) {
    const h=finiteScore(goal?.scoreAfter?.home), a=finiteScore(goal?.scoreAfter?.away);
    if (h==null || a==null) return false;
    if (eh!=null && ea!=null && (h>eh || a>ea)) return false;
  }
  if (expected===0 && goals.length!==0) return false;
  return true;
}
function factsQuality(facts){if(!factsMathematicallyValid(facts))return -1; const i=facts.integrity||{}, goals=Array.isArray(facts.goals)?facts.goals:[]; return (i.complete?100000:0)+(i.scoreComplete?20000:0)+num(i.usableGoalCount)*1000+num(i.scorerResolvedCount)*100+goals.reduce((sum,g)=>sum+(Array.isArray(g.assists)?g.assists.length:0),0)*10+(Array.isArray(facts.appearances)?facts.appearances.length:0); }
function factSignature(facts){const goals=(facts?.goals||[]).map((g)=>[g.scoreAfter?.home??'',g.scoreAfter?.away??'',g.minute||'',g.teamId||'',g.scorer||'',(g.assists||[]).join('+'),g.ownGoal?1:0].join('~')).join(';'); return `${facts?.integrity?.expectedHome??''}-${facts?.integrity?.expectedAway??''}|${facts?.integrity?.expectedGoals??0}|${goals}`; }
function sourceSummaries(summary, options) {
  const variants = Array.isArray(options?.variants) ? options.variants.filter((row)=>row?.data && typeof row.data==='object') : [];
  if (variants.length) return variants;
  return [{ source: 'espn_summary_gateway', data: summary || {} }];
}

export function normalizeLiveFacts(summary, options={}) {
  const variants=sourceSummaries(summary,options);
  const identitySummary=(summary&&typeof summary==='object'&&competitionOf(summary)?.competitors?.length)?summary:(variants.find((row)=>competitionOf(row.data)?.competitors?.length)?.data||summary||{});
  const match=matchFromSummary(identitySummary,options.eventId||'');
  const optionHome=finiteScore(options.expectedHome), optionAway=finiteScore(options.expectedAway);
  const summaryHome=finiteScore(match.home.score)??0, summaryAway=finiteScore(match.away.score)??0;
  let targetHome=optionHome, targetAway=optionAway;
  if(targetHome==null||targetAway==null){
    const explicitTotal=finiteScore(options.expectedGoals);
    if(explicitTotal!=null && summaryHome+summaryAway===explicitTotal){targetHome=summaryHome; targetAway=summaryAway;}
    else if(explicitTotal==null){targetHome=summaryHome; targetAway=summaryAway;}
  }
  const exactScoreKnown=targetHome!=null&&targetAway!=null;
  const expectedGoals=exactScoreKnown?targetHome+targetAway:Math.max(0,finiteScore(options.expectedGoals)??(summaryHome+summaryAway));
  if(!exactScoreKnown){
    // Sem o placar por lado não existe base matemática segura para atribuir autoria.
    // Mantemos o contrato conservador até o caller enviar home/away canônicos.
    targetHome=summaryHome; targetAway=summaryAway;
  }
  const observation={eventId:match.eventId,home:{...match.home,score:targetHome},away:{...match.away,score:targetAway}};
  const variantPlays=variants.map((variant)=>({source:text(variant.source||'espn'),plays:extractScoringPlays(variant.data||{},observation,text(variant.source||'espn'))}));
  const mergedPlays=mergeScoringPlayVariants(variantPlays);
  const reconciliation=reconcileScoringPlays(mergedPlays,observation);
  const plays=Array.isArray(reconciliation?.plays)?reconciliation.plays:[];
  const nodes=variants.flatMap((variant)=>goalNodes(variant.data||{}));
  const goals=[];
  for(const play of plays){
    let team=null;
    const playTeamId=text(play.teamId);
    if(playTeamId&&playTeamId===text(match.home.id))team=match.home;
    else if(playTeamId&&playTeamId===text(match.away.id))team=match.away;
    else if(play.side==='home')team=match.home;
    else if(play.side==='away')team=match.away;
    const scorerConflict=play.scorerConflict===true;
    const scorer=scorerConflict?'':compactName(play.athleteName||'');
    const node=nodeForPlay(nodes,{...play,teamId:text(team?.id||playTeamId)});
    const assists=(!scorerConflict&&scorer&&node)?assistantsFromNode(node,scorer):[];
    goals.push({
      key:text(play.key),minute:text(play.minute),teamId:text(team?.id||playTeamId),team:text(team?.name),side:text(team?.side||play.side),
      scorerId:scorerConflict?'':text(play.athleteId),scorer,assists,ownGoal:play.ownGoal===true,penalty:play.penalty===true,
      scorerConflict,description:text(play.description),scoreAfter:{home:play.homeScoreAfter==null?null:num(play.homeScoreAfter),away:play.awayScoreAfter==null?null:num(play.awayScoreAfter)},
      sources:Array.isArray(play.sources)?play.sources.map(text).filter(Boolean):[]
    });
  }
  goals.sort((a,b)=>(num(a.scoreAfter?.home)+num(a.scoreAfter?.away))-(num(b.scoreAfter?.home)+num(b.scoreAfter?.away))||text(a.minute).localeCompare(text(b.minute)));
  const appearances=[];
  for(const variant of variants) appearances.push(...extractAppearances(variant.data||{},match));
  for(const goal of goals){if(goal.scorer&&goal.team)appearances.push({name:goal.scorer,team:goal.team,teamId:goal.teamId}); for(const assistant of goal.assists||[])if(assistant&&goal.team)appearances.push({name:assistant,team:goal.team,teamId:goal.teamId});}
  const seen=new Set(); const uniqueAppearances=appearances.filter((row)=>{const key=`${normalized(row.team)}|${normalized(row.name)}`; if(!row.name||!row.team||seen.has(key))return false; seen.add(key); return true;});
  const observedGoalCount=goals.length, teamResolvedCount=goals.filter((g)=>g.team&&g.teamId).length, scorerResolvedCount=goals.filter((g)=>g.ownGoal||g.scorer).length, usableGoalCount=goals.filter((g)=>g.team&&(g.ownGoal||g.scorer)).length;
  const exactReconciliation=expectedGoals===0?observedGoalCount===0:reconciliation?.state==='canonical_score_match'&&observedGoalCount===expectedGoals;
  const scoreComplete=exactScoreKnown&&exactReconciliation;
  const identityComplete=expectedGoals===0?observedGoalCount===0:(teamResolvedCount===expectedGoals&&scorerResolvedCount===expectedGoals&&usableGoalCount===expectedGoals);
  const complete=scoreComplete&&identityComplete;
  const integrity={
    expectedHome:targetHome,expectedAway:targetAway,expectedGoals,observedGoalCount,teamResolvedCount,scorerResolvedCount,usableGoalCount,
    rawGoalVariants:num(reconciliation?.rawGoalVariants),discardedGoalVariants:num(reconciliation?.discardedGoalVariants),reconciliationState:text(reconciliation?.state),
    scoreComplete,identityComplete,complete,mathematicallyValid:observedGoalCount<=expectedGoals&&goals.every((g)=>finiteScore(g.scoreAfter?.home)!=null&&finiteScore(g.scoreAfter?.away)!=null&&num(g.scoreAfter.home)<=targetHome&&num(g.scoreAfter.away)<=targetAway),
    missingGoals:Math.max(0,expectedGoals-observedGoalCount),missingTeams:Math.max(0,expectedGoals-teamResolvedCount),missingScorers:Math.max(0,expectedGoals-scorerResolvedCount),
    status:complete?'complete':scoreComplete?'identity-pending':'summary-pending'
  };
  const facts={contractVersion:LIVE_FACTS_CONTRACT_VERSION,eventId:match.eventId,home:{...match.home,score:targetHome},away:{...match.away,score:targetAway},goals,appearances:uniqueAppearances,integrity};
  facts.signature=factSignature(facts); return facts;
}

export function chooseBestKnownLiveFacts(current,previous){
  if(!previous||typeof previous!=='object'||!factsMathematicallyValid(previous))return{facts:current,applied:false};
  const ci=current?.integrity||{}, pi=previous?.integrity||{};
  if(text(current?.eventId)!==text(previous?.eventId))return{facts:current,applied:false};
  if(num(ci.expectedGoals,-1)!==num(pi.expectedGoals,-2)||num(ci.expectedHome,-1)!==num(pi.expectedHome,-2)||num(ci.expectedAway,-1)!==num(pi.expectedAway,-2))return{facts:current,applied:false};
  if(!factsMathematicallyValid(current))return{facts:previous,applied:true};
  if(factsQuality(previous)<=factsQuality(current))return{facts:current,applied:false};
  return{facts:previous,applied:true};
}
export const LIVE_FACTS_CONSTANTS=Object.freeze({LIVE_FACTS_CONTRACT_VERSION});
