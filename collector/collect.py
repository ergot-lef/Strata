#!/usr/bin/env python3
"""Collecteur Strata : remplit data/strata.db depuis Wikidata et Our World in Data.

Exemples :
    python collector/collect.py events --from 1939 --to 1946
    python collector/collect.py events --from 1800 --to 2026 --min-sitelinks 10
    python collector/collect.py series population https://ourworldindata.org/grapher/population.csv
    python collector/collect.py stats

Méthode, en deux temps pour ménager le service public de Wikidata :
  1. une requête SPARQL légère liste les éléments datés d'une période
     (P585 « date » ou P580 « début »), via l'index des dates ;
  2. les détails (dates précises, types, pays, titres FR/EN/DE) viennent
     de l'API classique de Wikidata (wbgetentities), par paquets de 50.
Si le service SPARQL sature, la période est redécoupée (année → mois → jours).

Aucune dépendance : bibliothèque standard Python uniquement.
"""

import argparse
import csv
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from strata import __version__  # noqa: E402
from strata.db import DEFAULT_DB, connect  # noqa: E402
from strata.themes import classify  # noqa: E402
from strata.timeutil import fyear, parse_wikidata_time, span_for, to_xsd  # noqa: E402

SPARQL_URL = "https://query.wikidata.org/sparql"
API_URL = "https://www.wikidata.org/w/api.php"
USER_AGENT = f"Strata/{__version__} (https://github.com/ergot-lef/strata; frise chronologique personnelle)"
LANGS = ["fr", "en", "de"]

# Étape 1 : seulement la liste des éléments. « rangeSafe » permet au serveur
# d'utiliser son index de dates au lieu de parcourir toutes les valeurs.
LIST_QUERY = """
SELECT DISTINCT ?e WHERE {{
  {{ ?e wdt:P585 ?d . hint:Prior hint:rangeSafe true . }}
  UNION
  {{ ?e wdt:P580 ?d . hint:Prior hint:rangeSafe true . }}
  FILTER(?d >= "{start}"^^xsd:dateTime && ?d < "{stop}"^^xsd:dateTime)
  ?e wikibase:sitelinks ?sl .
  FILTER(?sl >= {min_sl})
}}
"""


class Overloaded(Exception):
    """Le serveur SPARQL n'a pas pu répondre à temps : découper plus fin."""


def log(msg: str) -> None:
    print(msg, flush=True)


def http_get(url: str, params: dict, accept: str = "application/json", tries: int = 6,
             timeout: int = 70) -> bytes:
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < tries:
                # Limitation de débit : on attend ce que le serveur demande.
                wait = int(e.headers.get("Retry-After") or 60)
                log(f"  serveur limité (429), attente {wait} s…")
                time.sleep(wait + 1)
                continue
            if e.code in (500, 502, 503, 504) and url == SPARQL_URL:
                raise Overloaded(f"HTTP {e.code}") from e
            if e.code in (500, 502, 503, 504) and attempt < tries:
                log(f"  HTTP {e.code}, nouvel essai dans {5 * attempt} s…")
                time.sleep(5 * attempt)
                continue
            raise
        except (TimeoutError, urllib.error.URLError) as e:
            reason = getattr(e, "reason", e)
            if url == SPARQL_URL and isinstance(reason, TimeoutError | OSError) and "timed out" in str(reason):
                raise Overloaded("délai dépassé") from e
            if attempt < tries:
                log(f"  réseau : {reason}, nouvel essai…")
                time.sleep(5 * attempt)
                continue
            raise
    raise RuntimeError("inaccessible")


def year_bound(year: int) -> str:
    sign = "-" if year < 0 else ""
    return f"{sign}{abs(year):04d}-01-01T00:00:00Z"


