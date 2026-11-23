# Strata

*[English version](README.md)*

**Une frise chronologique interactive du monde**, du Big Bang à aujourd'hui, construite à partir de Wikidata et de Wikipédia (FR, EN, DE…), avec des courbes de fond comme la démographie ou l'énergie.

L'idée : se promener dans le temps, zoomer de l'ère géologique jusqu'à l'heure, et voir **le même instant vécu par plusieurs pays**. Le 8 mai 1945 n'est pas le même à Paris, à Sétif, à Washington, à Moscou ou à Jakarta.

## Ce que fait la version 0.1

- **Couloirs par pays** : une ligne par pays, avec ses formes historiques regroupées (Allemagne = Reich + RFA + RDA…). Il y a aussi un couloir « Monde » pour les événements sans pays.
- **Zoom continu** à la molette, du milliard d'années à l'heure, et déplacement en glissant la souris. Raccourcis Ère / Siècle / Année / Mois / Jour / Heure.
- **Vue d'ensemble logarithmique** de tout le temps (Big Bang → aujourd'hui) : un clic t'emmène à l'époque choisie.
- **Tri par importance** : à chaque niveau de zoom, on affiche d'abord les événements présents dans le plus grand nombre de Wikipédias, et le reste devient des points. La frise reste lisible.
- **Précision honnête** : un événement connu seulement à l'année ou au mois est dessiné en pointillé. Les événements qui durent (guerres…) sont en bandes hachurées.
- **Filtres** par thème (guerre, politique, science, culture…) et choix de la langue des titres (FR / EN / DE).
- **Courbe de fond** (population mondiale, ou toute autre série d'Our World in Data).
- **Fiche détail** : titres dans chaque langue, description, pays, liens vers chaque Wikipédia et vers Wikidata.
- **Recherche** et champ « Aller à » (`1945-05-08`, `-500`, `66 Ma`, `4.5 Ga`).
- L'adresse de la page garde la vue (`#c=…&s=…`) : un favori te ramène au même endroit.

## Installation (Linux, macOS, Windows)

Il faut seulement **Python 3.10 ou plus récent**, aucune bibliothèque à installer.

```bash
git clone https://github.com/ergot-lef/strata.git
cd strata

# 1. Récupérer des événements depuis Wikidata (ici 1939 → 1945)
python collector/collect.py events --from 1939 --to 1946

# 2. Ajouter la courbe de population mondiale (Our World in Data)
python collector/collect.py series population https://ourworldindata.org/grapher/population.csv --label "Population mondiale"

# 3. Lancer l'application
python server/server.py
```

Ouvre ensuite **http://localhost:8765**.

### Collecter plus large

```bash
# Tout le XXe siècle, seulement les événements présents dans 10 Wikipédias ou plus
python collector/collect.py events --from 1900 --to 2001 --min-sitelinks 10

# Voir ce qu'il y a dans la base
python collector/collect.py stats
```

- Le collecteur travaille **année par année** et retient ce qu'il a déjà fait : tu peux l'arrêter et le relancer.
- `--min-sitelinks` règle le volume : 5 donne beaucoup d'événements, 20 seulement les grands.
- Le service public de Wikidata limite chaque requête à 60 secondes. Si une année échoue (`échec`), relance avec un `--min-sitelinks` plus élevé.

### Autres courbes de fond

N'importe quel graphique d'[Our World in Data](https://ourworldindata.org) propose un téléchargement CSV. Donne l'URL ou le fichier au collecteur :

```bash
python collector/collect.py series energie chemin/vers/le-fichier.csv --label "Énergie primaire" --unit "TWh"
```

### Couloirs

Les couloirs sont définis dans `web/lanes.json`. Chaque couloir regroupe un ou plusieurs identifiants Wikidata (le pays actuel et ses formes historiques). Les autres pays présents dans la base peuvent être ajoutés depuis la colonne de gauche (« Autres pays présents »).

## Organisation du code

```
collector/collect.py   récupère Wikidata (SPARQL + API) et les CSV Our World in Data
server/server.py       sert l'interface et une API JSON (bibliothèque standard Python)
strata/                schéma SQLite, conversion des dates, classement en thèmes
web/                   interface (HTML, CSS et JavaScript sans framework)
tests/                 tests sans réseau : python -m unittest discover tests
data/strata.db         la base locale (non versionnée)
```

Le temps est stocké partout en **année décimale** (`1945.35` ≈ début mai 1945). Un nombre à virgule flottante en double précision garde quelques microsecondes de précision autour de l'an 2000 et environ deux minutes au Big Bang. Une seule échelle suffit donc pour tout.

## Feuille de route

- [ ] Fuseaux horaires : afficher l'heure locale de chaque couloir
- [ ] Échelle logarithmique dans la frise elle-même, pour le temps profond
- [ ] Zone « avant le Big Bang » hachurée : hypothèses clairement séparées des faits
- [ ] Liens entre événements (cause, suite, même jour) tirés de Wikidata (P828, P1542, P155/P156)
- [ ] Naissances et décès de personnalités, découvertes et inventions comme calques séparés
- [ ] Prise en compte du calendrier julien pour les dates anciennes
- [ ] Plus de langues (ID, RU, AR, ZH…) et comparaison du récit de chaque Wikipédia
- [ ] Carte synchronisée avec le curseur

## Sources et licences des données

- **Wikidata** : données sous licence CC0.
- **Wikipédia** : seuls les titres et les liens sont utilisés ; les articles restent sur Wikipédia.
- **Our World in Data** : données sous licence CC BY 4.0, à citer quand tu affiches leurs courbes.
