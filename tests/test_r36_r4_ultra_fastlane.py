"""R36-R4 offline regression of FINAL delta and atomic core manifest."""
import unittest
from datetime import datetime,timedelta,timezone
from unittest.mock import patch
from scripts import af_ultra_fastlane_r36 as u
from scripts.publicar_af_core_r36 import manifest

class TestUltraFastlane(unittest.TestCase):
    def setUp(self):
        self.now=datetime(2026,11,23,23,30,tzinfo=timezone.utc)
        self.dt=self.now-timedelta(hours=2)
        self.event={"event_id":"401841323","estado":"in","concluido":False,
            "mandante_nome":"Internacional","visitante_nome":"Vitória",
            "data_dt":self.dt,"data_definir":False,"rodada":36}
        self.raw={"id":"401841323"}
    def candidate(self,state="post",completed=True,teams=("Internacional","Vitória"),scores=(2,5),dt=None):
        with patch.object(u.espn,"tipo_status",return_value={"state":state,"completed":completed}), \
             patch.object(u.espn,"competidores",return_value=teams), \
             patch.object(u.espn,"canonico_competidor",side_effect=lambda v:v), \
             patch.object(u.espn,"placar_competidor",side_effect=scores), \
             patch.object(u.espn,"parse_data_evento_brt",return_value=dt or self.dt), \
             patch.object(u.espn,"status_evento",return_value={"displayClock":"90'"}), \
             patch.object(u.espn,"_status_interrompido",return_value=False):
            return u.final_candidate(self.raw,{"401841323":self.event},self.now)
    def test_final_explicit_correct_identity(self):
        v=self.candidate()
        self.assertEqual((v["placar_mandante"],v["placar_visitante"]),(2,5))
        self.assertEqual(v["estado"],"post")
        self.assertEqual(self.event["estado"],"in")
    def test_never_promote_live_or_provisional(self):
        self.assertIsNone(self.candidate("in",True))
        self.assertIsNone(self.candidate("post",False))
        self.assertIsNone(self.candidate(teams=("Santos","Vitória")))
        self.assertIsNone(self.candidate(scores=(-1,5)))
        self.assertIsNone(self.candidate(dt=self.dt-timedelta(days=1)))
    def test_duplicate_avoids_all_network(self):
        with patch.object(u.espn,"snapshot_local_sincronizado",return_value=(True,"ok")), \
             patch.object(u,"load",return_value={}), \
             patch.object(u,"verified_finals",return_value={"401841323":("Internacional","Vitória",2,5)}), \
             patch.object(u,"current_publication_freshness",return_value={"estado_pronto":True,"atualizado":True}), \
             patch.object(u,"query_window",side_effect=AssertionError("network must not run")):
            self.assertEqual(u.collect("401841323"),[])
    def test_manifest_contract(self):
        p={"status":"ok","hash_entrada":"a"*64,"calculado_em":"2026-11-23T22:20:03-03:00",
           "clubes":[{}]*20,"simulacao":{"quantidade":2000000},
           "base_corrente":{"partidas_concluidas":358,"partidas_restantes":22}}
        m=manifest(p)
        self.assertEqual(m["concluidos"],358)
        self.assertEqual(len(m["revision"]),64)
        p["simulacao"]["quantidade"]=1000
        with self.assertRaises(ValueError):manifest(p)

if __name__=="__main__":unittest.main()