def list_qids(t_a: float, t_b: float, min_sl: int, depth: int = 0) -> list[str]:
    """QID des éléments datés dans [t_a, t_b[, en redécoupant si le serveur sature."""
    start, stop = to_xsd(t_a), to_xsd(t_b)
    query = LIST_QUERY.format(start=start, stop=stop, min_sl=min_sl)
    try:
        raw = http_get(SPARQL_URL, {"query": query, "format": "json"}, "application/sparql-results+json")
        rows = json.loads(raw)["results"]["bindings"]
        return [r["e"]["value"].rsplit("/", 1)[-1] for r in rows]
    except Overloaded as e:
        if t_b - t_a < 2 / 365:
            raise RuntimeError(f"{start[:10]} : le serveur sature même sur un jour ({e})") from e
        log(f"{'  ' * depth}  {start[:10]} → {stop[:10]} : trop lourd ({e}), découpage en deux…")
        time.sleep(3)
        mid = (t_a + t_b) / 2
        return list_qids(t_a, mid, min_sl, depth + 1) + list_qids(mid, t_b, min_sl, depth + 1)


def fetch_entities(qids: list[str], props: str = "labels|descriptions|sitelinks|claims") -> dict[str, dict]:
    """Éléments complets via l'API wbgetentities (pas le service SPARQL)."""
    out: dict[str, dict] = {}
    for i in range(0, len(qids), 50):
        batch = qids[i:i + 50]
        raw = http_get(API_URL, {
            "action": "wbgetentities", "ids": "|".join(batch), "format": "json",
            "props": props, "languages": "|".join(LANGS), "maxlag": 5,
        })
        out.update(json.loads(raw).get("entities", {}))
        time.sleep(0.2)
    return out


# --- Lecture des déclarations Wikidata ------------------------------------

def _statements(ent: dict, prop: str) -> list[dict]:
    """Déclarations d'une propriété : rang « préféré » d'abord, « déprécié » écarté."""
    sts = [s for s in ent.get("claims", {}).get(prop, []) if s.get("rank") != "deprecated"]
    preferred = [s for s in sts if s.get("rank") == "preferred"]
    return preferred or sts


def _item_ids(ent: dict, prop: str) -> list[str]:
    out = []
    for s in _statements(ent, prop):
        v = s.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(v, dict) and "id" in v:
            out.append(v["id"])
    return out


def _times(ent: dict, prop: str) -> list[tuple[float, int, str]]:
    out = []
    for s in _statements(ent, prop):
        v = s.get("mainsnak", {}).get("datavalue", {}).get("value")
        if not isinstance(v, dict) or "time" not in v:
            continue
        t = parse_wikidata_time(v["time"], api=True)
        if t is not None:
            out.append((t, int(v.get("precision", 11)), v["time"]))
    return out


def parse_entity(ent: dict) -> dict | None:
    """Élément de l'API -> événement Strata (ou None s'il n'a pas de date)."""
    point, start, end = _times(ent, "P585"), _times(ent, "P580"), _times(ent, "P582")
    dates = point or start
    if not dates:
        return None
    # La date la plus précise, puis la plus ancienne.
    t, prec, raw = sorted(dates, key=lambda d: (-d[1], d[0]))[0]
    t_end = end_raw = None
    if not point and end:
        t_end, _, end_raw = max(end, key=lambda d: d[0])
    return {
        "qid": ent["id"], "t": t, "prec": prec, "raw": raw, "end": t_end, "end_raw": end_raw,
        "sl": len(ent.get("sitelinks", {})),
        "types": _item_ids(ent, "P31"), "countries": _item_ids(ent, "P17"), "places": _item_ids(ent, "P276"),
        "labels": {l: ent.get("labels", {}).get(l, {}).get("value") for l in LANGS},
        "descr": {l: ent.get("descriptions", {}).get(l, {}).get("value") for l in LANGS},
        "articles": {l: ent.get("sitelinks", {}).get(f"{l}wiki", {}).get("title") for l in LANGS},
    }


# --- Enregistrement -----------------------------------------------------------

def _cached(con, table: str, qids: set[str]) -> set[str]:
    if not qids:
        return set()
    marks = ",".join("?" * len(qids))
    return {r[0] for r in con.execute(f"SELECT DISTINCT qid FROM {table} WHERE qid IN ({marks})", list(qids))}


