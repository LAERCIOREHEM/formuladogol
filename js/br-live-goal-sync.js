/* R10R17.2: preservar autoria confirmada quando gateway envia dado incompleto.
   Autor nunca é inferido do placar ou transferido para gol de outro time. */
(function (root) {
  "use strict";
  function score(goal) { return String(goal?.scoreAfter?.home) + ":" + String(goal?.scoreAfter?.away); }
  function valid(facts) {
    if (!facts || !Array.isArray(facts.goals) || facts.integrity?.mathematicallyValid === false) return false;
    const i = facts.integrity || {};
    const h = Number(i.expectedHome), a = Number(i.expectedAway);
    return Number.isInteger(h) && Number.isInteger(a) && h >= 0 && a >= 0 &&
      facts.goals.length <= h + a && facts.goals.every(g => {
        const x = Number(g?.scoreAfter?.home), y = Number(g?.scoreAfter?.away);
        return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= h && y <= a;
      });
  }
  function sameIdentity(a,b) {
    if (!a || !b || score(a) !== score(b)) return false;
    const sideA=String(a.side||''), sideB=String(b.side||'');
    const idA=String(a.teamId||''), idB=String(b.teamId||'');
    if (sideA && sideB && sideA !== sideB) return false;
    if (idA && idB && idA !== idB) return false;
    return (sideA && sideB) || (idA && idB);
  }
  function reconcile(previous, current) {
    if (!valid(previous)) return current || null;
    if (!current) return previous;
    if (!valid(current)) return previous;
    const p=previous.integrity, c=current.integrity;
    if (Number(p.expectedHome)!==Number(c.expectedHome) || Number(p.expectedAway)!==Number(c.expectedAway)) return current;
    const newer = current.goals.slice();
    let preserved=0;
    for (let n=0;n<newer.length;n++) {
      const goal=newer[n];
      if (String(goal.scorer||'').trim() || goal.ownGoal || goal.scorerConflict) continue;
      const candidates=previous.goals.filter(old=>sameIdentity(old,goal) && String(old.scorer||'').trim() && !old.scorerConflict);
      if (candidates.length!==1) continue;
      const old=candidates[0];
      newer[n]={...goal,scorer:old.scorer,scorerId:old.scorerId||goal.scorerId,minute:goal.minute||old.minute,
        sources:[...new Set([...(old.sources||[]),...(goal.sources||[])])],identityPending:false};
      preserved++;
    }
    // Não reutilizar um gol que simplesmente desapareceu do novo contrato;
    // só completar um item com o MESMO placar intermediário e lado/equipe.
    if (!preserved) return current;
    const missing=newer.filter(g=>!g.scorer&&!g.ownGoal).length;
    return {...current,goals:newer,integrity:{...c,missingScorers:missing,
      scorerResolvedCount:newer.length-missing,identityComplete:missing===0 && c.scoreComplete===true,
      complete:missing===0 && c.scoreComplete===true},
      meta:{...(current.meta||{}),browserConfirmedScorersPreserved:preserved}};
  }
  root.FDGLiveGoalSync={version:1,reconcile};
})(typeof window === "object" ? window : globalThis);
