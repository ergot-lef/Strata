import * as T from "./time.js";
import { loadStatic } from "./static-api.js";

// ===========================================================================
// Réglages
// ===========================================================================

const LANGS = ["fr", "en", "de"];
// Langues proposées d'emblée pour comparer les récits (les autres à la demande)
const COMPARE_LANGS = ["fr", "en", "de", "ru", "es", "it", "pl", "ar", "ja", "zh", "id"];
const RTL = new Set(["ar", "he", "fa", "ur", "arz", "azb", "ckb", "ps", "sd", "yi", "ug", "dv"]);
const ZOOMS = { ere: null, siecle: 100, annee: 1.2, mois: 31 * T.DAY, jour: 1.2 * T.DAY, heure: 3 * T.HOUR };
const MIN_SPAN = 0.5 * T.HOUR;
const BIG_BANG = -T.AGE_UNIVERSE;
const POINT_ROWS = 3, BAR_ROWS = 2, LIFE_ROWS = 2;
const ROW_H = 28, BAR_H = 22, LIFE_H = 18, TERM_H = 16;
const PER_LANE = 40, PEOPLE_PER_LANE = 14;
const WORLD = "OWID_WRL";
const DENSITY = "__density";
const LINK_KINDS = {
  cause: "Cause", consequence: "Conséquence", precede: "Précédé de", suit: "Suivi de",
  partie_de: "Fait partie de", comprend: "Comprend", evenement: "Événement clé", lie: "Lié à",
};
const LAYERS = [
  { id: "event", name: "Événements", on: true },
  { id: "discovery", name: "Découvertes, inventions ✦", on: true },
  { id: "work", name: "Œuvres (livres, films, tableaux…) ◆", on: false },
  { id: "other", name: "Hors événements (unités, organisations…)", on: false },
  { id: "people", name: "Vies des personnes", on: true },
  { id: "rulers", name: "Gouvernants", on: true },
  { id: "deep", name: "Temps profond (ères, jalons)", on: true },
  { id: "personal", name: "Ma frise", on: true },
];
const OVERVIEW_MARKS = [
  [13.8e9, "Big Bang"], [4.54e9, "Terre"], [66e6, "Fin des dinosaures"],
  [3e5, "Homo sapiens"], [5000, "Écriture"], [260, "Révolution industrielle"], [1, "1 an"],
];

const NOW = T.nowFyear();
const langNames = (() => { try { return new Intl.DisplayNames(["fr"], { type: "language" }); } catch (e) { return null; } })();
const langName = (code) => { try { return langNames?.of(code) || code; } catch (e) { return code; } };

const state = {
  log: false,
  lang: "fr",
  taxonomy: [], personDomains: [],
  themesOff: new Set(), subOff: new Set(), domainsOff: new Set(),
  layers: Object.fromEntries(LAYERS.map((l) => [l.id, l.on])),
  lanes: [], countryLabels: {}, countryIso: {},
  series: [], worldSeries: null, laneSeries: null, worldPts: [], lanePts: {}, seriesMeta: {},
  personal: [],
  deep: null,
  views: [],
  panel: null,          // { type, ... } contenu du panneau de droite
  detail: null,         // fiche d'événement ouverte
  chain: null,          // { qid, dir, nodes }
  compare: null,        // { qid, pages, loading, all }
  stats: null,
  static: null,         // mode sans serveur
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssNum = (name, dflt) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || dflt;
const labelW = () => cssNum("--lane-label", 150);

async function api(path, params = {}, signal) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (state.static) return state.static.call(path, Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, String(v)])));
  const url = new URL(path, location.href);
  for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

async function apiPost(path, body) {
  if (state.static) throw new Error("indisponible en version en ligne");
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function savePrefs() {
  try {
    localStorage.setItem("strata-prefs", JSON.stringify({
      lang: state.lang, themesOff: [...state.themesOff], subOff: [...state.subOff], domainsOff: [...state.domainsOff],
      layers: state.layers, worldSeries: state.worldSeries, laneSeries: state.laneSeries,
      lanesOn: Object.fromEntries(state.lanes.map((l) => [l.id, l.on])),
    }));
  } catch (e) { /* stockage indisponible */ }
}
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem("strata-prefs") || "{}"); } catch (e) { return {}; }
}

// ===========================================================================
// Vues (une frise, ou deux pour comparer deux époques)
// ===========================================================================

const U = (t) => (state.log ? T.logU(t, NOW) : t);
const UI = (u) => (state.log ? T.logT(u, NOW) : u);

class View {
  constructor(id, main, t0, t1) {
    Object.assign(this, { id, main, t0, t1, events: [], people: [], terms: [], states: [], density: null, hoverT: null, ctl: null, timer: null });
    const el = document.createElement("section");
    el.className = "view";
    el.dataset.view = id;
    el.innerHTML = `
      <div class="view-head">
        ${main ? '<h1 class="vtitle">…</h1>' : '<h2 class="vtitle">…</h2><label class="sr-only" for="goto2">Aller à (2e frise)</label><input id="goto2" class="goto2" placeholder="Aller à : 1918-11-11, 1929…">'}
        <span class="series-value muted"></span><span class="loading muted" hidden>chargement…</span>
        ${main ? "" : '<button class="text-btn close-view">Fermer la 2e frise</button>'}
      </div>
      <div class="timeline" tabindex="0" aria-label="Frise : molette pour zoomer, glisser pour se déplacer, flèches et + − au clavier">
        <svg class="curve" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="ruler-caption"></div>
        <div class="ruler"></div>
        <div class="deep" hidden></div>
        <div class="lanes"></div>
        <div class="before-bb" hidden><button class="bb-btn">Avant le Big Bang : hypothèses</button></div>
        <svg class="links-layer" aria-hidden="true"></svg>
        <div class="hover" hidden><div class="hover-label"></div></div>
        <div class="empty" hidden></div>
      </div>`;
    this.el = el;
    this.tl = el.querySelector(".timeline");
  }
  q(sel) { return this.el.querySelector(sel); }
  width() { return Math.max(100, this.tl.clientWidth - labelW()); }
  X(t, w = this.width()) { return ((U(t) - U(this.t0)) / (U(this.t1) - U(this.t0))) * w; }
  tAt(x, w = this.width()) { return UI(U(this.t0) + (x / w) * (U(this.t1) - U(this.t0))); }
  center() { return this.tAt(this.width() / 2); }
}

const mainView = () => state.views[0];
const otherView = (v) => state.views.find((x) => x !== v);

function setViewU(v, u0, u1, sync = true) {
  let lo, hi, minSpan;
  if (state.log) {
    lo = T.logU(BIG_BANG, NOW); hi = T.logU(NOW, NOW); minSpan = 1e-4;
  } else {
    lo = BIG_BANG - T.AGE_UNIVERSE * 0.3; hi = NOW + Math.max((u1 - u0) * 0.1, T.DAY); minSpan = MIN_SPAN;
  }
  const oldSpan = U(v.t1) - U(v.t0);
  let span = Math.max(minSpan, u1 - u0);
  if (span > hi - lo) span = hi - lo;
  let c = (u0 + u1) / 2;
  if (c - span / 2 < lo) c = lo + span / 2;
  if (c + span / 2 > hi) c = hi - span / 2;
  v.t0 = UI(c - span / 2);
  v.t1 = UI(c + span / 2);
  // Deux époques : même largeur de temps, pour comparer à la même échelle
  const o = otherView(v);
  if (sync && o && Math.abs(span - oldSpan) > 1e-12) {
    const oc = (U(o.t0) + U(o.t1)) / 2;
    setViewU(o, oc - span / 2, oc + span / 2, false);
  }
  scheduleRender();
  scheduleFetch(v);
  scheduleHash();
}
const setView = (v, t0, t1) => setViewU(v, U(t0), U(t1));

function zoomAround(v, t, factor) {
  const uc = U(t), u0 = U(v.t0), u1 = U(v.t1);
  setViewU(v, uc - (uc - u0) * factor, uc + (u1 - uc) * factor);
}

function centerOn(v, t, span) {
  if (state.log) setScale(false, false);
  setView(v, t - span / 2, t + span / 2);
}

function setScale(log, refit = true) {
  if (state.log === log) return;
  state.log = log;
  $("scale-log").classList.toggle("on", log);
  $("scale-lin").classList.toggle("on", !log);
  for (const v of state.views) {
    if (refit && log) { v.t0 = BIG_BANG; v.t1 = NOW; }
    if (v.t1 > NOW + 1) v.t1 = NOW;
    if (log && v.t0 < BIG_BANG) v.t0 = BIG_BANG;
    setView(v, v.t0, v.t1);
  }
}

// ===========================================================================
// Données
// ===========================================================================

function scheduleFetch(v) {
  clearTimeout(v.timer);
  v.timer = setTimeout(() => fetchView(v), 220);
}
const fetchAll = () => state.views.forEach(scheduleFetch);

function activeLanes() {
  const lanes = state.lanes.filter((l) => l.on);
  if (state.layers.personal && !state.static) lanes.push({ id: "me", name: "Ma frise", qids: [], personal: true, on: true });
  return lanes;
}
const activeQids = () => [...new Set(state.lanes.filter((l) => l.on).flatMap((l) => l.qids))];

function pinnedQids() {
  const out = [];
  const d = state.detail;
  if (d) out.push(d.qid, ...d.links.filter((l) => l.t0 !== null).map((l) => l.qid), ...d.same_day.map((e) => e.qid));
  if (state.chain) out.push(...state.chain.nodes.filter((n) => n.t0 !== null).map((n) => n.qid));
  return [...new Set(out)].slice(0, 100);
}

