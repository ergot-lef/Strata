# Strata

*[English version](README.md)*

**Une frise chronologique interactive du monde**, du Big Bang à aujourd'hui, construite à partir de Wikidata et de Wikipédia (FR, EN, DE), avec des courbes de fond (population, énergie, pétrole, dette…) pour le monde et pour chaque pays.

L'idée : se promener dans le temps, zoomer de l'ère géologique jusqu'à l'heure, et voir **le même instant vécu par plusieurs pays**. Le 8 mai 1945 n'est pas le même jour à Paris, à Sétif, à Washington, à Moscou ou à Jakarta.

## Fonctions

**Se promener dans le temps**
- **Couloirs par pays**, avec les formes historiques regroupées (Allemagne = Reich + RFA + RDA…) et un couloir « Monde » pour les événements sans pays.
- **Zoom continu** à la molette ou en pinçant (tactile), du milliard d'années à l'heure, raccourcis Ère / Siècle / Année / Mois / Jour / Heure.
- **Échelle linéaire ou logarithmique** : en « Log », tout le temps tient sur un écran.
- **Heure locale** de chaque couloir au survol, heures d'été de guerre comprises.
- **Deux époques** l'une au-dessus de l'autre, à la même échelle (1918 et 1945, 1929 et 2008…).
- **Ce jour-là** : ce qui s'est passé à la date du jour, à travers les siècles.

**Les calques**
- **Événements**, avec thèmes et sous-thèmes (guerre, politique, société, justice, religion, économie, sciences, catastrophes, culture, sport).
- **Découvertes et inventions** ✦ et **œuvres** ◆ (livres, films, tableaux, musique).
- **Vies des personnes** : chaque personnalité est une barre de sa naissance à sa mort, rangée dans le couloir de son pays, filtrable par domaine (politique, militaire, sciences, arts…). On voit qui vivait en même temps.
- **Gouvernants** : chefs d'État et de gouvernement en bandeau dans chaque couloir, et les États successifs d'un même pays (République de Weimar, Troisième Reich, RFA, RDA…).
- **Temps profond** : éons, ères et périodes géologiques (tableau officiel de la Commission internationale de stratigraphie, 2024), jalons de l'Univers, de la Terre et de la vie, grandes extinctions, et une **zone hachurée « avant le Big Bang »** qui présente les hypothèses, séparées des faits.
- **Ma frise** : tes propres événements (famille, maison, projets), qui restent sur ton ordinateur.

