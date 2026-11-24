#!/usr/bin/env python3
"""Serveur local Strata : sert l'interface web/ et une petite API JSON.

    python server/server.py            # http://localhost:8765
    python server/server.py --port 9000 --db data/strata.db

API :
    GET /api/events?from=1945.0&to=1945.5&countries=Q142,Q30&per_lane=25
                   [&themes=guerre,politique][&sub_off=sport.match][&include_other=1][&extra=Q1,Q2]
    GET /api/event?qid=Q...          fiche complète : résumés, liens, même jour
    GET /api/countries[?from=&to=]
    GET /api/themes
    GET /api/series                  liste des courbes
    GET /api/series?name=population&entities=OWID_WRL,FRA,DEU
    GET /api/search?q=hiroshima
    GET /api/stats
"""

import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
import sqlite3
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from strata.db import DEFAULT_DB, ROOT, connect  # noqa: E402
from strata.themes import person_domains_json, taxonomy_json  # noqa: E402
from strata.timeutil import fyear  # noqa: E402
from strata.timeutil import PRECISION_NAMES  # noqa: E402

WEB_DIR = ROOT / "web"
LANGS = ("fr", "en", "de")
LINK_NAMES = {
    "P828": "cause", "P1478": "cause", "P1542": "consequence", "P1536": "consequence",
    "P155": "precede", "P156": "suit", "P361": "partie_de", "P527": "comprend", "P793": "evenement",
}


def _chunks(seq, n=500):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _texts(con: sqlite3.Connection, qids, summary: bool = False) -> dict[str, dict]:
    out: dict[str, dict] = {q: {} for q in qids}
    cols = "qid, lang, label, descr, article" + (", summary" if summary else "")
    for part in _chunks(qids):
        sql = f"SELECT {cols} FROM event_text WHERE qid IN ({','.join('?' * len(part))})"
        for r in con.execute(sql, part):
            d = {"label": r["label"], "descr": r["descr"], "article": r["article"]}
            if summary:
                d["summary"] = r["summary"]
            out[r["qid"]][r["lang"]] = d
    return out


def _countries_of(con: sqlite3.Connection, qids) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {q: [] for q in qids}
    for part in _chunks(qids):
        sql = f"SELECT qid, country FROM event_country WHERE qid IN ({','.join('?' * len(part))})"
        for r in con.execute(sql, part):
            out[r["qid"]].append(r["country"])
    return out


def _labels(con, qids) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for part in _chunks(qids):
        sql = f"SELECT qid, lang, label FROM entity_label WHERE qid IN ({','.join('?' * len(part))})"
        for r in con.execute(sql, part):
            out.setdefault(r["qid"], {})[r["lang"]] = r["label"]
    return out


def _event_dict(r: sqlite3.Row, texts: dict, countries: dict) -> dict:
    keys = r.keys()
    return {
        "qid": r["qid"], "t0": r["t_lo"], "t1": r["t_hi"], "precision": r["precision"],
        "precision_name": PRECISION_NAMES.get(r["precision"], ""), "span": bool(r["is_span"]),
        "date": r["date_raw"], "end": r["end_raw"], "sitelinks": r["sitelinks"], "theme": r["theme"],
        "subtheme": r["subtheme"] if "subtheme" in keys else "",
        "is_event": bool(r["is_event"]) if "is_event" in keys else True,
        "kind": r["kind"] if "kind" in keys else "event",
        "text": texts.get(r["qid"], {}), "countries": countries.get(r["qid"], []) or ["_"],
    }