async function fetchView(v) {
  const qids = activeQids();
  v.ctl?.abort();
  v.ctl = new AbortController();
  const sig = v.ctl.signal;
  const span = v.t1 - v.t0;
  const from = v.t0 - span * 0.25, to = v.t1 + span * 0.25;
  const kinds = ["event", "discovery", "work", "other"].filter((k) => state.layers[k]);
  const themes = state.taxonomy.map((t) => t.id).filter((id) => !state.themesOff.has(id));
  v.q(".loading").hidden = false;
  try {
    const jobs = [
      qids.length && kinds.length ? api("/api/events", {
        from, to, countries: qids.join(","), themes: themes.join(","), sub_off: [...state.subOff].join(","),
        kinds: kinds.join(","), per_lane: PER_LANE, extra: pinnedQids().join(","),
      }, sig) : { events: [] },
      qids.length && state.layers.people ? api("/api/people", {
        from: v.t0, to: v.t1, countries: qids.join(","), per_lane: PEOPLE_PER_LANE, domains_off: [...state.domainsOff].join(","),
      }, sig) : { people: [] },
      qids.length && state.layers.rulers ? api("/api/rulers", { from, to, countries: qids.join(",") }, sig) : { terms: [], states: [] },
      qids.length && state.laneSeries === DENSITY ? api("/api/density", { from: v.t0, to: v.t1, countries: qids.join(","), bins: 160 }, sig) : null,
    ];
    const [ev, pe, ru, de] = await Promise.all(jobs);
    v.events = ev.events; v.people = pe.people; v.terms = ru.terms; v.states = ru.states; v.density = de;
    scheduleRender();
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  } finally {
    v.q(".loading").hidden = true;
  }
}

async function loadPersonal() {
  state.personal = state.static ? [] : (await api("/api/personal")).events;
  scheduleRender();
}

function laneIso(lane) {
  return lane.iso3 || (lane.qids?.length === 1 ? state.countryIso[lane.qids[0]] : null);
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
  if (state.laneSeries === DENSITY) { fetchAll(); return; }
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

const order = () => [state.lang, ...LANGS.filter((l) => l !== state.lang)];
function labelOf(text) {
  for (const l of order()) if (text?.[l]?.label) return text[l].label;
  return null;
}
const eventLabel = (ev) => labelOf(ev.text) || ev.qid;
function pickLabel(labels, fallback) {
  for (const l of order()) if (labels?.[l]) return labels[l];
  return Object.values(labels || {}).find(Boolean) || fallback;
}
const themeName = (id) => state.taxonomy.find((t) => t.id === id)?.name || "Autre";
const subName = (th, sub) => state.taxonomy.find((t) => t.id === th)?.subs.find((s) => s.id === sub)?.name || "";
const domainName = (id) => state.personDomains.find((d) => d.id === id)?.name || "Autre";
const countryName = (q) => (q === "_" ? "—" : state.countryLabels[q] || q);

// ===========================================================================
// Rendu
// ===========================================================================

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  for (const v of state.views) renderView(v);
  renderOverview();
  const v = mainView();
  let best = null, bestD = Infinity;
  if (!state.log) {
    const span = v.t1 - v.t0;
    for (const [k, s] of Object.entries(ZOOMS)) {
      const d = Math.abs(Math.log((s ?? NOW - BIG_BANG) / span));
      if (d < bestD) { bestD = d; best = k; }
    }
  }
  document.querySelectorAll(".zoom button").forEach((b) => b.classList.toggle("on", b.dataset.zoom === best && bestD < 1));
}

function viewTitle(v) {
  const span = v.t1 - v.t0;
  const c = v.center();
  if (!state.log) return T.formatTitle(c, span, NOW);
  return v.t0 <= BIG_BANG + 1e6 && v.t1 >= NOW - 1 ? "Du Big Bang à aujourd'hui" : `Autour de : ${T.formatAgeLabel(NOW - c)}`;
}

function renderView(v) {
  const w = v.width();
  v.q(".vtitle").textContent = viewTitle(v);
  renderRuler(v, w);
  renderDeep(v, w);
  renderLanes(v, w);
  renderWorldCurve(v, w);
  renderBeforeBigBang(v);
  renderLocalTimes(v);
  renderLinks(v);
}

function renderRuler(v, w) {
  const ticks = state.log ? T.logTicks(v.t0, v.t1, w, 80, NOW) : T.ticks(v.t0, v.t1, w, 90, NOW).ticks;
  v.q(".ruler").innerHTML = ticks.map((k) => `<div class="tick" style="left:${v.X(k.t, w).toFixed(1)}px">${esc(k.label)}</div>`).join("");
  v.q(".ruler-caption").textContent = state.log ? "âge (log)" : (v.t1 - v.t0 < 40 * T.DAY ? "temps UTC" : "");
  v.tl.querySelectorAll(".gridline").forEach((g) => g.remove());
  const lw = labelW();
  for (const k of ticks) {
    const g = document.createElement("div");
    g.className = "gridline";
    g.style.left = `${lw + v.X(k.t, w)}px`;
    v.tl.appendChild(g);
  }
}

function placeRow(rows, x0, x1, gap = 6) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].every(([a, b]) => x1 + gap <= a || x0 >= b + gap)) {
      rows[i].push([x0, x1]);
      return i;
    }
  }
  return -1;
}

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? "#1E2227" : "#FFFFFF";
}

// Bande « temps profond » : éons, ères, périodes géologiques (ICS 2024) et jalons
function renderDeep(v, w) {
  const box = v.q(".deep");
  const dt = state.deep;
  if (!dt || !state.layers.deep || v.t0 > NOW - 12000) { box.hidden = true; box.innerHTML = ""; return; }
  const tOf = (ma) => NOW - ma * 1e6;
  const html = [];
  let y = 2;
  for (const band of dt.bands) {
    const segs = band.items.filter((it) => tOf(it.from) < v.t1 && tOf(it.to) > v.t0);
    if (!segs.length) continue;
    html.push(`<div class="deep-caption" style="top:${y}px">${esc(band.row)}</div>`);
    for (const it of segs) {
      const a = Math.max(v.X(tOf(it.from), w), 0), b = Math.min(v.X(tOf(it.to), w), w);
      if (b - a < 1) continue;
      html.push(`<div class="deep-seg" title="${esc(`${it.name} : ${it.from} → ${it.to} Ma`)}" style="left:${a.toFixed(1)}px;width:${(b - a).toFixed(1)}px;top:${y}px;background:${it.color};color:${textColorFor(it.color)}">${b - a > 30 ? esc(it.name) : ""}</div>`);
    }
    y += 16;
  }
  const rows = [[], []];
  const marks = dt.milestones.filter((m) => tOf(m.ma) >= v.t0 && tOf(m.ma) <= v.t1);
  if (marks.length) html.push(`<div class="deep-caption" style="top:${y + 2}px">Jalons</div>`);
  for (const m of marks) {
    const x = v.X(tOf(m.ma), w);
    const label = `${m.approx ? "≈ " : ""}${m.name}`;
    const row = placeRow(rows, x, x + label.length * 6.2 + 10, 4);
    if (row < 0) continue;
    const age = m.ma >= 1 ? `${new Intl.NumberFormat("fr-FR").format(m.ma)} Ma` : T.formatAgeLabel(m.ma * 1e6);
    html.push(`<div class="deep-mark ${m.kind}" title="${esc(`${label} — ${age}${m.approx ? " (valeur approchée)" : ""}`)}" style="left:${x.toFixed(1)}px;top:${y + 2 + row * 16}px">${esc(label)}</div>`);
  }
  if (marks.length) y += 2 + 2 * 16;
  box.style.height = `${y + 2}px`;
  box.innerHTML = html.join("");
  box.hidden = false;
}

function renderBeforeBigBang(v) {
  const z = v.q(".before-bb");
  if (state.log || v.t0 >= BIG_BANG) { z.hidden = true; return; }
  const x = Math.min(v.X(BIG_BANG), v.width());
  z.hidden = x < 4;
  z.style.left = `${labelW()}px`;
  z.style.width = `${Math.max(0, x)}px`;
}

function areaPath(samples, h, max, top = 0.15) {
  let area = "", line = "", seg = [];
  const flush = () => {
    if (seg.length > 1) {
      const p = seg.map(([x, y]) => `${x} ${y.toFixed(1)}`);
      line += `M${p.join(" L")} `;
      area += `M${seg[0][0]} ${h} L${p.join(" L")} L${seg[seg.length - 1][0]} ${h} Z `;
    }
    seg = [];
  };
  for (const [x, val] of samples) {
    if (val === null) { flush(); continue; }
    seg.push([x, h - (val / max) * h * (1 - top)]);
  }
  flush();
  return { area, line };
}

function sampleSeries(v, pts, w) {
  const out = [];
  const step = Math.max(2, Math.floor(w / 240));
  for (let x = 0; x <= w; x += step) out.push([x, seriesAt(pts, v.tAt(x, w))]);
  return out;
}

