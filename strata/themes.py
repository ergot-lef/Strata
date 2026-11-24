"""Classement des éléments en thèmes et sous-thèmes, d'après le libellé
anglais de leurs types Wikidata (P31). Volontairement simple : on lit les
mots-clés dans l'ordre et le premier qui correspond gagne.

Un élément dont le type ressemble à une œuvre, une unité militaire, une
organisation… est marqué « hors événement » (is_event = 0) : l'interface
le masque par défaut.
"""

import re

# (thème, nom affiché, [(sous-thème, nom affiché, [mots-clés])])
TAXONOMY = [
    ("guerre", "Guerre", [
        ("capitulation", "Capitulation, armistice", ["surrender", "armistice", "ceasefire", "capitulation", "peace treaty"]),
        ("massacre", "Massacre, crime de guerre", ["massacre", "genocide", "mass murder", "war crime", "pogrom",
                                                     "ethnic cleansing", "mass shooting", "deportation"]),
        ("bombardement", "Bombardement", ["bombing", "air raid", "airstrike", "air strike", "shelling", "strategic bombing"]),
        ("bataille", "Bataille, siège", ["battle", "siege", "naval battle", "skirmish", "engagement"]),
        ("operation", "Opération, offensive", ["offensive", "military operation", "operation", "campaign", "invasion",
                                               "landing", "raid", "occupation", "evacuation", "military exercise"]),
        ("conflit", "Guerre, conflit, révolte", ["war", "conflict", "insurgency", "civil war", "rebellion", "uprising",
                                                 "revolt", "insurrection", "mutiny"]),
    ]),
    ("politique", "Politique", [
        ("election", "Élection, référendum", ["election", "referendum", "primary election", "by-election"]),
        ("traite", "Traité, accord", ["treaty", "agreement", "accord", "pact", "convention", "protocol"]),
        ("conference", "Conférence, sommet", ["conference", "summit", "congress", "assembly", "meeting"]),
        ("revolution", "Révolution, coup d'État", ["revolution", "coup", "putsch", "self-coup"]),
        ("independance", "Indépendance, frontières", ["independence", "declaration of independence", "partition",
                                                      "annexation", "unification", "secession", "dissolution"]),
        ("investiture", "Investiture, couronnement", ["inauguration", "coronation", "investiture", "accession"]),
        ("assassinat", "Assassinat politique", ["assassination", "attempted assassination", "regicide"]),
        ("diplomatie", "Diplomatie, crise", ["state visit", "diplomatic", "political crisis", "crisis", "ultimatum"]),
    ]),
    ("societe", "Société", [
        ("manifestation", "Manifestation, émeute", ["protest", "demonstration", "riot", "march", "civil disobedience"]),
        ("greve", "Grève", ["strike", "general strike", "lockout"]),
        ("migration", "Exode, migration", ["exodus", "migration", "refugee", "population transfer", "expulsion"]),
    ]),
    ("justice", "Justice, crime", [
        ("proces", "Procès", ["trial", "court case", "legal case", "tribunal", "lawsuit"]),
        ("attentat", "Attentat", ["terrorist attack", "terrorism", "attack", "hijacking", "hostage"]),
        ("crime", "Crime, exécution", ["murder", "crime", "execution", "kidnapping", "robbery", "heist"]),
    ]),
    ("religion", "Religion", [
        ("religion", "Religion", ["conclave", "council", "synod", "canonization", "pilgrimage", "papal", "religious"]),
    ]),
    ("economie", "Économie", [
        ("crise", "Crise financière", ["financial crisis", "stock market crash", "recession", "depression",
                                       "bank run", "hyperinflation", "default", "economic crisis"]),
        ("commerce", "Commerce, foire", ["world's fair", "trade", "exposition", "fair", "monetary reform", "currency"]),
    ]),
    ("science", "Sciences, techniques", [
        ("spatial", "Espace", ["spaceflight", "space mission", "satellite launch", "rocket launch", "space probe",
                               "crewed spaceflight", "space launch", "moon landing"]),
        ("nucleaire", "Nucléaire", ["nuclear test", "nuclear weapons test", "nuclear explosion"]),
        ("decouverte", "Découverte, expérience", ["discovery", "experiment", "observation", "invention", "first flight",
                                                   "record"]),
        ("expedition", "Expédition, exploration", ["expedition", "exploration", "voyage", "ascent"]),
        ("astronomie", "Astronomie", ["eclipse", "solar eclipse", "lunar eclipse", "comet", "supernova", "meteor",
                                      "transit", "impact event"]),
    ]),
    ("catastrophe", "Catastrophes", [
        ("seisme", "Séisme, tsunami", ["earthquake", "tsunami", "landslide", "avalanche"]),
        ("meteo", "Tempête, inondation", ["hurricane", "cyclone", "typhoon", "storm", "flood", "drought", "tornado",
                                          "blizzard", "heat wave", "cold wave", "weather"]),
        ("volcan", "Volcan", ["eruption", "volcanic eruption"]),
        ("epidemie", "Épidémie", ["epidemic", "pandemic", "outbreak", "disease outbreak"]),
        ("famine", "Famine", ["famine"]),
        ("accident", "Accident, incendie", ["accident", "crash", "shipwreck", "aviation accident", "derailment",
                                            "explosion", "fire", "stampede", "collapse", "disaster", "sinking",
                                            "mining accident", "industrial disaster"]),
    ]),
    ("culture", "Culture", [
        ("cinema", "Cinéma, récompense", ["film festival", "award ceremony", "ceremony", "premiere"]),
        ("musique", "Musique, concert", ["music festival", "festival", "concert", "concert tour", "song contest"]),
        ("exposition", "Exposition", ["exhibition", "art exhibition", "biennale"]),
        ("litterature", "Livre, littérature", ["literary work", "novel", "book", "poem", "play", "essay", "manifesto"]),
        ("art", "Peinture, sculpture, architecture", ["painting", "sculpture", "artwork", "building", "monument",
                                                     "photograph", "work of art"]),
        ("jeu", "Jeu vidéo, bande dessinée", ["video game", "comic", "manga", "board game"]),
        ("concours", "Concours", ["contest", "competition", "beauty pageant"]),
    ]),
    ("sport", "Sport", [
        ("jo", "Jeux olympiques", ["olympic games", "olympics", "winter olympic games", "summer olympic games",
                                   "paralympic games"]),
        ("course", "Course", ["race", "grand prix", "cycling race", "marathon", "rally", "regatta", "stage race"]),
        ("championnat", "Championnat, coupe", ["championship", "world cup", "tournament", "cup final", "final",
                                               "league", "season", "cup", "games"]),
        ("match", "Match", ["match", "game", "bout", "fight"]),
    ]),
]

