import * as T from "./time.js";

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

const LANGS = ["fr", "en", "de"];
const ZOOMS = { ere: null, siecle: 100, annee: 1.2, mois: 31 * T.DAY, jour: 1.2 * T.DAY, heure: 3 * T.HOUR };
const MIN_SPAN = 0.5 * T.HOUR;
const BIG_BANG = -T.AGE_UNIVERSE;
const POINT_ROWS = 3;
const BAR_ROWS = 2;
const ROW_H = 28;
const BAR_H = 22;
const PER_LANE = 40;
const WORLD = "OWID_WRL";
const LINK_KINDS = {
  cause: "Cause", consequence: "Conséquence", precede: "Précédé de", suit: "Suivi de",
  partie_de: "Fait partie de", comprend: "Comprend", evenement: "Événement clé", lie: "Lié à",
};

// Repères de la vue d'ensemble (âges connus, en années avant aujourd'hui)
const OVERVIEW_MARKS = [
  [13.8e9, "Big Bang"], [4.54e9, "Terre"], [66e6, "Fin des dinosaures"],
  [3e5, "Homo sapiens"], [5000, "Écriture"], [260, "Révolution industrielle"], [1, "1 an"],
];

const NOW = T.nowFyear();

const state = {
  t0: T.fyear(1945, 4, 23), t1: T.fyear(1945, 5, 24),
  log: false,
  lang: "fr",
  taxonomy: [],
  themesOff: new Set(),     // thèmes décochés
  subOff: new Set(),        // « theme.sous-theme » décochés
  includeOther: false,
  lanes: [],                // [{id, name, qids, iso3, tz, on}]
  countryLabels: {},
  countryIso: {},
  series: [],
  worldSeries: null, laneSeries: null,
  worldPts: [], lanePts: {}, seriesMeta: {},
  events: [],
  selected: null,           // qid sélectionné
  detail: null,             // fiche complète (/api/event)
  hoverT: null,
  stats: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssNum = (name, dflt) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || dflt;

async function api(path, params = {}, signal) {
  const url = new URL(path, location.href);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

// Préférences gardées dans le navigateur (facultatif : peut échouer)
function savePrefs() {
  try {
    localStorage.setItem("strata-prefs", JSON.stringify({
      lang: state.lang, themesOff: [...state.themesOff], subOff: [...state.subOff], includeOther: state.includeOther,
      worldSeries: state.worldSeries, laneSeries: state.laneSeries,
      lanesOn: Object.fromEntries(state.lanes.map((l) => [l.id, l.on])),
    }));
  } catch (e) { /* stockage indisponible */ }
}
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem("strata-prefs") || "{}"); } catch (e) { return {}; }
}

// ---------------------------------------------------------------------------
// Échelle : linéaire ou logarithmique (âge)
// ---------------------------------------------------------------------------

const U = (t) => (state.log ? T.logU(t, NOW) : t);
const UI = (u) => (state.log ? T.logT(u, NOW) : u);

function laneWidth() {
  return Math.max(100, $("timeline").clientWidth - cssNum("--lane-label", 150));
}
const X = (t, w = laneWidth()) => ((U(t) - U(state.t0)) / (U(state.t1) - U(state.t0))) * w;
const tAt = (x, w = laneWidth()) => UI(U(state.t0) + (x / w) * (U(state.t1) - U(state.t0)));

function setViewU(u0, u1) {
  let lo, hi, minSpan;
  if (state.log) {
    lo = T.logU(BIG_BANG, NOW); hi = T.logU(NOW, NOW); minSpan = 1e-4;
  } else {
    const span = u1 - u0;
    lo = BIG_BANG - Math.abs(span) * 0.02; hi = NOW + Math.max(span * 0.1, T.DAY); minSpan = MIN_SPAN;
  }
  let span = Math.max(minSpan, u1 - u0);
  if (span > hi - lo) span = hi - lo;
  let c = (u0 + u1) / 2;
  if (c - span / 2 < lo) c = lo + span / 2;
  if (c + span / 2 > hi) c = hi - span / 2;
  state.t0 = UI(c - span / 2);
  state.t1 = UI(c + span / 2);
  scheduleRender();
  scheduleFetch();
  scheduleHash();
}
const setView = (t0, t1) => setViewU(U(t0), U(t1));

function zoomAround(t, factor) {
  const uc = U(t), u0 = U(state.t0), u1 = U(state.t1);
  setViewU(uc - (uc - u0) * factor, uc + (u1 - uc) * factor);
}

function centerOn(t, span) {
  if (state.log) setScale(false, false);
  setView(t - span / 2, t + span / 2);
}

function setScale(log, refit = true) {
  if (state.log === log) return;
  state.log = log;
  $("scale-log").classList.toggle("on", log);
  $("scale-lin").classList.toggle("on", !log);
  if (refit && log) { state.t0 = BIG_BANG; state.t1 = NOW; }
  if (!log && state.t1 > NOW + 1) state.t1 = NOW;
  setView(state.t0, state.t1);
}

// ---------------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------------

let fetchTimer = null;
let fetchCtl = null;
function scheduleFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(fetchEvents, 220);
}

function activeQids() {
  return [...new Set(state.lanes.filter((l) => l.on).flatMap((l) => l.qids))];
}

