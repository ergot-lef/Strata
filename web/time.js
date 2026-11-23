// Temps de Strata : une « année décimale » (1945.35 ≈ début mai 1945).
// Mêmes règles que strata/timeutil.py côté Python.

const CUMUL = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

export const HOUR = 1 / 8766;
export const DAY = 1 / 365.2425;
export const AGE_UNIVERSE = 13.8e9;
const DATE_LIMIT = 200000; // au-delà, les objets Date de JS ne suivent plus

export function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function fyear(y, m = 1, d = 1, h = 0) {
  const leap = isLeap(y);
  const doy = CUMUL[m - 1] + (d - 1) + (leap && m > 2 ? 1 : 0);
  return y + (doy + h / 24) / (leap ? 366 : 365);
}

export function fromFyear(t) {
  const y = Math.floor(t);
  const leap = isLeap(y);
  const dayf = (t - y) * (leap ? 366 : 365) + 1e-7; // évite 14 h 59 au lieu de 15 h
  let doy = Math.floor(dayf);
  const h = (dayf - doy) * 24;
  let m = 12;
  for (let i = 1; i < 12; i++) {
    const start = CUMUL[i] + (leap && i >= 2 ? 1 : 0);
    if (doy < start) { m = i; break; }
  }
  const d = doy - (CUMUL[m - 1] + (leap && m > 2 ? 1 : 0)) + 1;
  return { y, m, d, h };
}

export function nowFyear() {
  const n = new Date();
  return fyear(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), n.getUTCHours() + n.getUTCMinutes() / 60);
}

const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

export function formatAge(age) {
  if (age >= 1e9) return `${nf1.format(age / 1e9)} Ga`;
  if (age >= 1e6) return `${nf1.format(age / 1e6)} Ma`;
  if (age >= 1e4) return `${nf1.format(age / 1e3)} ka`;
  return `${Math.round(age)} ans`;
}

// Année astronomique -> libellé : 0 = 1 av. J.-C.
export function formatYear(y, now = nowFyear()) {
  if (y < -10000) return `il y a ${formatAge(now - y)}`;
  const r = Math.round(y);
  if (r <= 0) return `${1 - r} av. J.-C.`;
  return String(r);
}

export function formatNumber(v) {
  if (Math.abs(v) >= 1e9) return `${nf2.format(v / 1e9)} milliards`;
  if (Math.abs(v) >= 1e6) return `${nf1.format(v / 1e6)} millions`;
  return nf1.format(v);
}

function weekday(y, m, d) {
  if (y < 1 || y > 9999) return "";
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return DAYS[dt.getUTCDay()];
}

// Titre de la vue selon le niveau de zoom (span = largeur visible en années).
export function formatTitle(t, span, now = nowFyear()) {
  if (t < -10000 || span > 5000) return formatYear(t, now);
  const { y, m, d, h } = fromFyear(t);
  const year = formatYear(y, now);
  if (span > 1.5) return year;
  if (span > 60 * DAY) return `${MONTHS_LONG[m - 1]} ${year}`;
  const wd = weekday(y, m, d);
  const day = `${wd ? wd + " " : ""}${d === 1 ? "1er" : d} ${MONTHS_LONG[m - 1]} ${year}`;
  if (span > 2 * DAY) return day.charAt(0).toUpperCase() + day.slice(1);
  return `${day.charAt(0).toUpperCase() + day.slice(1)}, ${Math.floor(h)} h`;
}

export function formatDateShort(t, precision, now = nowFyear()) {
  if (precision !== null && precision !== undefined && precision < 9) return formatYear(t, now);
  const { y, m, d, h } = fromFyear(t + 1e-9);
  const year = formatYear(y, now);
  if (precision === 9) return year;
  if (precision === 10) return `${MONTHS_LONG[m - 1]} ${year}`;
  const base = `${d === 1 ? "1er" : d} ${MONTHS_LONG[m - 1]} ${year}`;
  if (precision >= 12) return `${base}, ${Math.floor(h)} h`;
  return base;
}

