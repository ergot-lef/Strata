"""Schéma SQLite partagé par le collecteur et le serveur."""

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "strata.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    qid        TEXT PRIMARY KEY,
    t_lo       REAL NOT NULL,      -- début (année décimale)
    t_hi       REAL NOT NULL,      -- fin, ou début + durée de la précision
    precision  INTEGER,            -- précision Wikidata (9 = année, 11 = jour...)
    is_span    INTEGER NOT NULL DEFAULT 0, -- 1 = a une vraie date de fin (guerre...)
    date_raw   TEXT,
    end_raw    TEXT,
    sitelinks  INTEGER NOT NULL DEFAULT 0, -- nb de Wikipédias = importance
    theme      TEXT NOT NULL DEFAULT 'autre'
);
CREATE INDEX IF NOT EXISTS ix_events_lo ON events(t_lo);
CREATE INDEX IF NOT EXISTS ix_events_hi ON events(t_hi);

CREATE TABLE IF NOT EXISTS event_text (
    qid      TEXT NOT NULL,
    lang     TEXT NOT NULL,
    label    TEXT,
    descr    TEXT,
    article  TEXT,                 -- titre de l'article Wikipédia dans cette langue
    PRIMARY KEY (qid, lang)
);
CREATE INDEX IF NOT EXISTS ix_event_text_label ON event_text(label);

CREATE TABLE IF NOT EXISTS event_country (
    qid      TEXT NOT NULL,
    country  TEXT NOT NULL,
    PRIMARY KEY (qid, country)
);
CREATE INDEX IF NOT EXISTS ix_event_country_c ON event_country(country);

CREATE TABLE IF NOT EXISTS event_type (
    qid      TEXT NOT NULL,
    type     TEXT NOT NULL,
    PRIMARY KEY (qid, type)
);

-- Libellés des pays et des types
CREATE TABLE IF NOT EXISTS entity_label (
    qid   TEXT NOT NULL,
    lang  TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY (qid, lang)
);

-- Courbes de fond (population, énergie...)
CREATE TABLE IF NOT EXISTS series (
    name   TEXT NOT NULL,
    t      REAL NOT NULL,
    value  REAL NOT NULL,
    PRIMARY KEY (name, t)
);
CREATE TABLE IF NOT EXISTS series_meta (
    name   TEXT PRIMARY KEY,
    label  TEXT,
    unit   TEXT,
    source TEXT
);

-- Années déjà collectées (pour reprendre là où on s'est arrêté)
CREATE TABLE IF NOT EXISTS collected (
    chunk  TEXT PRIMARY KEY,
    at     TEXT NOT NULL
);
"""


def connect(path: Path | str = DEFAULT_DB) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con
