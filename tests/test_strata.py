"""Tests sans réseau : python -m unittest discover tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collector"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import collect  # noqa: E402
import server  # noqa: E402
from strata.db import connect  # noqa: E402
from strata.themes import classify  # noqa: E402
from strata.timeutil import fyear, parse_wikidata_time  # noqa: E402


def lit(v):
    return {"type": "literal", "value": v}


def uri(q):
    return {"type": "uri", "value": f"http://www.wikidata.org/entity/{q}"}


class TimeTests(unittest.TestCase):
    def test_parse(self):
        self.assertAlmostEqual(parse_wikidata_time("1945-05-08T00:00:00Z"), fyear(1945, 5, 8))
        self.assertAlmostEqual(parse_wikidata_time("-0499-01-01T00:00:00Z"), -499.0)
        self.assertIsNone(parse_wikidata_time("n'importe quoi"))

    def test_order(self):
        self.assertLess(fyear(1945, 5, 7), fyear(1945, 5, 8))
        self.assertLess(fyear(2024, 12, 31, 23), 2025)

    def test_year_bound(self):
        self.assertEqual(collect.year_bound(1945), "1945-01-01T00:00:00Z")
        self.assertEqual(collect.year_bound(-500), "-0500-01-01T00:00:00Z")


class ThemeTests(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify(["battle"]), "guerre")
        self.assertEqual(classify(["general election"]), "politique")
        self.assertEqual(classify(["military occupation"]), "guerre")  # pas « cup » → sport
        self.assertEqual(classify(["human"]), "autre")


class ParseEntityTests(unittest.TestCase):
    def test_best_date_countries_texts(self):
        def tv(t, p, rank="normal"):
            return {"rank": rank, "mainsnak": {"datavalue": {"value": {"time": t, "precision": p}}}}

        def item(q):
            return {"rank": "normal", "mainsnak": {"datavalue": {"value": {"id": q}}}}

        ent = {
            "id": "Q1",
            "claims": {
                "P585": [tv("+1945-00-00T00:00:00Z", 9), tv("+1945-05-08T00:00:00Z", 11),
                         tv("+1900-01-01T00:00:00Z", 11, "deprecated")],
                "P31": [item("Q10")], "P17": [item("Q142"), item("Q30")],
            },
            "labels": {"fr": {"value": "Test A"}},
            "sitelinks": {"frwiki": {"title": "Article A"}, "enwiki": {"title": "A"}},
        }
        ev = collect.parse_entity(ent)
        self.assertEqual(ev["prec"], 11)
        self.assertAlmostEqual(ev["t"], fyear(1945, 5, 8))
        self.assertEqual(ev["countries"], ["Q142", "Q30"])
        self.assertEqual(ev["sl"], 2)
        self.assertEqual(ev["labels"]["fr"], "Test A")
        self.assertEqual(ev["articles"]["fr"], "Article A")

    def test_span_and_bce(self):
        def tv(t, p):
            return {"rank": "normal", "mainsnak": {"datavalue": {"value": {"time": t, "precision": p}}}}

        ent = {"id": "Q2", "claims": {"P580": [tv("-0500-00-00T00:00:00Z", 9)], "P582": [tv("-0450-00-00T00:00:00Z", 9)]}}
        ev = collect.parse_entity(ent)
        self.assertAlmostEqual(ev["t"], -499.0)   # 500 av. J.-C.
        self.assertAlmostEqual(ev["end"], -449.0)
        self.assertIsNone(collect.parse_entity({"id": "Q3", "claims": {}}))

    def test_window_picks_matching_date(self):
        def tv(t, p):
            return {"rank": "normal", "mainsnak": {"datavalue": {"value": {"time": t, "precision": p}}}}

        ent = {"id": "Q4", "claims": {"P580": [tv("+1898-00-00T00:00:00Z", 9), tv("+1945-03-01T00:00:00Z", 11)],
                                      "P582": [tv("+1900-00-00T00:00:00Z", 9), tv("+1946-00-00T00:00:00Z", 9)]}}
        ev = collect.parse_entity(ent, (1945.0, 1946.0))
        self.assertAlmostEqual(ev["t"], fyear(1945, 3, 1))
        self.assertAlmostEqual(ev["end"], 1946.0)

    def test_xsd_bounds(self):
        from strata.timeutil import to_xsd
        self.assertEqual(to_xsd(fyear(1945, 5, 8, 15)), "1945-05-08T15:00:00Z")
        self.assertEqual(to_xsd(fyear(1946) - 1e-9), "1946-01-01T00:00:00Z")

    def test_series_csv(self):
        text = "Entity,Code,Year,population\nFrance,FRA,1950,41800000\nWorld,OWID_WRL,1950,2500000000\nWorld,OWID_WRL,1960,3000000000\n"
        self.assertEqual(collect.read_series_csv(text, "World"), [("OWID_WRL", 1950.0, 2.5e9), ("OWID_WRL", 1960.0, 3.0e9)])
        short = "entity,code,year,gdp,gdp__annotations\nFrance,FRA,1950,5000,note\nUSSR,,1950,3000,\n"
        self.assertEqual(collect.read_series_csv(short), [("FRA", 1950.0, 5000.0), ("USSR", 1950.0, 3000.0)])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.con = connect(Path(self.tmp.name) / "t.db")
        c = self.con
        t = fyear(1945, 5, 8)
        cols = "(qid, t_lo, t_hi, precision, is_span, date_raw, end_raw, sitelinks, theme, subtheme, is_event)"
        d = "+1945-05-08T00:00:00Z"
        c.execute(f"INSERT INTO events {cols} VALUES ('Q1',?,?,11,0,?,NULL,40,'guerre','bataille',1)", (t, t + 1 / 365.25, d))
        c.execute(f"INSERT INTO events {cols} VALUES ('Q2',?,?,11,0,?,NULL,5,'politique','election',1)", (t, t + 1 / 365.25, d))
        c.execute(f"INSERT INTO events {cols} VALUES ('Q3',?,?,11,0,?,NULL,9,'autre','',1)", (t, t + 1 / 365.25, d))
        c.execute(f"INSERT INTO events {cols} VALUES ('Q4',1800.0,1801.0,9,0,'d',NULL,9,'autre','',1)")
        c.execute(f"INSERT INTO events {cols} VALUES ('Q5',?,?,11,0,?,NULL,99,'autre','',0)", (t, t + 1 / 365.25, d))
        c.execute("INSERT INTO event_link VALUES ('Q1','P828','Q2')")
        c.executemany("INSERT INTO event_country VALUES (?,?)", [("Q1", "Q142"), ("Q1", "Q30"), ("Q2", "Q142")])
        c.executemany("INSERT INTO event_text (qid, lang, label, descr, article) VALUES (?,?,?,?,?)", [
            ("Q1", "fr", "Événement test A", "desc", "Article A"), ("Q2", "fr", "Événement test B", None, None),
        ])
        c.execute("INSERT INTO entity_label VALUES ('Q142','fr','France')")
        c.commit()

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def test_events_range_and_lanes(self):
        d = server.api_events(self.con, {"from": "1945.0", "to": "1946.0", "countries": "Q142,_"})
        qids = {e["qid"] for e in d["events"]}
        self.assertEqual(qids, {"Q1", "Q2", "Q3"})  # Q3 sans pays -> couloir « _ »
        q3 = next(e for e in d["events"] if e["qid"] == "Q3")
        self.assertEqual(q3["countries"], ["_"])

    def test_per_lane_limit(self):
        d = server.api_events(self.con, {"from": "1945.0", "to": "1946.0", "countries": "Q142", "per_lane": "1"})
        self.assertEqual([e["qid"] for e in d["events"]], ["Q1"])

    def test_themes_filter(self):
        d = server.api_events(self.con, {"from": "1945.0", "to": "1946.0", "countries": "Q142", "themes": "politique"})
        self.assertEqual([e["qid"] for e in d["events"]], ["Q2"])

    def test_non_events_hidden_and_subthemes(self):
        d = server.api_events(self.con, {"from": "1945.0", "to": "1946.0", "countries": "_"})
        self.assertNotIn("Q5", {e["qid"] for e in d["events"]})
        d = server.api_events(self.con, {"from": "1945.0", "to": "1946.0", "countries": "_", "include_other": "1"})
        self.assertIn("Q5", {e["qid"] for e in d["events"]})
        d = server.api_events(self.con, {"from": "1945.0", "to": "1946.0", "countries": "Q142", "sub_off": "guerre.bataille"})
        self.assertEqual([e["qid"] for e in d["events"]], ["Q2"])

    def test_event_detail_links_and_same_day(self):
        ev = server.api_event(self.con, {"qid": "Q2"})["event"]
        self.assertEqual([(l["kind"], l["qid"]) for l in ev["links"]], [("consequence", "Q1")])
        self.assertIn("Q1", {e["qid"] for e in ev["same_day"]})
        self.assertNotIn("Q5", {e["qid"] for e in ev["same_day"]})

    def test_migration_from_v01(self):
        import sqlite3
        path = Path(self.tmp.name) / "old.db"
        old = sqlite3.connect(path)
        old.executescript("""CREATE TABLE events (qid TEXT PRIMARY KEY, t_lo REAL NOT NULL, t_hi REAL NOT NULL,
            precision INTEGER, is_span INTEGER NOT NULL DEFAULT 0, date_raw TEXT, end_raw TEXT,
            sitelinks INTEGER NOT NULL DEFAULT 0, theme TEXT NOT NULL DEFAULT 'autre');
            CREATE TABLE event_text (qid TEXT, lang TEXT, label TEXT, descr TEXT, article TEXT, PRIMARY KEY (qid, lang));
            CREATE TABLE series (name TEXT, t REAL, value REAL, PRIMARY KEY (name, t));
            INSERT INTO series VALUES ('population', 1950, 2.5e9);""")
        old.close()
        con = connect(path)
        self.assertEqual(con.execute("SELECT entity FROM series_points").fetchone()[0], "OWID_WRL")
        self.assertIn("summary", {r[1] for r in con.execute("PRAGMA table_info(event_text)")})
        con.close()

    def test_search_and_countries(self):
        self.assertEqual(len(server.api_search(self.con, {"q": "test"})["events"]), 2)
        c = server.api_countries(self.con, {})["countries"]
        self.assertEqual(c[0]["qid"], "Q142")
        self.assertEqual(c[0]["fr"], "France")


if __name__ == "__main__":
    unittest.main()
