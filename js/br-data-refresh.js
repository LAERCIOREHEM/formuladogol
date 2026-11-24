/* R36-R5 FINAL — one bounded scheduler per existing refresh loop, no external polling service. */
(function(root){
  'use strict';
  const ACTIVE_MS=12000, IDLE_MS=60000, MIN_MS=2000;
  function create({run,active=()=>false,visible=()=>true,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}){
    let timer=null,running=false,queued=false,lastStart=-Infinity,enabled=false;
    const cancel=()=>{if(timer!==null)clearTimer(timer);timer=null;};
    function schedule(delay){
      cancel();if(!enabled||!visible())return;
      timer=setTimer(tick,Math.max(delay,MIN_MS-(clock()-lastStart),0));
    }
    async function tick(){
      timer=null;if(!enabled||!visible()||running)return;
      running=true;lastStart=clock();
      try{await run();}catch(error){onError(error);}
      finally{
        running=false;
        const urgent=queued;queued=false;
        schedule(urgent?0:Math.max(0,(active()?ACTIVE_MS:IDLE_MS)-(clock()-lastStart)));
      }
    }
    return Object.freeze({
      start(){enabled=true;schedule(active()?ACTIVE_MS:IDLE_MS);},
      wake(){enabled=true;if(!visible()){cancel();return;}if(running){queued=true;return;}schedule(0);},
      pause(){cancel();queued=false;},
      stop(){enabled=false;cancel();queued=false;},
      status(){return {running,queued,scheduled:timer!==null};}
    });
  }
  // Repeated ESPN FINALs are not new events. A score correction is a new signature.
  function finalKey(rows,published=[],isFinal=g=>g?.estado==='post'){
    const ids=new Set(published.map(g=>String(g?.event_id??g?.eventId??'')));
    return [...new Set(rows.filter(isFinal).map(g=>{
      const id=String(g?.eventId??g?.event_id??'');
      return id&&!ids.has(id)?[id,g.placarMandante??g.placar_mandante??'',g.placarVisitante??g.placar_visitante??''].join(':'):'';
    }).filter(Boolean))].sort().join('|');
  }
  root.FDGRefreshScheduler=Object.freeze({create,finalKey,ACTIVE_MS,IDLE_MS,MIN_MS});
})(typeof window!=='undefined'?window:globalThis);