function pinnedQids() {
  const d = state.detail;
  if (!d) return [];
  return [d.qid, ...d.links.filter((l) => l.t0 !== null).map((l) => l.qid), ...d.same_day.map((e) => e.qid)].slice(0, 60);
}

async function fetchEvents() {
  const qids = activeQids();
  if (!qids.length) { state.events = []; scheduleRender(); return; }
  fetchCtl?.abort();
  fetchCtl = new AbortController();
  const span = state.t1 - state.t0;
  const themes = state.taxonomy.map((t) => t.id).filter((id) => !state.themesOff.has(id));
  $("loading").hidden = false;
  try {
    const data = await api("/api/events", {
      from: state.t0 - span * 0.25, to: state.t1 + span * 0.25,
      countries: qids.join(","), themes: themes.join(","), sub_off: [...state.subOff].join(","),
      include_other: state.includeOther ? 1 : 0, per_lane: PER_LANE, extra: pinnedQids().join(","),
    }, fetchCtl.signal);
    state.events = data.events;
    scheduleRender();
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  } finally {
    $("loading").hidden = true;
  }
}

function laneIso(lane) {
  return lane.iso3 || (lane.qids.length === 1 ? state.countryIso[lane.qids[0]] : null);
}

async function loadWorldSeries() {
  state.worldPts = [];
  if (state.worldSeries) {
    const d = await api("/api/series", { name: state.worldSeries, entities: WORLD });
    state.worldPts = d.points[WORLD] || [];
    state.seriesMeta[state.worldSeries] = d.meta;
  }
  scheduleRender();
}

async function loadLaneSeries() {
  state.lanePts = {};
  if (state.laneSeries) {
    const isos = [...new Set(state.lanes.filter((l) => l.on).map(laneIso).filter(Boolean))];
    if (isos.length) {
      const d = await api("/api/series", { name: state.laneSeries, entities: isos.join(",") });
      state.lanePts = d.points;
      state.seriesMeta[state.laneSeries] = d.meta;
    }
  }
  scheduleRender();
}

function seriesAt(p, t) {
  if (!p || !p.length || t < p[0][0] || t > p[p.length - 1][0]) return null;
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= t) lo = m; else hi = m; }
  const [ta, va] = p[lo], [tb, vb] = p[hi];
  return tb === ta ? va : va + ((t - ta) / (tb - ta)) * (vb - va);
}

function labelOf(text) {
  const order = [state.lang, ...LANGS.filter((l) => l !== state.lang)];
  for (const l of order) if (text?.[l]?.label) return text[l].label;
  return null;
}
const eventLabel = (ev) => labelOf(ev.text) || ev.qid;
function linkLabel(l) {
  const order = [state.lang, ...LANGS.filter((x) => x !== state.lang)];
  for (const x of order) if (l.labels?.[x]) return l.labels[x];
  return l.qid;
}

function themeName(id) { return state.taxonomy.find((t) => t.id === id)?.name || "Autre"; }
function subName(th, sub) { return state.taxonomy.find((t) => t.id === th)?.subs.find((s) => s.id === sub)?.name || ""; }

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const w = laneWidth();
  const span = state.t1 - state.t0;
  const center = tAt(w / 2, w);
  $("title").textContent = !state.log ? T.formatTitle(center, span, NOW)
    : state.t0 <= BIG_BANG + 1e6 && state.t1 >= NOW - 1 ? "Du Big Bang à aujourd'hui"
    : `Autour de : ${T.formatAgeLabel(NOW - center)}`;

  let best = null, bestD = Infinity;
  if (!state.log) {
    for (const [k, s] of Object.entries(ZOOMS)) {
      const d = Math.abs(Math.log((s ?? NOW - BIG_BANG) / span));
      if (d < bestD) { bestD = d; best = k; }
    }
  }
  document.querySelectorAll(".zoom button").forEach((b) => b.classList.toggle("on", b.dataset.zoom === best && bestD < 1));

  renderRuler(w);
  renderLanes(w);
  renderWorldCurve(w);
  renderOverview();
  renderLocalTimes();
  renderLinks();
}

function renderRuler(w) {
  const ticks = state.log ? T.logTicks(state.t0, state.t1, w, 80, NOW) : T.ticks(state.t0, state.t1, w, 90, NOW).ticks;
  $("ruler").innerHTML = ticks.map((k) => `<div class="tick" style="left:${X(k.t, w).toFixed(1)}px">${esc(k.label)}</div>`).join("");
  $("ruler-caption").textContent = state.log ? "âge (log)" : (state.t1 - state.t0 < 40 * T.DAY ? "temps UTC" : "");
  const label = cssNum("--lane-label", 150);
  document.querySelectorAll(".gridline").forEach((g) => g.remove());
  const tl = $("timeline");
  for (const k of ticks) {
    const g = document.createElement("div");
    g.className = "gridline";
    g.style.left = `${label + X(k.t, w)}px`;
    tl.appendChild(g);
  }
}

function placeRow(rows, x0, x1) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].every(([a, b]) => x1 + 6 <= a || x0 >= b + 6)) {
      rows[i].push([x0, x1]);
      return i;
    }
  }
  return -1;
}

