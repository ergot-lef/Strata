"""Conversion des dates Wikidata en « années décimales ».

Toute la frise utilise un seul nombre flottant pour le temps : l'année
décimale (1945.35 = début mai 1945). Un float64 garde une précision de
quelques microsecondes autour de l'an 2000 et d'environ deux minutes vers
−13,8 milliards d'années : la même échelle va donc du Big Bang à l'heure
près.
"""

import re

# Précisions Wikidata (wikibase:timePrecision)
PRECISION_NAMES = {
    0: "milliard d'années",
    1: "centaine de millions d'années",
    2: "dizaine de millions d'années",
    3: "million d'années",
    4: "centaine de milliers d'années",
    5: "dizaine de milliers d'années",
    6: "millénaire",
    7: "siècle",
    8: "décennie",
    9: "année",
    10: "mois",
    11: "jour",
    12: "heure",
    13: "minute",
    14: "seconde",
}

# Durée (en années) couverte par une valeur d'une précision donnée.
PRECISION_SPAN = {
    0: 1e9, 1: 1e8, 2: 1e7, 3: 1e6, 4: 1e5, 5: 1e4, 6: 1e3, 7: 100.0,
    8: 10.0, 9: 1.0, 10: 1 / 12, 11: 1 / 365.25, 12: 1 / 8766,
    13: 1 / 525960, 14: 1 / 31557600,
}

_TIME_RE = re.compile(r"^([+-]?)(\d+)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$")
_CUMUL = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]


def is_leap(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def fyear(year: int, month: int = 1, day: int = 1, hour: float = 0.0) -> float:
    """Année décimale d'une date du calendrier grégorien proleptique."""
    month = min(max(month, 1), 12)
    day = max(day, 1)
    leap = is_leap(year)
    doy = _CUMUL[month - 1] + (day - 1) + (1 if leap and month > 2 else 0)
    return year + (doy + hour / 24.0) / (366 if leap else 365)


def parse_wikidata_time(value: str, api: bool = False) -> float | None:
    """'+1945-05-08T00:00:00Z' -> année décimale (numérotation astronomique :
    l'année 0 = 1 av. J.-C., l'année −499 = 500 av. J.-C.).

    Le service SPARQL exporte déjà en astronomique (XSD 1.1). L'API JSON
    (api=True) écrit les années historiques : « -0500 » = 500 av. J.-C.,
    sans année 0, d'où le décalage d'un an avant notre ère.
    """
    m = _TIME_RE.match(value.strip())
    if not m:
        return None
    sign, y, mo, d, h, mi, s = m.groups()
    year = int(y) * (-1 if sign == "-" else 1)
    if api and year < 0:
        year += 1
    hour = int(h) + int(mi) / 60 + int(s) / 3600
    return fyear(year, int(mo), int(d), hour)


def span_for(precision: int | None) -> float:
    if precision is None:
        return PRECISION_SPAN[11]
    return PRECISION_SPAN.get(int(precision), PRECISION_SPAN[11])


def from_fyear(t: float) -> tuple[int, int, int, int, int, int]:
    """Année décimale -> (année, mois, jour, heure, minute, seconde)."""
    y = int(t // 1)
    leap = is_leap(y)
    secs = round((t - y) * (366 if leap else 365) * 86400)
    doy, rem = divmod(secs, 86400)
    m = 12
    for i in range(1, 12):
        if doy < _CUMUL[i] + (1 if leap and i >= 2 else 0):
            m = i
            break
    d = doy - (_CUMUL[m - 1] + (1 if leap and m > 2 else 0)) + 1
    return y, m, d, rem // 3600, rem % 3600 // 60, rem % 60


def to_xsd(t: float) -> str:
    """Année décimale -> littéral xsd:dateTime (année astronomique)."""
    y, m, d, h, mi, s = from_fyear(t)
    if m == 12 and d > 31:  # arrondi en fin d'année
        y, m, d = y + 1, 1, 1
    sign = "-" if y < 0 else ""
    return f"{sign}{abs(y):04d}-{m:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}Z"
