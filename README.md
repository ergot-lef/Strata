# Strata

*[Version française](README.fr.md)*

**An interactive timeline of the world**, from the Big Bang to today, built from Wikidata and Wikipedia (FR, EN, DE), with background curves (population, energy, oil, debt…) for the world and for each country.

The idea: wander through time, zoom from geological eras down to the hour, and see **the same moment as lived in several countries**. 8 May 1945 was not the same day in Paris, Sétif, Washington, Moscow or Jakarta.

## Features

- **Country lanes**, with historical forms grouped together (Germany = Reich + FRG + GDR…) and a "World" lane for events with no country. Other countries found in the database can be added from the left column.
- **Continuous zoom** with the mouse wheel, from billions of years down to the hour, drag to pan, shortcuts Era / Century / Year / Month / Day / Hour.
- **Linear or logarithmic scale**: in "Log" mode all of time fits on one screen (billions of years on the left, the last days on the right).
- **Local time**: on hover, each lane shows its local time at that instant, wartime summer time included (8 May 1945, 03:51 in Paris = 21:51 the day before in New York = 10:51 in Jakarta).
- **Themes and sub-themes**: war (battle, bombing, massacre…), politics (election, treaty, revolution…), society, justice, religion, economy, science, disasters, culture, sport. Each sub-theme can be switched on or off.
- **Non-events filtered out**: films, military units, organisations… are hidden by default (checkbox "Inclure œuvres, unités, organisations").
- **Detail card**: Wikipedia summary (downloaded in advance, in the chosen language), date and precision, countries, **links** (causes, consequences, preceded by, followed by, part of…) and **the same day elsewhere**. Threads on the timeline connect the selected event to its links.
- **Background curves**: a world curve behind the whole timeline, and a per-country curve behind each lane, with the value at the centre of the view.
- **Light background** by default, with a button to switch to dark.
- **Search**, a "Go to" field (`1945-05-08`, `-500`, `66 Ma`, `4.5 Ga`), and a page address that keeps the view (`#c=…&s=…`).

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

### Coming from version 0.1

The database is upgraded automatically. To add the new data (sub-themes, links, summaries, country codes) to events already collected, without going through the SPARQL endpoint again:

```bash
git pull
python collector/collect.py update
python collector/collect.py series tout
```

### All collector commands

```bash
python collector/collect.py events --from 1900 --to 2001 --min-sitelinks 10   # collect a period
python collector/collect.py update        # re-read events in the database (links, themes, summaries)
python collector/collect.py summaries     # missing Wikipedia summaries only
python collector/collect.py series tout   # all curves ("tout" = all), or one: series petrole
python collector/collect.py stats         # database contents
```

- The collector works **year by year** and remembers what it has done, so you can stop and restart it.
- `--min-sitelinks` sets the volume: 5 gives many events, 20 only the major ones.
- If the Wikidata query service is overloaded, the period is split automatically (months, then days) and rate limits are respected.
- `--no-summaries` skips summaries for a faster run (add them later with `summaries`).

### Available background curves

| Name | Content | Period (roughly) |
|---|---|---|
| `population` | Population | −10,000 → today |
| `esperance` | Life expectancy at birth | varies by country |
| `pib` | GDP per capita (Maddison) | varies by country |
| `depenses` | Government spending, % of GDP (IMF) | 1800 → today (depends on country) |
| `energie` | Primary energy consumption | varies by country |
| `petrole` | Proven oil reserves | 1980 → today |
| `dette` | Central government debt, % of GDP | 2000 → today |

The exact period of each curve is shown in the app's list. All come from [Our World in Data](https://ourworldindata.org). Any other chart on the site can be added from its CSV:

```bash
python collector/collect.py series my_curve https://ourworldindata.org/grapher/<name>.csv --label "…" --unit "…"
```

### Lanes

Lanes are defined in `web/lanes.json`: for each one, the grouped Wikidata IDs (`qids`), the country code for curves (`iso3`) and the time zone for local time (`tz`).

## Code layout

```
collector/collect.py   fetches Wikidata (SPARQL + API), Wikipedia summaries and Our World in Data CSVs
server/server.py       serves the interface and a JSON API (Python standard library)
strata/                SQLite schema (with upgrades), dates, themes and sub-themes
web/                   interface (HTML, CSS and plain JavaScript, no framework)
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

- [x] Local time for each lane
- [x] Logarithmic scale in the timeline
- [x] Links between events (cause, consequence, follows/followed by, part of) and "the same day elsewhere"
- [x] Sub-themes and non-event filtering
- [x] Per-country background curves, Wikipedia summaries, light/dark theme
- [ ] Hatched "before the Big Bang" zone: hypotheses clearly separated from facts
- [ ] Births, deaths, discoveries and inventions as separate layers
- [ ] Julian calendar for old dates
- [ ] More languages (ID, RU, AR, ZH…) and a comparison of how each Wikipedia tells the story
- [ ] Map synchronised with the cursor

## Data sources and licences

- **Wikidata**: CC0.
- **Wikipedia**: titles, links and the opening lines of articles (CC BY-SA); full articles stay on Wikipedia.
- **Our World in Data**: CC BY 4.0, to be credited when you display their curves.
