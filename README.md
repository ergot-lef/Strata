# Strata

*[Version française](README.fr.md)*

**An interactive timeline of the world**, from the Big Bang to today, built from Wikidata and Wikipedia (FR, EN, DE…), with background curves such as population or energy use.

The idea: wander through time, zoom from geological eras down to the hour, and see **the same moment as lived in several countries**. 8 May 1945 was not the same day in Paris, Sétif, Washington, Moscow or Jakarta.

## What version 0.1 does

- **Country lanes**: one row per country, with its historical forms grouped together (Germany = Reich + FRG + GDR…). A "World" lane holds events with no country.
- **Continuous zoom** with the mouse wheel, from billions of years down to the hour, and drag to pan. Shortcuts: Era / Century / Year / Month / Day / Hour.
- **Logarithmic overview** of all time (Big Bang → today): click to jump to any period.
- **Importance ranking**: at every zoom level, the events present in the most Wikipedias are shown first and the rest become dots, so the timeline stays readable.
- **Honest precision**: events known only to the year or month are dashed. Events that last (wars…) are hatched bars.
- **Filters** by theme (war, politics, science, culture…) and title language (FR / EN / DE).
- **Background curve** (world population, or any other Our World in Data series).
- **Detail card**: titles in each language, description, countries, links to each Wikipedia and to Wikidata.
- **Search** and a "Go to" field (`1945-05-08`, `-500`, `66 Ma`, `4.5 Ga`).
- The page address keeps the view (`#c=…&s=…`), so a bookmark brings you back to the same place.

## Setup (Linux, macOS, Windows)

You only need **Python 3.10 or newer**; there is nothing to install.

```bash
git clone https://github.com/ergot-lef/strata.git
cd strata

# 1. Fetch events from Wikidata (here 1939 → 1945)
python collector/collect.py events --from 1939 --to 1946

# 2. Add the world population curve (Our World in Data)
python collector/collect.py series population https://ourworldindata.org/grapher/population.csv --label "World population"

# 3. Start the app
python server/server.py
```

Then open **http://localhost:8765**.

### Collecting more

```bash
# The whole 20th century, only events present in 10 or more Wikipedias
python collector/collect.py events --from 1900 --to 2001 --min-sitelinks 10

# See what is in the database
python collector/collect.py stats
```

- The collector works **year by year** and remembers what it has done, so you can stop and restart it.
- `--min-sitelinks` sets the volume: 5 gives many events, 20 only the major ones.
- The public Wikidata endpoint stops each query after 60 seconds. If a year fails, run it again with a higher `--min-sitelinks`.

### Other background curves

Any [Our World in Data](https://ourworldindata.org) chart offers a CSV download. Give the URL or file to the collector:

```bash
python collector/collect.py series energy path/to/file.csv --label "Primary energy" --unit "TWh"
```

### Lanes

Lanes are defined in `web/lanes.json`. Each lane groups one or more Wikidata IDs (the current country and its historical forms). Other countries found in the database can be added from the left column ("Autres pays présents").

## Code layout

```
collector/collect.py   fetches Wikidata (SPARQL + API) and Our World in Data CSVs
server/server.py       serves the interface and a JSON API (Python standard library)
strata/                SQLite schema, date conversion, theme classification
web/                   interface (HTML, CSS and plain JavaScript, no framework)
tests/                 offline tests: python -m unittest discover tests
data/strata.db         the local database (not versioned)
```

Time is stored everywhere as a **decimal year** (`1945.35` ≈ early May 1945). A double-precision float keeps a few microseconds of precision around the year 2000 and about two minutes at the Big Bang, so one scale covers everything.

## Roadmap

- [ ] Time zones: show each lane's local time
- [ ] Logarithmic scale inside the timeline itself, for deep time
- [ ] Hatched "before the Big Bang" zone: hypotheses clearly separated from facts
- [ ] Links between events (cause, consequence, same day) from Wikidata (P828, P1542, P155/P156)
- [ ] Births and deaths, discoveries and inventions as separate layers
- [ ] Julian calendar handling for old dates
- [ ] More languages (ID, RU, AR, ZH…) and a comparison of how each Wikipedia tells the story
- [ ] Map synchronised with the cursor

## Data sources and licences

- **Wikidata**: CC0.
- **Wikipedia**: only titles and links are used; the articles stay on Wikipedia.
- **Our World in Data**: CC BY 4.0, to be credited when you display their curves.
