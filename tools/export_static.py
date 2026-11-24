#!/usr/bin/env python3
"""Export statique de Strata : un dossier site/ consultable sans serveur
(GitHub Pages, une clé USB, un téléphone…).

    python tools/export_static.py                 # -> site/
    python tools/export_static.py --max-events 30000 --out /chemin/site

Ce qui est exporté : les données publiques (événements, découvertes,
œuvres, personnes, gouvernants, courbes). La frise personnelle n'est
JAMAIS exportée. Les récits comparés sont chargés à la volée depuis
Wikipédia par le navigateur.
"""

import argparse
import json
import shutil
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from strata.db import DEFAULT_DB, ROOT, WORLD, connect  # noqa: E402
from strata.themes import person_domains_json, taxonomy_json  # noqa: E402

SUMMARY_CHARS = 600


def r6(x):
    return None if x is None else round(x, 6)


def export(con: sqlite3.Connection, out: Path, max_events: int, max_people: int) -> dict:
    # Les éléments les plus présents dans les Wikipédias d'abord
    ev_rows = con.execute("SELECT * FROM events ORDER BY sitelinks DESC LIMIT ?", (max_events,)).fetchall()
    qids = [r["qid"] for r in ev_rows]
    keep = set(qids)
    ctry = {}
    for r in con.execute("SELECT qid, country FROM event_country"):
        if r["qid"] in keep:
            ctry.setdefault(r["qid"], []).append(r["country"])
    events = [[r["qid"], r6(r["t_lo"]), r6(r["t_hi"]), r["precision"], r["is_span"], r["date_raw"], r["end_raw"],
               r["sitelinks"], r["theme"], r["subtheme"], r["kind"], ctry.get(r["qid"], [])] for r in ev_rows]

    p_rows = con.execute("SELECT * FROM person ORDER BY sitelinks DESC LIMIT ?", (max_people,)).fetchall()
    pkeep = {r["qid"] for r in p_rows}
    pctry = {}
    for r in con.execute("SELECT qid, country FROM person_country"):
        if r["qid"] in pkeep:
            pctry.setdefault(r["qid"], []).append(r["country"])
    people = [[r["qid"], r6(r["t_birth"]), r6(r["t_death"]), r["prec_birth"], r["prec_death"], r["birth_raw"],
               r["sitelinks"], r["domain"], pctry.get(r["qid"], [])] for r in p_rows]

    texts = {}
    for r in con.execute("SELECT qid, lang, label, descr, article, summary FROM event_text"):
        if r["qid"] in keep or r["qid"] in pkeep:
            summ = r["summary"] or ""
            if len(summ) > SUMMARY_CHARS:
                summ = summ[:SUMMARY_CHARS].rsplit(" ", 1)[0] + " …"
            texts.setdefault(r["qid"], {})[r["lang"]] = [r["label"], r["descr"], r["article"], summ or None]

    links = [[r["qid"], r["prop"], r["target"]] for r in con.execute("SELECT * FROM event_link")
             if r["qid"] in keep or r["target"] in keep]
    terms = [[r["country"], r["role"], r["person"], r6(r["t0"]), r6(r["t1"])] for r in con.execute("SELECT * FROM office_term")]
    states = [[r["qid"], r6(r["t0"]), r6(r["t1"])] for r in con.execute("SELECT * FROM country_state")]
    labels = {}
    needed = {t[2] for t in terms} | {s[0] for s in states} | {c for v in ctry.values() for c in v} \
        | {c for v in pctry.values() for c in v} | {l[2] for l in links} | {l[0] for l in links}
    for r in con.execute("SELECT qid, lang, label FROM entity_label"):
        if r["qid"] in needed and r["lang"] in ("fr", "en"):
            labels.setdefault(r["qid"], {})[r["lang"]] = r["label"]
    iso = {r["qid"]: r["iso3"] for r in con.execute("SELECT qid, iso3 FROM country_info") if r["iso3"]}
    wikis = {}
    for r in con.execute("SELECT qid, lang, title FROM wiki_page"):
        if r["qid"] in keep or r["qid"] in pkeep:
            wikis.setdefault(r["qid"], {})[r["lang"]] = r["title"]

    # Courbes : pays des couloirs et pays présents + Monde
    try:
        lanes = json.loads((ROOT / "web" / "lanes.json").read_text(encoding="utf-8"))["lanes"]
    except (OSError, ValueError):
        lanes = []
    isos = {l.get("iso3") for l in lanes if l.get("iso3")} | set(iso.values()) | {WORLD}
    series_meta = [dict(r) for r in con.execute("SELECT * FROM series_meta")]
    series = {}
    for r in con.execute("SELECT name, entity, t, value FROM series_points ORDER BY t"):
        if r["entity"] in isos:
            series.setdefault(r["name"], {}).setdefault(r["entity"], []).append([r6(r["t"]), r["value"]])
    for m in series_meta:
        pts = series.get(m["name"], {})
        allt = [p[0] for v in pts.values() for p in v]
        m["t_min"], m["t_max"] = (min(allt), max(allt)) if allt else (None, None)
        m["world_points"] = len(pts.get(WORLD, []))

    data = {
        "version": 1, "events": events, "people": people, "texts": texts, "links": links, "terms": terms,
        "states": states, "labels": labels, "iso": iso, "wikis": wikis, "series_meta": series_meta,
        "series": series, "taxonomy": taxonomy_json(), "person_domains": person_domains_json(),
    }
    out.mkdir(parents=True, exist_ok=True)
    for f in (ROOT / "web").iterdir():
        if f.is_file():
            shutil.copy2(f, out / f.name)
    (out / "data").mkdir(exist_ok=True)
    (out / "data" / "strata.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")  # GitHub Pages : servir les fichiers tels quels
    return {"events": len(events), "people": len(people), "size": (out / "data" / "strata.json").stat().st_size}


def main() -> None:
    p = argparse.ArgumentParser(description="Export statique de Strata (sans serveur)")
    p.add_argument("--db", default=str(DEFAULT_DB))
    p.add_argument("--out", default=str(ROOT / "site"))
    p.add_argument("--max-events", type=int, default=20000, help="nombre maximum d'événements, les plus connus d'abord")
    p.add_argument("--max-people", type=int, default=5000, help="nombre maximum de personnes")
    args = p.parse_args()
    res = export(connect(args.db), Path(args.out), args.max_events, args.max_people)
    print(f"Export dans {args.out} : {res['events']} éléments, {res['people']} personnes, "
          f"{res['size'] / 1e6:.1f} Mo de données. La frise personnelle n'est pas incluse.")


if __name__ == "__main__":
    main()
