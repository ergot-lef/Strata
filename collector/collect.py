#!/usr/bin/env python3
"""Collecteur Strata : remplit data/strata.db depuis Wikidata et Our World in Data.

Exemples :
    python collector/collect.py events --from 1939 --to 1946
    python collector/collect.py events --from 1800 --to 2026 --min-sitelinks 10
    python collector/collect.py series population https://ourworldindata.org/grapher/population.csv
    python collector/collect.py stats

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
from strata.timeutil import parse_wikidata_time, span_for  # noqa: E402

SPARQL_URL = "https://query.wikidata.org/sparql"
API_URL = "https://www.wikidata.org/w/api.php"
USER_AGENT = f"Strata/{__version__} (https://github.com/ergot-lef/strata; frise chronologique personnelle)"
LANGS = ["fr", "en", "de"]

# Un événement = un élément Wikidata qui a une date ponctuelle (P585)
# ou une date de début (P580), et qui existe dans au moins N Wikipédias.
EVENTS_QUERY = """
SELECT ?e ?time ?prec ?end ?sl ?type ?country WHERE {{
  {{
    ?e p:P585/psv:P585 ?tv .
  }} UNION {{
    ?e p:P580/psv:P580 ?tv .
    OPTIONAL {{ ?e wdt:P582 ?end . }}
  }}
  ?tv wikibase:timeValue ?time ; wikibase:timePrecision ?prec .
  FILTER(?time >= "{start}"^^xsd:dateTime && ?time < "{stop}"^^xsd:dateTime)
  ?e wikibase:sitelinks ?sl .
  FILTER(?sl >= {min_sl})
  ?e wdt:P31 ?type .
  OPTIONAL {{
    {{ ?e wdt:P17 ?country . }} UNION {{ ?e wdt:P276/wdt:P17 ?country . }}
  }}
}}
"""


def log(msg: str) -> None:
    print(msg, flush=True)


def http_get(url: str, params: dict, accept: str = "application/json", tries: int = 5) -> bytes:
    full = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < tries:
                wait = int(e.headers.get("Retry-After") or 0) or 5 * attempt
                log(f"  HTTP {e.code}, nouvel essai dans {wait} s…")
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < tries:
                log(f"  réseau : {e}, nouvel essai…")
                time.sleep(5 * attempt)
                continue
            raise
    raise RuntimeError("inaccessible")


def year_bound(year: int) -> str:
    sign = "-" if year < 0 else ""
    return f"{sign}{abs(year):04d}-01-01T00:00:00Z"


def sparql(query: str) -> list[dict]:
    raw = http_get(SPARQL_URL, {"query": query, "format": "json"}, "application/sparql-results+json")
    return json.loads(raw)["results"]["bindings"]


def qid_of(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def parse_rows(rows: list[dict]) -> dict[str, dict]:
    """Regroupe les lignes SPARQL (une par type × pays) par événement."""
    events: dict[str, dict] = {}
    for row in rows:
        qid = qid_of(row["e"]["value"])
        t = parse_wikidata_time(row["time"]["value"])
        if t is None:
            continue
        ev = events.setdefault(qid, {
            "qid": qid, "t": t, "prec": int(row["prec"]["value"]),
            "raw": row["time"]["value"], "end": None, "end_raw": None,
            "sl": int(row["sl"]["value"]), "types": set(), "countries": set(),
        })
        # Plusieurs dates possibles : on garde la plus précise, puis la plus ancienne.
        prec = int(row["prec"]["value"])
        if prec > ev["prec"] or (prec == ev["prec"] and t < ev["t"]):
            ev.update(t=t, prec=prec, raw=row["time"]["value"])
        if "end" in row:
            te = parse_wikidata_time(row["end"]["value"])
            if te is not None and (ev["end"] is None or te > ev["end"]):
                ev["end"], ev["end_raw"] = te, row["end"]["value"]
        if "type" in row:
            ev["types"].add(qid_of(row["type"]["value"]))
        if "country" in row:
            ev["countries"].add(qid_of(row["country"]["value"]))
    return events


def fetch_entities(qids: list[str]) -> dict[str, dict]:
    """Libellés, descriptions et articles Wikipédia FR/EN/DE (API wbgetentities)."""
    out: dict[str, dict] = {}
    for i in range(0, len(qids), 50):
        batch = qids[i:i + 50]
        raw = http_get(API_URL, {
            "action": "wbgetentities", "ids": "|".join(batch), "format": "json",
            "props": "labels|descriptions|sitelinks", "languages": "|".join(LANGS),
            "sitefilter": "|".join(f"{l}wiki" for l in LANGS),
        })
        out.update(json.loads(raw).get("entities", {}))
        time.sleep(0.3)
    return out


def store_entities_labels(con, entities: dict[str, dict]) -> None:
    for qid, ent in entities.items():
        for lang in LANGS:
            label = ent.get("labels", {}).get(lang, {}).get("value")
            if label:
                con.execute("INSERT OR REPLACE INTO entity_label VALUES (?,?,?)", (qid, lang, label))


def known_labels(con, qids: set[str]) -> set[str]:
    if not qids:
        return set()
    marks = ",".join("?" * len(qids))
    return {r[0] for r in con.execute(f"SELECT DISTINCT qid FROM entity_label WHERE qid IN ({marks})", list(qids))}


def save_chunk(con, events: dict[str, dict]) -> int:
    if not events:
        return 0
    # Libellés des types et des pays (en cache dans entity_label)
    aux = set().union(*(e["types"] | e["countries"] for e in events.values()))
    missing = sorted(aux - known_labels(con, aux))
    if missing:
        store_entities_labels(con, fetch_entities(missing))

    texts = fetch_entities(sorted(events))
    for qid, ev in events.items():
        type_labels = [r[0] for r in con.execute(
            "SELECT label FROM entity_label WHERE lang='en' AND qid IN (%s)" % ",".join("?" * len(ev["types"])),
            list(ev["types"]))] if ev["types"] else []
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
        ent = texts.get(qid, {})
        for lang in LANGS:
            label = ent.get("labels", {}).get(lang, {}).get("value")
            descr = ent.get("descriptions", {}).get(lang, {}).get("value")
            article = ent.get("sitelinks", {}).get(f"{lang}wiki", {}).get("title")
            if label or article:
                con.execute("INSERT OR REPLACE INTO event_text VALUES (?,?,?,?,?)", (qid, lang, label, descr, article))
    con.commit()
    return len(events)


def cmd_events(args) -> None:
    con = connect(args.db)
    total = 0
    for year in range(args.start, args.stop):
        chunk = f"events:{year}:{args.min_sitelinks}"
        if not args.force and con.execute("SELECT 1 FROM collected WHERE chunk=?", (chunk,)).fetchone():
            log(f"{year} : déjà collecté (--force pour refaire)")
            continue
        query = EVENTS_QUERY.format(start=year_bound(year), stop=year_bound(year + 1), min_sl=args.min_sitelinks)
        try:
            rows = sparql(query)
        except Exception as e:  # noqa: BLE001 — on continue l'année suivante
            log(f"{year} : échec ({e})")
            continue
        n = save_chunk(con, parse_rows(rows))
        con.execute("INSERT OR REPLACE INTO collected VALUES (?,?)", (chunk, datetime.now(timezone.utc).isoformat()))
        con.commit()
        total += n
        log(f"{year} : {n} événements")
        time.sleep(1.0)  # politesse envers le service public de Wikidata
    log(f"Terminé : {total} événements ajoutés ou mis à jour.")


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
