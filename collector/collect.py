#!/usr/bin/env python3
"""Collecteur Strata : remplit data/strata.db depuis Wikidata, Wikipédia et Our World in Data.

Exemples :
    python collector/collect.py events --from 1939 --to 1946
    python collector/collect.py events --from 1800 --to 2026 --min-sitelinks 10
    python collector/collect.py update                # relit les événements déjà en base (liens, thèmes, résumés)
    python collector/collect.py summaries             # résumés Wikipédia manquants
    python collector/collect.py series tout           # toutes les courbes prêtes à l'emploi
    python collector/collect.py series population     # une seule
    python collector/collect.py series ma_serie fichier.csv --label "…" --unit "…"
    python collector/collect.py stats

Méthode, en deux temps pour ménager le service public de Wikidata :
  1. une requête SPARQL légère liste les éléments datés d'une période
     (P585 « date » ou P580 « début »), via l'index des dates ;
  2. les détails (dates précises, types, pays, liens, titres FR/EN/DE)
     viennent de l'API classique de Wikidata (wbgetentities), par paquets
     de 50, et les résumés de l'API de chaque Wikipédia, par paquets de 20.
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
from strata.db import DEFAULT_DB, WORLD, connect  # noqa: E402
from strata.themes import classify_full  # noqa: E402
from strata.timeutil import fyear, parse_wikidata_time, span_for, to_xsd  # noqa: E402

SPARQL_URL = "https://query.wikidata.org/sparql"
API_URL = "https://www.wikidata.org/w/api.php"
USER_AGENT = f"Strata/{__version__} (https://github.com/ergot-lef/strata; frise chronologique personnelle)"
LANGS = ["fr", "en", "de"]
SUMMARY_CHARS = 900

# Liens entre éléments gardés pour la fiche détail et les fils sur la frise
LINK_PROPS = {
    "P828": "cause", "P1542": "consequence", "P1478": "cause", "P1536": "consequence",
    "P155": "precede", "P156": "suit", "P361": "partie_de", "P527": "comprend", "P793": "evenement",
}
MAX_LINKS_PER_PROP = 30

# Courbes prêtes à l'emploi (graphiques « grapher » d'Our World in Data)
OWID = "https://ourworldindata.org/grapher/{}.csv?csvType=full&useColumnShortNames=true"
SERIES_PRESETS = {
    "population": ("population", "Population", "hab."),
    "energie": ("primary-energy-cons", "Énergie primaire consommée", "TWh"),
    "petrole": ("oil-proved-reserves", "Réserves prouvées de pétrole", "m³"),
    "dette": ("gross-public-sector-debt-as-a-proportion-of-gdp", "Dette publique (administration centrale)", "% du PIB"),
    "depenses": ("historical-gov-spending-gdp", "Dépenses publiques", "% du PIB"),
    "pib": ("gdp-per-capita-maddison", "PIB par habitant", "$ (2011)"),
    "esperance": ("life-expectancy", "Espérance de vie à la naissance", "ans"),
}

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
            if url == SPARQL_URL and "timed out" in str(reason):
                raise Overloaded("délai dépassé") from e
            if attempt < tries:
                log(f"  réseau : {reason}, nouvel essai…")
                time.sleep(5 * attempt)
                continue
            raise
    raise RuntimeError("inaccessible")


def mw_api(url: str, params: dict) -> dict:
    """Appel à une API MediaWiki (Wikidata, Wikipédia) avec respect de maxlag."""
    for attempt in range(1, 7):
        data = json.loads(http_get(url, {**params, "format": "json", "maxlag": 5}))
        err = data.get("error", {})
        if err.get("code") == "maxlag" and attempt < 6:
            log("  serveur chargé (maxlag), attente 10 s…")
            time.sleep(10)
            continue
        if err:
            raise RuntimeError(f"API : {err.get('info', err)}")
        return data
    raise RuntimeError("API indisponible")


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
    """Éléments via l'API wbgetentities (pas le service SPARQL)."""
    out: dict[str, dict] = {}
    for i in range(0, len(qids), 50):
        batch = qids[i:i + 50]
        data = mw_api(API_URL, {"action": "wbgetentities", "ids": "|".join(batch),
                                "props": props, "languages": "|".join(LANGS)})
        out.update({k: v for k, v in data.get("entities", {}).items() if "missing" not in v})
        time.sleep(0.2)
    return out


# --- Lecture des déclarations Wikidata ------------------------------------

