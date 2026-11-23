"""Classement grossier des événements en thèmes, d'après le libellé
anglais de leur type Wikidata (P31). Volontairement simple : à affiner."""

import re

THEMES = ["guerre", "politique", "science", "culture", "catastrophe", "sport", "economie", "autre"]

_KEYWORDS = [
    ("guerre", ["battle", "war", "siege", "offensive", "military", "invasion", "bombing",
                "massacre", "conflict", "uprising", "rebellion", "revolt", "attack",
                "operation", "campaign", "surrender", "armistice", "insurgency", "genocide"]),
    ("politique", ["election", "treaty", "referendum", "coup", "summit", "declaration",
                   "conference", "protest", "revolution", "independence", "coronation",
                   "legislation", "constitution", "agreement", "assassination",
                   "demonstration", "state visit", "annexation", "inauguration"]),
    ("catastrophe", ["earthquake", "flood", "disaster", "eruption", "epidemic", "pandemic",
                     "hurricane", "cyclone", "fire", "famine", "tsunami", "accident",
                     "crash", "shipwreck", "explosion", "storm"]),
    ("science", ["launch", "spaceflight", "discovery", "experiment", "eclipse", "expedition",
                 "nuclear test", "invention", "observation", "mission", "comet"]),
    ("sport", ["olympic", "championship", "match", "tournament", "world cup", "grand prix",
               "race", "season", "final", "games"]),
    ("culture", ["festival", "premiere", "exhibition", "film", "album", "concert",
                 "ceremony", "award", "opening", "contest", "exposition", "performance"]),
    ("economie", ["crisis", "crash", "strike", "trade", "economic", "financial", "world's fair"]),
]


_PATTERNS = [
    (theme, re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")s?\b"))
    for theme, words in _KEYWORDS
]


def classify(type_labels: list[str]) -> str:
    text = " ".join(t.lower() for t in type_labels if t)
    for theme, pattern in _PATTERNS:
        if pattern.search(text):
            return theme
    return "autre"
