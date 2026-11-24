"""Schéma SQLite partagé par le collecteur et le serveur.

connect() crée les tables manquantes et met à niveau une base d'une
version précédente (colonnes ajoutées, anciennes séries recopiées).
"""

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "strata.db"
WORLD = "OWID_WRL"  # code « Monde » d'Our World in Data

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

-- Liens entre éléments : cause (P828), conséquence (P1542), précède/suit
-- (P155/P156), fait partie de (P361), comprend (P527)...
CREATE TABLE IF NOT EXISTS event_link (
    qid     TEXT NOT NULL,
    prop    TEXT NOT NULL,
    target  TEXT NOT NULL,
    PRIMARY KEY (qid, prop, target)
);
CREATE INDEX IF NOT EXISTS ix_event_link_target ON event_link(target);

-- Libellés des pays, des types et des cibles de liens
CREATE TABLE IF NOT EXISTS entity_label (
    qid   TEXT NOT NULL,
    lang  TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY (qid, lang)
);

-- Code ISO 3166 alpha-3 des pays (P298), pour relier les courbes par pays
CREATE TABLE IF NOT EXISTS country_info (
    qid   TEXT PRIMARY KEY,
    iso3  TEXT
);

-- Pays des lieux (P276 -> P17), pour situer un événement sans pays
CREATE TABLE IF NOT EXISTS place_country (
    qid     TEXT NOT NULL,
    country TEXT NOT NULL,      -- « - » = lieu sans pays connu
    PRIMARY KEY (qid, country)
);

-- Courbes de fond (population, énergie...), par pays (code ISO) et Monde
CREATE TABLE IF NOT EXISTS series_points (
    name    TEXT NOT NULL,
    entity  TEXT NOT NULL,
    t       REAL NOT NULL,
    value   REAL NOT NULL,
    PRIMARY KEY (name, entity, t)
);
CREATE TABLE IF NOT EXISTS series_meta (
    name   TEXT PRIMARY KEY,
    label  TEXT,
    unit   TEXT,
    source TEXT
);

-- Périodes déjà collectées (pour reprendre là où on s'est arrêté)
CREATE TABLE IF NOT EXISTS collected (
    chunk  TEXT PRIMARY KEY,
    at     TEXT NOT NULL
);
"""

# Colonnes ajoutées après la version 0.1 : (table, colonne, définition)
_ADDED_COLUMNS = [
    ("events", "subtheme", "TEXT NOT NULL DEFAULT ''"),
    ("events", "is_event", "INTEGER NOT NULL DEFAULT 1"),
    ("event_text", "summary", "TEXT"),
]


def _migrate(con: sqlite3.Connection) -> None:
    for table, col, decl in _ADDED_COLUMNS:
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    # Version 0.1 : une seule série mondiale par nom, dans la table « series »
    old = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='series'").fetchone()
    if old:
        con.execute(f"INSERT OR IGNORE INTO series_points SELECT name, '{WORLD}', t, value FROM series")
        con.execute("DROP TABLE series")
    con.commit()


def connect(path: Path | str = DEFAULT_DB) -> sqlite3.Connection:
    if str(path) != ":memory:":
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate(con)
    return con
