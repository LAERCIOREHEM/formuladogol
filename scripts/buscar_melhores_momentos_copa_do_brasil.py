#!/usr/bin/env python3
"""Localiza melhores momentos oficiais das fases eliminatórias da Copa do Brasil 2026 no YouTube.

Objetivos:
- vincular vídeo por event_id ESPN, nunca apenas pelo nome do confronto;
- aceitar somente canais oficiais configurados e vídeos públicos/embeddable;
- priorizar varredura barata da playlist de uploads; search.list é fallback;
- preservar o último mapa íntegro se a API ficar indisponível;
- gerar JSON consumido pelo editorial sem tornar a publicação dependente de iframe externo.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

ROOT = Path(__file__).resolve().parent.parent
COPA_PATH = ROOT / "dados-br" / "competicoes-af-previsao" / "copa-do-brasil.json"
CONFIG_PATH = ROOT / "dados-br" / "config-transmissoes-aovivo.json"
OUTPUT_PATH = ROOT / "dados-br" / "melhores-momentos-copa-do-brasil.json"
YT_API = "https://www.googleapis.com/youtube/v3"
PHASES = {600: "Oitavas de final", 700: "Quartas de final", 800: "Semifinal", 900: "Final"}
TZ = dt.timezone(dt.timedelta(hours=-3))


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return copy.deepcopy(default)


def _effective_payload(value: Any) -> Any:
    """Remove somente metadados voláteis para evitar commits sem mudança esportiva."""
    if not isinstance(value, Mapping):
        return value
    clean = copy.deepcopy(dict(value))
    clean.pop("atualizado_em", None)
    audit = clean.get("auditoria_api")
    if isinstance(audit, dict):
        # Quota/calls descrevem a execução, não o conteúdo publicado.
        clean.pop("auditoria_api", None)
    return clean


def save_json_if_changed(path: Path, payload: Mapping[str, Any]) -> bool:
    old = load_json(path, None)
    if old is not None and _effective_payload(old) == _effective_payload(payload):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)
    return True


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("&", " e ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def video_id_from_url(value: Any) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", text):
        return text
    try:
        parsed = urllib.parse.urlparse(text if "://" in text else "https://" + text)
        host = parsed.netloc.lower().split(":")[0]
        candidate = ""
        if host in {"youtu.be", "www.youtu.be"}:
            candidate = parsed.path.strip("/").split("/")[0]
        elif host == "youtube.com" or host.endswith(".youtube.com"):
            parts = parsed.path.strip("/").split("/")
            if parts and parts[0] in {"embed", "live", "shorts"} and len(parts) >= 2:
                candidate = parts[1]
            else:
                candidate = (urllib.parse.parse_qs(parsed.query).get("v") or [""])[0]
        return candidate if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate or "") else ""
    except Exception:
        return ""


def now_brt() -> dt.datetime:
    return dt.datetime.now(TZ).replace(microsecond=0)


def iso(value: dt.datetime | None) -> str:
    return value.isoformat() if value else ""


def side_name(side: Any) -> str:
    return str((side or {}).get("nome") or (side or {}).get("nome_espn") or "").strip()


def current_phase_rank(snapshot: Mapping[str, Any]) -> int:
    try:
        rank = int((snapshot.get("fase_atual") or {}).get("ordem") or 0)
    except (TypeError, ValueError):
        rank = 0
    if rank in PHASES:
        return rank
    available = sorted({
        int(event.get("fase_ordem") or 0)
        for event in (snapshot.get("eventos") or [])
        if int(event.get("fase_ordem") or 0) in PHASES
    })
    return available[-1] if available else 0


def game_rows(snapshot: Mapping[str, Any], phase_rank: int | None = None) -> list[dict[str, Any]]:
    rank = phase_rank or current_phase_rank(snapshot)
    rows: list[dict[str, Any]] = []
    for event in snapshot.get("eventos") or []:
        if int(event.get("fase_ordem") or 0) != rank:
            continue
        if not event.get("concluido"):
            continue
        home_obj, away_obj = event.get("mandante") or {}, event.get("visitante") or {}
        home, away = side_name(home_obj), side_name(away_obj)
        if not home or not away:
            continue
        rows.append({
            "event_id": str(event.get("event_id") or ""),
            "fase_ordem": rank,
            "data_iso": str(event.get("data_iso") or ""),
            "mandante": home,
            "visitante": away,
            "placar_mandante": int(home_obj.get("placar")) if home_obj.get("placar") is not None else None,
            "placar_visitante": int(away_obj.get("placar")) if away_obj.get("placar") is not None else None,
            "perna": int(event.get("perna") or 0),
        })
    rows.sort(key=lambda item: (item["data_iso"], item["event_id"]))
    return rows


def aliases_for(team: str) -> list[str]:
    predefined = {
        "Atlético-MG": ["atletico mg", "atletico mineiro", "galo"],
        "Athletico-PR": ["athletico pr", "athletico paranaense", "furacao"],
        "Vasco da Gama": ["vasco", "vasco da gama"],
        "Internacional": ["internacional", "inter"],
        "Grêmio": ["gremio"],
        "Vitória": ["vitoria"],
        "Chapecoense": ["chapecoense", "chape"],
    }
    values = [team] + predefined.get(team, [])
    return list(dict.fromkeys(filter(None, (norm(v) for v in values))))


def team_present(text: str, team: str) -> bool:
    text_n = f" {norm(text)} "
    return any(f" {alias} " in text_n for alias in aliases_for(team))


def score_tokens(title: str) -> list[tuple[int, int]]:
    text = norm(title)
    out: list[tuple[int, int]] = []
    for match in re.finditer(r"(?:^|\s)(\d{1,2})\s*x\s*(\d{1,2})(?:\s|$)", text):
        out.append((int(match.group(1)), int(match.group(2))))
    return out


@dataclass
class Candidate:
    video_id: str
    channel_id: str
    channel_title: str
    title: str
    published_at: str
    thumbnail: str
    embeddable: bool
    public: bool
    source: str
    score: float = 0.0
    reasons: tuple[str, ...] = ()


def evaluate(candidate: Candidate, game: Mapping[str, Any]) -> Candidate:
    title_n = norm(candidate.title)
    if not candidate.embeddable or not candidate.public:
        return copy.copy(candidate)
    if not team_present(candidate.title, str(game["mandante"])) or not team_present(candidate.title, str(game["visitante"])):
        return copy.copy(candidate)
    score = 60.0
    reasons = ["os dois clubes aparecem no título"]
    if "melhores momentos" in title_n or "melhor momento" in title_n:
        score += 25
        reasons.append("título identifica melhores momentos")
    elif "gols" in title_n:
        score += 7
    if "copa do brasil" in title_n:
        score += 16
        reasons.append("competição aparece no título")
    if "2026" in title_n:
        score += 3
    h, a = game.get("placar_mandante"), game.get("placar_visitante")
    pairs = score_tokens(candidate.title)
    if h is not None and a is not None and pairs:
        if (int(h), int(a)) in pairs:
            score += 22
            reasons.append("placar confere")
        elif (int(a), int(h)) in pairs:
            score -= 35
        else:
            score -= 18
    return Candidate(**{**candidate.__dict__, "score": score, "reasons": tuple(reasons)})


class YouTube:
    def __init__(self, key: str, timeout: int = 25):
        self.key = key
        self.timeout = timeout
        self.quota = 0
        self.calls: dict[str, int] = {}

    def get(self, resource: str, **params: Any) -> dict[str, Any]:
        params = {k: v for k, v in params.items() if v not in (None, "", [], ())}
        params["key"] = self.key
        url = f"{YT_API}/{resource}?" + urllib.parse.urlencode(params, doseq=True)
        request = urllib.request.Request(url, headers={"User-Agent": "formula-do-gol-copa-highlights/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"YouTube API HTTP {exc.code} em {resource}: {body[:500]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Falha de rede na YouTube API em {resource}: {exc}") from exc
        self.calls[resource] = self.calls.get(resource, 0) + 1
        self.quota += 100 if resource == "search" else 1
        time.sleep(0.02)
        return data


def chunks(values: Sequence[str], size: int = 50) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield list(values[index:index + size])


def video_details(client: YouTube, ids: Sequence[str], source: str) -> list[Candidate]:
    out: list[Candidate] = []
    for group in chunks(list(dict.fromkeys(filter(None, ids)))):
        data = client.get("videos", part="snippet,status", id=",".join(group), maxResults=50)
        for item in data.get("items") or []:
            snippet, status = item.get("snippet") or {}, item.get("status") or {}
            thumbs = snippet.get("thumbnails") or {}
            thumb = ""
            for key in ("maxres", "standard", "high", "medium", "default"):
                if isinstance(thumbs.get(key), dict) and thumbs[key].get("url"):
                    thumb = str(thumbs[key]["url"]); break
            out.append(Candidate(
                video_id=str(item.get("id") or ""),
                channel_id=str(snippet.get("channelId") or ""),
                channel_title=str(snippet.get("channelTitle") or ""),
                title=str(snippet.get("title") or ""),
                published_at=str(snippet.get("publishedAt") or ""),
                thumbnail=thumb,
                embeddable=status.get("embeddable") is True,
                public=str(status.get("privacyStatus") or "public") == "public",
                source=source,
            ))
    return out


def channel_uploads(client: YouTube, channel_id: str, max_items: int = 250) -> list[Candidate]:
    data = client.get("channels", part="contentDetails", id=channel_id)
    items = data.get("items") or []
    if not items:
        return []
    playlist = (((items[0].get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads") or "")
    if not playlist:
        return []
    ids: list[str] = []
    token = ""
    while len(ids) < max_items:
        page = client.get("playlistItems", part="contentDetails", playlistId=playlist, maxResults=50, pageToken=token)
        for item in page.get("items") or []:
            video_id = str((item.get("contentDetails") or {}).get("videoId") or "")
            if video_id: ids.append(video_id)
        token = str(page.get("nextPageToken") or "")
        if not token: break
    return video_details(client, ids[:max_items], "uploads")


def search_game(client: YouTube, channel_id: str, game: Mapping[str, Any]) -> list[Candidate]:
    h, a = game.get("placar_mandante"), game.get("placar_visitante")
    score = f" {h} x {a}" if h is not None and a is not None else ""
    query = f'{game["mandante"]}{score} {game["visitante"]} melhores momentos Copa do Brasil 2026'
    data = client.get(
        "search", part="snippet", type="video", channelId=channel_id, q=query,
        order="date", maxResults=8, safeSearch="none"
    )
    ids = [str((item.get("id") or {}).get("videoId") or "") for item in data.get("items") or []]
    return video_details(client, ids, "search")


def best_for_game(game: Mapping[str, Any], candidates: Sequence[Candidate], channel_ids: set[str]) -> Candidate | None:
    scored = [evaluate(candidate, game) for candidate in candidates if candidate.channel_id in channel_ids]
    scored = [candidate for candidate in scored if candidate.score >= 92 and candidate.public]
    if not scored:
        return None
    scored.sort(key=lambda item: (item.score, item.published_at, item.video_id), reverse=True)
    return scored[0]


def build_payload(games: Sequence[Mapping[str, Any]], found: Mapping[str, Candidate], client: YouTube | None, previous: Mapping[str, Any] | None = None) -> dict[str, Any]:
    previous = previous or {}
    previous_games = previous.get("jogos") if isinstance(previous, Mapping) else {}
    rows: dict[str, Any] = {
        str(key): dict(value)
        for key, value in (previous_games or {}).items()
        if isinstance(value, Mapping)
    }
    missing: list[str] = []
    for game in games:
        event_id = str(game["event_id"])
        candidate = found.get(event_id)
        if candidate:
            rows[event_id] = {
                "event_id": event_id,
                "mandante": game["mandante"],
                "visitante": game["visitante"],
                "placar_mandante": game.get("placar_mandante"),
                "placar_visitante": game.get("placar_visitante"),
                "video_id": candidate.video_id,
                "url": f"https://www.youtube.com/watch?v={candidate.video_id}",
                "embed_url": f"https://www.youtube-nocookie.com/embed/{candidate.video_id}",
                "thumbnail": candidate.thumbnail or f"https://i.ytimg.com/vi/{candidate.video_id}/hqdefault.jpg",
                "titulo": candidate.title,
                "fonte": candidate.channel_title or "YouTube oficial",
                "channel_id": candidate.channel_id,
                "embeddable": bool(candidate.embeddable and candidate.channel_id != "UCZiYbVptd3PVPf4f6eR6UaQ" and "caze" not in norm(candidate.channel_title)),
                "confianca": round(min(1.0, candidate.score / 126.0), 4),
                "motivos": list(candidate.reasons),
                "origem_busca": candidate.source,
            }
        else:
            old = (previous_games or {}).get(event_id) if isinstance(previous_games, Mapping) else None
            old_id = video_id_from_url((old or {}).get("video_id") or (old or {}).get("url")) if isinstance(old, Mapping) else ""
            if old_id and (old or {}).get("embeddable") is not False:
                rows[event_id] = dict(old)
            else:
                missing.append(event_id)
    return {
        "schema_version": 1,
        "competicao": "Copa do Brasil 2026",
        "fase": PHASES.get(int(games[0].get("fase_ordem") or 0), "Fase eliminatória") if games else str((previous or {}).get("fase") or "Fase eliminatória"),
        "fase_ordem": int(games[0].get("fase_ordem") or 0) if games else int((previous or {}).get("fase_ordem") or 0),
        "atualizado_em": iso(now_brt()),
        "fonte": "YouTube oficial — vídeos públicos com incorporação permitida",
        "politica": "Vínculo por event_id ESPN; canais oficiais; ambos os clubes e a competição precisam ser reconhecidos; embed deve estar permitido pelo YouTube.",
        "total_esperado": len(games),
        "total_vinculados": len(rows),
        "total_pendentes": len(missing),
        "pendentes": missing,
        "jogos": rows,
        "auditoria_api": {
            "quota_estimada": client.quota if client else 0,
            "requisicoes": client.calls if client else {},
        },
    }


def run(api_key: str, dry_run: bool = False) -> dict[str, Any]:
    snapshot = load_json(COPA_PATH, {}) or {}
    rank = current_phase_rank(snapshot)
    if rank not in PHASES:
        raise RuntimeError("Copa do Brasil: fase eliminatória atual não identificada")
    games = game_rows(snapshot, rank)
    if not games:
        print(f"Copa do Brasil: nenhum jogo concluído em {PHASES[rank]}; mapa anterior preservado.")
        return load_json(OUTPUT_PATH, {}) or build_payload([], {}, None, {})
    config = load_json(CONFIG_PATH, {}) or {}
    channels = [item for item in (config.get("canais") or []) if item.get("channel_id")]
    channel_ids = {str(item["channel_id"]) for item in channels}
    previous = load_json(OUTPUT_PATH, {}) or {}
    if not api_key:
        payload = build_payload(games, {}, None, previous)
        if not dry_run and not OUTPUT_PATH.exists(): save_json_if_changed(OUTPUT_PATH, payload)
        print("Aviso: YOUTUBE_API_KEY ausente; preservando vínculos existentes.")
        return payload

    client = YouTube(api_key)
    candidates: list[Candidate] = []
    for channel in channels:
        candidates.extend(channel_uploads(client, str(channel["channel_id"]), 300))
    found: dict[str, Candidate] = {}
    for game in games:
        candidate = best_for_game(game, candidates, channel_ids)
        if candidate: found[str(game["event_id"])] = candidate

    for game in games:
        event_id = str(game["event_id"])
        if event_id in found: continue
        extra: list[Candidate] = []
        for channel in channels:
            extra.extend(search_game(client, str(channel["channel_id"]), game))
        candidate = best_for_game(game, extra, channel_ids)
        if candidate: found[event_id] = candidate

    payload = build_payload(games, found, client, previous)
    if not dry_run:
        changed = save_json_if_changed(OUTPUT_PATH, payload)
        print(f"Melhores momentos Copa: {payload['total_vinculados']}/{payload['total_esperado']} vinculados; alterado={changed}.")
    else:
        print(json.dumps({k: payload[k] for k in ("total_esperado", "total_vinculados", "total_pendentes", "pendentes", "auditoria_api")}, ensure_ascii=False, indent=2))
    return payload


def self_test() -> None:
    assert video_id_from_url("https://www.youtube.com/watch?v=AbCdEfGhI_1") == "AbCdEfGhI_1"
    assert video_id_from_url("https://youtu.be/AbCdEfGhI_1?t=3") == "AbCdEfGhI_1"
    game = {"mandante":"Vitória","visitante":"Athletico-PR","placar_mandante":4,"placar_visitante":0}
    good = Candidate("AbCdEfGhI_1","official","GE TV","VITÓRIA 4 X 0 ATHLETICO-PR | MELHORES MOMENTOS | COPA DO BRASIL 2026","2026-08-07T00:00:00Z","",True,True,"test")
    scored = evaluate(good, game)
    assert scored.score >= 120 and "placar confere" in scored.reasons
    bad = Candidate("AbCdEfGhI_2","official","GE TV","VITÓRIA 4 X 0 BAHIA | MELHORES MOMENTOS | COPA DO BRASIL 2026","","",True,True,"test")
    assert evaluate(bad, game).score == 0
    payload = build_payload([{"event_id":"1", "fase_ordem":700, **game}], {"1": scored}, None, {})
    assert payload["total_vinculados"] == 1 and payload["jogos"]["1"]["embeddable"] is True
    assert payload["fase"] == "Quartas de final" and payload["fase_ordem"] == 700
    previous = {"jogos": {"old": {"event_id": "old", "video_id": "AbCdEfGhI_9", "embeddable": True}}, "fase": "Oitavas de final", "fase_ordem": 600}
    preserved = build_payload([{"event_id":"1", "fase_ordem":700, **game}], {}, None, previous)
    assert "old" in preserved["jogos"] and "1" not in preserved["jogos"]
    assert current_phase_rank({"fase_atual": {"ordem": 800}, "eventos": []}) == 800
    changed_time = copy.deepcopy(payload)
    changed_time["atualizado_em"] = "2099-01-01T00:00:00-03:00"
    changed_time["auditoria_api"] = {"quota_estimada": 999, "requisicoes": {"search": 9}}
    assert _effective_payload(payload) == _effective_payload(changed_time)
    print("Self-test melhores momentos Copa do Brasil: OK")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test(); return 0
    try:
        run(os.environ.get("YOUTUBE_API_KEY", "").strip(), dry_run=args.dry_run)
    except Exception as exc:
        # Vídeos são enriquecimento editorial: uma indisponibilidade da API do
        # YouTube jamais deve derrubar a atualização esportiva. Se o artefato já
        # existe (inclusive ainda vazio), ele é preservado atomicamente.
        if OUTPUT_PATH.exists():
            print(f"::warning::Busca de melhores momentos da Copa falhou ({exc}); mapa anterior preservado.")
            return 0
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