function areaPath(samples, w, h, max, top = 0.15) {
  let area = "", line = "", seg = [];
  const flush = () => {
    if (seg.length > 1) {
      const p = seg.map(([x, y]) => `${x} ${y.toFixed(1)}`);
      line += `M${p.join(" L")} `;
      area += `M${seg[0][0]} ${h} L${p.join(" L")} L${seg[seg.length - 1][0]} ${h} Z `;
    }
    seg = [];
  };
  for (const [x, v] of samples) {
    if (v === null) { flush(); continue; }
    seg.push([x, h - (v / max) * h * (1 - top)]);
  }
  flush();
  return { area, line };
}

function sampleSeries(pts, w) {
  const out = [];
  const step = Math.max(2, Math.floor(w / 240));
  for (let x = 0; x <= w; x += step) out.push([x, seriesAt(pts, tAt(x, w))]);
  return out;
}

function formatValue(v, meta) {
  const unit = meta?.unit ? ` ${meta.unit}` : "";
  if (meta?.unit?.startsWith("%") || meta?.unit === "ans") return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(v)}${unit}`;
  return `${T.formatNumber(v)}${unit}`;
}

function renderLanes(w) {
  const lanes = state.lanes.filter((l) => l.on);
  const pinned = new Set(pinnedQids());
  const html = [];
  const center = tAt(w / 2, w);
  const laneMeta = state.seriesMeta[state.laneSeries];
  for (const lane of lanes) {
    const qset = new Set(lane.qids);
    const evs = state.events
      .filter((e) => e.countries.some((c) => qset.has(c)))
      .filter((e) => pinned.has(e.qid) || (!state.themesOff.has(e.theme) && !state.subOff.has(`${e.theme}.${e.subtheme}`)))
      .sort((a, b) => (pinned.has(b.qid) - pinned.has(a.qid)) || b.sitelinks - a.sitelinks);
    const barRows = Array.from({ length: BAR_ROWS }, () => []);
    const ptRows = Array.from({ length: POINT_ROWS }, () => []);
    const items = [];
    let visible = 0;
    for (const ev of evs) {
      const x0 = X(ev.t0, w), x1 = X(ev.t1, w);
      if (x1 < 0 || x0 > w) continue;
      visible++;
      const label = eventLabel(ev);
      const cls = [`th-${ev.theme}`];
      if (state.selected === ev.qid) cls.push("sel");
      if (ev.precision !== null && ev.precision < 11 && !ev.span) cls.push("vague");
      if (!ev.is_event) cls.push("other");
      const title = `${label} — ${T.formatDateShort(ev.t0, ev.precision, NOW)}`;
      const isBar = ev.span || x1 - x0 > 60;
      if (isBar) {
        const a = Math.max(x0, -2), b = Math.min(x1, w + 2);
        const row = placeRow(barRows, a, b);
        if (row < 0) { items.push(`<div class="dot th-${ev.theme}" style="left:${a.toFixed(1)}px" title="${esc(title)}"></div>`); continue; }
        const top = POINT_ROWS * ROW_H + 6 + row * BAR_H;
        items.push(`<button class="ev bar${ev.span ? " span" : ""} ${cls.join(" ")}" data-qid="${ev.qid}" title="${esc(title)}" style="left:${a.toFixed(1)}px;width:${Math.max(b - a, 8).toFixed(1)}px;top:${top}px">${esc(label)}</button>`);
      } else {
        const wl = Math.min(label.length * 6.6 + 20, 280);
        const row = placeRow(ptRows, x0, x0 + wl);
        if (row < 0) { items.push(`<div class="dot th-${ev.theme}" style="left:${x0.toFixed(1)}px" title="${esc(title)}"></div>`); continue; }
        const top = 6 + row * ROW_H;
        items.push(`<div class="pin th-${ev.theme}" style="left:${x0.toFixed(1)}px;top:${top + 24}px"></div>`);
        items.push(`<button class="ev ${cls.join(" ")}" data-qid="${ev.qid}" title="${esc(title)}" style="left:${x0.toFixed(1)}px;max-width:${wl.toFixed(0)}px;top:${top}px">${esc(label)}</button>`);
      }
    }
    const h = POINT_ROWS * ROW_H + BAR_ROWS * BAR_H + 14;

    // Courbe du pays en fond du couloir (échelle propre au couloir)
    let curve = "", valTxt = "";
    const iso = laneIso(lane);
    const pts = iso ? state.lanePts[iso] : null;
    if (state.laneSeries && pts && pts.length > 1) {
      const samples = sampleSeries(pts, w);
      const vals = samples.map((s) => s[1]).filter((v) => v !== null);
      if (vals.length) {
        const max = Math.max(...vals.map(Math.abs)) || 1;
        const { area, line } = areaPath(samples, w, h, max, 0.25);
        curve = `<svg class="lane-curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${area}" fill="var(--lane-curve)" fill-opacity=".035"></path><path d="${line}" fill="none" stroke="var(--lane-curve)" stroke-opacity=".55" stroke-width="1.5" vector-effect="non-scaling-stroke"></path></svg>`;
      }
      const v = seriesAt(pts, center);
      if (v !== null) valTxt = `≈ ${formatValue(v, laneMeta)}`;
    }
    html.push(`<div class="lane" data-lane="${lane.id}"><div class="lane-name">${esc(lane.name)}<span class="count">${visible} événement${visible > 1 ? "s" : ""}</span>${valTxt ? `<span class="lane-val" title="${esc(laneMeta?.label || "")}">${esc(valTxt)}</span>` : ""}</div><div class="lane-body" style="height:${h}px">${curve}${items.join("")}</div></div>`);
  }
  $("lanes").innerHTML = html.join("");

  const empty = $("empty");
  if (state.stats && state.stats.events === 0) {
    empty.hidden = false;
    empty.innerHTML = `La base est vide. Lance le collecteur, par exemple :<br><code>python collector/collect.py events --from 1939 --to 1946</code><br>puis recharge la page.`;
  } else if (!lanes.length) {
    empty.hidden = false;
    empty.textContent = "Aucun couloir sélectionné : coche des pays dans la colonne de gauche.";
  } else {
    empty.hidden = true;
  }
}

function renderWorldCurve(w) {
  const svg = $("curve");
  const valEl = $("series-value");
  const p = state.worldPts;
  if (!state.worldSeries || p.length < 2) { svg.innerHTML = ""; valEl.textContent = ""; return; }
  const h = 300;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const samples = sampleSeries(p, w);
  const vals = samples.map((s) => s[1]).filter((v) => v !== null);
  if (!vals.length) svg.innerHTML = "";
  else {
    const { area, line } = areaPath(samples, w, h, Math.max(...vals.map(Math.abs)) || 1);
    svg.innerHTML = `<path d="${area}" fill="var(--curve)" fill-opacity=".07"></path><path d="${line}" fill="none" stroke="var(--curve)" stroke-opacity=".45" stroke-width="2" vector-effect="non-scaling-stroke"></path>`;
  }
  const meta = state.seriesMeta[state.worldSeries];
  const v = seriesAt(p, tAt(w / 2, w));
  valEl.textContent = v === null ? `${meta?.label ?? state.worldSeries} (monde) : pas de donnée à cette date`
    : `${meta?.label ?? state.worldSeries} (monde) ≈ ${formatValue(v, meta)}`;
}

function renderOverview() {
  const bar = $("overview");
  const a = T.overviewX(state.t0, NOW) * 100, b = T.overviewX(state.t1, NOW) * 100;
  bar.innerHTML = OVERVIEW_MARKS.map(([age, name]) => `<div class="mark" style="left:${(T.overviewX(NOW - age, NOW) * 100).toFixed(2)}%">${esc(name)}</div>`).join("")
    + `<div class="view" style="left:${a.toFixed(2)}%;width:${Math.max(b - a, 0.4).toFixed(2)}%"></div>`;
}

// Heure locale de chaque couloir sous le curseur (zoom au jour ou plus fin)
const tzFormats = {};
function localTime(t, tz) {
  const { y, m, d, h } = T.fromFyear(t);
  if (y < 1 || y > 9999) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, Math.round(h * 60), 0, 0);
  try {
    tzFormats[tz] ??= new Intl.DateTimeFormat("fr-FR", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return tzFormats[tz].format(dt);
  } catch (e) { return null; }
}

function renderLocalTimes() {
  document.querySelectorAll(".local-time").forEach((e) => e.remove());
  const span = state.t1 - state.t0;
  if (state.hoverT === null || state.log || span > 6 * T.DAY) return;
  const x = X(state.hoverT);
  for (const lane of state.lanes.filter((l) => l.on && l.tz)) {
    const body = document.querySelector(`.lane[data-lane="${lane.id}"] .lane-body`);
    const txt = localTime(state.hoverT, lane.tz);
    if (!body || !txt) continue;
    const el = document.createElement("div");
    el.className = "local-time";
    el.style.left = `${x}px`;
    el.textContent = `${txt}${lane.tzName ? ` (${lane.tzName})` : ""}`;
    body.appendChild(el);
  }
}

// Fils entre l'événement sélectionné et ses liens / le même jour
function renderLinks() {
  const svg = $("links-layer");
  const d = state.detail;
  document.querySelectorAll(".ev.linked").forEach((e) => e.classList.remove("linked"));
  if (!d) { svg.innerHTML = ""; return; }
  const tl = $("timeline").getBoundingClientRect();
  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left - tl.left + Math.min(r.width, 60) / 2, r.top - tl.top + r.height / 2]; };
  const from = document.querySelector(`.ev[data-qid="${d.qid}"]`);
  if (!from) { svg.innerHTML = ""; return; }
  const [x0, y0] = center(from);
  const parts = [];
  const targets = [
    ...d.links.filter((l) => l.t0 !== null).map((l) => [l.qid, "link"]),
    ...d.same_day.map((e) => [e.qid, "same"]),
  ];
  const done = new Set();
  for (const [qid, kind] of targets) {
    if (done.has(qid) || qid === d.qid) continue;
    done.add(qid);
    const el = document.querySelector(`.ev[data-qid="${qid}"]`);
    if (!el) continue;
    el.classList.add("linked");
    const [x1, y1] = center(el);
    const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - Math.max(20, Math.abs(x1 - x0) * 0.15);
    parts.push(`<path d="M${x0} ${y0} Q${mx} ${my} ${x1} ${y1}" fill="none" stroke="var(--accent-2)" stroke-width="2" ${kind === "same" ? 'stroke-dasharray="5 4" stroke-opacity=".7"' : ""}></path>`);
  }
  svg.innerHTML = parts.join("");
}

// ---------------------------------------------------------------------------
// Fiche détail
// ---------------------------------------------------------------------------

async function openDetail(qid, { center = false } = {}) {
  const { event: ev } = await api("/api/event", { qid });
  if (!ev) return;
  state.selected = qid;
  state.detail = ev;
  if (center) {
    const span = state.t1 - state.t0;
    const inView = ev.t0 >= state.t0 && ev.t0 <= state.t1;
    if (!inView || state.log) {
      const s = state.log ? Math.max((ev.t1 - ev.t0) * 20, 30 * T.DAY) : span;
      centerOn(ev.span ? (ev.t0 + ev.t1) / 2 : ev.t0, s);
    }
  }
  renderDetail();
  // La fiche occupe la droite de la frise : on décale la vue pour que
  // l'événement (et ses liens) restent visibles à gauche de la fiche.
  const w = laneWidth();
  const x = X(ev.t0, w);
  const panel = $("detail").offsetWidth + 40;
  if (x > w - panel - 220 || x < 0) {
    const du = ((x - w * 0.3) / w) * (U(state.t1) - U(state.t0));
    setViewU(U(state.t0) + du, U(state.t1) + du);
  }
  scheduleFetch();
  scheduleRender();
}

function closeDetail() {
  state.selected = null;
  state.detail = null;
  $("detail").hidden = true;
  scheduleRender();
}

function renderDetail() {
  const ev = state.detail;
  const el = $("detail");
  if (!ev) { el.hidden = true; return; }
  const order = [state.lang, ...LANGS.filter((l) => l !== state.lang)];
  const sumLang = order.find((l) => ev.text[l]?.summary);
  const summary = sumLang ? ev.text[sumLang].summary : "";
  const descr = order.map((l) => ev.text[l]?.descr).find(Boolean) || "";
  const countries = ev.countries.map((c) => (c === "_" ? "—" : state.countryLabels[c] || c)).join(", ");
  const date = T.formatDateShort(ev.t0, ev.precision, NOW) + (ev.span ? ` → ${T.formatDateShort(ev.t1, ev.precision, NOW)}` : "");
  const article = (l) => `https://${l}.wikipedia.org/wiki/${encodeURIComponent(ev.text[l].article.replace(/ /g, "_"))}`;

  const groups = {};
  for (const l of ev.links) (groups[l.kind] ??= []).push(l);
  const linkHtml = Object.entries(LINK_KINDS).filter(([k]) => groups[k]).map(([k, name]) => groups[k].map((l) => {
    const when = l.t0 !== null ? T.formatDateShort(l.t0, l.precision, NOW) : "";
    const inner = `<span class="k">${esc(name)}</span><span>${esc(linkLabel(l))}</span><span class="d">${esc(when)}</span>`;
    return l.t0 !== null
      ? `<li><button data-go="${l.qid}">${inner}</button></li>`
      : `<li><a href="https://www.wikidata.org/wiki/${l.qid}" target="_blank" rel="noopener">${inner}</a></li>`;
  }).join("")).join("");
  const sameHtml = ev.same_day.map((e) => {
    const c = e.countries.map((x) => (x === "_" ? "" : state.countryLabels[x] || "")).filter(Boolean).slice(0, 2).join(", ");
    return `<li><button data-go="${e.qid}"><span class="k">${esc(c || "—")}</span><span>${esc(eventLabel(e))}</span></button></li>`;
  }).join("");

  el.className = `detail th-${ev.theme}`;
  el.innerHTML = `
    <button class="close" aria-label="Fermer la fiche">×</button>
    <h2>${esc(eventLabel(ev))}</h2>
    <div class="muted">${esc(descr)}</div>
    <span class="tag">${esc(themeName(ev.theme))}${ev.subtheme ? ` · ${esc(subName(ev.theme, ev.subtheme))}` : ""}</span>${ev.is_event ? "" : '<span class="tag">hors événement</span>'}
    ${summary ? `<div class="summary">${esc(summary)}<span class="src">Wikipédia ${sumLang.toUpperCase()}${sumLang !== state.lang ? " (pas de résumé dans la langue choisie)" : ""}</span></div>`
      : '<div class="summary muted">Pas de résumé en base. Lance <code>python collector/collect.py summaries</code>.</div>'}
    <dl>
      <dt>Date</dt><dd>${esc(date)}</dd>
      <dt>Précision</dt><dd>${esc(ev.precision_name || "?")}</dd>
      <dt>Pays</dt><dd>${esc(countries)}</dd>
      <dt>Importance</dt><dd>présent dans ${ev.sitelinks} Wikipédias</dd>
    </dl>
    ${linkHtml ? `<h3>Liens</h3><ul class="link-list">${linkHtml}</ul>` : ""}
    ${sameHtml ? `<h3>Le même jour ailleurs</h3><ul class="link-list">${sameHtml}</ul>` : ""}
    <h3>Titres</h3>
    <div class="langs">${LANGS.filter((l) => ev.text[l]?.label).map((l) => `<div><b>${l.toUpperCase()}</b>${esc(ev.text[l].label)}</div>`).join("")}</div>
    <div class="links">${LANGS.filter((l) => ev.text[l]?.article).map((l) => `<a href="${article(l)}" target="_blank" rel="noopener">Wikipédia ${l.toUpperCase()}</a>`).join("")}<a href="https://www.wikidata.org/wiki/${ev.qid}" target="_blank" rel="noopener">Wikidata</a></div>`;
  el.hidden = false;
  el.scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Colonne de gauche