function formatValue(val, meta) {
  const unit = meta?.unit ? ` ${meta.unit}` : "";
  if (["%", "°C", "ppm", "ans", "0 à 1"].some((u) => meta?.unit?.startsWith(u))) {
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: meta.unit === "0 à 1" ? 2 : 1 }).format(val)}${unit}`;
  }
  return `${T.formatNumber(val)}${unit}`;
}

function lanePoints(v, lane) {
  if (state.laneSeries === DENSITY) {
    const d = v.density;
    if (!d || !lane.qids?.length) return null;
    const width = (d.to - d.from) / d.bins;
    const sum = new Array(d.bins).fill(0);
    for (const q of lane.qids) (d.counts[q] || []).forEach((n, i) => { sum[i] += n; });
    return sum.map((n, i) => [d.from + (i + 0.5) * width, n]);
  }
  const iso = laneIso(lane);
  return iso ? state.lanePts[iso] : null;
}

function renderLanes(v, w) {
  const lanes = activeLanes();
  const pinned = new Set(pinnedQids());
  const html = [];
  const center = v.tAt(w / 2, w);
  const laneMeta = state.laneSeries === DENSITY ? { label: "Densité d'événements", unit: "" } : state.seriesMeta[state.laneSeries];
  const selected = state.panel?.qid;
  for (const lane of lanes) {
    const qset = new Set(lane.qids || []);
    const items = [];
    const ptRows = Array.from({ length: POINT_ROWS }, () => []);
    const barRows = Array.from({ length: BAR_ROWS }, () => []);
    let visible = 0;

    // --- Événements, découvertes, œuvres (ou frise perso)
    const evs = lane.personal
      ? state.personal.map((p) => ({ qid: `me-${p.id}`, pid: p.id, t0: p.t0, t1: p.t1 ?? p.t0 + T.DAY, span: p.t1 !== null && p.t1 !== undefined, precision: 11, sitelinks: 0, theme: "autre", kind: "personal", text: { fr: { label: p.title } }, is_event: true }))
      : v.events
        .filter((e) => e.countries.some((c) => qset.has(c)))
        .filter((e) => pinned.has(e.qid) || (!state.themesOff.has(e.theme) && !state.subOff.has(`${e.theme}.${e.subtheme}`)) || e.kind !== "event")
        .sort((a, b) => (pinned.has(b.qid) - pinned.has(a.qid)) || b.sitelinks - a.sitelinks);
    for (const ev of evs) {
      const x0 = v.X(ev.t0, w), x1 = v.X(ev.t1, w);
      if (x1 < 0 || x0 > w) continue;
      visible++;
      const label = eventLabel(ev);
      const cls = [`th-${ev.theme}`, `k-${ev.kind}`];
      if (selected === ev.qid) cls.push("sel");
      if (ev.precision !== null && ev.precision < 11 && !ev.span) cls.push("vague");
      if (ev.kind === "other") cls.push("other");
      const title = `${label} — ${T.formatDateShort(ev.t0, ev.precision, NOW)}`;
      const data = ev.pid ? `data-personal="${ev.pid}"` : `data-qid="${ev.qid}"`;
      if (ev.span || x1 - x0 > 60) {
        const a = Math.max(x0, -2), b = Math.min(x1, w + 2);
        const row = placeRow(barRows, a, b);
        if (row < 0) { items.push(`<div class="dot th-${ev.theme}" style="left:${a.toFixed(1)}px" title="${esc(title)}"></div>`); continue; }
        const top = POINT_ROWS * ROW_H + 6 + row * BAR_H;
        items.push(`<button class="ev bar${ev.span ? " span" : ""} ${cls.join(" ")}" ${data} title="${esc(title)}" style="left:${a.toFixed(1)}px;width:${Math.max(b - a, 8).toFixed(1)}px;top:${top}px">${esc(label)}</button>`);
      } else {
        const wl = Math.min(label.length * 6.6 + 24, 280);
        const row = placeRow(ptRows, x0, x0 + wl);
        if (row < 0) { items.push(`<div class="dot th-${ev.theme}" style="left:${x0.toFixed(1)}px" title="${esc(title)}"></div>`); continue; }
        const top = 6 + row * ROW_H;
        items.push(`<div class="pin th-${ev.theme}" style="left:${x0.toFixed(1)}px;top:${top + 24}px"></div>`);
        items.push(`<button class="ev ${cls.join(" ")}" ${data} title="${esc(title)}" style="left:${x0.toFixed(1)}px;max-width:${wl.toFixed(0)}px;top:${top}px">${esc(label)}</button>`);
      }
    }
    let y = POINT_ROWS * ROW_H + BAR_ROWS * BAR_H + 10;
    const captions = [];

    // --- Vies des personnes
    if (state.layers.people && !lane.personal) {
      const rows = Array.from({ length: LIFE_ROWS }, () => []);
      const ppl = v.people.filter((p) => p.countries.some((c) => qset.has(c))).sort((a, b) => b.sitelinks - a.sitelinks);
      let any = false;
      for (const p of ppl) {
        const end = p.death ?? Math.min(p.birth + 100, NOW);
        const a = Math.max(v.X(p.birth, w), -2), b = Math.min(v.X(end, w), w + 2);
        if (b < 0 || a > w) continue;
        const name = labelOf(p.text) || p.qid;
        const row = placeRow(rows, a, Math.max(b, a + Math.min(name.length * 6 + 16, 200)), 4);
        if (row < 0) continue;
        any = true;
        const years = `${T.formatYear(p.birth, NOW)} – ${p.death !== null && p.death !== undefined ? T.formatYear(p.death, NOW) : "?"}`;
        items.push(`<button class="life th-${p.domain}${p.death === null || p.death === undefined ? " open-end" : ""}" data-person="${p.qid}" title="${esc(`${name} (${years}) — ${domainName(p.domain)}`)}" style="left:${a.toFixed(1)}px;width:${Math.max(b - a, 10).toFixed(1)}px;top:${y + row * LIFE_H}px">${esc(name)}</button>`);
      }
      if (any) { captions.push([y, "Vies"]); y += LIFE_ROWS * LIFE_H + 4; }
    }

    // --- Gouvernants (et États successifs d'un même pays)
    if (state.layers.rulers && !lane.personal && lane.qids?.some((q) => q !== "_")) {
      const rowsDef = [];
      if (lane.qids.length > 1) {
        const segs = v.states.filter((s) => qset.has(s.qid) && s.t0 !== null)
          .map((s) => ({ t0: s.t0, t1: s.t1 ?? NOW, label: pickLabel(s.labels, s.qid), cls: "state", data: `data-wd="${s.qid}"` }));
        if (segs.length) rowsDef.push(["État", segs]);
      }
      for (const [role, cap] of [["etat", "Chef d'État"], ["gouvernement", "Gouvernement"]]) {
        const segs = v.terms.filter((t) => t.role === role && qset.has(t.country))
          .map((t) => ({ t0: t.t0, t1: t.t1 ?? NOW, label: pickLabel(t.labels, t.person), cls: "", data: `data-term="${t.person}" data-role="${role}" data-country="${t.country}" data-t0="${t.t0}" data-t1="${t.t1 ?? ""}"` }));
        if (segs.length) rowsDef.push([cap, segs]);
      }
      for (const [cap, segs] of rowsDef) {
        segs.sort((a, b) => a.t0 - b.t0);
        segs.forEach((s, i) => {
          const a = Math.max(v.X(s.t0, w), -2), b = Math.min(v.X(s.t1, w), w + 2);
          if (b < 0 || a > w || b - a < 1) return;
          items.push(`<button class="term ${s.cls}${i % 2 ? " alt" : ""}" ${s.data} title="${esc(`${cap} : ${s.label} (${T.formatYear(s.t0, NOW)} – ${s.t1 >= NOW - 0.01 ? "…" : T.formatYear(s.t1, NOW)})`)}" style="left:${a.toFixed(1)}px;width:${(b - a).toFixed(1)}px;top:${y}px">${b - a > 24 ? esc(s.label) : ""}</button>`);
        });
        captions.push([y, cap]);
        y += TERM_H + 2;
      }
    }
    const h = Math.max(y + 6, 90);

    // --- Courbe du pays (ou densité) en fond du couloir
    let curve = "", valTxt = "";
    const pts = state.laneSeries && !lane.personal ? lanePoints(v, lane) : null;
    if (pts && pts.length > 1) {
      const samples = sampleSeries(v, pts, w);
      const vals = samples.map((s) => s[1]).filter((x) => x !== null);
      if (vals.length) {
        const max = Math.max(...vals.map(Math.abs)) || 1;
        const { area, line } = areaPath(samples, h, max, 0.25);
        curve = `<svg class="lane-curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${area}" fill="var(--lane-curve)" fill-opacity=".035"></path><path d="${line}" fill="none" stroke="var(--lane-curve)" stroke-opacity=".55" stroke-width="1.5" vector-effect="non-scaling-stroke"></path></svg>`;
      }
      const val = seriesAt(pts, center);
      if (val !== null && state.laneSeries !== DENSITY) valTxt = `≈ ${formatValue(val, laneMeta)}`;
    }
    const caps = captions.map(([cy, c]) => `<span class="band-caption" style="position:absolute;top:${cy}px">${esc(c)}</span>`).join("");
    html.push(`<div class="lane${lane.personal ? " me" : ""}" data-lane="${lane.id}"><div class="lane-name" style="position:relative">${esc(lane.name)}<span class="count">${visible} élément${visible > 1 ? "s" : ""}</span>${valTxt ? `<span class="lane-val" title="${esc(laneMeta?.label || "")}">${esc(valTxt)}</span>` : ""}${caps}</div><div class="lane-body" style="height:${h}px">${curve}${items.join("")}</div></div>`);
  }
  v.q(".lanes").innerHTML = html.join("");

  const empty = v.q(".empty");
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

function renderWorldCurve(v, w) {
  const svg = v.q(".curve");
  const valEl = v.q(".series-value");
  const p = state.worldPts;
  if (!state.worldSeries || p.length < 2) { svg.innerHTML = ""; valEl.textContent = ""; return; }
  const h = 300;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const samples = sampleSeries(v, p, w);
  const vals = samples.map((s) => s[1]).filter((x) => x !== null);
  if (!vals.length) svg.innerHTML = "";
  else {
    const { area, line } = areaPath(samples, h, Math.max(...vals.map(Math.abs)) || 1);
    svg.innerHTML = `<path d="${area}" fill="var(--curve)" fill-opacity=".045"></path><path d="${line}" fill="none" stroke="var(--curve)" stroke-opacity=".45" stroke-width="2" vector-effect="non-scaling-stroke"></path>`;
  }
  const meta = state.seriesMeta[state.worldSeries];
  const val = seriesAt(p, v.tAt(w / 2, w));
  valEl.textContent = val === null ? `${meta?.label ?? state.worldSeries} (monde) : pas de donnée à cette date`
    : `${meta?.label ?? state.worldSeries} (monde) ≈ ${formatValue(val, meta)}`;
}

function renderOverview() {
  const bar = $("overview");
  const rects = state.views.map((v, i) => {
    const a = T.overviewX(v.t0, NOW) * 100, b = T.overviewX(v.t1, NOW) * 100;
    return `<div class="vp" style="left:${a.toFixed(2)}%;width:${Math.max(b - a, 0.4).toFixed(2)}%;${i ? "border-style:dashed" : ""}" title="${i ? "2e frise" : "frise principale"}"></div>`;
  });
  bar.innerHTML = OVERVIEW_MARKS.map(([age, name]) => `<div class="mark" style="left:${(T.overviewX(NOW - age, NOW) * 100).toFixed(2)}%">${esc(name)}</div>`).join("") + rects.join("");
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

function renderLocalTimes(v) {
  v.el.querySelectorAll(".local-time").forEach((e) => e.remove());
  if (v.hoverT === null || state.log || v.t1 - v.t0 > 6 * T.DAY) return;
  const x = v.X(v.hoverT);
  for (const lane of state.lanes.filter((l) => l.on && l.tz)) {
    const body = v.el.querySelector(`.lane[data-lane="${lane.id}"] .lane-body`);
    const txt = localTime(v.hoverT, lane.tz);
    if (!body || !txt) continue;
    const el = document.createElement("div");
    el.className = "local-time";
    el.style.left = `${x}px`;
    el.textContent = `${txt}${lane.tzName ? ` (${lane.tzName})` : ""}`;
    body.appendChild(el);
  }
}

// Fils : événement ouvert ↔ ses liens et le même jour ; chaîne de causes
function renderLinks(v) {
  const svg = v.q(".links-layer");
  v.el.querySelectorAll(".ev.linked").forEach((e) => e.classList.remove("linked"));
  const pairs = [];
  const d = state.detail;
  if (d) {
    for (const l of d.links) if (l.t0 !== null) pairs.push([d.qid, l.qid, "link"]);
    for (const e of d.same_day) pairs.push([d.qid, e.qid, "same"]);
  }
  if (state.chain) for (const n of state.chain.nodes) pairs.push([n.parent, n.qid, "chain"]);
  if (!pairs.length) { svg.innerHTML = ""; return; }
  const tl = v.tl.getBoundingClientRect();
  const pos = (qid) => {
    const el = v.el.querySelector(`.ev[data-qid="${qid}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { el, x: r.left - tl.left + Math.min(r.width, 60) / 2, y: r.top - tl.top + r.height / 2 };
  };
  const parts = [];
  const done = new Set();
  for (const [a, b, kind] of pairs) {
    if (a === b || done.has(a + b)) continue;
    done.add(a + b);
    const pa = pos(a), pb = pos(b);
    if (!pa || !pb) continue;
    pb.el.classList.add("linked");
    const mx = (pa.x + pb.x) / 2, my = Math.min(pa.y, pb.y) - Math.max(20, Math.abs(pb.x - pa.x) * 0.15);
    const style = kind === "same" ? 'stroke-dasharray="5 4" stroke-opacity=".7"' : kind === "chain" ? 'stroke-opacity=".85" marker-end="url(#arrow)"' : "";
    parts.push(`<path d="M${pa.x} ${pa.y} Q${mx} ${my} ${pb.x} ${pb.y}" fill="none" stroke="var(--accent-2)" stroke-width="2" ${style}></path>`);
  }
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent-2)"></path></marker></defs>${parts.join("")}`;
}