def api_events(con, q: dict) -> dict:
    t_from, t_to = float(q["from"]), float(q["to"])
    per_lane = min(int(q.get("per_lane", 25)), 200)
    themes = [t for t in q.get("themes", "").split(",") if t]
    sub_off = [s for s in q.get("sub_off", "").split(",") if s]
    countries = [c for c in q.get("countries", "").split(",") if c]
    where = ["e.t_lo <= ?", "e.t_hi >= ?"]
    params: list = [t_to, t_from]
    kinds = [k for k in q.get("kinds", "").split(",") if k] or ["event"]
    if q.get("include_other") == "1" and "other" not in kinds:
        kinds.append("other")
    where.append(f"e.kind IN ({','.join('?' * len(kinds))})")
    params += kinds
    if themes:
        where.append(f"e.theme IN ({','.join('?' * len(themes))})")
        params += themes
    if sub_off:
        where.append(f"(e.theme || '.' || e.subtheme) NOT IN ({','.join('?' * len(sub_off))})")
        params += sub_off
    if countries:
        where.append(f"COALESCE(c.country, '_') IN ({','.join('?' * len(countries))})")
        params += countries
    # « _ » = événement sans pays (couloir « Monde »).
    # Les N événements les plus « importants » (présents dans le plus de
    # Wikipédias) de chaque pays : la frise reste lisible à tout zoom.
    sql = f"""
        SELECT * FROM (
            SELECT e.*, COALESCE(c.country, '_') AS lane_country,
                   ROW_NUMBER() OVER (PARTITION BY COALESCE(c.country, '_') ORDER BY e.sitelinks DESC) AS rk
            FROM events e LEFT JOIN event_country c ON c.qid = e.qid
            WHERE {' AND '.join(where)}
        ) WHERE rk <= ?
    """
    rows = con.execute(sql, params + [per_lane]).fetchall()
    # Éléments épinglés (fiche ouverte, ses liens, le même jour) : toujours renvoyés
    extra = [x for x in q.get("extra", "").split(",") if x][:100]
    if extra:
        rows += con.execute(f"""SELECT e.* FROM events e WHERE e.qid IN ({','.join('?' * len(extra))})
                                AND e.t_lo <= ? AND e.t_hi >= ?""", extra + [t_to, t_from]).fetchall()
    qids = sorted({r["qid"] for r in rows})
    texts, ctry = _texts(con, qids), _countries_of(con, qids)
    seen, events = set(), []
    for r in rows:
        if r["qid"] not in seen:
            seen.add(r["qid"])
            events.append(_event_dict(r, texts, ctry))
    return {"events": events}


def api_event(con, q: dict) -> dict:
    qid = q.get("qid", "")
    r = con.execute("SELECT * FROM events WHERE qid=?", (qid,)).fetchone()
    if not r:
        return {"event": None}
    ev = _event_dict(r, _texts(con, [qid], summary=True), _countries_of(con, [qid]))

    # Liens dans les deux sens : « A a pour cause B » vaut « B a pour conséquence A ».
    out_links = [(LINK_NAMES.get(p, p), t) for p, t in con.execute("SELECT prop, target FROM event_link WHERE qid=?", (qid,))]
    reverse = {"cause": "consequence", "consequence": "cause", "precede": "suit", "suit": "precede",
               "partie_de": "comprend", "comprend": "partie_de", "evenement": "partie_de"}
    in_links = [(reverse.get(LINK_NAMES.get(p, p), "lie"), s)
                for p, s in con.execute("SELECT prop, qid FROM event_link WHERE target=?", (qid,))]
    pairs = list(dict.fromkeys(out_links + in_links))
    targets = sorted({t for _, t in pairs})
    in_db = {row["qid"]: row for part in _chunks(targets)
             for row in con.execute(f"SELECT qid, t_lo, precision FROM events WHERE qid IN ({','.join('?' * len(part))})", part)}
    t_texts, t_labels = _texts(con, targets), _labels(con, targets)
    links = []
    for kind, t in pairs:
        labels = {l: v.get("label") for l, v in t_texts.get(t, {}).items()} or t_labels.get(t, {})
        row = in_db.get(t)
        links.append({"kind": kind, "qid": t, "labels": labels,
                      "t0": row["t_lo"] if row else None, "precision": row["precision"] if row else None})
    ev["links"] = links

    # Le même jour ailleurs (dates connues au jour près)
    same = []
    if (r["precision"] or 0) >= 11:
        rows = con.execute("""SELECT * FROM events WHERE substr(date_raw,1,11) = substr(?,1,11) AND precision >= 11
                              AND qid != ? AND is_event = 1 ORDER BY sitelinks DESC LIMIT 15""",
                           (r["date_raw"], qid)).fetchall()
        sq = [x["qid"] for x in rows]
        st, sc = _texts(con, sq), _countries_of(con, sq)
        same = [_event_dict(x, st, sc) for x in rows]
    ev["same_day"] = same
    ev["wiki_count"] = con.execute("SELECT COUNT(*) FROM wiki_page WHERE qid=?", (qid,)).fetchone()[0]
    return {"event": ev}