// ---------------------------------------------------------------------------

function renderSidebar() {
  $("themes").innerHTML = state.taxonomy.map((t) => {
    const on = !state.themesOff.has(t.id);
    const subs = t.subs.map((s) => `<label><input type="checkbox" data-sub="${t.id}.${s.id}"${state.subOff.has(`${t.id}.${s.id}`) ? "" : " checked"}${on ? "" : " disabled"}> ${esc(s.name)}<span class="n">${s.n || ""}</span></label>`).join("");
    return `<div class="theme-row th-${t.id}" data-theme-row="${t.id}">
      <div class="theme-head">
        <input type="checkbox" data-theme="${t.id}"${on ? " checked" : ""} aria-label="${esc(t.name)}">
        <button class="expand" ${t.subs.length ? "" : "disabled"} aria-expanded="false"><span class="swatch"></span>${esc(t.name)}<span class="n">${t.n || ""}</span>${t.subs.length ? '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>' : ""}</button>
      </div>
      ${t.subs.length ? `<div class="subs" hidden>${subs}</div>` : ""}
    </div>`;
  }).join("");
  $("include-other").checked = state.includeOther;
  $("langs").innerHTML = LANGS.map((l) => `<button class="lang${state.lang === l ? " on" : ""}" data-lang="${l}" aria-pressed="${state.lang === l}">${l.toUpperCase()}</button>`).join("");
  $("lanes-list").innerHTML = state.lanes.map((l, i) =>
    `<label><input type="checkbox" data-lane="${i}"${l.on ? " checked" : ""}> ${esc(l.name)}</label>`).join("");
  const opt = (list, cur) => [`<option value="">Aucune</option>`,
    ...list.map((s) => `<option value="${esc(s.name)}"${cur === s.name ? " selected" : ""}>${esc(s.label || s.name)}${s.t_min !== null && s.t_min !== undefined ? ` (${T.formatYear(s.t_min, NOW)} → ${T.formatYear(s.t_max, NOW)})` : ""}</option>`)].join("");
  $("series-world").innerHTML = opt(state.series.filter((s) => s.world_points > 0), state.worldSeries);
  $("series-lane").innerHTML = opt(state.series, state.laneSeries);
}