// ===========================================================================
// Panneau de droite : fiches, récits comparés, causes, ce jour-là, angles morts…
// ===========================================================================

function openPanel(panel) {
  state.panel = panel;
  renderPanel();
}

function closePanel() {
  state.panel = null;
  state.detail = null;
  state.chain = null;
  state.compare = null;
  $("panel").hidden = true;
  fetchAll();
  scheduleRender();
}

function keepVisible(v, t) {
  // La fiche occupe la droite de la frise : décaler pour garder t visible à gauche.
  const w = v.width();
  const x = v.X(t, w);
  const panel = $("panel").offsetWidth + 40;
  if (x > w - panel - 220 || x < 0) {
    const du = ((x - w * 0.3) / w) * (U(v.t1) - U(v.t0));
    setViewU(v, U(v.t0) + du, U(v.t1) + du, false);
  }
}

async function openEvent(qid, { view = mainView(), center = false } = {}) {
  const { event: ev } = await api("/api/event", { qid });
  if (!ev) { toast("Élément absent de la base"); return; }
  state.detail = ev;
  state.chain = null;
  state.compare = null;
  if (center && (ev.t0 < view.t0 || ev.t0 > view.t1 || state.log)) {
    const s = state.log ? Math.max((ev.t1 - ev.t0) * 20, 30 * T.DAY) : view.t1 - view.t0;
    centerOn(view, ev.span ? (ev.t0 + ev.t1) / 2 : ev.t0, s);
  }
  openPanel({ type: "event", qid, section: null });
  keepVisible(view, ev.t0);
  fetchAll();
}

async function openPerson(qid, fallback = null) {
  const { person } = await api("/api/person", { qid });
  if (!person) {
    if (fallback) openPanel({ type: "term", ...fallback });
    else window.open(`https://www.wikidata.org/wiki/${qid}`, "_blank", "noopener");
    return;
  }
  openPanel({ type: "person", qid, person });
}

function articleUrl(lang, title) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function linksBlock(text, qid) {
  return `<div class="links">${LANGS.filter((l) => text[l]?.article).map((l) => `<a href="${articleUrl(l, text[l].article)}" target="_blank" rel="noopener">Wikipédia ${l.toUpperCase()}</a>`).join("")}<a href="https://www.wikidata.org/wiki/${esc(qid)}" target="_blank" rel="noopener">Wikidata</a></div>`;
}

function summaryBlock(text) {
  const l = order().find((x) => text[x]?.summary);
  if (!l) return state.static ? "" : '<div class="summary muted">Pas de résumé en base. Lance <code>python collector/collect.py summaries</code>.</div>';
  return `<div class="summary">${esc(text[l].summary)}<span class="src">Wikipédia ${l.toUpperCase()}${l !== state.lang ? " (pas de résumé dans la langue choisie)" : ""}</span></div>`;
}

function renderPanel() {
  const el = $("panel");
  const p = state.panel;
  if (!p) { el.hidden = true; return; }
  const renderers = { event: panelEvent, person: panelPerson, term: panelTerm, today: panelToday, coverage: panelCoverage, bb: panelBigBang, "personal-form": panelPersonalForm, personal: panelPersonal };
  el.className = `detail${p.type === "event" && state.detail ? ` th-${state.detail.theme}` : ""}`;
  el.innerHTML = `<button class="close" aria-label="Fermer le panneau">×</button>${renderers[p.type]()}`;
  el.hidden = false;
  scheduleRender();
}