def api_countries(con, q: dict) -> dict:
    params: list = []
    where = ""
    if "from" in q and "to" in q:
        where = "WHERE e.t_lo <= ? AND e.t_hi >= ?"
        params = [float(q["to"]), float(q["from"])]
    sql = f"""
        SELECT c.country AS qid, COUNT(*) AS n,
               (SELECT label FROM entity_label l WHERE l.qid = c.country AND l.lang='fr') AS fr,
               (SELECT label FROM entity_label l WHERE l.qid = c.country AND l.lang='en') AS en,
               (SELECT iso3 FROM country_info i WHERE i.qid = c.country) AS iso3
        FROM event_country c JOIN events e ON e.qid = c.qid {where}
        GROUP BY c.country ORDER BY n DESC LIMIT 400
    """
    return {"countries": [dict(r) for r in con.execute(sql, params)]}


def api_series(con, q: dict) -> dict:
    if "name" not in q:
        rows = con.execute("""SELECT m.*, MIN(p.t) AS t_min, MAX(p.t) AS t_max,
                                     SUM(p.entity = 'OWID_WRL') AS world_points
                              FROM series_meta m LEFT JOIN series_points p ON p.name = m.name
                              GROUP BY m.name ORDER BY m.name""")
        return {"series": [dict(r) for r in rows]}
    name = q["name"]
    meta = con.execute("SELECT * FROM series_meta WHERE name=?", (name,)).fetchone()
    entities = [e for e in q.get("entities", "OWID_WRL").split(",") if e]
    points: dict[str, list] = {e: [] for e in entities}
    for part in _chunks(entities):
        sql = f"SELECT entity, t, value FROM series_points WHERE name=? AND entity IN ({','.join('?' * len(part))}) ORDER BY t"
        for r in con.execute(sql, [name] + part):
            points[r["entity"]].append([r["t"], r["value"]])
    return {"meta": dict(meta) if meta else None, "points": points}


def api_search(con, q: dict) -> dict:
    term = q.get("q", "").strip()
    if len(term) < 2:
        return {"events": []}
    rows = con.execute("""
        SELECT DISTINCT e.* FROM events e JOIN event_text t ON t.qid = e.qid
        WHERE t.label LIKE ? ORDER BY e.is_event DESC, e.sitelinks DESC LIMIT 25
    """, (f"%{term}%",)).fetchall()
    qids = [r["qid"] for r in rows]
    texts, ctry = _texts(con, qids), _countries_of(con, qids)
    return {"events": [_event_dict(r, texts, ctry) for r in rows]}


def api_themes(con, q: dict) -> dict:
    counts = {(r[0], r[1]): r[2] for r in con.execute(
        "SELECT theme, subtheme, COUNT(*) FROM events WHERE is_event = 1 GROUP BY theme, subtheme")}
    themes = taxonomy_json()
    for t in themes:
        t["n"] = sum(v for (th, _), v in counts.items() if th == t["id"])
        for s in t["subs"]:
            s["n"] = counts.get((t["id"], s["id"]), 0)
    return {"themes": themes, "person_domains": person_domains_json()}


def api_stats(con, q: dict) -> dict:
    n, lo, hi = con.execute("SELECT COUNT(*), MIN(t_lo), MAX(t_lo) FROM events").fetchone()
    return {"events": n, "from": lo, "to": hi,
            "series": [r[0] for r in con.execute("SELECT name FROM series_meta")]}


# --- Personnes -------------------------------------------------------------------