def _statements(ent: dict, prop: str) -> list[dict]:
    """Déclarations d'une propriété : rang « préféré » d'abord, « déprécié » écarté."""
    sts = [s for s in ent.get("claims", {}).get(prop, []) if s.get("rank") != "deprecated"]
    preferred = [s for s in sts if s.get("rank") == "preferred"]
    return preferred or sts


def _all_statements(ent: dict, prop: str) -> list[dict]:
    return [s for s in ent.get("claims", {}).get(prop, []) if s.get("rank") != "deprecated"]


def _item_ids(ent: dict, prop: str, every: bool = False) -> list[str]:
    out = []
    for s in (_all_statements if every else _statements)(ent, prop):
        v = s.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(v, dict) and "id" in v and v["id"] not in out:
            out.append(v["id"])
    return out


def _string(ent: dict, prop: str) -> str | None:
    for s in _statements(ent, prop):
        v = s.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(v, str):
            return v
    return None


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


def parse_entity(ent: dict, window: tuple[float, float] | None = None) -> dict | None:
    """Élément de l'API -> événement Strata (ou None s'il n'a pas de date).

    window : période collectée. Quand l'élément a plusieurs dates, on garde
    celle qui tombe dans cette période (c'est elle qui l'a fait sortir).
    """
    point, start, end = _times(ent, "P585"), _times(ent, "P580"), _times(ent, "P582")
    if window:
        a, b = window
        in_p = [d for d in point if a <= d[0] < b]
        in_s = [d for d in start if a <= d[0] < b]
        if in_p or in_s:
            point, start = in_p, in_s
    dates = point or start
    if not dates:
        return None
    # La date la plus précise, puis la plus ancienne.
    t, prec, raw = sorted(dates, key=lambda d: (-d[1], d[0]))[0]
    t_end = end_raw = None
    if not point and end:
        after = [d for d in end if d[0] >= t] or end
        t_end, _, end_raw = min(after, key=lambda d: d[0])
    links = []
    for prop in LINK_PROPS:
        links += [(prop, q) for q in _item_ids(ent, prop, every=True)[:MAX_LINKS_PER_PROP] if q != ent["id"]]
    return {
        "qid": ent["id"], "t": t, "prec": prec, "raw": raw, "end": t_end, "end_raw": end_raw,
        "sl": len(ent.get("sitelinks", {})),
        "types": _item_ids(ent, "P31"), "countries": _item_ids(ent, "P17"), "places": _item_ids(ent, "P276"),
        "links": links,
        "labels": {l: ent.get("labels", {}).get(l, {}).get("value") for l in LANGS},
        "descr": {l: ent.get("descriptions", {}).get(l, {}).get("value") for l in LANGS},
        "articles": {l: ent.get("sitelinks", {}).get(f"{l}wiki", {}).get("title") for l in LANGS},
    }


# --- Enregistrement -----------------------------------------------------------

def _cached(con, table: str, qids: set[str]) -> set[str]:
    out: set[str] = set()
    qlist = list(qids)
    for i in range(0, len(qlist), 500):
        part = qlist[i:i + 500]
        marks = ",".join("?" * len(part))
        out |= {r[0] for r in con.execute(f"SELECT DISTINCT qid FROM {table} WHERE qid IN ({marks})", part)}
    return out


def resolve_places(con, places: set[str]) -> dict[str, list[str]]:
    """Pays (P17) des lieux (P276), avec cache dans place_country."""
    missing = sorted(places - _cached(con, "place_country", places))
    if missing:
        for qid, ent in fetch_entities(missing, "claims").items():
            cs = _item_ids(ent, "P17") or ["-"]
            con.executemany("INSERT OR IGNORE INTO place_country VALUES (?,?)", [(qid, c) for c in cs])
        for qid in missing:  # éléments supprimés de Wikidata
            con.execute("INSERT OR IGNORE INTO place_country VALUES (?, '-')", (qid,))
    out: dict[str, list[str]] = {}
    plist = list(places)
    for i in range(0, len(plist), 500):
        part = plist[i:i + 500]
        marks = ",".join("?" * len(part))
        for r in con.execute(f"SELECT qid, country FROM place_country WHERE qid IN ({marks})", part):
            if r[1] != "-":
                out.setdefault(r[0], []).append(r[1])
    return out