function panelEvent() {
  const ev = state.detail;
  const p = state.panel;
  const descr = order().map((l) => ev.text[l]?.descr).find(Boolean) || "";
  const date = T.formatDateShort(ev.t0, ev.precision, NOW) + (ev.span ? ` → ${T.formatDateShort(ev.t1, ev.precision, NOW)}` : "");
  const kindTag = { discovery: "Découverte, invention", work: "Œuvre", other: "Hors événement" }[ev.kind];
  const groups = {};
  for (const l of ev.links) (groups[l.kind] ??= []).push(l);
  const linkHtml = Object.entries(LINK_KINDS).filter(([k]) => groups[k]).map(([k, name]) => groups[k].map((l) => {
    const when = l.t0 !== null ? T.formatDateShort(l.t0, l.precision, NOW) : "";
    const inner = `<span class="k">${esc(name)}</span><span>${esc(pickLabel(l.labels, l.qid))}</span><span class="d">${esc(when)}</span>`;
    return l.t0 !== null ? `<li><button data-go="${l.qid}">${inner}</button></li>`
      : `<li><a href="https://www.wikidata.org/wiki/${l.qid}" target="_blank" rel="noopener">${inner}</a></li>`;
  }).join("")).join("");
  const sameHtml = ev.same_day.map((e) => {
    const c = e.countries.map((x) => (x === "_" ? "" : state.countryLabels[x] || "")).filter(Boolean).slice(0, 2).join(", ");
    return `<li><button data-go="${e.qid}"><span class="k">${esc(c || "—")}</span><span>${esc(eventLabel(e))}</span></button></li>`;
  }).join("");
  let section = "";
  if (p.section === "compare") section = sectionCompare();
  else if (p.section === "causes" || p.section === "consequences") section = sectionChain();
  return `
    <h2>${esc(eventLabel(ev))}</h2>
    <div class="muted">${esc(descr)}</div>
    <span class="tag">${esc(themeName(ev.theme))}${ev.subtheme ? ` · ${esc(subName(ev.theme, ev.subtheme))}` : ""}</span>${kindTag ? `<span class="tag">${esc(kindTag)}</span>` : ""}
    ${summaryBlock(ev.text)}
    <dl>
      <dt>Date</dt><dd>${esc(date)}</dd>
      <dt>Précision</dt><dd>${esc(ev.precision_name || "?")}</dd>
      <dt>Pays</dt><dd>${esc(ev.countries.map(countryName).join(", "))}</dd>
      <dt>Importance</dt><dd>présent dans ${ev.sitelinks} projets Wikimedia</dd>
    </dl>
    <div class="section-btns">
      <button data-section="compare" class="${p.section === "compare" ? "on" : ""}">Comparer les Wikipédias${ev.wiki_count ? ` (${ev.wiki_count})` : ""}</button>
      <button data-section="causes" class="${p.section === "causes" ? "on" : ""}">Remonter les causes</button>
      <button data-section="consequences" class="${p.section === "consequences" ? "on" : ""}">Suivre les conséquences</button>
    </div>
    ${section}
    ${linkHtml ? `<h3>Liens</h3><ul class="link-list">${linkHtml}</ul>` : ""}
    ${sameHtml ? `<h3>Le même jour ailleurs</h3><ul class="link-list">${sameHtml}</ul>` : ""}
    <h3>Titres</h3>
    <div class="langs">${LANGS.filter((l) => ev.text[l]?.label).map((l) => `<div><b>${l.toUpperCase()}</b>${esc(ev.text[l].label)}</div>`).join("")}</div>
    ${linksBlock(ev.text, ev.qid)}`;
}

// --- Récits comparés ---------------------------------------------------------

async function loadCompare(qid, all = false) {
  const first = !state.compare || state.compare.qid !== qid;
  if (first) state.compare = { qid, pages: [], loading: true, all };
  state.compare.all = all || state.compare.all;
  state.compare.loading = true;
  renderPanel();
  let data = await api("/api/compare", { qid });
  const avail = data.pages.map((p) => p.lang);
  const wanted = (state.compare.all ? avail : COMPARE_LANGS.filter((l) => avail.includes(l)))
    .filter((l) => { const pg = data.pages.find((x) => x.lang === l); return !(pg.summary && pg.length); });
  state.compare.pages = data.pages;
  renderPanel();
  for (let i = 0; i < wanted.length; i += 12) {
    if (state.compare?.qid !== qid) return;
    data = await api("/api/compare", { qid, fetch: wanted.slice(i, i + 12).join(",") });
    if (state.compare?.qid !== qid) return;
    state.compare.pages = data.pages;
    if (data.errors?.length) state.compare.errors = data.errors;
    renderPanel();
  }
  state.compare.loading = false;
  renderPanel();
}

function sectionCompare() {
  const c = state.compare;
  if (!c) return "";
  const pages = [...c.pages];
  if (!pages.length) return `<div class="muted">${c.loading ? "Chargement…" : "Aucune page connue. Lance <code>python collector/collect.py update</code> pour récupérer les liens vers toutes les Wikipédias."}</div>`;
  const shown = c.all ? pages : pages.filter((p) => COMPARE_LANGS.includes(p.lang));
  shown.sort((a, b) => (b.length ?? -1) - (a.length ?? -1));
  const max = Math.max(1, ...shown.map((p) => p.length || 0));
  const present = new Set(pages.map((p) => p.lang));
  const absent = COMPARE_LANGS.filter((l) => !present.has(l));
  const rows = shown.map((p) => {
    const kb = p.length ? `${Math.round(p.length / 1000)} ko` : "…";
    const tr = p.summary && p.lang !== state.lang
      ? `<a href="https://translate.google.com/?sl=${encodeURIComponent(p.lang)}&tl=${state.lang}&text=${encodeURIComponent(p.summary.slice(0, 1800))}&op=translate" target="_blank" rel="noopener">Traduire</a>` : "";
    return `<div class="cmp-row">
      <div class="cmp-head"><span class="lang-code">${esc(p.lang.toUpperCase())}</span><span>${esc(langName(p.lang))}</span>
        <div class="cmp-bar-wrap" title="Taille de l'article"><div class="cmp-bar" style="width:${(((p.length || 0) / max) * 100).toFixed(1)}%"></div></div>
        <span class="cmp-len">${kb}</span></div>
      ${p.summary ? `<div class="cmp-text" lang="${esc(p.lang)}"${RTL.has(p.lang) ? ' dir="rtl"' : ""}>${esc(p.summary)}</div>` : p.summary === "" ? '<div class="cmp-text muted">(introduction vide)</div>' : ""}
      <div class="cmp-tools"><a href="${articleUrl(p.lang, p.title)}" target="_blank" rel="noopener">Lire l'article</a>${tr}</div>
    </div>`;
  }).join("");
  return `<h3>Le même sujet dans chaque Wikipédia</h3>
    <div class="muted">Article présent dans ${pages.length} Wikipédias. La barre montre la taille de chaque article : ce que chaque langue juge important d'en dire.${c.loading ? " Chargement des introductions…" : ""}</div>
    ${absent.length ? `<p class="absent">Absent de : ${absent.map((l) => esc(langName(l))).join(", ")}</p>` : ""}
    ${rows}
    ${!c.all && pages.length > shown.length ? `<button class="small-btn" data-compare-all="1">Afficher toutes les langues (${pages.length})</button>` : ""}
    ${c.errors?.length ? `<p class="absent">Non chargé : ${esc(c.errors.join(" ; "))}</p>` : ""}`;
}

// --- Chaînes de causes / conséquences --------------------------------------------

async function loadChain(qid, dir) {
  state.chain = { qid, dir, nodes: [], loading: true };
  renderPanel();
  const data = await api("/api/chain", { qid, dir, depth: 5 });
  if (state.chain?.qid !== qid || state.chain.dir !== dir) return;
  state.chain = { qid, dir, nodes: data.nodes };
  renderPanel();
  fetchAll();
}

function sectionChain() {
  const c = state.chain;
  if (!c) return "";
  if (c.loading) return '<div class="muted">Chargement…</div>';
  if (!c.nodes.length) return `<div class="muted">Wikidata ne relie aucun${c.dir === "causes" ? "e cause" : "e conséquence"} à cet événement.</div>`;
  const items = c.nodes.map((n) => {
    const when = n.t0 !== null ? T.formatDateShort(n.t0, n.precision, NOW) : "hors base";
    const inner = `<span class="lvl">${"›".repeat(n.level)}</span><span>${esc(pickLabel(n.labels, n.qid))}</span><span class="d">${esc(when)}</span>`;
    return `<li class="chain-item" style="padding-left:${(n.level - 1) * 14}px">${n.t0 !== null ? `<button data-go="${n.qid}">${inner}</button>` : `<a href="https://www.wikidata.org/wiki/${n.qid}" target="_blank" rel="noopener">${inner}</a>`}</li>`;
  }).join("");
  return `<h3>${c.dir === "causes" ? "Chaîne des causes" : "Chaîne des conséquences"}</h3>
    <div class="muted">D'après les liens « cause » et « conséquence » de Wikidata, sur ${Math.max(...c.nodes.map((n) => n.level))} niveau(x). Les flèches sur la frise relient les éléments visibles.</div>
    <ul class="link-list">${items}</ul>`;
}

// --- Personnes et gouvernants ------------------------------------------------------

function panelPerson() {
  const p = state.panel.person;
  const name = labelOf(p.text) || p.qid;
  const descr = order().map((l) => p.text[l]?.descr).find(Boolean) || "";
  const end = p.death ?? NOW;
  const age = Math.floor(end - p.birth);
  const life = `${T.formatDateShort(p.birth, p.prec_birth, NOW)} – ${p.death !== null && p.death !== undefined ? T.formatDateShort(p.death, p.prec_death, NOW) : "?"}`;
  const offices = p.offices.map((o) => `<li><span class="k">${o.role === "etat" ? "Chef d'État" : "Gouvernement"}</span><span>${esc(pickLabel(o.country_label, o.country))}</span><span class="d">${esc(T.formatYear(o.t0, NOW))} – ${o.t1 ? esc(T.formatYear(o.t1, NOW)) : "…"}</span></li>`).join("");
  const cont = p.contemporaries.map((c) => `<li><button data-person-go="${c.qid}"><span class="k">${esc(domainName(c.domain))}</span><span>${esc(labelOf(c.text) || c.qid)}</span><span class="d">${esc(T.formatYear(c.birth, NOW))}–${c.death ? esc(T.formatYear(c.death, NOW)) : ""}</span></button></li>`).join("");
  return `<h2>${esc(name)}</h2><div class="muted">${esc(descr)}</div>
    <span class="tag th-${p.domain}" style="background:var(--tb);color:var(--tf)">${esc(domainName(p.domain))}</span>
    ${summaryBlock(p.text)}
    <dl><dt>Vie</dt><dd>${esc(life)}${p.death ? ` (${age} ans)` : ""}</dd>
      <dt>Nationalité</dt><dd>${esc(p.countries.map(countryName).join(", "))}</dd>
      <dt>Importance</dt><dd>présent dans ${p.sitelinks} projets Wikimedia</dd></dl>
    <div class="section-btns"><button data-goto-t="${p.birth}" data-goto-span="${Math.max(end - p.birth, 1) * 1.3}">Voir sa vie sur la frise</button></div>
    ${offices ? `<h3>Fonctions</h3><ul class="link-list">${offices}</ul>` : ""}
    ${cont ? `<h3>Contemporains connus</h3><ul class="link-list">${cont}</ul>` : ""}
    ${linksBlock(p.text, p.qid)}`;
}

