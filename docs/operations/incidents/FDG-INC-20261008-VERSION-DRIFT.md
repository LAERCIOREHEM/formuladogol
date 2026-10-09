# FDG-INC-20261008 — CONTRACT_VERSION_DRIFT
**Sintoma:** Worker novo publicado, health ainda anunciava versão antiga.  
**Causa:** `ORCHESTRATOR_VERSION` no Wrangler sobrescrevia o fallback do código.  
**Regra:** `contract.js` é autoridade; Wrangler usa placeholder renderizado e o deploy bloqueia drift antes da publicação.