// --- Graduations ---------------------------------------------------------

const UNITS = [];
for (const n of [1, 3, 6, 12]) UNITS.push({ k: "hour", n, approx: n * HOUR });
for (const n of [1, 2, 7, 14]) UNITS.push({ k: "day", n, approx: n * DAY });
for (const n of [1, 3, 6]) UNITS.push({ k: "month", n, approx: n / 12 });
for (let e = 0; e <= 10; e++) for (const f of [1, 2, 5]) UNITS.push({ k: "year", n: f * 10 ** e, approx: f * 10 ** e });

function toDate(t) {
  const { y, m, d, h } = fromFyear(t);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(Math.floor(h), 0, 0, 0);
  return dt;
}

function dateToFyear(dt) {
  return fyear(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), dt.getUTCHours());
}

export function ticks(t0, t1, widthPx, minPx = 90, now = nowFyear()) {
  const span = t1 - t0;
  const deep = Math.abs(t0) > DATE_LIMIT || Math.abs(t1) > DATE_LIMIT;
  const unit = UNITS.find((u) => (!deep || u.k === "year") && (u.approx / span) * widthPx >= minPx) || UNITS[UNITS.length - 1];
  const out = [];
  if (unit.k === "year") {
    const n = unit.n;
    for (let k = Math.ceil(t0 / n); k * n <= t1 && out.length < 200; k++) {
      // Avant notre ère : graduer en années historiques (500 av. J.-C.,
      // pas l'année astronomique −500 qui vaut 501 av. J.-C.).
      const v = k * n;
      const tt = v < 0 && v > -10000 ? v + 1 : v;
      out.push({ t: tt, label: formatYear(tt, now) });
    }
    return { unit, ticks: out };
  }
  if (unit.k === "month") {
    let { y, m } = fromFyear(t0);
    m = Math.floor((m - 1) / unit.n) * unit.n + 1;
    while (out.length < 200) {
      const t = fyear(y, m, 1);
      if (t > t1) break;
      if (t >= t0) out.push({ t, label: m === 1 ? `${MONTHS[0]} ${formatYear(y, now)}` : MONTHS[m - 1] });
      m += unit.n;
      if (m > 12) { m -= 12; y += 1; }
    }
    return { unit, ticks: out };
  }
  const dt = toDate(t0);
  if (unit.k === "day") {
    dt.setUTCHours(0);
    while (out.length < 200) {
      const t = dateToFyear(dt);
      if (t > t1) break;
      const d = dt.getUTCDate();
      const mo = dt.getUTCMonth();
      if (t >= t0) out.push({ t, label: `${d === 1 ? "1er" : d} ${MONTHS[mo]}` });
      dt.setUTCDate(d + unit.n);
    }
    return { unit, ticks: out };
  }
  dt.setUTCHours(Math.floor(dt.getUTCHours() / unit.n) * unit.n);
  while (out.length < 200) {
    const t = dateToFyear(dt);
    if (t > t1) break;
    const hh = dt.getUTCHours();
    if (t >= t0) out.push({ t, label: hh === 0 ? `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}` : `${hh} h` });
    dt.setUTCHours(hh + unit.n);
  }
  return { unit, ticks: out };
}

// --- Vue d'ensemble logarithmique (du Big Bang à aujourd'hui) -------------

const MIN_AGE = DAY;
const LOG_MAX = Math.log10(AGE_UNIVERSE);
const LOG_MIN = Math.log10(MIN_AGE);

export function overviewX(t, now = nowFyear()) {
  const age = Math.max(now - t, MIN_AGE);
  return Math.min(1, Math.max(0, (LOG_MAX - Math.log10(age)) / (LOG_MAX - LOG_MIN)));
}

export function overviewT(x, now = nowFyear()) {
  return now - 10 ** (LOG_MAX - x * (LOG_MAX - LOG_MIN));
}
