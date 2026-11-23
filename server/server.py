#!/usr/bin/env python3
"""Serveur local Strata : sert l'interface web/ et une petite API JSON.

    python server/server.py            # http://localhost:8765
    python server/server.py --port 9000 --db data/strata.db

API :
    GET /api/events?from=1945.0&to=1945.5&countries=Q142,Q30&per_lane=25
    GET /api/countries?from=1945.0&to=1945.5
    GET /api/series                 (liste)   /api/series?name=population
    GET /api/search?q=hiroshima
    GET /api/event?qid=Q...
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
from strata.timeutil import PRECISION_NAMES  # noqa: E402

WEB_DIR = ROOT / "web"
LANGS = ("fr", "en", "de")


def _texts(con: sqlite3.Connection, qids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {q: {} for q in qids}
    for i in range(0, len(qids), 500):
        part = qids[i:i + 500]
        sql = "SELECT qid, lang, label, descr, article FROM event_text WHERE qid IN (%s)" % ",".join("?" * len(part))
        for r in con.execute(sql, part):
            out[r["qid"]][r["lang"]] = {"label": r["label"], "descr": r["descr"], "article": r["article"]}
    return out


def _countries_of(con: sqlite3.Connection, qids: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {q: [] for q in qids}
    for i in range(0, len(qids), 500):
        part = qids[i:i + 500]
        sql = "SELECT qid, country FROM event_country WHERE qid IN (%s)" % ",".join("?" * len(part))
        for r in con.execute(sql, part):
            out[r["qid"]].append(r["country"])
    return out


def _event_dict(r: sqlite3.Row, texts: dict, countries: dict) -> dict:
    return {
        "qid": r["qid"], "t0": r["t_lo"], "t1": r["t_hi"], "precision": r["precision"],
        "precision_name": PRECISION_NAMES.get(r["precision"], ""), "span": bool(r["is_span"]),
        "date": r["date_raw"], "end": r["end_raw"], "sitelinks": r["sitelinks"], "theme": r["theme"],
        "text": texts.get(r["qid"], {}), "countries": countries.get(r["qid"], []),
    }


def api_events(con, q: dict) -> dict:
    t_from, t_to = float(q["from"]), float(q["to"])
    per_lane = min(int(q.get("per_lane", 25)), 200)
    themes = [t for t in q.get("themes", "").split(",") if t]
    countries = [c for c in q.get("countries", "").split(",") if c]
    where = ["e.t_lo <= ?", "e.t_hi >= ?"]
    params: list = [t_to, t_from]
    if themes:
        where.append("e.theme IN (%s)" % ",".join("?" * len(themes)))
        params += themes
    if countries:
        where.append("COALESCE(c.country, '_') IN (%s)" % ",".join("?" * len(countries)))
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
    qids = sorted({r["qid"] for r in rows})
    texts, ctry = _texts(con, qids), _countries_of(con, qids)
    seen, events = set(), []
    for r in rows:
        if r["qid"] not in seen:
            seen.add(r["qid"])
            d = _event_dict(r, texts, ctry)
            if not d["countries"]:
                d["countries"] = ["_"]
            events.append(d)
    return {"events": events}


def api_countries(con, q: dict) -> dict:
    params: list = []
    where = ""
    if "from" in q and "to" in q:
        where = "WHERE e.t_lo <= ? AND e.t_hi >= ?"
        params = [float(q["to"]), float(q["from"])]
    sql = f"""
        SELECT c.country AS qid, COUNT(*) AS n,
               (SELECT label FROM entity_label l WHERE l.qid = c.country AND l.lang='fr') AS fr,
               (SELECT label FROM entity_label l WHERE l.qid = c.country AND l.lang='en') AS en
        FROM event_country c JOIN events e ON e.qid = c.qid {where}
        GROUP BY c.country ORDER BY n DESC LIMIT 300
    """
    return {"countries": [dict(r) for r in con.execute(sql, params)]}


def api_series(con, q: dict) -> dict:
    if "name" not in q:
        return {"series": [dict(r) for r in con.execute("SELECT * FROM series_meta ORDER BY name")]}
    meta = con.execute("SELECT * FROM series_meta WHERE name=?", (q["name"],)).fetchone()
    pts = [[r["t"], r["value"]] for r in con.execute("SELECT t, value FROM series WHERE name=? ORDER BY t", (q["name"],))]
    return {"meta": dict(meta) if meta else None, "points": pts}


def api_search(con, q: dict) -> dict:
    term = q.get("q", "").strip()
    if len(term) < 2:
        return {"events": []}
    rows = con.execute("""
        SELECT DISTINCT e.* FROM events e JOIN event_text t ON t.qid = e.qid
        WHERE t.label LIKE ? ORDER BY e.sitelinks DESC LIMIT 25
    """, (f"%{term}%",)).fetchall()
    qids = [r["qid"] for r in rows]
    texts, ctry = _texts(con, qids), _countries_of(con, qids)
    return {"events": [_event_dict(r, texts, ctry) for r in rows]}


def api_event(con, q: dict) -> dict:
    r = con.execute("SELECT * FROM events WHERE qid=?", (q.get("qid", ""),)).fetchone()
    if not r:
        return {"event": None}
    return {"event": _event_dict(r, _texts(con, [r["qid"]]), _countries_of(con, [r["qid"]]))}


def api_stats(con, q: dict) -> dict:
    n, lo, hi = con.execute("SELECT COUNT(*), MIN(t_lo), MAX(t_lo) FROM events").fetchone()
    return {"events": n, "from": lo, "to": hi,
            "series": [r[0] for r in con.execute("SELECT name FROM series_meta")]}


ROUTES = {
    "/api/events": api_events, "/api/countries": api_countries, "/api/series": api_series,
    "/api/search": api_search, "/api/event": api_event, "/api/stats": api_stats,
}


def make_handler(db_path: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(WEB_DIR), **kw)

        def log_message(self, fmt, *args):  # journal plus discret
            if not self.path.startswith("/api/"):
                return
            sys.stderr.write("%s\n" % (fmt % args))

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
