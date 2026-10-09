from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class ReliabilityIncidentRegressionSuite(unittest.TestCase):
    def test_final_state_regression_is_monotonic(self):
        espn = load_module('fdg_atualizar_espn_incident', ROOT / 'atualizar_espn.py')
        from datetime import datetime, timedelta, timezone
        now = datetime(2026, 10, 8, 22, 0, tzinfo=timezone(timedelta(hours=-3)))
        final = {
            'event_id':'401841251','rodada':29,'data_dt':now,'data_iso':'2026-10-08T19:30',
            'mandante_nome':'Santos','visitante_nome':'Flamengo','mandante':espn.info_time('Santos'),
            'visitante':espn.info_time('Flamengo'),'estadio':'','transmissao':'','status':'FT','estado':'post',
            'concluido':True,'adiado':False,'data_definir':False,'placar_mandante':2,'placar_visitante':2,
            'finalizado_em':'2026-10-08T22:18:57-03:00','_sort':now.timestamp(),
        }
        stale = copy.deepcopy(final)
        stale.update(status="82'", estado='in', concluido=False, placar_mandante=1, placar_visitante=2)
        merged = espn._mesclar_eventos_normalizados([final],[stale])
        row = next(x for x in merged if x['event_id']=='401841251')
        self.assertTrue(row['concluido'])
        self.assertEqual(row['estado'],'post')
        self.assertEqual((row['placar_mandante'],row['placar_visitante']),(2,2))

    def test_af_coverage_mismatch_has_stable_incident_code(self):
        from scripts.fdg_reliability import classify_exception
        self.assertEqual(
            classify_exception(AssertionError('cobertura das probabilidades por jogo diverge do calendário restante')),
            'AF_COVERAGE_MISMATCH',
        )

    def test_version_drift_is_blocked_by_contract_placeholder(self):
        wrangler=(ROOT/'cloudflare/orchestrator-worker/wrangler.template.jsonc').read_text(encoding='utf-8')
        contract=(ROOT/'cloudflare/orchestrator-worker/src/contract.js').read_text(encoding='utf-8')
        pkg=json.loads((ROOT/'cloudflare/orchestrator-worker/package.json').read_text(encoding='utf-8'))
        self.assertIn('__ORCHESTRATOR_VERSION__',wrangler)
        self.assertIn("version: '2.4.0'",contract)
        self.assertEqual(pkg['version'],'2.4.0')

    def test_wrong_match_attendance_keeps_identity_gate(self):
        profile=(ROOT/'cloudflare/push-worker/src/postgame-search-profile.js').read_text(encoding='utf-8')
        fastlane=(ROOT/'cloudflare/push-worker/src/postgame-fastlane.js').read_text(encoding='utf-8')
        self.assertIn('Match Identity Gate',profile)
        self.assertIn('IA é SOMENTE descoberta',fastlane)

    def test_public_revenue_field_collision_is_quarantined(self):
        from scripts.postgame_factual_integrity import (
            INCIDENT_PUBLIC_REVENUE_COLLISION, inspect_factual_integrity, quarantine_row
        )
        bad = inspect_factual_integrity(15056, None, 15056)
        self.assertEqual(bad['critical'], [INCIDENT_PUBLIC_REVENUE_COLLISION])
        clean, verdict = quarantine_row({'publico':15056,'renda':15056,'fonte_renda':'https://example.com/x'})
        self.assertEqual(clean.get('publico'), 15056)
        self.assertNotIn('renda', clean)
        self.assertEqual(verdict['quarantine_fields'], ['renda'])
        good = inspect_factual_integrity(15056, None, 708004.50)
        self.assertEqual(good['critical'], [])
        corrections=json.loads((ROOT/'dados-br/correcoes/publicos-verificados.json').read_text(encoding='utf-8'))
        self.assertEqual(float(corrections['jogos']['401841248']['renda']), 708004.50)

    def test_false_red_card_guard_remains_present(self):
        corpus='\n'.join(p.read_text(encoding='utf-8',errors='ignore') for p in [
            ROOT/'cloudflare/push-worker/src/index.js', ROOT/'cloudflare/push-worker/tests/test-postgame-fastlane.mjs'
        ])
        self.assertTrue('red' in corpus.lower() or 'vermelh' in corpus.lower())

    def test_migration_sla_suppression_remains_present(self):
        index=(ROOT/'cloudflare/push-worker/src/index.js').read_text(encoding='utf-8')
        self.assertIn('postgameMigrationSlaSuppression',index)
        self.assertIn('postgameAdministrativeReopenSlaAnchor',index)

    def test_current_repository_snapshot_passes_integrity_guard(self):
        from scripts.validar_snapshot_esportivo import validate_snapshot
        report=validate_snapshot(profile='ci')
        self.assertEqual(report['status'],'ok')
        self.assertEqual(report['metrics']['total'],380)
        self.assertEqual(report['metrics']['simulations'],2_000_000)


if __name__ == '__main__':
    unittest.main()
