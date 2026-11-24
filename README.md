# Strata

*[Version française](README.fr.md)*

**An interactive timeline of the world**, from the Big Bang to today, built from Wikidata and Wikipedia (FR, EN, DE), with background curves (population, energy, oil, debt…) for the world and for each country.

The idea: wander through time, zoom from geological eras down to the hour, and see **the same moment as lived in several countries**. 8 May 1945 was not the same day in Paris, Sétif, Washington, Moscow or Jakarta.

## Features

**Wandering through time**
- **Country lanes**, with historical forms grouped together (Germany = Reich + FRG + GDR…) and a "World" lane for events with no country.
- **Continuous zoom** with the mouse wheel or a pinch (touch), from billions of years down to the hour, shortcuts Era / Century / Year / Month / Day / Hour.
- **Linear or logarithmic scale**: in "Log" mode all of time fits on one screen.
- **Local time** for each lane on hover, wartime summer time included.
- **Two eras** one above the other, at the same scale (1918 and 1945, 1929 and 2008…).
- **On this day**: what happened on today's date across the centuries.

**Layers**
- **Events**, with themes and sub-themes (war, politics, society, justice, religion, economy, science, disasters, culture, sport).
- **Discoveries and inventions** ✦ and **works** ◆ (books, films, paintings, music).
- **People's lives**: each figure is a bar from birth to death, placed in their country's lane, filterable by field (politics, military, science, arts…). You see who was alive at the same time.
- **Rulers**: heads of state and government as a strip in each lane, plus the successive states of one country (Weimar Republic, Third Reich, FRG, GDR…).
- **Deep time**: geological eons, eras and periods (official International Commission on Stratigraphy chart, 2024), milestones of the Universe, the Earth and life, mass extinctions, and a **hatched "before the Big Bang" zone** presenting the hypotheses, kept apart from facts.
- **My timeline**: your own events (family, house, projects), which stay on your computer.

**Understanding**
- **Detail card**: Wikipedia summary, links (causes, consequences, preceded by, followed by…) and "the same day elsewhere", with threads drawn on the timeline.
- **Compare Wikipedias**: the same event in every language that has an article, with the size of each article (what each country thinks worth saying), the opening of each article, a link to translate it, and the major languages where it is missing.
- **Trace causes / follow consequences**: the full chain from Wikidata, over several levels, with arrows on the timeline.
- **Blind spots**: how many events the sources tell per country, relative to population, plus an "event density" curve in each lane.
- **Background curves**: a world curve behind the timeline and a per-country curve in each lane (17 ready-made curves, see below).

**Practical**
- Light background by default, dark button; search; "Go to" (`1945-05-08`, `-500`, `66 Ma`); page address that keeps the view.
- **Export**: copy the link to the view, print or save as PDF.
- **Online version** with no server (GitHub Pages, phone), without your personal data.

## Setup (Linux, macOS, Windows)

You only need **Python 3.10 or newer**; there is nothing to install.

```bash
git clone https://github.com/ergot-lef/strata.git
cd strata

# 1. Events from Wikidata (here 1939 → 1945), with Wikipedia summaries
python collector/collect.py events --from 1939 --to 1946

# 2. All ready-made background curves (Our World in Data)
python collector/collect.py series tout

# 3. Start the app
python server/server.py
```

Then open **http://localhost:8765**.

### Coming from an earlier version

The database is upgraded automatically. To add the new data (sub-themes, links, summaries, country codes) to events already collected, without going through the SPARQL endpoint again:

```bash
git pull
python collector/collect.py update
python collector/collect.py series tout
```

For version 0.3, then add the new layers for your periods:

```bash
python collector/collect.py culture --from 1939 --to 1946
python collector/collect.py people --from 1860 --to 1946
python collector/collect.py rulers
```

### All collector commands

```bash
python collector/collect.py events  --from 1900 --to 2001 --min-sitelinks 10   # events
python collector/collect.py culture --from 1900 --to 2001                      # discoveries, inventions, works
python collector/collect.py people  --from 1850 --to 1990                      # people, by year of birth
python collector/collect.py rulers                                             # heads of state and government
python collector/collect.py update          # re-read items in the database (links, themes, all Wikipedias)
python collector/collect.py summaries       # missing Wikipedia summaries
python collector/collect.py series tout     # all curves ("tout" = all), or one: series petrole
python collector/collect.py stats           # database contents
```

