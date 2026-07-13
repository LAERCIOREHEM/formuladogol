#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_elencos_brasileirao.py — coleta elencos dos clubes do Brasileirão pela ESPN.

Objetivo da Execução 9:
  - preencher dados-br/elencos.json com jogadores, posições, números e idade;
  - não quebrar o workflow caso a ESPN não entregue roster para algum clube;
  - preservar nomes canônicos usados pelo Ranking/Clubes.

A API da ESPN não é oficial para este uso; por isso este script é tolerante:
se uma coleta falhar, ele grava avisos e mantém a estrutura válida para o site.
"""
from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

FUSO_BRASILIA = timezone(timedelta(hours=-3))
URL_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams"
URL_ROSTER = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams/{team_id}/roster"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}

CANONICOS = [
    "Athletico-PR", "Atlético-MG", "Bahia", "Botafogo", "Bragantino",
    "Chapecoense", "Corinthians", "Coritiba", "Cruzeiro", "Flamengo",
    "Fluminense", "Grêmio", "Internacional", "Mirassol", "Palmeiras",
    "Remo", "Santos", "São Paulo", "Vasco da Gama", "Vitória",
]

ALIASES = {
    "athletico-pr": "Athletico-PR", "athletico paranaense": "Athletico-PR", "athletico": "Athletico-PR", "cap": "Athletico-PR",
    "atletico-mg": "Atlético-MG", "atletico mineiro": "Atlético-MG", "atletico mg": "Atlético-MG", "clube atletico mineiro": "Atlético-MG", "cam": "Atlético-MG",
    "bahia": "Bahia", "esporte clube bahia": "Bahia", "ec bahia": "Bahia", "bah": "Bahia",
    "botafogo": "Botafogo", "botafogo rj": "Botafogo", "botafogo de futebol e regatas": "Botafogo", "bot": "Botafogo",
    "bragantino": "Bragantino", "red bull bragantino": "Bragantino", "rb bragantino": "Bragantino", "rbb": "Bragantino",
    "chapecoense": "Chapecoense", "associacao chapecoense de futebol": "Chapecoense", "cha": "Chapecoense",
    "corinthians": "Corinthians", "sc corinthians paulista": "Corinthians", "corinthians paulista": "Corinthians", "cor": "Corinthians",
    "coritiba": "Coritiba", "coritiba fc": "Coritiba", "coritiba foot ball club": "Coritiba", "cfc": "Coritiba",
    "cruzeiro": "Cruzeiro", "cruzeiro ec": "Cruzeiro", "cruzeiro esporte clube": "Cruzeiro", "cru": "Cruzeiro",
    "flamengo": "Flamengo", "cr flamengo": "Flamengo", "clube de regatas do flamengo": "Flamengo", "fla": "Flamengo",
    "fluminense": "Fluminense", "fluminense fc": "Fluminense", "fluminense football club": "Fluminense", "flu": "Fluminense",
    "gremio": "Grêmio", "gremio fbpa": "Grêmio", "gremio foot-ball porto alegrense": "Grêmio", "gre": "Grêmio",
    "internacional": "Internacional", "sc internacional": "Internacional", "sport club internacional": "Internacional", "inter de porto alegre": "Internacional", "int": "Internacional",
    "mirassol": "Mirassol", "mirassol fc": "Mirassol", "mirassol futebol clube": "Mirassol", "mir": "Mirassol",
    "palmeiras": "Palmeiras", "se palmeiras": "Palmeiras", "sociedade esportiva palmeiras": "Palmeiras", "pal": "Palmeiras",
    "remo": "Remo", "clube do remo": "Remo", "rem": "Remo",
    "santos": "Santos", "santos fc": "Santos", "santos futebol clube": "Santos", "san": "Santos",
    "sao paulo": "São Paulo", "sao paulo fc": "São Paulo", "sao paulo futebol clube": "São Paulo", "sao": "São Paulo",
    "vasco": "Vasco da Gama", "vasco da gama": "Vasco da Gama", "cr vasco da gama": "Vasco da Gama", "club de regatas vasco da gama": "Vasco da Gama", "vas": "Vasco da Gama",
    "vitoria": "Vitória", "ec vitoria": "Vitória", "esporte clube vitoria": "Vitória", "vitoria ba": "Vitória", "vit": "Vitória",
}

TOKENS = [
    ("paranaense", "Athletico-PR"), ("athletico", "Athletico-PR"), ("mineiro", "Atlético-MG"),
    ("bragantino", "Bragantino"), ("chapecoense", "Chapecoense"), ("corinthians", "Corinthians"),
    ("coritiba", "Coritiba"), ("cruzeiro", "Cruzeiro"), ("flamengo", "Flamengo"),
    ("fluminense", "Fluminense"), ("gremio", "Grêmio"), ("internacional", "Internacional"),
    ("mirassol", "Mirassol"), ("palmeiras", "Palmeiras"), ("remo", "Remo"), ("santos", "Santos"),
    ("vasco", "Vasco da Gama"), ("botafogo", "Botafogo"), ("bahia", "Bahia"), ("vitoria", "Vitória"),
]


def agora_iso() -> str:
    return datetime.now(FUSO_BRASILIA).isoformat()


def normalizar(valor: Any) -> str:
    s = unicodedata.normalize("NFD", str(valor or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9\- ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def para_canonico(*candidatos: Any) -> str | None:
    for cand in candidatos:
        n = normalizar(cand)
        if not n:
            continue
        if n in ALIASES:
            return ALIASES[n]
        for canon in CANONICOS:
            if n == normalizar(canon):
                return canon
    texto = " ".join(normalizar(c) for c in candidatos if c)
    for token, canon in TOKENS:
        if re.search(r"\b" + re.escape(token) + r"\b", texto):
            return canon
    return None


def fetch_json(url: str, timeout: int = 25, tentativas: int = 2) -> dict[str, Any]:
    ultimo: Exception | None = None
    for i in range(1, tentativas + 1):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(f"{url}{sep}_={int(time.time())}", headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout + 8 * (i - 1)) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                return json.loads(r.read().decode(charset, errors="replace"))
        except Exception as e:  # noqa: BLE001
            ultimo = e
            if i < tentativas:
                time.sleep(1.5 * i)
    raise RuntimeError(f"falha ao buscar {url}: {ultimo}")


def gravar(caminho: str, payload: dict[str, Any]) -> None:
    p = Path(caminho)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)


def carregar_json(caminho: str, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(Path(caminho).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def coletar_times(no: Any, achados: list[dict[str, Any]]) -> None:
    if isinstance(no, dict):
        team = no.get("team") if isinstance(no.get("team"), dict) else no
        if isinstance(team, dict) and (team.get("id") or team.get("uid")) and (
            team.get("displayName") or team.get("name") or team.get("shortDisplayName")
        ):
            achados.append(team)
        for v in no.values():
            coletar_times(v, achados)
    elif isinstance(no, list):
        for v in no:
            coletar_times(v, achados)


def mapear_times_espn() -> tuple[dict[str, str], list[str]]:
    avisos: list[str] = []
    data = fetch_json(URL_TEAMS)
    teams: list[dict[str, Any]] = []
    coletar_times(data, teams)
    mapa: dict[str, str] = {}
    vistos_ids: set[str] = set()
    for t in teams:
        team_id = str(t.get("id") or t.get("uid") or "").split(":")[-1]
        if not team_id or team_id in vistos_ids:
            continue
        vistos_ids.add(team_id)
        canon = para_canonico(t.get("displayName"), t.get("shortDisplayName"), t.get("name"), t.get("location"), t.get("abbreviation"), t.get("slug"))
        if canon and canon not in mapa:
            mapa[canon] = team_id
    faltam = sorted(set(CANONICOS) - set(mapa))
    if faltam:
        avisos.append("Times sem id ESPN no endpoint /teams: " + ", ".join(faltam))
    return mapa, avisos


BANNED_NAMES = {
    "active", "inactive", "total", "athlete", "athletes", "player", "players",
    "defender", "defenders", "forward", "forwards", "goalkeeper", "goalkeepers",
    "midfielder", "midfielders", "goleiro", "goleiros", "defensor", "defensores",
    "atacante", "atacantes", "meio campista", "meio campistas", "elenco", "roster",
}

POSITION_MAP = {
    "gk": "Goleiro", "goalkeeper": "Goleiro", "keeper": "Goleiro", "goleiro": "Goleiro",
    "df": "Defensor", "defender": "Defensor", "defensor": "Defensor",
    "cb": "Zagueiro", "centre back": "Zagueiro", "center back": "Zagueiro", "zagueiro": "Zagueiro",
    "rb": "Lateral-direito", "right back": "Lateral-direito", "lateral direito": "Lateral-direito",
    "lb": "Lateral-esquerdo", "left back": "Lateral-esquerdo", "lateral esquerdo": "Lateral-esquerdo",
    "mf": "Meio-campista", "midfielder": "Meio-campista", "meio campista": "Meio-campista",
    "dm": "Volante", "defensive midfielder": "Volante", "volante": "Volante",
    "cm": "Meio-campista", "central midfielder": "Meio-campista",
    "am": "Meia", "attacking midfielder": "Meia", "meia": "Meia",
    "fw": "Atacante", "forward": "Atacante", "attacker": "Atacante", "atacante": "Atacante",
    "st": "Atacante", "striker": "Atacante", "centre forward": "Atacante", "center forward": "Atacante",
    "winger": "Atacante", "left winger": "Atacante", "right winger": "Atacante",
}

POSITION_ORDER = {
    "Goleiro": 0,
    "Zagueiro": 1,
    "Lateral-direito": 2,
    "Lateral-esquerdo": 2,
    "Defensor": 2,
    "Volante": 3,
    "Meio-campista": 4,
    "Meia": 4,
    "Atacante": 5,
    "": 6,
}

# O roster do Remo não era entregue de forma completa pelo endpoint da ESPN.
# Complemento documental atualizado em 03/07/2026 pelo ge.
REMO_COMPLEMENTAR = [
    ("Ivan", "Goleiro"), ("João Victor", "Goleiro"), ("Marcelo Rangel", "Goleiro"),
    ("Marcus Alexandre", "Goleiro"), ("Ygor Vinhas", "Goleiro"),
    ("Léo Andrade", "Zagueiro"), ("Matheus Felipe", "Zagueiro"), ("Marllon", "Zagueiro"),
    ("Thalisson", "Zagueiro"), ("Duplexe Tchamba", "Zagueiro"),
    ("João Lucas", "Lateral-direito"), ("Marcelinho", "Lateral-direito"),
    ("Matheus Alexandre", "Lateral-direito"), ("Mayk", "Lateral-esquerdo"),
    ("Edson Fernando", "Volante"), ("Jaderson", "Volante"), ("Patrick", "Volante"),
    ("Leonel Picco", "Volante"), ("Zé Welison", "Volante"), ("Zé Ricardo", "Volante"),
    ("David Braga", "Meia"), ("Giovanni Pavani", "Meia"), ("Vitor Bueno", "Meia"),
    ("Alef Manga", "Atacante"), ("Eduardo Melo", "Atacante"), ("Jajá", "Atacante"),
    ("Yago Pikachu", "Atacante"), ("Gabriel Poveda", "Atacante"),
    ("Gabriel Taliari", "Atacante"), ("Tico", "Atacante"),
]

COMPLEMENTOS = {
    "Remo": [
        {"id": "", "nome": nome, "posicao": posicao, "numero": "", "idade": "", "origem": "complemento_documental"}
        for nome, posicao in REMO_COMPLEMENTAR
    ]
}

FONTES_COMPLEMENTARES = {
    "Remo": "https://ge.globo.com/pa/futebol/times/remo/noticia/2026/07/03/mais-de-um-time-deixou-o-remo-em-seis-meses-da-temporada-2026-veja.ghtml"
}


def extrair_athletes(no: Any, saida: list[dict[str, Any]]) -> None:
    """Extrai candidatos; a validação estrita é feita em normalizar_atleta."""
    if isinstance(no, dict):
        athletes = no.get("athletes")
        if isinstance(athletes, list):
            for item in athletes:
                if not isinstance(item, dict):
                    continue
                athlete = item.get("athlete") if isinstance(item.get("athlete"), dict) else item
                if isinstance(athlete, dict):
                    # Preserva posição/camisa que às vezes ficam no wrapper.
                    merged = dict(item)
                    merged.update(athlete)
                    saida.append(merged)
        # Endpoints alternativos podem usar items/roster com uma lista plana.
        for key in ("items", "roster", "players"):
            values = no.get(key)
            if isinstance(values, list):
                for item in values:
                    if isinstance(item, dict):
                        athlete = item.get("athlete") if isinstance(item.get("athlete"), dict) else item
                        if isinstance(athlete, dict):
                            merged = dict(item)
                            merged.update(athlete)
                            saida.append(merged)
        for key, value in no.items():
            if key not in {"athletes", "items", "roster", "players"}:
                extrair_athletes(value, saida)
    elif isinstance(no, list):
        for item in no:
            extrair_athletes(item, saida)


def texto_posicao(pos: Any) -> str:
    if isinstance(pos, dict):
        raw = str(pos.get("displayName") or pos.get("name") or pos.get("abbreviation") or "")
    else:
        raw = str(pos or "")
    n = normalizar(raw).replace("-", " ")
    if n in POSITION_MAP:
        return POSITION_MAP[n]
    # Correspondência controlada para nomes compostos.
    for token, translated in POSITION_MAP.items():
        if len(token) > 2 and token in n:
            return translated
    return raw.strip() if raw.strip() and n not in BANNED_NAMES else ""


def idade_valida(value: Any) -> int | str:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return ""
    return n if 14 <= n <= 50 else ""


def numero_valido(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    m = re.fullmatch(r"\d{1,3}", raw)
    return raw if m and 0 < int(raw) <= 999 else ""


def nome_invalido(nome: str, clube: str = "") -> bool:
    n = normalizar(nome).replace("-", " ")
    if not n or n in BANNED_NAMES or len(n) < 2 or len(n) > 80:
        return True
    if not re.search(r"[a-z]", n):
        return True
    nomes_clubes = {normalizar(c).replace("-", " ") for c in CANONICOS}
    nomes_clubes.update(normalizar(a).replace("-", " ") for a in ALIASES)
    if n in nomes_clubes or (clube and n == normalizar(clube).replace("-", " ")):
        return True
    return False


def normalizar_atleta(a: dict[str, Any], clube: str = "") -> dict[str, Any] | None:
    if not isinstance(a, dict):
        return None
    nome = a.get("displayName") or a.get("fullName") or a.get("name") or a.get("shortName") or a.get("nome")
    nome = re.sub(r"\s+", " ", str(nome or "")).strip()
    if nome_invalido(nome, clube):
        return None
    posicao = texto_posicao(a.get("position") or a.get("posicao"))
    numero = numero_valido(a.get("jersey") or a.get("number") or a.get("numero"))
    idade = idade_valida(a.get("age") or a.get("idade"))
    athlete_id = str(a.get("id") or "").strip()
    # Um atleta real precisa ao menos de posição, camisa, idade ou id não trivial.
    if not posicao and not numero and not idade and (not athlete_id or athlete_id in {"0", "1", "2", "10", "19"}):
        return None
    return {
        "id": athlete_id,
        "nome": nome,
        "posicao": posicao,
        "numero": numero,
        "idade": idade,
        **({"origem": a.get("origem")} if a.get("origem") else {}),
    }


def sanitizar_elenco(jogadores: Any, clube: str) -> tuple[list[dict[str, Any]], list[str]]:
    if not isinstance(jogadores, list):
        return [], []
    limpos: list[dict[str, Any]] = []
    rejeitados: list[str] = []
    vistos: set[str] = set()
    for raw in jogadores:
        j = normalizar_atleta(raw, clube) if isinstance(raw, dict) else None
        if not j:
            if isinstance(raw, dict):
                nome = str(raw.get("nome") or raw.get("displayName") or raw.get("name") or "").strip()
                if nome:
                    rejeitados.append(nome)
            continue
        chave = f"id:{j['id']}" if j.get("id") else f"nome:{normalizar(j['nome'])}"
        if chave in vistos:
            continue
        vistos.add(chave)
        limpos.append(j)
    limpos.sort(key=lambda x: (POSITION_ORDER.get(str(x.get("posicao") or ""), 6), normalizar(x.get("nome"))))
    return limpos, sorted(set(rejeitados), key=normalizar)


def mesclar_complemento(clube: str, elenco: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    complemento = COMPLEMENTOS.get(clube) or []
    if not complemento:
        return elenco, 0
    out = list(elenco)
    nomes = {normalizar(j.get("nome")) for j in out}
    adicionados = 0
    for item in complemento:
        if normalizar(item.get("nome")) in nomes:
            continue
        out.append(dict(item))
        nomes.add(normalizar(item.get("nome")))
        adicionados += 1
    out.sort(key=lambda x: (POSITION_ORDER.get(str(x.get("posicao") or ""), 6), normalizar(x.get("nome"))))
    return out, adicionados


def coletar_roster(team_id: str, clube: str) -> list[dict[str, Any]]:
    url = URL_ROSTER.format(team_id=urllib.parse.quote(str(team_id)))
    data = fetch_json(url)
    candidatos: list[dict[str, Any]] = []
    extrair_athletes(data, candidatos)
    jogadores, _ = sanitizar_elenco(candidatos, clube)
    return jogadores


def self_test() -> None:
    sample = {
        "athletes": [
            {"id": "10", "displayName": "Midfielder"},
            {"athlete": {"id": "12345", "displayName": "Jogador Teste", "position": {"displayName": "Defender"}, "jersey": "4", "age": 25}},
            {"athlete": {"id": "12345", "displayName": "Jogador Teste", "position": {"displayName": "Defender"}, "jersey": "4", "age": 25}},
        ],
        "team": {"id": "999", "displayName": "Bahia"},
    }
    candidatos: list[dict[str, Any]] = []
    extrair_athletes(sample, candidatos)
    limpos, rejeitados = sanitizar_elenco(candidatos + [{"id": "0", "nome": "Total"}], "Bahia")
    assert len(limpos) == 1, limpos
    assert limpos[0]["nome"] == "Jogador Teste"
    assert limpos[0]["posicao"] == "Defensor"
    assert "Midfielder" in rejeitados and "Total" in rejeitados
    remo, added = mesclar_complemento("Remo", [])
    assert len(remo) >= 25 and added == len(remo)
    print("SELF-TEST OK: cabeçalhos rejeitados, atleta deduplicado, posição traduzida e complemento válido.")


def build_payload(elencos: dict[str, list[dict[str, Any]]], avisos: list[str], audit: dict[str, Any]) -> dict[str, Any]:
    total = sum(len(v) for v in elencos.values())
    return {
        "atualizado_em": agora_iso(),
        "fonte": "ESPN roster endpoint + base local sanitizada + complemento documental quando necessário",
        "metodologia": (
            "Aceita somente registros identificáveis como atletas, remove cabeçalhos/metadados, "
            "traduz posições, deduplica por id/nome e preserva o último elenco íntegro quando a coleta oscila."
        ),
        "fontes_complementares": FONTES_COMPLEMENTARES,
        "total_clubes_com_elenco": sum(1 for v in elencos.values() if v),
        "total_jogadores": total,
        "elencos": {c: elencos.get(c, []) for c in CANONICOS},
        "auditoria_resumo": audit.get("resumo") or {},
        "avisos": avisos,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Atualiza e sanitiza elencos do Brasileirão.")
    parser.add_argument("--reparar-local", action="store_true", help="Sanitiza dados-br/elencos.json sem acessar a rede.")
    parser.add_argument("--self-test", action="store_true", help="Executa testes internos sem rede.")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return

    antigo = carregar_json("dados-br/elencos.json", {"elencos": {}})
    elencos_antigos = antigo.get("elencos") if isinstance(antigo, dict) else {}
    if not isinstance(elencos_antigos, dict):
        elencos_antigos = {}

    avisos: list[str] = []
    rejeitados_por_clube: dict[str, list[str]] = {}
    complementados: dict[str, int] = {}
    preservados: list[str] = []
    elencos: dict[str, list[dict[str, Any]]] = {}

    # Sanitiza primeiro a base existente. Assim, uma oscilação da rede nunca repõe lixo.
    for clube in CANONICOS:
        limpos, rejeitados = sanitizar_elenco(elencos_antigos.get(clube) or [], clube)
        elencos[clube] = limpos
        if rejeitados:
            rejeitados_por_clube[clube] = rejeitados

    mapa: dict[str, str] = {}
    if not args.reparar_local:
        try:
            mapa, avisos_times = mapear_times_espn()
            avisos.extend(avisos_times)
        except Exception as exc:  # noqa: BLE001
            avisos.append(f"Falha ao buscar lista de times ESPN: {type(exc).__name__}: {exc}")

        for clube in CANONICOS:
            team_id = mapa.get(clube)
            if not team_id:
                preservados.append(clube)
                continue
            try:
                novos = coletar_roster(team_id, clube)
                if len(novos) >= 15:
                    elencos[clube] = novos
                    print(f"{clube}: {len(novos)} jogadores válidos")
                else:
                    preservados.append(clube)
                    avisos.append(f"{clube}: roster ESPN incompleto ({len(novos)} válidos); base íntegra preservada")
            except Exception as exc:  # noqa: BLE001
                preservados.append(clube)
                avisos.append(f"{clube}: falha no roster ESPN ({type(exc).__name__}: {exc}); base íntegra preservada")
            time.sleep(0.25)

    for clube in CANONICOS:
        if len(elencos[clube]) < 15 and clube in COMPLEMENTOS:
            elencos[clube], added = mesclar_complemento(clube, elencos[clube])
            if added:
                complementados[clube] = added

    incompletos = {clube: len(rows) for clube, rows in elencos.items() if len(rows) < 15}
    nomes_proibidos = []
    for clube, rows in elencos.items():
        for row in rows:
            if nome_invalido(str(row.get("nome") or ""), clube):
                nomes_proibidos.append(f"{clube}: {row.get('nome')}")

    status = "ok" if not incompletos and not nomes_proibidos else "erro"
    audit = {
        "gerado_em": agora_iso(),
        "status": status,
        "resumo": {
            "clubes": len(elencos),
            "clubes_com_15_ou_mais": sum(1 for rows in elencos.values() if len(rows) >= 15),
            "total_jogadores": sum(len(rows) for rows in elencos.values()),
            "registros_rejeitados": sum(len(v) for v in rejeitados_por_clube.values()),
            "clubes_com_complemento": len(complementados),
            "clubes_preservados": len(set(preservados)),
        },
        "contagem_por_clube": {clube: len(elencos[clube]) for clube in CANONICOS},
        "rejeitados_por_clube": rejeitados_por_clube,
        "complementados": complementados,
        "fontes_complementares": FONTES_COMPLEMENTARES,
        "incompletos": incompletos,
        "nomes_proibidos": nomes_proibidos,
        "avisos": avisos,
    }
    gravar("dados-br/elencos.json", build_payload(elencos, avisos, audit))
    gravar("dados-br/auditoria-elencos.json", audit)
    print(f"dados-br/elencos.json gerado: {len(elencos)} clubes, {audit['resumo']['total_jogadores']} jogadores válidos")
    print(f"Registros descartados: {audit['resumo']['registros_rejeitados']}; complementos: {complementados or 'nenhum'}")
    if status != "ok":
        raise RuntimeError(f"Auditoria de elencos falhou: incompletos={incompletos}; proibidos={nomes_proibidos}")


if __name__ == "__main__":
    main()
