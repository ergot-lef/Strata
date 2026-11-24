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

    def test_xsd_bounds(self):
        from strata.timeutil import to_xsd
        self.assertEqual(to_xsd(fyear(1945, 5, 8, 15)), "1945-05-08T15:00:00Z")
        self.assertEqual(to_xsd(fyear(1946) - 1e-9), "1946-01-01T00:00:00Z")

    def test_series_csv(self):
        text = "Entity,Code,Year,population\nFrance,FRA,1950,41800000\nWorld,OWID_WRL,1950,2500000000\nWorld,OWID_WRL,1960,3000000000\n"
        self.assertEqual(collect.read_series_csv(text, "World"), [(1950.0, 2.5e9), (1960.0, 3.0e9)])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.con = connect(Path(self.tmp.name) / "t.db")
        c = self.con
        t = fyear(1945, 5, 8)
        c.execute("INSERT INTO events VALUES ('Q1',?,?,11,0,'d',NULL,40,'guerre')", (t, t + 1 / 365.25))
        c.execute("INSERT INTO events VALUES ('Q2',?,?,11,0,'d',NULL,5,'politique')", (t, t + 1 / 365.25))
        c.execute("INSERT INTO events VALUES ('Q3',?,?,11,0,'d',NULL,9,'autre')", (t, t + 1 / 365.25))
        c.execute("INSERT INTO events VALUES ('Q4',1800.0,1801.0,9,0,'d',NULL,9,'autre')")
        c.executemany("INSERT INTO event_country VALUES (?,?)", [("Q1", "Q142"), ("Q1", "Q30"), ("Q2", "Q142")])
        c.executemany("INSERT INTO event_text VALUES (?,?,?,?,?)", [
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

    def test_search_and_countries(self):
        self.assertEqual(len(server.api_search(self.con, {"q": "test"})["events"]), 2)
        c = server.api_countries(self.con, {})["countries"]
        self.assertEqual(c[0]["qid"], "Q142")
        self.assertEqual(c[0]["fr"], "France")


if __name__ == "__main__":
    unittest.main()