- The collector works **year by year** and remembers what it has done, so you can stop and restart it.
- `--min-sitelinks` sets the volume: the minimum number of Wikipedias with an article. Defaults: 5 for events, 25 for works, 40 for people.
- For **lives**, collect births **before** the period you care about: to see who was alive in 1945, use for example `--from 1860 --to 1946`.
- `rulers` uses the countries in `web/lanes.json` and the most frequent ones in your database. Run it again when you add lanes.
- If the Wikidata query service is overloaded, the period is split automatically (months, then days) and rate limits are respected.
- `--no-summaries` skips summaries for a faster run.

### Available background curves

| Name | Content |
|---|---|
| `population` | Population (since −10,000) |
| `esperance` | Life expectancy at birth |
| `mortalite` | Under-5 child mortality |
| `pib` | GDP per capita (Maddison) |
| `pauvrete` | Share of population in extreme poverty |
| `urbanisation` | Share of urban population |
| `alphabetisation` | Literacy |
| `democratie` | Electoral democracy index (V-Dem, since 1789) |
| `depenses` | Government spending, % of GDP (IMF, since 1800) |
| `dette` | Central government debt, % of GDP (since 2000 only) |
| `militaire` | Military spending, % of GDP (since 1949) |
| `energie` | Primary energy consumption |
| `petrole` | Proven oil reserves (since 1980) |
| `prix_petrole` | Crude oil price (since 1861) |
| `emissions` | CO₂ emissions (since 1750) |
| `co2` | Atmospheric CO₂, ice cores (800,000 years) |
| `temperature` | Global temperature anomaly (since 1850) |

The exact period of each curve is shown in the app's list. All come from [Our World in Data](https://ourworldindata.org). Any other chart on the site can be added from its CSV:

```bash
python collector/collect.py series my_curve https://ourworldindata.org/grapher/<name>.csv --label "…" --unit "…"
```

### Lanes

Lanes are defined in `web/lanes.json`: for each one, the grouped Wikidata IDs (`qids`), the country code for curves (`iso3`) and the time zone for local time (`tz`).

## Online version (phone, GitHub Pages)

```bash
python tools/export_static.py          # creates the site/ folder (public data only)
```

The `site/` folder works without a server. To publish it with GitHub Pages: create a second repository (for example `strata-site`), copy the contents of `site/` into it, push, then enable Pages in the repository settings (branch `main`, root folder). Any other static hosting works too.

**Your personal timeline is never exported.** Online, the Wikipedia comparison reads articles directly from Wikipedia.

## Code layout

```
collector/collect.py   fetches Wikidata (SPARQL + API), Wikipedia summaries and Our World in Data CSVs
server/server.py       serves the interface and a JSON API (Python standard library)
tools/export_static.py serverless export for the online version
strata/                SQLite schema (with upgrades), dates, themes and sub-themes
web/                   interface (HTML, CSS and plain JavaScript, no framework); deeptime.json = deep time
tests/                 offline tests: python -m unittest discover tests
data/strata.db         the local database (not versioned)
```

Time is stored everywhere as a **decimal year** (`1945.35` ≈ early May 1945). A double-precision float keeps a few microseconds of precision around the year 2000 and about two minutes at the Big Bang, so one scale covers everything.

## Known limits

- Wikidata almost always gives dates **to the day**, rarely to the hour: local time is there to find your bearings, not to date an event precisely.
- Themes come from the Wikidata type, matched by keywords: some items end up in "Other" or in the wrong sub-theme.
- Very old dates are shown without Julian calendar conversion.
- Sources are much richer on Europe and North America than on the rest of the world.

## Roadmap

- [x] Local time, logarithmic scale, links between events, sub-themes, per-country curves, light/dark theme (0.2)
- [x] Rulers, people's lives, discoveries and works, deep time and "before the Big Bang" (0.3)
- [x] Compare Wikipedias, cause chains, blind spots, two eras, on this day, personal timeline, export, online version (0.3)
- [ ] Map synchronised with the cursor
- [ ] Julian calendar for old dates
- [ ] Build the whole database at once from the full Wikidata dump

## Data sources and licences

- **Wikidata**: CC0.
- **Wikipedia**: titles, links, size and opening lines of articles (CC BY-SA); full articles stay on Wikipedia.
- **Deep time**: ICS International Chronostratigraphic Chart (v2024/12); milestones of the Universe and of life are approximate values (marked "≈").
- **Our World in Data**: CC BY 4.0, to be credited when you display their curves.
