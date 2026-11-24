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
import sqlite3
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from strata.db import DEFAULT_DB, ROOT, connect  # noqa: E402
from strata.themes import taxonomy_json  # noqa: E402
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
    if q.get("include_other") != "1":
        where.append("e.is_event = 1")
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
    return {"themes": themes}


def api_stats(con, q: dict) -> dict:
    n, lo, hi = con.execute("SELECT COUNT(*), MIN(t_lo), MAX(t_lo) FROM events").fetchone()
    return {"events": n, "from": lo, "to": hi,
            "series": [r[0] for r in con.execute("SELECT name FROM series_meta")]}


ROUTES = {
    "/api/events": api_events, "/api/event": api_event, "/api/countries": api_countries,
    "/api/series": api_series, "/api/search": api_search, "/api/themes": api_themes, "/api/stats": api_stats,
}


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

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            route = ROUTES.get(url.path)
            if route is None:
                return super().do_GET()
            q = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query).items()}
            try:
                con = connect(db_path)
                try:
                    body, status = route(con, q), 200
                finally:
                    con.close()
            except (KeyError, ValueError) as e:
                body, status = {"error": f"paramètre manquant ou invalide : {e}"}, 400
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