def _now() -> float:
    n = datetime.now(timezone.utc)
    return fyear(n.year, n.month, n.day, n.hour)


def _person_dict(r, texts, countries) -> dict:
    return {
        "qid": r["qid"], "birth": r["t_birth"], "death": r["t_death"], "prec_birth": r["prec_birth"],
        "prec_death": r["prec_death"], "sitelinks": r["sitelinks"], "domain": r["domain"],
        "text": texts.get(r["qid"], {}), "countries": countries.get(r["qid"], []) or ["_"],
    }


def _person_countries(con, qids):
    out = {q: [] for q in qids}
    for part in _chunks(qids):
        for r in con.execute(f"SELECT qid, country FROM person_country WHERE qid IN ({','.join('?' * len(part))})", part):
            out[r["qid"]].append(r["country"])
    return out


def api_people(con, q: dict) -> dict:
    """Personnes vivantes pendant la période, les plus connues de chaque pays."""
    t_from, t_to = float(q["from"]), float(q["to"])
    per_lane = min(int(q.get("per_lane", 12)), 100)
    countries = [c for c in q.get("countries", "").split(",") if c]
    domains_off = [d for d in q.get("domains_off", "").split(",") if d]
    now = _now()
    # Sans date de décès connue : on suppose une vie de 100 ans au plus.
    where = ["p.t_birth <= ?", "COALESCE(p.t_death, MIN(p.t_birth + 100, ?)) >= ?"]
    params: list = [t_to, now, t_from]
    if countries:
        where.append(f"COALESCE(c.country, '_') IN ({','.join('?' * len(countries))})")
        params += countries
    if domains_off:
        where.append(f"p.domain NOT IN ({','.join('?' * len(domains_off))})")
        params += domains_off
    rows = con.execute(f"""
        SELECT * FROM (
            SELECT p.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(c.country, '_') ORDER BY p.sitelinks DESC) AS rk
            FROM person p LEFT JOIN person_country c ON c.qid = p.qid
            WHERE {' AND '.join(where)}
        ) WHERE rk <= ?""", params + [per_lane]).fetchall()
    qids = sorted({r["qid"] for r in rows})
    texts, ctry = _texts(con, qids), _person_countries(con, qids)
    seen, out = set(), []
    for r in rows:
        if r["qid"] not in seen:
            seen.add(r["qid"])
            out.append(_person_dict(r, texts, ctry))
    return {"people": out}


def api_person(con, q: dict) -> dict:
    qid = q.get("qid", "")
    r = con.execute("SELECT * FROM person WHERE qid=?", (qid,)).fetchone()
    if not r:
        return {"person": None}
    p = _person_dict(r, _texts(con, [qid], summary=True), _person_countries(con, [qid]))
    end = r["t_death"] if r["t_death"] is not None else _now()
    rows = con.execute("""SELECT * FROM person WHERE qid != ? AND t_birth <= ? AND COALESCE(t_death, t_birth + 100) >= ?
                          ORDER BY sitelinks DESC LIMIT 20""", (qid, end, r["t_birth"])).fetchall()
    cq = [x["qid"] for x in rows]
    ct, cc = _texts(con, cq), _person_countries(con, cq)
    p["contemporaries"] = [_person_dict(x, ct, cc) for x in rows]
    roles = con.execute("SELECT country, role, t0, t1 FROM office_term WHERE person=? ORDER BY t0", (qid,)).fetchall()
    labels = _labels(con, [x["country"] for x in roles])
    p["offices"] = [{**dict(x), "country_label": labels.get(x["country"], {})} for x in roles]
    return {"person": p}


# --- Gouvernants ----------------------------------------------------------------

