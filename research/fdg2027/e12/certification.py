"""E12 read-only certification. This module has no deploy or activation capability."""
import copy, hashlib, json, re, sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
sys.path.insert(0,str(HERE.parent/"e01"))
import foundation as f
CORE=("tabela.json","resultados.json","jogos.json","espn_eventos.json","dados-br/agenda-clubes-br.json","dados-br/probabilidades-brasileirao.json","dados-br/probabilidades-por-pontuacao.json","dados-br/probabilidades-jogos.json","dados-br/auditoria-probabilidades.json","dados-br/auditoria-competicoes-af-previsao.json","dados-br/vagas-libertadores-2027.json")
CURRENT={"season":2026,"model":"AF-Previsão 1.3","public_switch":False,"production_write":False,"lineup_enabled":False,"rapm_required":False,"research_only":True}
GATES=("scientific_superiority","prospective_complete","source_identity_verified","source_timestamps_verified","publication_rights_verified","real_quota_verified","actual_billing_verified","distributed_adapters_verified","live_notification_integration_verified","operational_rollback_verified","season_2026_final_archive","season_2027_official_started","season_2027_rules_verified","separate_activation_authorized","separate_model_promotion_authorized")
def raw(x):return json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode()
def sha(b):return hashlib.sha256(b).hexdigest()
def jsonfile(path):return json.loads(path.read_bytes())
def decide(evidence):
    # Unknown or missing evidence fails closed; caller cannot activate anything with this output.
    blocked=[k for k in GATES if evidence.get(k) is not True]
    return {"production_ready":not blocked,"blocked":blocked,"recommendation":"hold" if blocked else "eligible_for_separate_review","activation_performed":False,"promotion_performed":False,"current":copy.deepcopy(CURRENT)}
def rollback_drill():
    # Exercise reference flag restoration, not Cloudflare/D1/production rollback.
    prior=raw(CURRENT);prior_hash=sha(prior);staged=copy.deepcopy(CURRENT)
    staged.update(season=2027,model="AF-Previsão 2.0",public_switch=True,production_write=True)
    d=decide({})
    if d["blocked"]:staged=json.loads(prior)
    assert raw(staged)==prior and sha(raw(staged))==prior_hash
    return {"reference_flag_restore":True,"restored_sha256":prior_hash,"production_rollback_tested":False}
def validate_core(m,s):
    assert m==s["manifest"] and m["schema_version"]==1
    assert re.fullmatch("[0-9a-f]{64}",m["hash_entrada"])
    assert m["revision"]==sha((m["hash_entrada"]+"|"+m["calculado_em"]).encode())
    assert type(m["concluidos"]) is int and type(m["restantes"]) is int and 0<=m["concluidos"]<=380 and m["concluidos"]+m["restantes"]==380
    data=s["files"];assert set(data)==set(CORE)
    p=data[CORE[5]];r=data["resultados.json"]["resultados"];t=data["tabela.json"]["tabela"];j=data[CORE[7]]
    assert p["status"]=="ok" and p["hash_entrada"]==m["hash_entrada"] and p["calculado_em"]==m["calculado_em"] and p["simulacao"]["quantidade"]==2000000
    assert p["base_corrente"]["partidas_concluidas"]==m["concluidos"] and p["base_corrente"]["partidas_restantes"]==m["restantes"]
    assert len(p["clubes"])==len(t)==20 and len(r)==m["concluidos"] and len(j["jogos"])==m["restantes"]
    assert j["temporada"]==2026 and j["versao_modelo"]=="AF-Previsão 1.3"
    ri={str(x["event_id"]) for x in r};ji={str(x["event_id"]) for x in j["jogos"]}
    assert len(ri)==len(r) and len(ji)==len(j["jogos"]) and not ri&ji
    for x in j["jogos"]:
        v=x["probabilidades_exibicao_pct"]
        assert all(type(v[k]) in (int,float) and 0<=v[k]<=100 for k in ("mandante","empate","visitante"))
        assert abs(sum(v[k] for k in ("mandante","empate","visitante"))-100)<1e-6
    return {"revision":m["revision"],"concluded":m["concluidos"],"remaining":m["restantes"],"clubs":len(t),"core_files":len(data),"model":j["versao_modelo"]}
def repository_core():
    m=jsonfile(ROOT/"dados-br/af-core-manifest.json");s=jsonfile(ROOT/"dados-br/af-core-snapshot.json")
    q=validate_core(m,s)
    assert f.public_season()=="2026" and f.continental_rule_state(2027)=="unverified"
    assert not f.REG["public_switch_enabled"] and not f.REG["production_write_enabled"]
    assert "temporada: 2026" in (ROOT/"js/br-config.js").read_text()
    q["manifest_sha256"]=sha((ROOT/"dados-br/af-core-manifest.json").read_bytes())
    q["snapshot_sha256"]=sha((ROOT/"dados-br/af-core-snapshot.json").read_bytes())
    q["archive_finalized"]=False # 2026 final archive requires official closure and separate review.
    return q
