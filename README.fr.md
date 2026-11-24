# Strata

*[English version](README.md)*

**Une frise chronologique interactive du monde**, du Big Bang à aujourd'hui, construite à partir de Wikidata et de Wikipédia (FR, EN, DE), avec des courbes de fond (population, énergie, pétrole, dette…) pour le monde et pour chaque pays.

L'idée : se promener dans le temps, zoomer de l'ère géologique jusqu'à l'heure, et voir **le même instant vécu par plusieurs pays**. Le 8 mai 1945 n'est pas le même jour à Paris, à Sétif, à Washington, à Moscou ou à Jakarta.

## Fonctions

- **Couloirs par pays**, avec les formes historiques regroupées (Allemagne = Reich + RFA + RDA…) et un couloir « Monde » pour les événements sans pays. Les autres pays de la base s'ajoutent depuis la colonne de gauche.
- **Zoom continu** à la molette, du milliard d'années à l'heure, déplacement en glissant la souris, raccourcis Ère / Siècle / Année / Mois / Jour / Heure.
- **Échelle linéaire ou logarithmique** : en mode « Log », tout le temps tient sur un écran (milliards d'années à gauche, derniers jours à droite).
- **Heure locale** : au survol, chaque couloir affiche son heure locale à cet instant, heures d'été de guerre comprises (8 mai 1945, 3 h 51 à Paris = 21 h 51 la veille à New York = 10 h 51 à Jakarta).
- **Thèmes et sous-thèmes** : guerre (bataille, bombardement, massacre…), politique (élection, traité, révolution…), société, justice, religion, économie, sciences, catastrophes, culture, sport. Chaque sous-thème se coche ou se décoche.
- **Tri des non-événements** : films, unités militaires, organisations… sont masqués par défaut (case « Inclure œuvres, unités, organisations »).
- **Fiche détail** : résumé Wikipédia (téléchargé d'avance, dans la langue choisie), date et précision, pays, **liens** (causes, conséquences, précédé de, suivi de, fait partie de…) et **le même jour ailleurs**. Des fils relient sur la frise l'événement choisi à ses liens.
- **Courbes de fond** : une courbe mondiale en fond de la frise, et une courbe par pays en fond de chaque couloir, avec la valeur au centre de la vue.
- **Fond clair** par défaut, bouton pour passer en sombre.
- **Recherche**, champ « Aller à » (`1945-05-08`, `-500`, `66 Ma`, `4.5 Ga`), et adresse de page qui garde la vue (`#c=…&s=…`).

## Installation (Linux, macOS, Windows)

Il faut seulement **Python 3.10 ou plus récent**, aucune bibliothèque à installer.

```bash
git clone https://github.com/ergot-lef/strata.git
cd strata

# 1. Événements de Wikidata (ici 1939 → 1945), avec les résumés Wikipédia
python collector/collect.py events --from 1939 --to 1946

# 2. Toutes les courbes de fond prêtes à l'emploi (Our World in Data)
python collector/collect.py series tout

# 3. Lancer l'application
python server/server.py
```

Ouvre ensuite **http://localhost:8765**.

### Venant de la version 0.1

La base est mise à niveau automatiquement. Pour récupérer les nouveautés (sous-thèmes, liens, résumés, codes pays) sur les événements déjà collectés, sans repasser par le service SPARQL :

```bash
git pull
python collector/collect.py update
python collector/collect.py series tout
```

### Toutes les commandes du collecteur

```bash
python collector/collect.py events --from 1900 --to 2001 --min-sitelinks 10   # collecter une période
python collector/collect.py update        # relire les événements en base (liens, thèmes, résumés)
python collector/collect.py summaries     # résumés Wikipédia manquants seulement
python collector/collect.py series tout   # toutes les courbes, ou une seule : series petrole
python collector/collect.py stats         # contenu de la base
```

- Le collecteur travaille **année par année** et retient ce qu'il a déjà fait : tu peux l'arrêter et le relancer.
- `--min-sitelinks` règle le volume : 5 donne beaucoup d'événements, 20 seulement les grands.
- Si le service de requêtes de Wikidata sature, la période est automatiquement découpée (mois, puis jours) et les limitations de débit sont respectées.
- `--no-summaries` saute les résumés pour une collecte plus rapide (ils pourront être ajoutés plus tard avec `summaries`).

### Courbes de fond disponibles

| Nom | Contenu | Période (environ) |
|---|---|---|
| `population` | Population | −10 000 → aujourd'hui |
| `esperance` | Espérance de vie à la naissance | variable selon les pays |
| `pib` | PIB par habitant (Maddison) | variable selon les pays |
| `depenses` | Dépenses publiques, % du PIB (FMI) | 1800 → aujourd'hui (selon pays) |
| `energie` | Énergie primaire consommée | variable selon les pays |
| `petrole` | Réserves prouvées de pétrole | 1980 → aujourd'hui |
| `dette` | Dette publique de l'administration centrale, % du PIB | 2000 → aujourd'hui |

La période exacte de chaque courbe est affichée dans la liste de l'application. Toutes viennent d'[Our World in Data](https://ourworldindata.org). N'importe quel autre graphique du site peut être ajouté avec son CSV :

```bash
python collector/collect.py series ma_courbe https://ourworldindata.org/grapher/<nom>.csv --label "…" --unit "…"
```

### Couloirs

Les couloirs sont définis dans `web/lanes.json` : pour chacun, les identifiants Wikidata regroupés (`qids`), le code pays des courbes (`iso3`) et le fuseau horaire pour l'heure locale (`tz`).

## Organisation du code

```
collector/collect.py   récupère Wikidata (SPARQL + API), les résumés Wikipédia et les CSV Our World in Data
server/server.py       sert l'interface et une API JSON (bibliothèque standard Python)
strata/                schéma SQLite (avec mise à niveau), dates, thèmes et sous-thèmes
web/                   interface (HTML, CSS et JavaScript sans framework)
tests/                 tests sans réseau : python -m unittest discover tests
data/strata.db         la base locale (non versionnée)
```

Le temps est stocké partout en **année décimale** (`1945.35` ≈ début mai 1945). Un nombre à virgule flottante en double précision garde quelques microsecondes de précision autour de l'an 2000 et environ deux minutes au Big Bang : une seule échelle suffit donc pour tout.

## Limites connues

- Wikidata donne presque toujours la date **au jour près**, rarement à l'heure : l'heure locale sert à se repérer, pas à dater un événement précis.
- Le classement en thèmes se fait d'après le type Wikidata, par mots-clés : quelques éléments tombent dans « Autre » ou dans le mauvais sous-thème.
- Les dates très anciennes sont affichées sans conversion du calendrier julien.
- Les sources sont bien plus riches sur l'Europe et l'Amérique du Nord que sur le reste du monde.

## Feuille de route

- [x] Heure locale de chaque couloir
- [x] Échelle logarithmique dans la frise
- [x] Liens entre événements (cause, conséquence, précède/suit, fait partie de) et « le même jour ailleurs »
- [x] Sous-thèmes et tri des non-événements
- [x] Courbes de fond par pays, résumés Wikipédia, thème clair/sombre
- [ ] Zone « avant le Big Bang » hachurée : hypothèses clairement séparées des faits
- [ ] Naissances, décès, découvertes et inventions comme calques séparés
- [ ] Calendrier julien pour les dates anciennes
- [ ] Plus de langues (ID, RU, AR, ZH…) et comparaison du récit de chaque Wikipédia
- [ ] Carte synchronisée avec le curseur

## Sources et licences des données

- **Wikidata** : données sous licence CC0.
- **Wikipédia** : titres, liens et premières lignes des articles (licence CC BY-SA) ; les articles complets restent sur Wikipédia.
- **Our World in Data** : données sous licence CC BY 4.0, à citer quand tu affiches leurs courbes.