def api_rulers(con, q: dict) -> dict:
    t_from, t_to = float(q["from"]), float(q["to"])
    countries = [c for c in q.get("countries", "").split(",") if c and c != "_"]
    if not countries:
        return {"terms": [], "states": []}
    marks = ",".join("?" * len(countries))
    now = _now()
    rows = con.execute(f"""SELECT * FROM office_term WHERE country IN ({marks}) AND t0 <= ?
                           AND COALESCE(t1, ?) >= ? ORDER BY t0""", countries + [t_to, now, t_from]).fetchall()
    persons = sorted({r["person"] for r in rows})
    labels, texts = _labels(con, persons), _texts(con, persons)
    terms = [{**dict(r), "labels": labels.get(r["person"]) or {l: v.get("label") for l, v in texts.get(r["person"], {}).items()}}
             for r in rows]
    states = [dict(r) for r in con.execute(f"SELECT * FROM country_state WHERE qid IN ({marks})", countries)]
    slabels = _labels(con, [s_["qid"] for s_ in states])
    for st in states:
        st["labels"] = slabels.get(st["qid"], {})
    return {"terms": terms, "states": states}


# --- Récits comparés : toutes les Wikipédias ------------------------------------

USER_AGENT = "Strata/0.3 (https://github.com/ergot-lef/strata; frise chronologique personnelle)"


def _fetch_intro(lang: str, title: str) -> tuple[str, int | None]:
    url = f"https://{lang}.wikipedia.org/w/api.php?" + urllib.parse.urlencode({
        "action": "query", "prop": "extracts|info", "exintro": 1, "explaintext": 1, "redirects": 1,
        "formatversion": 2, "format": "json", "titles": title,
    })
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())
    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return "", None
    text = " ".join((pages[0].get("extract") or "").split())
    if len(text) > 1500:
        text = text[:1500].rsplit(" ", 1)[0] + " …"
    return text, pages[0].get("length")


def api_compare(con, q: dict) -> dict:
    """Pages de toutes les Wikipédias sur un élément ; fetch=fr,ru,… télécharge les débuts manquants."""
    qid = q.get("qid", "")
    rows = {r["lang"]: dict(r) for r in con.execute("SELECT lang, title, summary, length FROM wiki_page WHERE qid=?", (qid,))}
    # Résumés déjà connus en FR/EN/DE
    for r in con.execute("SELECT lang, article, summary FROM event_text WHERE qid=? AND article IS NOT NULL", (qid,)):
        row = rows.setdefault(r["lang"], {"lang": r["lang"], "title": r["article"], "summary": None, "length": None})
        if not row.get("summary") and r["summary"]:
            row["summary"] = r["summary"]
    errors = []
    for lang in [x for x in q.get("fetch", "").split(",") if x][:15]:
        row = rows.get(lang)
        if not row or (row.get("summary") and row.get("length")):
            continue
        try:
            text, length = _fetch_intro(lang, row["title"])
        except Exception as e:  # noqa: BLE001 — pas de réseau, langue inconnue…
            errors.append(f"{lang} : {e}")
            continue
        row["summary"], row["length"] = text, length
        con.execute("INSERT OR REPLACE INTO wiki_page VALUES (?,?,?,?,?)", (qid, lang, row["title"], text, length))
        time.sleep(0.1)
    con.commit()
    return {"qid": qid, "pages": sorted(rows.values(), key=lambda r: r["lang"]), "errors": errors}


# --- Chaînes de causes et de conséquences ----------------------------------------

CAUSE_OUT = {"P828", "P1478"}           # A a pour cause B
EFFECT_OUT = {"P1542", "P1536"}         # A a pour conséquence B


