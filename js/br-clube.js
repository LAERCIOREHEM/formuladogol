(()=>{'use strict';
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
function scrollToHash(hash){const el=document.querySelector(hash);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});}
document.addEventListener('click',e=>{const a=e.target.closest('[data-club-anchor]');if(!a)return;const h=a.getAttribute('href');if(h&&h.startsWith('#')){e.preventDefault();scrollToHash(h);history.replaceState(null,'',h);}});
function refreshLive(){const box=document.querySelector('[data-club-live-box]');if(!box)return;const event=box.dataset.eventId||'';const state=(box.dataset.state||'').toLowerCase();box.hidden=!(event&&state==='in');}
document.addEventListener('DOMContentLoaded',()=>{refreshLive();if(location.hash)setTimeout(()=>scrollToHash(location.hash),100);});
})();