def store_labels(con, qids: set[str], countries: set[str]) -> None:
    """Libellés (et code ISO pour les pays) des éléments pas encore en cache."""
    need_label = qids - _cached(con, "entity_label", qids)
    need_iso = countries - _cached(con, "country_info", countries)
    todo = sorted(need_label | need_iso)
    if not todo:
        return
    for qid, ent in fetch_entities(todo, "labels|claims").items():
        for lang in LANGS:
            label = ent.get("labels", {}).get(lang, {}).get("value")
            if label:
                con.execute("INSERT OR REPLACE INTO entity_label VALUES (?,?,?)", (qid, lang, label))
        if qid in countries:
            con.execute("INSERT OR REPLACE INTO country_info VALUES (?,?)", (qid, _string(ent, "P298")))


def save_events(con, events: list[dict]) -> int:
    if not events:
        return 0
    place_map = resolve_places(con, {p for e in events if not e["countries"] for p in e["places"]})
    for e in events:
        if not e["countries"]:
            e["countries"] = sorted({c for p in e["places"] for c in place_map.get(p, [])})
    countries = {c for e in events for c in e["countries"]}
    targets = {q for e in events for _, q in e["links"]}
    store_labels(con, {q for e in events for q in e["types"]} | countries | targets, countries)

    for ev in events:
        qid = ev["qid"]
        type_labels = [r[0] for r in con.execute(
            "SELECT label FROM entity_label WHERE lang='en' AND qid IN (%s)" % ",".join("?" * len(ev["types"])),
            ev["types"])] if ev["types"] else []
        theme, sub, is_event = classify_full(type_labels)
        is_span = 1 if ev["end"] is not None and ev["end"] > ev["t"] else 0
        t_hi = ev["end"] if is_span else ev["t"] + span_for(ev["prec"])
        con.execute(
            """INSERT OR REPLACE INTO events
               (qid, t_lo, t_hi, precision, is_span, date_raw, end_raw, sitelinks, theme, subtheme, is_event)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (qid, ev["t"], t_hi, ev["prec"], is_span, ev["raw"], ev["end_raw"], ev["sl"], theme, sub, is_event),
        )
        con.execute("DELETE FROM event_country WHERE qid=?", (qid,))
        con.executemany("INSERT OR IGNORE INTO event_country VALUES (?,?)", [(qid, c) for c in ev["countries"]])
        con.execute("DELETE FROM event_type WHERE qid=?", (qid,))
        con.executemany("INSERT OR IGNORE INTO event_type VALUES (?,?)", [(qid, t) for t in ev["types"]])
        con.execute("DELETE FROM event_link WHERE qid=?", (qid,))
        con.executemany("INSERT OR IGNORE INTO event_link VALUES (?,?,?)", [(qid, p, q) for p, q in ev["links"]])
        for lang in LANGS:
            label, descr, article = ev["labels"].get(lang), ev["descr"].get(lang), ev["articles"].get(lang)
            if label or article:
                old = con.execute("SELECT article, summary FROM event_text WHERE qid=? AND lang=?", (qid, lang)).fetchone()
                summary = old["summary"] if old and old["article"] == article else None
                con.execute("INSERT OR REPLACE INTO event_text (qid, lang, label, descr, article, summary) VALUES (?,?,?,?,?,?)",
                            (qid, lang, label, descr, article, summary))
    con.commit()
    return len(events)


# --- Résumés Wikipédia ------------------------------------------------------------

def fetch_summaries(con, qids: list[str] | None = None) -> int:
    """Premières lignes de chaque article (FR, EN, DE), pour la fiche détail."""
    done = 0
    for lang in LANGS:
        sql = "SELECT qid, article FROM event_text WHERE lang=? AND article IS NOT NULL AND summary IS NULL"
        rows = con.execute(sql, (lang,)).fetchall()
        if qids is not None:
            wanted = set(qids)
            rows = [r for r in rows if r["qid"] in wanted]
        for i in range(0, len(rows), 20):  # l'API donne 20 introductions par appel
            part = rows[i:i + 20]
            data = mw_api(f"https://{lang}.wikipedia.org/w/api.php", {
                "action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1, "exlimit": 20,
                "redirects": 1, "formatversion": 2, "titles": "|".join(r["article"] for r in part),
            })
            q = data.get("query", {})
            alias = {}
            for m in q.get("normalized", []) + q.get("redirects", []):
                alias[m["from"]] = m["to"]
            extracts = {p["title"]: p.get("extract", "") for p in q.get("pages", [])}
            for r in part:
                title = r["article"]
                while title in alias:
                    title = alias[title]
                text = " ".join((extracts.get(title) or "").split())
                if len(text) > SUMMARY_CHARS:
                    cut = text[:SUMMARY_CHARS].rsplit(" ", 1)[0]
                    text = cut + " …"
                con.execute("UPDATE event_text SET summary=? WHERE qid=? AND lang=?", (text, r["qid"], lang))
                done += 1
            con.commit()
            time.sleep(0.2)
    return done


# --- Commandes ----------------------------------------------------------------------

def collect_period(con, t_a: float, t_b: float, min_sl: int, summaries: bool = True) -> int:
    qids = list_qids(t_a, t_b, min_sl)
    if not qids:
        return 0
    events = [ev for ent in fetch_entities(qids).values() if (ev := parse_entity(ent, (t_a, t_b)))]
    n = save_events(con, events)
    if summaries:
        fetch_summaries(con, [e["qid"] for e in events])
    return n


def cmd_events(args) -> None:
    con = connect(args.db)
    total = 0
    for year in range(args.start, args.stop):
        chunk = f"events:{year}:{args.min_sitelinks}"
        if not args.force and con.execute("SELECT 1 FROM collected WHERE chunk=?", (chunk,)).fetchone():
            log(f"{year} : déjà collecté (--force pour refaire)")
            continue
        try:
            n = collect_period(con, fyear(year), fyear(year + 1), args.min_sitelinks, not args.no_summaries)
        except Exception as e:  # noqa: BLE001 — on passe à l'année suivante
            log(f"{year} : échec ({e}). Relance plus tard : les années réussies sont gardées.")
            continue
        con.execute("INSERT OR REPLACE INTO collected VALUES (?,?)", (chunk, datetime.now(timezone.utc).isoformat()))
        con.commit()
        total += n
        log(f"{year} : {n} événements")
        time.sleep(2)  # politesse envers le service public de Wikidata
    log(f"Terminé : {total} événements ajoutés ou mis à jour.")


def cmd_update(args) -> None:
    """Relit par l'API les événements déjà en base, sans le service SPARQL :
    liens, sous-thèmes, tri des non-événements, codes pays, résumés."""
    con = connect(args.db)
    rows = con.execute("SELECT qid, t_lo, precision FROM events ORDER BY t_lo").fetchall()
    log(f"Mise à jour de {len(rows)} éléments…")
    for i in range(0, len(rows), 200):
        part = rows[i:i + 200]
        ents = fetch_entities([r["qid"] for r in part])
        events = []
        for r in part:
            ent = ents.get(r["qid"])
            if not ent:
                continue
            w = span_for(r["precision"]) + 1e-6
            ev = parse_entity(ent, (r["t_lo"] - 1e-6, r["t_lo"] + w))
            if ev:
                events.append(ev)
        save_events(con, events)
        log(f"  {min(i + 200, len(rows))}/{len(rows)}")
    if not args.no_summaries:
        log(f"Résumés Wikipédia : {fetch_summaries(con)} ajoutés.")
    log("Terminé.")


def cmd_summaries(args) -> None:
    con = connect(args.db)
    log(f"Résumés Wikipédia : {fetch_summaries(con)} ajoutés.")


def read_series_csv(text: str, entity: str | None = None) -> list[tuple[str, float, float]]:
    """CSV « grapher » d'Our World in Data -> [(entité, année, valeur)].

    L'entité est le code ISO à 3 lettres (OWID_WRL pour le Monde) ou, à
    défaut, le nom. entity=None garde toutes les lignes.
    """
    reader = csv.DictReader(io.StringIO(text))
    cols = reader.fieldnames or []
    low = {c.lower(): c for c in cols}
    ent_col, code_col = low.get("entity"), low.get("code")
    year_col = next((low[c] for c in ("year", "day", "date") if c in low), None)
    skip = {ent_col, code_col, year_col}
    value_col = next((c for c in cols if c not in skip and not c.endswith("__annotations")), None)
    if not ent_col or not year_col or not value_col:
        raise ValueError(f"colonnes inattendues : {cols}")
    points = []
    for row in reader:
        name, code = row.get(ent_col, ""), (row.get(code_col) or "").strip() if code_col else ""
        key = code or name
        if entity and entity not in (name, code):
            continue
        raw = (row.get(value_col) or "").strip()
        if not raw:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        y = row[year_col]
        year = float(y[:4]) + (int(y[5:7]) - 1) / 12 if "-" in y[1:] else float(y)
        points.append((key, year, value))
    return points


def load_series(con, name: str, source: str, label: str, unit: str, entity: str | None = None) -> None:
    text = http_get(source, {}, "text/csv").decode("utf-8") if source.startswith("http") \
        else Path(source).read_text(encoding="utf-8")
    points = read_series_csv(text, entity)
    if not points:
        raise ValueError(f"aucune donnée utilisable dans {source}")
    con.execute("DELETE FROM series_points WHERE name=?", (name,))
    con.executemany("INSERT OR REPLACE INTO series_points VALUES (?,?,?,?)", [(name, e, t, v) for e, t, v in points])
    con.execute("INSERT OR REPLACE INTO series_meta VALUES (?,?,?,?)", (name, label or name, unit, source))
    con.commit()
    ents = {e for e, _, _ in points}
    years = [t for _, t, _ in points]
    log(f"Série « {label or name} » : {len(points)} points, {len(ents)} pays/zones, {min(years):.0f} → {max(years):.0f}"
        + ("" if WORLD in ents or entity else " (pas de total mondial)"))


def cmd_series(args) -> None:
    con = connect(args.db)
    if args.source is None:
        names = list(SERIES_PRESETS) if args.name in ("tout", "all") else [args.name]
        for n in names:
            if n not in SERIES_PRESETS:
                sys.exit(f"Série inconnue « {n} ». Prêtes à l'emploi : {', '.join(SERIES_PRESETS)} (ou « tout »)")
            slug, label, unit = SERIES_PRESETS[n]
            try:
                load_series(con, n, OWID.format(slug), args.label or label, args.unit or unit)
            except Exception as e:  # noqa: BLE001
                log(f"Série « {n} » : échec ({e})")
        return
    load_series(con, args.name, args.source, args.label, args.unit or "", args.entity)


def cmd_stats(args) -> None:
    con = connect(args.db)
    n = con.execute("SELECT COUNT(*), MIN(t_lo), MAX(t_lo), SUM(is_event=0) FROM events").fetchone()
    log(f"Éléments : {n[0]}" + (f" ({n[1]:.0f} → {n[2]:.0f}), dont {n[3]} hors événements" if n[0] else ""))
    for r in con.execute("SELECT theme, COUNT(*) FROM events WHERE is_event=1 GROUP BY theme ORDER BY 2 DESC"):
        log(f"  {r[0]:<12} {r[1]}")
    s = con.execute("SELECT COUNT(*), SUM(summary IS NOT NULL AND summary != '') FROM event_text WHERE article IS NOT NULL").fetchone()
    log(f"Résumés Wikipédia : {s[1] or 0}/{s[0]}")
    log(f"Liens entre éléments : {con.execute('SELECT COUNT(*) FROM event_link').fetchone()[0]}")
    for r in con.execute("SELECT m.name, m.label, COUNT(*), COUNT(DISTINCT p.entity) FROM series_meta m "
                         "JOIN series_points p ON p.name = m.name GROUP BY m.name"):
        log(f"Série {r[0]} ({r[1]}) : {r[2]} points, {r[3]} pays/zones")


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
    e.add_argument("--no-summaries", action="store_true", help="ne pas télécharger les résumés Wikipédia")
    e.set_defaults(func=cmd_events)

    u = sub.add_parser("update", help="relire les événements en base (liens, thèmes, résumés)")
    u.add_argument("--no-summaries", action="store_true", help="ne pas télécharger les résumés Wikipédia")
    u.set_defaults(func=cmd_update)

    sm = sub.add_parser("summaries", help="télécharger les résumés Wikipédia manquants")
    sm.set_defaults(func=cmd_summaries)

    s = sub.add_parser("series", help="courbes de fond (Our World in Data)")
    s.add_argument("name", help=f"nom : {', '.join(SERIES_PRESETS)}, « tout », ou un nom libre avec une source")
    s.add_argument("source", nargs="?", help="URL ou fichier CSV (facultatif pour les séries prêtes à l'emploi)")
    s.add_argument("--entity", help="ne garder qu'un pays/zone (défaut : tous)")
    s.add_argument("--label", help="libellé affiché")
    s.add_argument("--unit", help="unité affichée")
    s.set_defaults(func=cmd_series)

    st = sub.add_parser("stats", help="résumé du contenu de la base")
    st.set_defaults(func=cmd_stats)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