def api_chain(con, q: dict) -> dict:
    """Remonte les causes (dir=causes) ou descend les conséquences (dir=consequences), en largeur."""
    root = q.get("qid", "")
    want_causes = q.get("dir", "causes") == "causes"
    depth = min(int(q.get("depth", 4)), 8)
    seen, nodes, frontier = {root}, [], [root]
    for level in range(1, depth + 1):
        nxt = []
        for cur in frontier:
            fwd = CAUSE_OUT if want_causes else EFFECT_OUT
            back = EFFECT_OUT if want_causes else CAUSE_OUT
            found = [t for (p, t) in con.execute("SELECT prop, target FROM event_link WHERE qid=?", (cur,)) if p in fwd]
            found += [s_ for (p, s_) in con.execute("SELECT prop, qid FROM event_link WHERE target=?", (cur,)) if p in back]
            for t in found:
                if t in seen:
                    continue
                seen.add(t)
                nodes.append({"qid": t, "parent": cur, "level": level})
                nxt.append(t)
        frontier = nxt[:60]
        if not frontier:
            break
    qids = [n["qid"] for n in nodes]
    texts, labels = _texts(con, qids), _labels(con, qids)
    rows = {r["qid"]: r for part in _chunks(qids)
            for r in con.execute(f"SELECT qid, t_lo, precision FROM events WHERE qid IN ({','.join('?' * len(part))})", part)}
    for n in nodes:
        n["labels"] = {l: v.get("label") for l, v in texts.get(n["qid"], {}).items()} or labels.get(n["qid"], {})
        r = rows.get(n["qid"])
        n["t0"], n["precision"] = (r["t_lo"], r["precision"]) if r else (None, None)
    return {"qid": root, "dir": "causes" if want_causes else "consequences", "nodes": nodes}


# --- Densité et angles morts ------------------------------------------------------

def api_density(con, q: dict) -> dict:
    """Nombre d'événements par intervalle de temps, pour chaque pays demandé."""
    t_from, t_to = float(q["from"]), float(q["to"])
    bins = max(10, min(int(q.get("bins", 120)), 400))
    countries = [c for c in q.get("countries", "").split(",") if c]
    width = (t_to - t_from) / bins
    out = {c: [0] * bins for c in countries}
    if countries and width > 0:
        marks = ",".join("?" * len(countries))
        for r in con.execute(f"""SELECT COALESCE(c.country,'_') AS c, CAST((e.t_lo - ?) / ? AS INTEGER) AS b, COUNT(*) AS n
                                 FROM events e LEFT JOIN event_country c ON c.qid = e.qid
                                 WHERE e.kind='event' AND e.t_lo >= ? AND e.t_lo < ? AND COALESCE(c.country,'_') IN ({marks})
                                 GROUP BY 1, 2""", [t_from, width, t_from, t_to] + countries):
            if 0 <= r["b"] < bins:
                out[r["c"]][r["b"]] = r["n"]
    return {"from": t_from, "to": t_to, "bins": bins, "counts": out}