async function loadCountries() {
  const d = await api("/api/countries");
  const grouped = new Set(state.lanes.flatMap((l) => l.qids));
  for (const c of d.countries) {
    state.countryLabels[c.qid] = c.fr || c.en || c.qid;
    if (c.iso3) state.countryIso[c.qid] = c.iso3;
  }
  for (const l of state.lanes) for (const q of l.qids) if (!state.countryLabels[q]) state.countryLabels[q] = l.name;
  const others = d.countries.filter((c) => !grouped.has(c.qid)).slice(0, 100);
  $("other-countries").innerHTML = others.length
    ? others.map((c) => `<label><input type="checkbox" data-add="${c.qid}"${state.lanes.some((l) => l.id === `x-${c.qid}` && l.on) ? " checked" : ""}> ${esc(c.fr || c.en || c.qid)}<span class="n">${c.n}</span></label>`).join("")
    : `<div class="muted">—</div>`;
}

function wireSidebar() {
  $("themes").addEventListener("click", (e) => {
    const b = e.target.closest(".expand");
    if (!b) return;
    const row = b.closest(".theme-row");
    const subs = row.querySelector(".subs");
    if (!subs) return;
    subs.hidden = !subs.hidden;
    row.classList.toggle("open", !subs.hidden);
    b.setAttribute("aria-expanded", String(!subs.hidden));
  });
  $("themes").addEventListener("change", (e) => {
    const th = e.target.dataset.theme, sub = e.target.dataset.sub;
    if (th) {
      e.target.checked ? state.themesOff.delete(th) : state.themesOff.add(th);
      e.target.closest(".theme-row").querySelectorAll("[data-sub]").forEach((i) => { i.disabled = !e.target.checked; });
    } else if (sub) {
      e.target.checked ? state.subOff.delete(sub) : state.subOff.add(sub);
    } else return;
    savePrefs(); scheduleRender(); scheduleFetch();
  });
  $("include-other").addEventListener("change", (e) => {
    state.includeOther = e.target.checked;
    savePrefs(); scheduleFetch();
  });
  $("langs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang]");
    if (!b) return;
    state.lang = b.dataset.lang;
    savePrefs(); renderSidebar(); renderDetail(); scheduleRender();
  });
  $("lanes-list").addEventListener("change", (e) => {
    const i = e.target.dataset.lane;
    if (i === undefined) return;
    state.lanes[+i].on = e.target.checked;
    savePrefs(); scheduleRender(); scheduleFetch(); loadLaneSeries();
  });
  $("other-countries").addEventListener("change", (e) => {
    const q = e.target.dataset.add;
    if (!q) return;
    let lane = state.lanes.find((l) => l.id === `x-${q}`);
    if (!lane) { lane = { id: `x-${q}`, name: state.countryLabels[q] || q, qids: [q], iso3: state.countryIso[q], on: true }; state.lanes.push(lane); }
    lane.on = e.target.checked;
    renderSidebar(); scheduleRender(); scheduleFetch(); loadLaneSeries();
  });
  $("series-world").addEventListener("change", (e) => { state.worldSeries = e.target.value || null; savePrefs(); loadWorldSeries(); });
  $("series-lane").addEventListener("change", (e) => { state.laneSeries = e.target.value || null; savePrefs(); loadLaneSeries(); });
}