**Comprendre**
- **Fiche détail** : résumé Wikipédia, liens (causes, conséquences, précédé de, suivi de…) et « le même jour ailleurs », avec des fils tracés sur la frise.
- **Comparer les Wikipédias** : le même événement dans toutes les langues où il a un article, avec la taille de chaque article (ce que chaque pays juge important d'en dire), le début de chaque article, un lien pour le traduire, et les grandes langues où il n'existe pas.
- **Remonter les causes / suivre les conséquences** : la chaîne complète d'après Wikidata, sur plusieurs niveaux, avec des flèches sur la frise.
- **Angles morts** : combien d'événements les sources racontent par pays, rapporté à la population, et une courbe « densité d'événements » dans chaque couloir.
- **Courbes de fond** : une courbe mondiale derrière la frise et une courbe par pays dans chaque couloir (17 courbes prêtes à l'emploi, voir plus bas).

**Pratique**
- Fond clair par défaut, bouton sombre ; recherche ; « Aller à » (`1945-05-08`, `-500`, `66 Ma`) ; adresse de page qui garde la vue.
- **Exporter** : copier le lien de la vue, imprimer ou enregistrer en PDF.
- **Version en ligne** sans serveur (GitHub Pages, téléphone), sans tes données personnelles.

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

### Venant d'une version précédente

La base est mise à niveau automatiquement. Pour récupérer les nouveautés (sous-thèmes, liens, résumés, codes pays) sur les événements déjà collectés, sans repasser par le service SPARQL :

```bash
git pull
python collector/collect.py update
python collector/collect.py series tout
```

Pour la version 0.3, ajoute ensuite les nouveaux calques sur tes périodes :

```bash
python collector/collect.py culture --from 1939 --to 1946
python collector/collect.py people --from 1860 --to 1946
python collector/collect.py rulers
```

### Toutes les commandes du collecteur

```bash
python collector/collect.py events  --from 1900 --to 2001 --min-sitelinks 10   # événements
python collector/collect.py culture --from 1900 --to 2001                      # découvertes, inventions, œuvres
python collector/collect.py people  --from 1850 --to 1990                      # personnes, par année de naissance
python collector/collect.py rulers                                             # chefs d'État et de gouvernement
python collector/collect.py update          # relire les éléments en base (liens, thèmes, toutes les Wikipédias)
python collector/collect.py summaries       # résumés Wikipédia manquants
python collector/collect.py series tout     # toutes les courbes, ou une seule : series petrole
python collector/collect.py stats           # contenu de la base
```

- Le collecteur travaille **année par année** et retient ce qu'il a déjà fait : tu peux l'arrêter et le relancer.
- `--min-sitelinks` règle le volume : nombre minimum de Wikipédias où l'élément a un article. Par défaut 5 pour les événements, 25 pour les œuvres, 40 pour les personnes.
- Pour les **vies**, collecte les naissances **avant** la période qui t'intéresse : pour voir qui vivait en 1945, prends par exemple `--from 1860 --to 1946`.
- `rulers` prend les pays de `web/lanes.json` et les plus présents dans ta base. Relance-le quand tu ajoutes des couloirs.
- Si le service de requêtes de Wikidata sature, la période est automatiquement découpée (mois, puis jours) et les limitations de débit sont respectées.
- `--no-summaries` saute les résumés pour une collecte plus rapide.

### Courbes de fond disponibles

| Nom | Contenu |
|---|---|
| `population` | Population (depuis −10 000) |
| `esperance` | Espérance de vie à la naissance |
| `mortalite` | Mortalité des enfants de moins de 5 ans |
| `pib` | PIB par habitant (Maddison) |
| `pauvrete` | Part de la population en extrême pauvreté |
| `urbanisation` | Part de la population urbaine |
| `alphabetisation` | Alphabétisation |
| `democratie` | Indice de démocratie électorale (V-Dem, depuis 1789) |
| `depenses` | Dépenses publiques, % du PIB (FMI, depuis 1800) |
| `dette` | Dette publique de l'administration centrale, % du PIB (depuis 2000 seulement) |
| `militaire` | Dépenses militaires, % du PIB (depuis 1949) |
| `energie` | Énergie primaire consommée |
| `petrole` | Réserves prouvées de pétrole (depuis 1980) |
| `prix_petrole` | Prix du pétrole brut (depuis 1861) |
| `emissions` | Émissions de CO₂ (depuis 1750) |
| `co2` | CO₂ dans l'atmosphère, carottes de glace (800 000 ans) |
| `temperature` | Écart de température mondiale (depuis 1850) |

La période exacte de chaque courbe est affichée dans la liste de l'application. Toutes viennent d'[Our World in Data](https://ourworldindata.org). N'importe quel autre graphique du site peut être ajouté avec son CSV :

```bash
python collector/collect.py series ma_courbe https://ourworldindata.org/grapher/<nom>.csv --label "…" --unit "…"
```

### Couloirs

Les couloirs sont définis dans `web/lanes.json` : pour chacun, les identifiants Wikidata regroupés (`qids`), le code pays des courbes (`iso3`) et le fuseau horaire pour l'heure locale (`tz`).

## Version en ligne (téléphone, GitHub Pages)

```bash
python tools/export_static.py          # crée le dossier site/ (données publiques seulement)
```

Le dossier `site/` fonctionne sans serveur. Pour le mettre en ligne avec GitHub Pages : crée un second dépôt (par exemple `strata-site`), copie-y le contenu de `site/`, pousse-le, puis active Pages dans les réglages du dépôt (branche `main`, dossier racine). N'importe quel autre hébergement de pages statiques convient aussi.

**Ta frise personnelle n'est jamais exportée.** En ligne, la comparaison des Wikipédias lit les articles directement sur Wikipédia.

## Organisation du code

```
collector/collect.py   récupère Wikidata (SPARQL + API), les résumés Wikipédia et les CSV Our World in Data
server/server.py       sert l'interface et une API JSON (bibliothèque standard Python)
tools/export_static.py export sans serveur pour la version en ligne
strata/                schéma SQLite (avec mise à niveau), dates, thèmes et sous-thèmes
web/                   interface (HTML, CSS et JavaScript sans framework) ; deeptime.json = temps profond
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

- [x] Heure locale, échelle logarithmique, liens entre événements, sous-thèmes, courbes par pays, thème clair/sombre (0.2)
- [x] Gouvernants, vies des personnes, découvertes et œuvres, temps profond et « avant le Big Bang » (0.3)
- [x] Comparer les Wikipédias, chaînes de causes, angles morts, deux époques, ce jour-là, frise personnelle, export, version en ligne (0.3)
- [ ] Carte synchronisée avec le curseur
- [ ] Calendrier julien pour les dates anciennes
- [ ] Construire toute la base d'un coup depuis l'export complet de Wikidata

## Sources et licences des données

- **Wikidata** : données sous licence CC0.
- **Wikipédia** : titres, liens, taille et premières lignes des articles (licence CC BY-SA) ; les articles complets restent sur Wikipédia.
- **Temps profond** : tableau chronostratigraphique international de l'ICS (v2024/12) ; les jalons de l'Univers et de la vie sont des valeurs approchées (marquées « ≈ »).
- **Our World in Data** : données sous licence CC BY 4.0, à citer quand tu affiches leurs courbes.