def api_coverage(con, q: dict) -> dict:
    """Couverture par pays sur la période : événements et événements par million d'habitants."""
    t_from, t_to = float(q["from"]), float(q["to"])
    mid = (t_from + t_to) / 2
    rows = con.execute("""
        SELECT c.country AS qid, COUNT(*) AS n,
               (SELECT label FROM entity_label l WHERE l.qid = c.country AND l.lang='fr') AS fr,
               (SELECT label FROM entity_label l WHERE l.qid = c.country AND l.lang='en') AS en,
               (SELECT iso3 FROM country_info i WHERE i.qid = c.country) AS iso3
        FROM event_country c JOIN events e ON e.qid = c.qid
        WHERE e.kind='event' AND e.t_lo <= ? AND e.t_hi >= ?
        GROUP BY c.country ORDER BY n DESC LIMIT 150""", (t_to, t_from)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["population"] = None
        if r["iso3"]:
            p = con.execute("""SELECT value FROM series_points WHERE name='population' AND entity=?
                               ORDER BY ABS(t - ?) LIMIT 1""", (r["iso3"], mid)).fetchone()
            if p:
                d["population"] = p[0]
        d["per_million"] = d["n"] / (d["population"] / 1e6) if d["population"] else None
        out.append(d)
    return {"countries": out}


# --- Ce jour-là ----------------------------------------------------------------

def api_onthisday(con, q: dict) -> dict:
    m, d = int(q.get("m", 1)), int(q.get("d", 1))
    md = f"-{m:02d}-{d:02d}T"
    rows = con.execute("""SELECT * FROM events WHERE precision >= 11 AND kind != 'other' AND instr(date_raw, ?) > 0
                          ORDER BY sitelinks DESC LIMIT ?""", (md, int(q.get("limit", 60)))).fetchall()
    qids = [r["qid"] for r in rows]
    texts, ctry = _texts(con, qids), _countries_of(con, qids)
    events = sorted((_event_dict(r, texts, ctry) for r in rows), key=lambda e: e["t0"])
    prow = con.execute("""SELECT * FROM person WHERE prec_birth >= 11 AND instr(birth_raw, ?) > 0
                          ORDER BY sitelinks DESC LIMIT 20""", (md,)).fetchall()
    pq = [r["qid"] for r in prow]
    people = sorted((_person_dict(r, _texts(con, pq), _person_countries(con, pq)) for r in prow), key=lambda p: p["birth"])
    return {"m": m, "d": d, "events": events, "births": people}


# --- Frise personnelle -----------------------------------------------------------

def api_personal(con, q: dict) -> dict:
    return {"events": [dict(r) for r in con.execute("SELECT * FROM personal_event ORDER BY t0")]}


def personal_add(con, body: dict) -> dict:
    t0, title = float(body["t0"]), str(body["title"]).strip()[:200]
    if not title:
        raise ValueError("titre vide")
    t1 = float(body["t1"]) if body.get("t1") not in (None, "") else None
    cur = con.execute("INSERT INTO personal_event (t0, t1, date_raw, title, notes, created) VALUES (?,?,?,?,?,?)",
                      (t0, t1, str(body.get("date_raw", ""))[:40], title, str(body.get("notes", ""))[:4000],
                       datetime.now(timezone.utc).isoformat()))
    con.commit()
    return {"id": cur.lastrowid}


def personal_delete(con, body: dict) -> dict:
    con.execute("DELETE FROM personal_event WHERE id=?", (int(body["id"]),))
    con.commit()
    return {"ok": True}


ROUTES = {
    "/api/events": api_events, "/api/event": api_event, "/api/countries": api_countries,
    "/api/series": api_series, "/api/search": api_search, "/api/themes": api_themes, "/api/stats": api_stats,
    "/api/people": api_people, "/api/person": api_person, "/api/rulers": api_rulers, "/api/compare": api_compare,
    "/api/chain": api_chain, "/api/density": api_density, "/api/coverage": api_coverage,
    "/api/onthisday": api_onthisday, "/api/personal": api_personal,
}
POST_ROUTES = {"/api/personal/add": personal_add, "/api/personal/delete": personal_delete}


def make_handler(db_path: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(WEB_DIR), **kw)

        def log_message(self, fmt, *args):  # journal plus discret
            if not self.path.startswith("/api/"):
                return
            sys.stderr.write("%s\n" % (fmt % args))

        def end_headers(self):
            # Toujours la dernière version des fichiers de l'interface
            if not self.path.startswith("/api/"):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def _run(self, route, arg):
            try:
                con = connect(db_path)
                try:
                    return route(con, arg), 200
                finally:
                    con.close()
            except (KeyError, ValueError, TypeError) as e:
                return {"error": f"paramètre manquant ou invalide : {e}"}, 400

        def do_POST(self):
            url = urllib.parse.urlparse(self.path)
            route = POST_ROUTES.get(url.path)
            if route is None:
                self.send_error(404)
                return
            # Écriture réservée à ce poste : refuse les pages d'autres sites
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
                self.send_error(403)
                return
            try:
                length = min(int(self.headers.get("Content-Length") or 0), 100_000)
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                payload = None
            body, status = self._run(route, payload) if isinstance(payload, dict) else ({"error": "JSON invalide"}, 400)
            self._send_json(body, status)

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            route = ROUTES.get(url.path)
            if route is None:
                return super().do_GET()
            q = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query).items()}
            body, status = self._run(route, q)
            self._send_json(body, status)

        def _send_json(self, body, status):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def main() -> None:
    p = argparse.ArgumentParser(description="Serveur local Strata")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--db", default=str(DEFAULT_DB))
    args = p.parse_args()
    db_path = Path(args.db)
    connect(db_path).close()
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(db_path))
    print(f"Strata : http://{args.host}:{args.port}  (base : {db_path})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