def resolve_places(con, places: set[str]) -> dict[str, list[str]]:
    """Pays (P17) des lieux (P276), avec cache dans place_country."""
    missing = sorted(places - _cached(con, "place_country", places))
    if missing:
        for qid, ent in fetch_entities(missing, "claims").items():
            cs = _item_ids(ent, "P17") or ["-"]
            con.executemany("INSERT OR IGNORE INTO place_country VALUES (?,?)", [(qid, c) for c in cs])
    out: dict[str, list[str]] = {}
    if places:
        marks = ",".join("?" * len(places))
        for r in con.execute(f"SELECT qid, country FROM place_country WHERE qid IN ({marks})", list(places)):
            if r[1] != "-":
                out.setdefault(r[0], []).append(r[1])
    return out


def save_events(con, events: list[dict]) -> int:
    if not events:
        return 0
    # Libellés des types et des pays (cache entity_label)
    aux = {q for e in events for q in e["types"] + e["countries"]}
    place_map = resolve_places(con, {p for e in events if not e["countries"] for p in e["places"]})
    for e in events:
        if not e["countries"]:
            e["countries"] = sorted({c for p in e["places"] for c in place_map.get(p, [])})
            aux.update(e["countries"])
    missing = sorted(aux - _cached(con, "entity_label", aux))
    if missing:
        for qid, ent in fetch_entities(missing, "labels").items():
            for lang in LANGS:
                label = ent.get("labels", {}).get(lang, {}).get("value")
                if label:
                    con.execute("INSERT OR REPLACE INTO entity_label VALUES (?,?,?)", (qid, lang, label))

    for ev in events:
        qid = ev["qid"]
        type_labels = [r[0] for r in con.execute(
            "SELECT label FROM entity_label WHERE lang='en' AND qid IN (%s)" % ",".join("?" * len(ev["types"])),
            ev["types"])] if ev["types"] else []
        is_span = 1 if ev["end"] is not None and ev["end"] > ev["t"] else 0
        t_hi = ev["end"] if is_span else ev["t"] + span_for(ev["prec"])
        con.execute(
            "INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,?,?)",
            (qid, ev["t"], t_hi, ev["prec"], is_span, ev["raw"], ev["end_raw"], ev["sl"], classify(type_labels)),
        )
        con.execute("DELETE FROM event_country WHERE qid=?", (qid,))
        con.executemany("INSERT OR IGNORE INTO event_country VALUES (?,?)", [(qid, c) for c in ev["countries"]])
        con.execute("DELETE FROM event_type WHERE qid=?", (qid,))
        con.executemany("INSERT OR IGNORE INTO event_type VALUES (?,?)", [(qid, t) for t in ev["types"]])
        for lang in LANGS:
            label, descr, article = ev["labels"].get(lang), ev["descr"].get(lang), ev["articles"].get(lang)
            if label or article:
                con.execute("INSERT OR REPLACE INTO event_text VALUES (?,?,?,?,?)", (qid, lang, label, descr, article))
    con.commit()
    return len(events)


def collect_period(con, t_a: float, t_b: float, min_sl: int) -> int:
    qids = list_qids(t_a, t_b, min_sl)
    if not qids:
        return 0
    events = [ev for ent in fetch_entities(qids).values() if (ev := parse_entity(ent))]
    return save_events(con, events)


def cmd_events(args) -> None:
    con = connect(args.db)
    total = 0
    for year in range(args.start, args.stop):
        chunk = f"events:{year}:{args.min_sitelinks}"
        if not args.force and con.execute("SELECT 1 FROM collected WHERE chunk=?", (chunk,)).fetchone():
            log(f"{year} : déjà collecté (--force pour refaire)")
            continue
        try:
            n = collect_period(con, fyear(year), fyear(year + 1), args.min_sitelinks)
        except Exception as e:  # noqa: BLE001 — on passe à l'année suivante
            log(f"{year} : échec ({e}). Relance plus tard : les années réussies sont gardées.")
            continue
        con.execute("INSERT OR REPLACE INTO collected VALUES (?,?)", (chunk, datetime.now(timezone.utc).isoformat()))
        con.commit()
        total += n
        log(f"{year} : {n} événements")
        time.sleep(2)  # politesse envers le service public de Wikidata
    log(f"Terminé : {total} événements ajoutés ou mis à jour.")


