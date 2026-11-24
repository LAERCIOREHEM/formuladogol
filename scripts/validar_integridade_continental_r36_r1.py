#!/usr/bin/env python3
"""R36-R1: impede publicação de chances continentais divergentes das finais."""
from __future__ import annotations

import argparse
import json
import re
from html import unescape
import sys
import unicodedata
from pathlib import Path
from urllib.request import Request, urlopen


def read(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    return re.sub(r"[^a-z0-9]+", "-", "".join(c for c in normalized if not unicodedata.combining(c)).lower()).strip("-")


def final_event(snapshot: dict) -> dict | None:
    rows = [event for event in snapshot.get("eventos", []) if int(event.get("fase_ordem") or 0) == 900]
    if len(rows) > 1:
        raise AssertionError("mais de uma final continental encontrada")
    return rows[0] if rows else None


def validate(root: Path, site: Path) -> dict:
    prob = read(root / "dados-br/probabilidades-brasileirao.json")
    sul = read(root / "dados-br/competicoes-af-previsao/sul-americana.json")
    if prob.get("status") != "ok" or prob.get("simulacao", {}).get("quantidade", 0) < 1:
        raise AssertionError("snapshot AF inválido")
    if sul.get("status") != "ok":
        raise AssertionError("snapshot da Sul-Americana não certificado")
    teams = {team["clube"]: team for team in prob["clubes"]}
    if len(teams) != 20:
        raise AssertionError("AF deve ter exatamente 20 clubes")
    last = final_event(sul)
    if last and last.get("concluido") is True:
        champion = str(last.get("vencedor") or "")
        participants = {str((last.get(side) or {}).get("nome") or "") for side in ("mandante", "visitante")}
        if not champion or champion not in participants:
            raise AssertionError("campeão continental inválido")
        losing = participants - {champion}
        for loser in losing:
            if loser in teams:
                detail = teams[loser]["decomposicao_chances"]["libertadores"]["vias"]["via_titulo_sul_americana"]
                if (detail.get("ocorrencias") != 0 or detail.get("impossivel_estruturalmente") is not True
                        or detail.get("exibicao") != "0%"):
                    raise AssertionError(f"vice com via de título ainda ativa: {loser}")

    public = read(site / "dados-br/probabilidades-brasileirao.json")
    if public.get("hash_entrada") != prob.get("hash_entrada") or public.get("calculado_em") != prob.get("calculado_em"):
        raise AssertionError("JSON público e cálculo AF apresentam versões diferentes")
    compact = read(site / "dados-br/vagas-libertadores-2027.json")
    if compact.get("schema_version") != 1:
        raise AssertionError("versão do snapshot público de vagas incorreta")
    summary_final = final_event(compact.get("sulamericana") or {})
    if last and last.get("concluido") is True:
        if not summary_final or summary_final.get("concluido") is not True or summary_final.get("vencedor") != last.get("vencedor"):
            raise AssertionError("snapshot público não contém campeão da Sul-Americana")
    checked = 0
    for name, data in teams.items():
        page = site / "clube" / slugify(name) / "index.html"
        html = unescape(page.read_text(encoding="utf-8"))
        display = data["probabilidades_detalhes"]["libertadores"]["exibicao"]
        if f"a de Libertadores é {display}" not in html:
            raise AssertionError(f"{name}: chance de Libertadores diverge do AF ({display})")
        route = data["decomposicao_chances"]["libertadores"]["vias"]["via_titulo_sul_americana"]
        expected = route.get("exibicao")
        pattern = r'<div class="club-route-card(?: is-off)?"><small>Via título da Sul-Americana</small><strong>([^<]+)</strong><span>([^<]+)</span>'
        match = re.search(pattern, html)
        if not match or match.group(1) != expected:
            raise AssertionError(f"{name}: probabilidade de título da Sul-Americana divergente")
        if route.get("impossivel_estruturalmente") is True and match.group(2) == "via disponível":
            raise AssertionError(f"{name}: via matematicamente impossível exibida como disponível")
        checked += 1
    result = {
        "status": "R36_R1_LOCAL_PASS",
        "clubes": checked,
        "af_calculado_em": prob.get("calculado_em"),
        "final_sulamericana": last.get("vencedor") if last and last.get("concluido") else "pendente",
        "publicacao_consistente": True,
    }
    return result


def validate_live(root: Path, url: str) -> dict:
    def get(path: str) -> bytes:
        request = Request(url.rstrip("/") + path + "?r36r1=live", headers={
            "User-Agent": "FDG-R36-R1-Publication-Integrity/1.0",
            "Cache-Control": "no-cache, no-store",
        })
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise AssertionError(f"HTTP {response.status}: {path}")
            return response.read()

    canonical = read(root / "dados-br/probabilidades-brasileirao.json")
    online = json.loads(get("/dados-br/probabilidades-brasileirao.json").decode("utf-8"))
    for field in ("hash_entrada", "calculado_em"):
        if canonical.get(field) != online.get(field):
            raise AssertionError(f"site desatualizado: {field}")
    sula = read(root / "dados-br/competicoes-af-previsao/sul-americana.json")
    final = final_event(sula)
    if final and final.get("concluido") is True:
        vagas = json.loads(get("/dados-br/vagas-libertadores-2027.json").decode("utf-8"))
        published = final_event(vagas.get("sulamericana") or {})
        if not published or published.get("vencedor") != final.get("vencedor"):
            raise AssertionError("campeão divergente no snapshot público")
    for item in canonical.get("clubes", []):
        name = item["clube"]
        html = unescape(get(f"/clube/{slugify(name)}/").decode("utf-8"))
        expected = item["probabilidades_detalhes"]["libertadores"]["exibicao"]
        if f"a de Libertadores é {expected}" not in html:
            raise AssertionError(f"página pública desatualizada: {name} ({expected})")
        if final and final.get("concluido") is True and name in {
            (final.get("mandante") or {}).get("nome"), (final.get("visitante") or {}).get("nome")
        } and name != final.get("vencedor"):
            pattern = r'<div class="club-route-card is-off"><small>Via título da Sul-Americana</small><strong>0%</strong>'
            if not re.search(pattern, html):
                raise AssertionError(f"vice com via ao título ativa no site: {name}")
    return {"status": "R36_R1_LIVE_PASS", "clubes": len(canonical["clubes"])}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--site-dir", default="_site")
    parser.add_argument("--live-url")
    args = parser.parse_args()
    root = Path(args.repo_root).resolve()
    report = validate_live(root, args.live_url) if args.live_url else validate(root, Path(args.site_dir).resolve())
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AssertionError, OSError, KeyError, ValueError) as exc:
        print(f"R36_R1_INTEGRITY_FAILURE: {exc}", file=sys.stderr)
        sys.exit(1)
