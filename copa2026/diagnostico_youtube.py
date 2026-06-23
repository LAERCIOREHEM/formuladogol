#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DIAGNÓSTICO: o que a API do YouTube retorna pras lives da CazéTV?
Descobre se o problema é (a) a API não retornar as lives, ou (b) o videoId mudar.

COMO RODAR:
  No terminal, com a chave da API:
    YOUTUBE_API_KEY=SUA_CHAVE python3 diagnostico_youtube.py

  (a mesma chave que está no secret YOUTUBE_API_KEY do GitHub)
"""
import os, json, urllib.request, urllib.parse

API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
CAZE_CHANNEL_ID = "UCZiYbVptd3PVPf4f6eR6UaQ"
CAZE_UPLOADS_ID = "UU" + CAZE_CHANNEL_ID[2:]


def yt_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "diag/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def busca(event_type):
    """Busca lives por eventType (live / upcoming / completed)."""
    base = "https://www.googleapis.com/youtube/v3/search"
    params = {
        "part": "snippet", "channelId": CAZE_CHANNEL_ID,
        "eventType": event_type, "type": "video",
        "maxResults": "25", "order": "date", "key": API_KEY
    }
    try:
        data = yt_get(base + "?" + urllib.parse.urlencode(params))
        itens = []
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            vid = (it.get("id") or {}).get("videoId")
            itens.append({"videoId": vid, "titulo": sn.get("title", "")})
        return itens, None
    except urllib.error.HTTPError as e:
        corpo = e.read().decode("utf-8", "ignore")[:300]
        return [], f"HTTP {e.code}: {corpo}"
    except Exception as e:
        return [], str(e)


def uploads_recentes(n=15):
    """Lista os últimos uploads do canal (inclui lives, que aparecem aqui também)."""
    base = "https://www.googleapis.com/youtube/v3/playlistItems"
    params = {"part": "snippet", "playlistId": CAZE_UPLOADS_ID,
              "maxResults": str(n), "key": API_KEY}
    try:
        data = yt_get(base + "?" + urllib.parse.urlencode(params))
        return [{"videoId": (it["snippet"].get("resourceId") or {}).get("videoId"),
                 "titulo": it["snippet"].get("title", "")} for it in data.get("items", [])], None
    except Exception as e:
        return [], str(e)


def detalhes_live(video_ids):
    """Para cada videoId, mostra liveBroadcastContent (live/upcoming/none) e status."""
    if not video_ids:
        return {}
    base = "https://www.googleapis.com/youtube/v3/videos"
    params = {"part": "snippet,liveStreamingDetails",
              "id": ",".join(video_ids[:20]), "key": API_KEY}
    try:
        data = yt_get(base + "?" + urllib.parse.urlencode(params))
        out = {}
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            out[it["id"]] = {
                "titulo": sn.get("title", ""),
                "liveBroadcastContent": sn.get("liveBroadcastContent", "?"),
                "tem_liveStreamingDetails": "liveStreamingDetails" in it
            }
        return out
    except Exception as e:
        return {"erro": str(e)}


def main():
    if not API_KEY:
        print("ERRO: defina YOUTUBE_API_KEY. Ex: YOUTUBE_API_KEY=xxxx python3 diagnostico_youtube.py")
        return

    print("=" * 60)
    print("DIAGNÓSTICO DAS LIVES DA CAZÉTV")
    print("=" * 60)

    for et in ["live", "upcoming"]:
        itens, err = busca(et)
        print(f"\n### eventType={et} ###")
        if err:
            print(f"  ERRO: {err}")
            if "quota" in err.lower() or "403" in err:
                print("  >>> POSSÍVEL CAUSA: cota da API esgotada ou chave inválida!")
        elif not itens:
            print(f"  (vazio — a API não retornou nenhuma live '{et}')")
            print(f"  >>> Se há jogo passando AGORA na Cazé, isso CONFIRMA que")
            print(f"      o eventType={et} não é confiável.")
        else:
            print(f"  {len(itens)} resultado(s):")
            for v in itens:
                print(f"    - [{v['videoId']}] {v['titulo'][:55]}")

    # uploads recentes (lives aparecem aqui também, mais confiável)
    ups, err = uploads_recentes(15)
    print(f"\n### uploads recentes do canal (últimos 15) ###")
    if err:
        print(f"  ERRO: {err}")
    else:
        for v in ups:
            print(f"    - [{v['videoId']}] {v['titulo'][:55]}")
        # checa o liveBroadcastContent dos uploads recentes
        det = detalhes_live([v["videoId"] for v in ups if v["videoId"]])
        print(f"\n### estado ao vivo dos uploads recentes ###")
        for vid, d in det.items():
            if isinstance(d, dict) and "liveBroadcastContent" in d:
                marca = ""
                if d["liveBroadcastContent"] == "live":
                    marca = " <<< AO VIVO AGORA"
                elif d["liveBroadcastContent"] == "upcoming":
                    marca = " <<< AGENDADA"
                print(f"    [{vid}] {d['liveBroadcastContent']}{marca}  {d['titulo'][:45]}")

    print("\n" + "=" * 60)
    print("MANDE TODO ESTE RESULTADO PRO CLAUDE")
    print("=" * 60)


if __name__ == "__main__":
    main()