# --- Courbes de fond ------------------------------------------------------------

def read_series_csv(text: str, entity: str) -> list[tuple[float, float]]:
    """CSV « grapher » d'Our World in Data : Entity, Code, Year, <valeur>."""
    reader = csv.DictReader(io.StringIO(text))
    cols = reader.fieldnames or []
    year_col = next((c for c in cols if c.lower() in ("year", "day", "date")), None)
    value_col = next((c for c in reversed(cols) if c not in ("Entity", "Code", year_col)), None)
    if not year_col or not value_col:
        raise ValueError(f"colonnes inattendues : {cols}")
    points = []
    for row in reader:
        if row.get("Entity") != entity or not row.get(value_col):
            continue
        raw = row[year_col]
        year = float(raw[:4]) + (int(raw[5:7]) - 1) / 12 if "-" in raw[1:] else float(raw)
        points.append((year, float(row[value_col])))
    return points


def cmd_series(args) -> None:
    src = args.source
    if src.startswith("http"):
        text = http_get(src, {}, "text/csv").decode("utf-8")
    else:
        text = Path(src).read_text(encoding="utf-8")
    points = read_series_csv(text, args.entity)
    if not points:
        sys.exit(f"Aucune ligne pour « {args.entity} » dans {src}")
    con = connect(args.db)
    con.execute("DELETE FROM series WHERE name=?", (args.name,))
    con.executemany("INSERT OR REPLACE INTO series VALUES (?,?,?)", [(args.name, t, v) for t, v in points])
    con.execute("INSERT OR REPLACE INTO series_meta VALUES (?,?,?,?)",
                (args.name, args.label or args.name, args.unit, src))
    con.commit()
    log(f"Série « {args.name} » : {len(points)} points ({points[0][0]:.0f} → {points[-1][0]:.0f}).")


def cmd_stats(args) -> None:
    con = connect(args.db)
    n = con.execute("SELECT COUNT(*), MIN(t_lo), MAX(t_lo) FROM events").fetchone()
    log(f"Événements : {n[0]}" + (f" ({n[1]:.0f} → {n[2]:.0f})" if n[0] else ""))
    for r in con.execute("SELECT theme, COUNT(*) FROM events GROUP BY theme ORDER BY 2 DESC"):
        log(f"  {r[0]:<12} {r[1]}")
    for r in con.execute("SELECT name, COUNT(*) FROM series GROUP BY name"):
        log(f"Série {r[0]} : {r[1]} points")


def main() -> None:
    p = argparse.ArgumentParser(description="Collecteur de données Strata")
    p.add_argument("--db", default=str(DEFAULT_DB), help="chemin de la base SQLite")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("events", help="événements datés depuis Wikidata")
    e.add_argument("--from", dest="start", type=int, required=True, help="première année (incluse)")
    e.add_argument("--to", dest="stop", type=int, required=True, help="dernière année (exclue)")
    e.add_argument("--min-sitelinks", type=int, default=5,
                   help="nombre minimum de Wikipédias où l'article existe (importance)")
    e.add_argument("--force", action="store_true", help="recollecter les années déjà faites")
    e.set_defaults(func=cmd_events)

    s = sub.add_parser("series", help="courbe de fond depuis un CSV Our World in Data")
    s.add_argument("name", help="nom court, ex. population")
    s.add_argument("source", help="URL ou fichier CSV")
    s.add_argument("--entity", default="World", help="ligne à garder (défaut : World)")
    s.add_argument("--label", help="libellé affiché, ex. « Population mondiale »")
    s.add_argument("--unit", default="", help="unité affichée")
    s.set_defaults(func=cmd_series)

    st = sub.add_parser("stats", help="résumé du contenu de la base")
    st.set_defaults(func=cmd_stats)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