function panelTerm() {
  const p = state.panel;
  return `<h2>${esc(p.label)}</h2>
    <dl><dt>Fonction</dt><dd>${p.role === "etat" ? "Chef d'État" : "Chef de gouvernement"}</dd>
      <dt>Pays</dt><dd>${esc(countryName(p.country))}</dd>
      <dt>Période</dt><dd>${esc(T.formatDateShort(p.t0, 11, NOW))} – ${p.t1 ? esc(T.formatDateShort(p.t1, 11, NOW)) : "…"}</dd></dl>
    <p class="muted">Cette personne n'est pas encore dans le calque « Vies ». Lance <code>python collector/collect.py people</code> sur ses années de naissance pour l'ajouter.</p>
    <div class="links"><a href="https://www.wikidata.org/wiki/${esc(p.qid)}" target="_blank" rel="noopener">Wikidata</a></div>`;
}

// --- Ce jour-là -------------------------------------------------------------------

async function openToday() {
  const n = new Date();
  openPanel({ type: "today", loading: true, m: n.getMonth() + 1, d: n.getDate() });
  const data = await api("/api/onthisday", { m: n.getMonth() + 1, d: n.getDate() });
  if (state.panel?.type === "today") openPanel({ type: "today", ...data });
}

function century(t) {
  const y = Math.floor(t);
  if (y <= 0) return "Avant notre ère";
  const c = Math.ceil(y / 100);
  return `${c}${c === 1 ? "er" : "e"} siècle`;
}

function panelToday() {
  const p = state.panel;
  const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  if (p.loading) return `<h2>Un ${p.d} ${months[p.m - 1]}</h2><div class="muted">Chargement…</div>`;
  let cur = "";
  const evs = p.events.map((e) => {
    const c = century(e.t0);
    const head = c !== cur ? `</ul><div class="century">${esc(c)}</div><ul class="link-list">` : "";
    cur = c;
    return `${head}<li><button data-go="${e.qid}"><span class="k">${esc(T.formatYear(e.t0, NOW))}</span><span>${esc(eventLabel(e))}</span><span class="d">${esc(e.countries.map(countryName).filter((x) => x !== "—").slice(0, 2).join(", "))}</span></button></li>`;
  }).join("");
  const births = p.births.map((b) => `<li><button data-person-go="${b.qid}"><span class="k">${esc(T.formatYear(b.birth, NOW))}</span><span>${esc(labelOf(b.text) || b.qid)}</span><span class="d">${esc(domainName(b.domain))}</span></button></li>`).join("");
  return `<h2>Un ${p.d} ${months[p.m - 1]}, à travers les siècles</h2>
    <div class="muted">Événements datés au jour près dans ta base. Plus tu collectes de périodes, plus la liste s'allonge.</div>
    ${evs ? `<ul class="link-list">${evs}</ul>` : '<p class="muted">Aucun événement en base pour ce jour.</p>'}
    ${births ? `<h3>Nés ce jour-là</h3><ul class="link-list">${births}</ul>` : ""}`;
}

// --- Angles morts -----------------------------------------------------------------

async function openCoverage() {
  const v = mainView();
  openPanel({ type: "coverage", loading: true });
  const data = await api("/api/coverage", { from: v.t0, to: v.t1 });
  if (state.panel?.type === "coverage") openPanel({ type: "coverage", rows: data.countries, t0: v.t0, t1: v.t1 });
}

function panelCoverage() {
  const p = state.panel;
  if (p.loading) return "<h2>Angles morts</h2><div class='muted'>Chargement…</div>";
  const top = p.rows.slice(0, 15);
  const withPop = p.rows.filter((r) => r.per_million !== null && r.population > 1e6);
  const least = [...withPop].sort((a, b) => a.per_million - b.per_million).slice(0, 15);
  const most = [...withPop].sort((a, b) => b.per_million - a.per_million).slice(0, 8);
  const row = (r, val) => `<div class="cov-row"><button data-add-country="${r.qid}">${esc(r.fr || r.en || r.qid)}</button><span class="num">${r.n} év.</span><span class="num">${val}</span></div>`;
  const pm = (r) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(r.per_million)} / M hab.`;
  return `<h2>Angles morts</h2>
    <div class="muted">Combien d'événements les sources racontent pour chaque pays, entre ${esc(T.formatYear(p.t0, NOW))} et ${esc(T.formatYear(p.t1, NOW))}. Rapporté à la population, on voit quelles régions restent dans l'ombre. Clique un pays pour lui ouvrir un couloir.</div>
    <h3>Le plus d'événements</h3>${top.map((r) => row(r, r.population ? pm(r) : "")).join("")}
    ${least.length ? `<h3>Les moins racontés (par habitant)</h3>${least.map((r) => row(r, pm(r))).join("")}` : '<p class="muted">Charge la courbe « population » (<code>series population</code>) pour comparer par habitant.</p>'}
    ${most.length ? `<h3>Les plus racontés (par habitant)</h3>${most.map((r) => row(r, pm(r))).join("")}` : ""}`;
}

// --- Avant le Big Bang ---------------------------------------------------------------

function panelBigBang() {
  const b = state.deep?.before_big_bang;
  if (!b) return "<h2>Avant le Big Bang</h2>";
  return `<h2>${esc(b.title)}</h2><p class="summary">${esc(b.intro)}</p>
    ${b.items.map((i) => `<h3>${esc(i.name)}</h3><p style="font-size:14px;line-height:1.5;margin:4px 0">${esc(i.text)}</p>`).join("")}
    <p class="muted">Zone hachurée : hypothèses, aucun fait observé.</p>`;
}

// --- Frise personnelle --------------------------------------------------------------

function parseUserDate(s) {
  const m = String(s || "").trim().match(/^(-?\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (!m) return null;
  const y = +m[1];
  return T.fyear(y < 0 ? y + 1 : y, +(m[2] || 1), +(m[3] || 1));
}

function panelPersonalForm() {
  return `<h2>Ajouter à ma frise</h2>
    <p class="muted">Tes événements restent sur ton ordinateur, dans ta base. Ils ne sont jamais inclus dans la version en ligne.</p>
    <form id="personal-form">
      <label class="form-row">Date (AAAA-MM-JJ, AAAA-MM ou AAAA)<input name="t0" required placeholder="1985-06-21"></label>
      <label class="form-row">Fin (facultatif, pour une période)<input name="t1" placeholder="1990"></label>
      <label class="form-row">Titre<input name="title" required maxlength="200" placeholder="Naissance, déménagement, chantier…"></label>
      <label class="form-row">Notes<textarea name="notes" rows="4"></textarea></label>
      <button class="primary-btn" type="submit">Ajouter</button>
    </form>`;
}

function panelPersonal() {
  const e = state.personal.find((x) => x.id === state.panel.id);
  if (!e) return "<p class='muted'>Élément supprimé.</p>";
  return `<h2>${esc(e.title)}</h2>
    <dl><dt>Date</dt><dd>${esc(e.date_raw || T.formatDateShort(e.t0, 11, NOW))}${e.t1 ? ` → ${esc(T.formatYear(e.t1, NOW))}` : ""}</dd></dl>
    ${e.notes ? `<p class="summary">${esc(e.notes)}</p>` : ""}
    <button class="danger-btn" data-personal-delete="${e.id}">Supprimer</button>`;
}

function wirePanel() {
  const el = $("panel");
  el.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest(".close")) { closePanel(); return; }
    const go = t.closest("[data-go]");
    if (go) { openEvent(go.dataset.go, { center: true }); return; }
    const pg = t.closest("[data-person-go]");
    if (pg) { openPerson(pg.dataset.personGo); return; }
    const sec = t.closest("[data-section]");
    if (sec && state.detail) {
      const s = sec.dataset.section;
      state.panel.section = state.panel.section === s ? null : s;
      if (state.panel.section === "compare") loadCompare(state.detail.qid);
      else if (state.panel.section) loadChain(state.detail.qid, s);
      else { state.chain = null; renderPanel(); fetchAll(); }
      return;
    }
    if (t.closest("[data-compare-all]") && state.detail) { loadCompare(state.detail.qid, true); return; }
    const gt = t.closest("[data-goto-t]");
    if (gt) { const s = +gt.dataset.gotoSpan; centerOn(mainView(), +gt.dataset.gotoT + s / 2.6, s); return; }
    const add = t.closest("[data-add-country]");
    if (add) { addCountryLane(add.dataset.addCountry); toast("Couloir ajouté"); return; }
    const del = t.closest("[data-personal-delete]");
    if (del) {
      await apiPost("/api/personal/delete", { id: +del.dataset.personalDelete });
      await loadPersonal();
      closePanel();
    }
  });
  el.addEventListener("submit", async (e) => {
    if (e.target.id !== "personal-form") return;
    e.preventDefault();
    const f = new FormData(e.target);
    const t0 = parseUserDate(f.get("t0"));
    const t1 = f.get("t1") ? parseUserDate(f.get("t1")) : null;
    if (t0 === null || (f.get("t1") && t1 === null)) { toast("Date non reconnue : écris 1985-06-21, 1985-06 ou 1985"); return; }
    try {
      await apiPost("/api/personal/add", { t0, t1, date_raw: f.get("t0"), title: f.get("title"), notes: f.get("notes") });
      await loadPersonal();
      toast("Ajouté à ta frise");
      centerOn(mainView(), t0, Math.max((t1 ?? t0) - t0, 1) * 3);
      closePanel();
    } catch (err) { toast(`Impossible d'ajouter : ${err.message}`); }
  });
}