// ---------------------------------------------------------------------------
// Interactions sur la frise
// ---------------------------------------------------------------------------

function laneX(clientX) {
  const r = $("timeline").getBoundingClientRect();
  return clientX - r.left - cssNum("--lane-label", 150);
}

function wireTimeline() {
  const tl = $("timeline");
  tl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const x = Math.max(0, laneX(e.clientX));
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(dy)) {
      const du = ((e.deltaX || dy) / laneWidth()) * (U(state.t1) - U(state.t0));
      setViewU(U(state.t0) + du, U(state.t1) + du);
    } else {
      zoomAround(tAt(x), Math.exp(dy * 0.0015));
    }
  }, { passive: false });

  let drag = null;
  tl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".ev")) return;
    drag = { x: e.clientX, u0: U(state.t0), u1: U(state.t1) };
    tl.setPointerCapture(e.pointerId);
    tl.classList.add("dragging");
  });
  tl.addEventListener("pointermove", (e) => {
    const x = laneX(e.clientX);
    const hover = $("hover");
    if (x >= 0 && !drag) {
      hover.hidden = false;
      hover.style.left = `${cssNum("--lane-label", 150) + x}px`;
      const span = state.t1 - state.t0;
      const t = tAt(x);
      state.hoverT = t;
      const prec = state.log ? null : span < 4 * T.DAY ? 12 : span < 120 * T.DAY ? 11 : span < 6 ? 10 : 9;
      hover.firstElementChild.textContent = state.log ? T.formatAgeLabel(NOW - t) : T.formatDateShort(t, prec, NOW);
      renderLocalTimes();
    } else if (!drag) {
      hover.hidden = true;
    }
    if (!drag) return;
    const du = ((e.clientX - drag.x) / laneWidth()) * (drag.u1 - drag.u0);
    setViewU(drag.u0 - du, drag.u1 - du);
  });
  const end = () => { drag = null; tl.classList.remove("dragging"); };
  tl.addEventListener("pointerup", end);
  tl.addEventListener("pointercancel", end);
  tl.addEventListener("pointerleave", () => { $("hover").hidden = true; state.hoverT = null; renderLocalTimes(); });
  tl.addEventListener("dblclick", (e) => {
    if (e.target.closest(".ev")) return;
    const x = laneX(e.clientX);
    if (x >= 0) zoomAround(tAt(x), 0.5);
  });
  tl.addEventListener("click", (e) => {
    const b = e.target.closest(".ev");
    if (b) openDetail(b.dataset.qid);
  });
  tl.addEventListener("keydown", (e) => {
    const du = (U(state.t1) - U(state.t0)) * 0.15;
    const c = tAt(laneWidth() / 2);
    if (e.key === "ArrowLeft") { setViewU(U(state.t0) - du, U(state.t1) - du); e.preventDefault(); }
    else if (e.key === "ArrowRight") { setViewU(U(state.t0) + du, U(state.t1) + du); e.preventDefault(); }
    else if (e.key === "+" || e.key === "=") { zoomAround(c, 0.7); e.preventDefault(); }
    else if (e.key === "-") { zoomAround(c, 1 / 0.7); e.preventDefault(); }
    else if (e.key === "Escape") closeDetail();
  });

  $("detail").addEventListener("click", (e) => {
    if (e.target.closest(".close")) { closeDetail(); return; }
    const b = e.target.closest("[data-go]");
    if (b) openDetail(b.dataset.go, { center: true });
  });

  $("overview").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = T.overviewT((e.clientX - r.left) / r.width, NOW);
    const age = Math.max(NOW - t, T.DAY);
    centerOn(t, Math.min(age * 0.8, NOW - BIG_BANG));
  });

  document.querySelectorAll(".zoom button").forEach((b) => b.addEventListener("click", () => {
    const s = ZOOMS[b.dataset.zoom];
    if (s === null) { setScale(false, false); setView(BIG_BANG, NOW); }
    else centerOn(tAt(laneWidth() / 2), s);
  }));
  $("scale-lin").addEventListener("click", () => setScale(false));
  $("scale-log").addEventListener("click", () => setScale(true));

  $("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    if (dark) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("strata-theme", dark ? "dark" : "light"); } catch (e) { /* rien */ }
    scheduleRender();
  });

  window.addEventListener("resize", scheduleRender);
}