# Types qui ne sont pas des événements datés (œuvres, groupes, objets...).
NON_EVENT = [
    "film", "animated film", "short film", "animated short film", "documentary film", "television series",
    "television program", "episode", "album", "single", "song", "video game", "book", "novel", "literary work",
    "magazine", "newspaper", "periodical", "painting", "sculpture", "artwork", "photograph",
    "military unit", "squadron", "regiment", "division", "brigade", "battalion", "fleet", "wing", "geschwader",
    "army", "corps", "unit", "organization", "organisation", "company", "business", "political party",
    "sports team", "club", "human", "ship", "aircraft", "building", "bridge", "airport", "school", "university",
    "award", "decoration", "order", "medal", "government", "cabinet", "legislature", "parliament term",
    "position", "office", "list", "class", "family", "name", "taxon", "fictional", "comic", "manga",
]

THEMES = [t[0] for t in TAXONOMY] + ["autre"]


def _rx(words):
    return re.compile(r"\b(" + "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True)) + r")s?\b")


# Sous-thèmes réservés aux œuvres (calque « Œuvres ») : jamais utilisés pour
# classer un événement, sinon un roman deviendrait un « événement ».
WORK_ONLY = {"litterature", "art", "jeu"}
_PATTERNS = [(theme, sub, _rx(words)) for theme, _, subs in TAXONOMY for sub, _, words in subs if sub not in WORK_ONLY]
_NON_EVENT = _rx(NON_EVENT)
# Expressions à retirer avant de chercher un type d'événement : « video game »
# ne doit pas être lu comme « game » (sport), ni « military unit » comme une opération.
_MASK = _rx([w for w in NON_EVENT if " " in w] + ["sports club", "football club", "racing team", "war film",
                                                   "war memorial", "battleship", "warship", "game show"])