// ===========================================================================
// Colonne de gauche
// ===========================================================================

function renderSidebar() {
  $("layers").innerHTML = LAYERS.filter((l) => !(l.id === "personal" && state.static)).map((l) =>
    `<label><input type="checkbox" data-layer="${l.id}"${state.layers[l.id] ? " checked" : ""}> ${esc(l.name)}</label>`).join("");
  const pd = $("person-domains");
  pd.hidden = !state.layers.people;
  $("layers").querySelector('[data-layer="people"]')?.closest("label").after(pd);
  pd.innerHTML = state.personDomains.map((d) => `<label class="th-${d.id}"><input type="checkbox" data-domain="${d.id}"${state.domainsOff.has(d.id) ? "" : " checked"}> <span class="layer-dot" style="background:var(--tb);border:1px solid var(--tf)"></span>${esc(d.name)}</label>`).join("");
  $("btn-personal-add").hidden = !state.layers.personal || !!state.static;

  $("themes").innerHTML = state.taxonomy.map((t) => {
    const on = !state.themesOff.has(t.id);
    const subs = t.subs.map((s) => `<label><input type="checkbox" data-sub="${t.id}.${s.id}"${state.subOff.has(`${t.id}.${s.id}`) ? "" : " checked"}${on ? "" : " disabled"}> ${esc(s.name)}<span class="n">${s.n || ""}</span></label>`).join("");
    return `<div class="theme-row th-${t.id}">
      <div class="theme-head">
        <input type="checkbox" data-theme="${t.id}"${on ? " checked" : ""} aria-label="${esc(t.name)}">
        <button class="expand" ${t.subs.length ? "" : "disabled"} aria-expanded="false"><span class="swatch"></span>${esc(t.name)}<span class="n">${t.n || ""}</span>${t.subs.length ? '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>' : ""}</button>
      </div>
      ${t.subs.length ? `<div class="subs" hidden>${subs}</div>` : ""}
    </div>`;
  }).join("");
  $("langs").innerHTML = LANGS.map((l) => `<button class="lang${state.lang === l ? " on" : ""}" data-lang="${l}" aria-pressed="${state.lang === l}">${l.toUpperCase()}</button>`).join("");
  $("lanes-list").innerHTML = state.lanes.map((l, i) => `<label><input type="checkbox" data-lane="${i}"${l.on ? " checked" : ""}> ${esc(l.name)}</label>`).join("");
  const opt = (list, cur, extra = "") => [`<option value="">Aucune</option>`, extra,
    ...list.map((s) => `<option value="${esc(s.name)}"${cur === s.name ? " selected" : ""}>${esc(s.label || s.name)}${s.t_min !== null && s.t_min !== undefined ? ` (${T.formatYear(s.t_min, NOW)} → ${T.formatYear(s.t_max, NOW)})` : ""}</option>`)].join("");
  $("series-world").innerHTML = opt(state.series.filter((s) => s.world_points > 0), state.worldSeries);
  $("series-lane").innerHTML = opt(state.series, state.laneSeries, `<option value="${DENSITY}"${state.laneSeries === DENSITY ? " selected" : ""}>Densité d'événements (angles morts)</option>`);
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

function addCountryLane(q, on = true) {
  let lane = state.lanes.find((l) => l.qids.length === 1 && l.qids[0] === q);
  if (!lane) { lane = { id: `x-${q}`, name: countryName(q), qids: [q], iso3: state.countryIso[q], on }; state.lanes.push(lane); }
  lane.on = on;
  renderSidebar(); fetchAll(); loadLaneSeries(); savePrefs();
}

function wireSidebar() {
  $("layers").addEventListener("change", (e) => {
    const id = e.target.dataset.layer;
    if (!id) return;
    state.layers[id] = e.target.checked;
    savePrefs(); renderSidebar(); fetchAll(); scheduleRender();
  });
  $("person-domains").addEventListener("change", (e) => {
    const d = e.target.dataset.domain;
    if (!d) return;
    e.target.checked ? state.domainsOff.delete(d) : state.domainsOff.add(d);
    savePrefs(); fetchAll();
  });
  $("btn-personal-add").addEventListener("click", () => openPanel({ type: "personal-form" }));
  $("btn-coverage").addEventListener("click", openCoverage);
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
    savePrefs(); scheduleRender(); fetchAll();
  });
  $("langs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang]");
    if (!b) return;
    state.lang = b.dataset.lang;
    savePrefs(); renderSidebar(); renderPanel(); scheduleRender();
  });
  $("lanes-list").addEventListener("change", (e) => {
    const i = e.target.dataset.lane;
    if (i === undefined) return;
    state.lanes[+i].on = e.target.checked;
    savePrefs(); scheduleRender(); fetchAll(); loadLaneSeries();
  });
  $("other-countries").addEventListener("change", (e) => {
    const q = e.target.dataset.add;
    if (q) addCountryLane(q, e.target.checked);
  });
  $("series-world").addEventListener("change", (e) => { state.worldSeries = e.target.value || null; savePrefs(); loadWorldSeries(); });
  $("series-lane").addEventListener("change", (e) => { state.laneSeries = e.target.value || null; savePrefs(); loadLaneSeries(); });
}

// ===========================================================================
// Interactions sur une frise
// ===========================================================================

function laneX(v, clientX) {
  return clientX - v.tl.getBoundingClientRect().left - labelW();
}

function wireView(v) {
  const tl = v.tl;
  tl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const x = Math.max(0, laneX(v, e.clientX));
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(dy)) {
      const du = ((e.deltaX || dy) / v.width()) * (U(v.t1) - U(v.t0));
      setViewU(v, U(v.t0) + du, U(v.t1) + du);
    } else {
      zoomAround(v, v.tAt(x), Math.exp(dy * 0.0015));
    }
  }, { passive: false });

  // Glisser à la souris ou au doigt ; pincer à deux doigts pour zoomer
  const pointers = new Map();
  let drag = null, pinch = null;
  tl.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".ev, .life, .term, .bb-btn")) return;
    pointers.set(e.pointerId, e.clientX);
    tl.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.abs(a - b) || 1, mid: v.tAt(laneX(v, (a + b) / 2)) };
      drag = null;
    } else {
      drag = { x: e.clientX, u0: U(v.t0), u1: U(v.t1) };
      tl.classList.add("dragging");
    }
  });
  tl.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e.clientX);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.abs(a - b) || 1;
      zoomAround(v, pinch.mid, pinch.d / d);
      pinch.d = d;
      return;
    }
    const x = laneX(v, e.clientX);
    const hover = v.q(".hover");
    if (x >= 0 && !drag && e.pointerType !== "touch") {
      hover.hidden = false;
      hover.style.left = `${labelW() + x}px`;
      const span = v.t1 - v.t0;
      const t = v.tAt(x);
      v.hoverT = t;
      const prec = state.log ? null : span < 4 * T.DAY ? 12 : span < 120 * T.DAY ? 11 : span < 6 ? 10 : 9;
      hover.firstElementChild.textContent = state.log ? T.formatAgeLabel(NOW - t) : T.formatDateShort(t, prec, NOW);
      renderLocalTimes(v);
    } else if (!drag) {
      hover.hidden = true;
    }
    if (!drag) return;
    const du = ((e.clientX - drag.x) / v.width()) * (drag.u1 - drag.u0);
    setViewU(v, drag.u0 - du, drag.u1 - du);
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
    tl.classList.remove("dragging");
  };
  tl.addEventListener("pointerup", end);
  tl.addEventListener("pointercancel", end);
  tl.addEventListener("pointerleave", () => { v.q(".hover").hidden = true; v.hoverT = null; renderLocalTimes(v); });
  tl.addEventListener("dblclick", (e) => {
    if (e.target.closest(".ev, .life, .term")) return;
    const x = laneX(v, e.clientX);
    if (x >= 0) zoomAround(v, v.tAt(x), 0.5);
  });
  tl.addEventListener("click", (e) => {
    const b = e.target.closest(".ev[data-qid]");
    if (b) { openEvent(b.dataset.qid, { view: v }); return; }
    const pe = e.target.closest(".ev[data-personal]");
    if (pe) { openPanel({ type: "personal", id: +pe.dataset.personal }); return; }
    const life = e.target.closest("[data-person]");
    if (life) { openPerson(life.dataset.person); return; }
    const term = e.target.closest("[data-term]");
    if (term) {
      openPerson(term.dataset.term, {
        qid: term.dataset.term, label: term.textContent || term.title, role: term.dataset.role, country: term.dataset.country,
        t0: +term.dataset.t0, t1: term.dataset.t1 ? +term.dataset.t1 : null,
      });
      return;
    }
    const wd = e.target.closest("[data-wd]");
    if (wd) { window.open(`https://www.wikidata.org/wiki/${wd.dataset.wd}`, "_blank", "noopener"); return; }
    if (e.target.closest(".bb-btn")) openPanel({ type: "bb" });
  });
  tl.addEventListener("keydown", (e) => {
    const du = (U(v.t1) - U(v.t0)) * 0.15;
    const c = v.center();
    if (e.key === "ArrowLeft") { setViewU(v, U(v.t0) - du, U(v.t1) - du); e.preventDefault(); }
    else if (e.key === "ArrowRight") { setViewU(v, U(v.t0) + du, U(v.t1) + du); e.preventDefault(); }
    else if (e.key === "+" || e.key === "=") { zoomAround(v, c, 0.7); e.preventDefault(); }
    else if (e.key === "-") { zoomAround(v, c, 1 / 0.7); e.preventDefault(); }
    else if (e.key === "Escape") closePanel();
  });
  if (!v.main) {
    v.q(".close-view").addEventListener("click", () => toggleCompare(false));
    v.q(".goto2").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const g = parseGoto(e.target.value);
      if (g) setView(v, g.t - (v.t1 - v.t0) / 2, g.t + (v.t1 - v.t0) / 2);
      else toast("Format : 1945-05-08, 1945, -500, 66 Ma");
    });
  }
}