// ---------------------------------------------------------------------------
// Recherche et « aller à »
// ---------------------------------------------------------------------------

function parseGoto(text) {
  const s = text.trim().toLowerCase().replace(",", ".");
  let m = s.match(/^(-?\d{1,6})-(\d{1,2})(?:-(\d{1,2}))?(?:[ t](\d{1,2})(?:h|:\d\d)?)?$/);
  if (m) {
    const y = +m[1];
    const astro = y < 0 ? y + 1 : y;
    const span = m[4] ? 3 * T.HOUR : m[3] ? 3 * T.DAY : 45 * T.DAY;
    return { t: T.fyear(astro, +m[2], +(m[3] || 1), +(m[4] || 0)) + (m[4] ? 0 : m[3] ? 0.5 * T.DAY : 0), span };
  }
  m = s.match(/^([\d.]+)\s*(ga|ma|ka)$/);
  if (m) {
    const age = +m[1] * { ga: 1e9, ma: 1e6, ka: 1e3 }[m[2]];
    return { t: NOW - age, span: age * 0.5 };
  }
  m = s.match(/^(-?[\d.]+(?:e\d+)?)\s*(av\.? ?j\.?-?c\.?)?$/);
  if (m) {
    let y = +m[1];
    if (m[2]) y = -Math.abs(y);
    if (y > 10000) return { t: NOW - y, span: y * 0.5 }; // « 66e6 » = il y a 66 millions d'années
    const astro = y < 0 ? y + 1 : y;
    return { t: astro + 0.5, span: 3 };
  }
  return null;
}

