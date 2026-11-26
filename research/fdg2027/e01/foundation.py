"""FDG E01: offline season contract. No production writes or network access."""
import json
import re
from pathlib import Path
from types import MappingProxyType
from urllib.parse import parse_qs, urlsplit

def freeze(x):
    if isinstance(x, dict):
        return MappingProxyType({k: freeze(v) for k,v in x.items()})
    if isinstance(x, list):
        return tuple(freeze(v) for v in x)
    return x

REG = freeze(json.loads(Path(__file__).with_name("season-registry.json").read_text(encoding="utf-8")))
COMP = REG["competition"]
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", re.ASCII)

def token(value):
    if not isinstance(value, str) or not TOKEN.fullmatch(value) or value in (".", ".."):
        raise ValueError("invalid token")
    return value

def season(value):
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or value not in REG["seasons"]:
        raise ValueError("unknown season")
    return value

def public_season(value=None):
    year = season(REG["default_season"] if value is None else value)
    if not REG["seasons"][year]["public_read"]:
        raise ValueError("season not public")
    return year

def season_from_url(url):
    if not isinstance(url,str) or not url.startswith("/") or url.startswith("//") or "\\" in url:
        raise ValueError("local path required")
    values = parse_qs(urlsplit(url).query, keep_blank_values=True).get("temporada", [])
    if len(values) > 1:
        raise ValueError("ambiguous season")
    return public_season(values[0] if values else None)

def legacy_read_path(year, asset):
    public_season(year)
    if asset not in REG["legacy_assets"]:
        raise ValueError("unknown legacy asset")
    return REG["legacy_assets"][asset]

def private_key(year, asset):
    year = season(year)
    if asset not in REG["private_assets"]:
        raise ValueError("unknown private asset")
    return f"fdg2027/{COMP}/{year}/{asset}.json"

def private_path(root, repo_root, year, asset):
    """Resolve an external private workspace path, rejecting symlink escapes.
    Caller owns directory permissions; this function does not create/write files."""
    root, repo = Path(root), Path(repo_root)
    if not root.is_absolute() or not repo.is_absolute():
        raise ValueError("absolute roots required")
    root, repo = root.resolve(), repo.resolve()
    if root == repo or repo in root.parents or root in repo.parents:
        raise ValueError("private root must be disjoint from repository")
    target = root / private_key(year, asset)
    if target.resolve() != target:
        raise ValueError("symlink escape or alias")
    return target

def identity(kind, provider, source_id, year=None):
    if kind not in REG["identity_kinds"] or provider not in REG["providers"]:
        raise ValueError("unknown identity type/provider")
    source_id = token(source_id)
    if kind == "fixture":
        if year is None:
            raise ValueError("fixture season required")
        return f"{COMP}:{season(year)}:fixture:{provider}:{source_id}"
    if year is not None:
        raise ValueError("club/player identity is stable across seasons")
    return f"{COMP}:{kind}:{provider}:{source_id}"

def namespace(year, domain, name):
    if domain not in REG["namespace_domains"]:
        raise ValueError("unknown namespace")
    return f"fdg:v1:{COMP}:{season(year)}:{domain}:{token(name)}"

def validate_envelope(year, payload):
    year = season(year)
    if not isinstance(payload,dict) or payload.get("competition") != COMP or season(payload.get("season")) != year:
        raise ValueError("cross-season or competition mismatch")
    return payload

def continental_rule_state(year):
    return REG["seasons"][season(year)]["continental_rules"]