def classify_full(type_labels: list[str]) -> tuple[str, str, int]:
    """-> (thème, sous-thème, is_event).

    On regarde d'abord si l'un des types ressemble à un événement connu ;
    sinon, un type d'œuvre / d'organisation / d'objet classe l'élément
    « hors événement ».
    """
    text = " ".join(t.lower() for t in type_labels if t)
    masked = _MASK.sub(" ", text)
    for theme, sub, pattern in _PATTERNS:
        if pattern.search(masked):
            return theme, sub, 1
    if _NON_EVENT.search(text):
        return "autre", "", 0
    return "autre", "", 1


def classify(type_labels: list[str]) -> str:
    return classify_full(type_labels)[0]


def taxonomy_json() -> list[dict]:
    return [{"id": t, "name": n, "subs": [{"id": s, "name": sn} for s, sn, _ in subs]} for t, n, subs in TAXONOMY] \
        + [{"id": "autre", "name": "Autre", "subs": []}]


# --- Œuvres (P577) et découvertes (P575) --------------------------------------

_WORK = [
    ("cinema", ["film", "television series", "television program", "documentary", "animated", "episode"]),
    ("musique", ["album", "single", "song", "opera", "symphony", "composition", "musical work"]),
    ("litterature", ["literary work", "novel", "book", "poem", "play", "essay", "manifesto", "written work",
                     "periodical", "newspaper", "magazine", "scholarly article", "treatise"]),
    ("art", ["painting", "sculpture", "artwork", "photograph", "building", "monument", "work of art"]),
    ("jeu", ["video game", "comic", "manga", "board game"]),
]
_WORK_PATTERNS = [(sub, _rx(words)) for sub, words in _WORK]


def classify_work(type_labels: list[str]) -> tuple[str, str]:
    text = " ".join(t.lower() for t in type_labels if t)
    for sub, pattern in _WORK_PATTERNS:
        if pattern.search(text):
            return "culture", sub
    return "culture", ""


# --- Domaines des personnes (P106 occupation) ----------------------------------

PERSON_DOMAINS = [
    ("politique", "Politique", ["politician", "statesman", "monarch", "diplomat", "head of state", "president",
                               "prime minister", "king", "queen", "emperor", "aristocrat", "noble", "revolutionary",
                               "activist", "trade unionist", "lawyer", "judge", "civil servant"]),
    ("guerre", "Militaire", ["military officer", "military personnel", "soldier", "general", "admiral",
                             "military leader", "resistance fighter", "aviator", "fighter pilot"]),
    ("science", "Sciences, techniques", ["physicist", "chemist", "mathematician", "biologist", "astronomer",
                                         "engineer", "inventor", "physician", "scientist", "geologist", "botanist",
                                         "computer scientist", "economist", "psychologist", "explorer",
                                         "astronaut", "naturalist", "zoologist", "geographer"]),
    ("culture", "Arts, lettres", ["writer", "novelist", "poet", "painter", "sculptor", "composer", "musician",
                                  "singer", "actor", "actress", "film director", "architect", "photographer",
                                  "playwright", "philosopher", "journalist", "screenwriter", "dancer", "artist",
                                  "historian", "comedian", "illustrator"]),
    ("sport", "Sport", ["athlete", "footballer", "association football player", "cyclist", "tennis player",
                        "boxer", "racing driver", "swimmer", "basketball player", "chess player", "player"]),
    ("religion", "Religion", ["priest", "theologian", "bishop", "pope", "rabbi", "imam", "missionary", "monk",
                              "nun", "saint", "religious leader", "cardinal"]),
    ("economie", "Économie, entreprise", ["businessperson", "entrepreneur", "banker", "industrialist",
                                          "merchant", "investor"]),
]
_PERSON_PATTERNS = [(d, _rx(words)) for d, _, words in PERSON_DOMAINS]


def classify_person(occupation_labels: list[str]) -> str:
    """Domaine de la première occupation reconnue (l'ordre de Wikidata compte)."""
    for occ in occupation_labels:
        o = (occ or "").lower()
        for d, pattern in _PERSON_PATTERNS:
            if pattern.search(o):
                return d
    return "autre"


def person_domains_json() -> list[dict]:
    return [{"id": d, "name": n} for d, n, _ in PERSON_DOMAINS] + [{"id": "autre", "name": "Autre"}]