function wireSearch() {
  const input = $("search");
  const list = $("search-results");
  let timer = null;
  let results = [];
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      results = (await api("/api/search", { q })).events;
      list.innerHTML = results.length
        ? results.map((ev, i) => `<li><button data-i="${i}">${esc(eventLabel(ev))}<span class="sub">${esc(T.formatDateShort(ev.t0, ev.precision, NOW))}${ev.is_event ? "" : " · hors événement"}</span></button></li>`).join("")
        : `<li class="muted" style="padding:8px">Aucun résultat</li>`;
      list.hidden = false;
    }, 250);
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const ev = results[+b.dataset.i];
    const span = ev.span ? (ev.t1 - ev.t0) * 1.4 : Math.max((ev.t1 - ev.t0) * 20, 14 * T.DAY);
    centerOn(ev.span ? (ev.t0 + ev.t1) / 2 : ev.t0, span);
    list.hidden = true;
    openDetail(ev.qid);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) list.hidden = true; });

  $("goto").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const g = parseGoto(e.target.value);
    if (g) { centerOn(g.t, g.span); e.target.setCustomValidity(""); }
    else { e.target.setCustomValidity("Format : 1945-05-08, 1945, -500, 66 Ma, 4.5 Ga"); e.target.reportValidity(); }
  });
}

// ---------------------------------------------------------------------------
// Adresse de la page (#c=…&s=…&log=1) pour garder ou partager une vue
// ---------------------------------------------------------------------------

let hashTimer = null;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = (state.t0 + state.t1) / 2, s = state.t1 - state.t0;
    history.replaceState(null, "", `#c=${c.toPrecision(12)}&s=${s.toPrecision(6)}${state.log ? "&log=1" : ""}`);
  }, 300);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const c = parseFloat(p.get("c")), s = parseFloat(p.get("s"));
  if (Number.isFinite(c) && Number.isFinite(s) && s > 0) { state.t0 = c - s / 2; state.t1 = c + s / 2; }
  if (p.get("log") === "1") {
    state.log = true;
    $("scale-log").classList.add("on");
    $("scale-lin").classList.remove("on");
  }
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function init() {
  readHash();
  const prefs = loadPrefs();
  const [lanes, stats, series, themes] = await Promise.all([
    fetch("lanes.json").then((r) => r.json()),
    api("/api/stats"),
    api("/api/series"),
    api("/api/themes"),
  ]);
  state.lanes = lanes.lanes.map((l) => ({ ...l, on: prefs.lanesOn?.[l.id] ?? l.on }));
  state.stats = stats;
  state.series = series.series;
  state.taxonomy = themes.themes;
  state.lang = prefs.lang || "fr";
  state.themesOff = new Set(prefs.themesOff || []);
  state.subOff = new Set(prefs.subOff || []);
  state.includeOther = !!prefs.includeOther;
  const has = (n) => n && state.series.some((s) => s.name === n);
  const withWorld = (n) => n && state.series.some((s) => s.name === n && s.world_points > 0);
  state.worldSeries = prefs.worldSeries !== undefined ? (withWorld(prefs.worldSeries) ? prefs.worldSeries : null)
    : (withWorld("population") ? "population" : null);
  state.laneSeries = prefs.laneSeries !== undefined ? (has(prefs.laneSeries) ? prefs.laneSeries : null)
    : (has("population") ? "population" : null);
  $("db-stats").textContent = stats.events
    ? `${stats.events.toLocaleString("fr-FR")} éléments en base (${T.formatYear(stats.from, NOW)} → ${T.formatYear(stats.to, NOW)})`
    : "Base vide";
  renderSidebar();
  wireSidebar();
  wireTimeline();
  wireSearch();
  await loadCountries().catch(console.error);
  setView(state.t0, state.t1);
  await Promise.all([loadWorldSeries(), loadLaneSeries()]).catch(console.error);
}

init().catch((e) => {
  console.error(e);
  $("empty").hidden = false;
  $("empty").textContent = `Impossible de joindre le serveur local (${e.message}). Lance : python server/server.py`;
});
