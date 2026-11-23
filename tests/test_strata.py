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


class ParseRowsTests(unittest.TestCase):
    def test_group_and_best_precision(self):
        rows = [
            {"e": uri("Q1"), "time": lit("1945-01-01T00:00:00Z"), "prec": lit("9"), "sl": lit("12"),
             "type": uri("Q10"), "country": uri("Q142")},
            {"e": uri("Q1"), "time": lit("1945-05-08T00:00:00Z"), "prec": lit("11"), "sl": lit("12"),
             "type": uri("Q11"), "country": uri("Q30")},
            {"e": uri("Q2"), "time": lit("1939-09-01T00:00:00Z"), "prec": lit("11"), "sl": lit("80"),
             "end": lit("1945-09-02T00:00:00Z"), "type": uri("Q12")},
        ]
        ev = collect.parse_rows(rows)
        self.assertEqual(ev["Q1"]["prec"], 11)
        self.assertAlmostEqual(ev["Q1"]["t"], fyear(1945, 5, 8))
        self.assertEqual(ev["Q1"]["countries"], {"Q142", "Q30"})
        self.assertAlmostEqual(ev["Q2"]["end"], fyear(1945, 9, 2))

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
