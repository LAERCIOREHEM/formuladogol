# FDG-INC-20261008 — FINAL_STATE_REGRESSION
**Sintoma:** jogos já encerrados reapareceram como pendentes na cobertura pré-jogo.  
**Causa:** superfície atrasada do scoreboard substituía estado FINAL já confirmado.  
**Regra:** `post` é monotônico para o mesmo `event_id`; feed `pre/in` posterior é ignorado.  
**Teste:** `tests/incidents/test_reliability_incidents.py::test_final_state_regression_is_monotonic`.