function toggleCompare(on) {
  const btn = $("btn-compare");
  if (on && state.views.length === 1) {
    const m = mainView();
    const span = m.t1 - m.t0;
    const shift = span < 50 ? 30 : span * 1.5;   // par défaut : trente ans plus tôt
    const v = new View("v2", false, m.t0 - shift, m.t1 - shift);
    state.views.push(v);
    $("views").appendChild(v.el);
    wireView(v);
    setView(v, v.t0, v.t1);
    btn.setAttribute("aria-pressed", "true");
  } else if (!on && state.views.length > 1) {
    const v = state.views.pop();
    v.el.remove();
    btn.setAttribute("aria-pressed", "false");
    scheduleHash();
    scheduleRender();
  }
}

function wireGlobal() {
  $("overview").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = T.overviewT((e.clientX - r.left) / r.width, NOW);
    const age = Math.max(NOW - t, T.DAY);
    centerOn(mainView(), t, Math.min(age * 0.8, NOW - BIG_BANG));
  });
  document.querySelectorAll(".zoom button").forEach((b) => b.addEventListener("click", () => {
    const s = ZOOMS[b.dataset.zoom];
    for (const v of state.views) {
      if (s === null) { setScale(false, false); setView(v, BIG_BANG, NOW); }
      else centerOn(v, v.center(), s);
    }
  }));
  $("scale-lin").addEventListener("click", () => setScale(false));
  $("scale-log").addEventListener("click", () => setScale(true));
  $("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    if (dark) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("strata-theme", dark ? "dark" : "light"); } catch (e) { /* rien */ }
    scheduleRender();
  });
  $("btn-today").addEventListener("click", openToday);
  $("btn-compare").addEventListener("click", () => toggleCompare(state.views.length === 1));
  const menu = $("export-menu");
  $("btn-export").addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    $("btn-export").setAttribute("aria-expanded", String(!menu.hidden));
  });
  menu.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-export]");
    if (!b) return;
    menu.hidden = true;
    if (b.dataset.export === "link") {
      try { await navigator.clipboard.writeText(location.href); toast("Lien de la vue copié"); } catch (err) { prompt("Copie ce lien :", location.href); }
    } else window.print();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) menu.hidden = true; });
  window.addEventListener("resize", scheduleRender);
  wirePanel();
}

// ===========================================================================
// Recherche et « aller à »
// ===========================================================================

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
    if (y > 10000) return { t: NOW - y, span: y * 0.5 };
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
      const kindTxt = { discovery: " · découverte", work: " · œuvre", other: " · hors événement" };
      list.innerHTML = results.length
        ? results.map((ev, i) => `<li><button data-i="${i}">${esc(eventLabel(ev))}<span class="sub">${esc(T.formatDateShort(ev.t0, ev.precision, NOW))}${kindTxt[ev.kind] || ""}</span></button></li>`).join("")
        : `<li class="muted" style="padding:8px">Aucun résultat</li>`;
      list.hidden = false;
    }, 250);
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const ev = results[+b.dataset.i];
    if (!state.layers[ev.kind]) { state.layers[ev.kind] = true; renderSidebar(); }
    const span = ev.span ? (ev.t1 - ev.t0) * 1.4 : Math.max((ev.t1 - ev.t0) * 20, 14 * T.DAY);
    centerOn(mainView(), ev.span ? (ev.t0 + ev.t1) / 2 : ev.t0, span);
    list.hidden = true;
    openEvent(ev.qid);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) list.hidden = true; });
  $("goto").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const g = parseGoto(e.target.value);
    if (g) { centerOn(mainView(), g.t, g.span); e.target.setCustomValidity(""); }
    else { e.target.setCustomValidity("Format : 1945-05-08, 1945, -500, 66 Ma, 4.5 Ga"); e.target.reportValidity(); }
  });
}

// ===========================================================================
// Adresse de la page (#c=…&s=…&log=1&c2=…) pour garder ou partager une vue
// ===========================================================================

let hashTimer = null;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const [m, v2] = state.views;
    if (!m) return;
    let h = `#c=${((m.t0 + m.t1) / 2).toPrecision(12)}&s=${(m.t1 - m.t0).toPrecision(6)}${state.log ? "&log=1" : ""}`;
    if (v2) h += `&c2=${((v2.t0 + v2.t1) / 2).toPrecision(12)}`;
    history.replaceState(null, "", h);
  }, 300);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const c = parseFloat(p.get("c")), s = parseFloat(p.get("s")), c2 = parseFloat(p.get("c2"));
  const out = { t0: T.fyear(1945, 4, 23), t1: T.fyear(1945, 5, 24), c2: null };
  if (Number.isFinite(c) && Number.isFinite(s) && s > 0) { out.t0 = c - s / 2; out.t1 = c + s / 2; }
  if (Number.isFinite(c2)) out.c2 = c2;
  if (p.get("log") === "1") {
    state.log = true;
    $("scale-log").classList.add("on");
    $("scale-lin").classList.remove("on");
  }
  return out;
}

// ===========================================================================
// Démarrage
// ===========================================================================

async function init() {
  const h = readHash();
  let stats;
  try {
    stats = await api("/api/stats");
  } catch (e) {
    // Pas de serveur : version en ligne (données statiques)
    state.static = await loadStatic();
    stats = await api("/api/stats");
  }
  const prefs = loadPrefs();
  const [lanes, series, themes, deep] = await Promise.all([
    fetch("lanes.json").then((r) => r.json()),
    api("/api/series"),
    api("/api/themes"),
    fetch("deeptime.json").then((r) => r.json()).catch(() => null),
  ]);
  state.stats = stats;
  state.deep = deep;
  state.lanes = lanes.lanes.map((l) => ({ ...l, on: prefs.lanesOn?.[l.id] ?? l.on }));
  state.series = series.series;
  state.taxonomy = themes.themes;
  state.personDomains = themes.person_domains || [];
  state.lang = prefs.lang || "fr";
  state.themesOff = new Set(prefs.themesOff || []);
  state.subOff = new Set(prefs.subOff || []);
  state.domainsOff = new Set(prefs.domainsOff || []);
  if (prefs.layers) Object.assign(state.layers, prefs.layers);
  const has = (n) => n && (n === DENSITY || state.series.some((s) => s.name === n));
  const withWorld = (n) => n && state.series.some((s) => s.name === n && s.world_points > 0);
  state.worldSeries = prefs.worldSeries !== undefined ? (withWorld(prefs.worldSeries) ? prefs.worldSeries : null)
    : (withWorld("population") ? "population" : null);
  state.laneSeries = prefs.laneSeries !== undefined ? (has(prefs.laneSeries) ? prefs.laneSeries : null)
    : (has("population") ? "population" : null);
  $("db-stats").textContent = stats.events
    ? `${stats.events.toLocaleString("fr-FR")} éléments en base (${T.formatYear(stats.from, NOW)} → ${T.formatYear(stats.to, NOW)})${state.static ? " · version en ligne" : ""}`
    : "Base vide";

  const v = new View("v1", true, h.t0, h.t1);
  state.views.push(v);
  $("views").appendChild(v.el);
  wireView(v);
  renderSidebar();
  wireSidebar();
  wireGlobal();
  wireSearch();
  await loadCountries().catch(console.error);
  setView(v, v.t0, v.t1);
  if (h.c2 !== null) {
    toggleCompare(true);
    const v2 = state.views[1];
    const span = v.t1 - v.t0;
    setView(v2, h.c2 - span / 2, h.c2 + span / 2);
  }
  await Promise.all([loadWorldSeries(), loadLaneSeries(), loadPersonal()]).catch(console.error);
  // Adresse modifiée à la main ou favori ouvert dans le même onglet
  window.addEventListener("hashchange", () => {
    const n = readHash();
    if (!n.log && state.log) setScale(false, false);
    setView(mainView(), n.t0, n.t1);
  });
}

init().catch((e) => {
  console.error(e);
  document.querySelector("#views").innerHTML = `<div class="empty" style="position:static">Impossible de charger Strata (${esc(e.message)}). Lance : <code>python server/server.py</code></div>`;
});
