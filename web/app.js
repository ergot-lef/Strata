import * as T from "./time.js";

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

const THEMES = {
  guerre: { name: "Guerre", bg: "#4A2420", fg: "#F7B2A9" },
  politique: { name: "Politique", bg: "#1E3354", fg: "#A9CBFF" },
  science: { name: "Science", bg: "#1C3D31", fg: "#A6E6C9" },
  culture: { name: "Culture", bg: "#352650", fg: "#DCC4FA" },
  economie: { name: "Économie", bg: "#46321C", fg: "#F9CC9C" },
  catastrophe: { name: "Catastrophes", bg: "#4A3A16", fg: "#F2D78A" },
  sport: { name: "Sport", bg: "#163B45", fg: "#9ADBEB" },
  autre: { name: "Autre", bg: "#263042", fg: "#C3CCDA" },
};
const LANGS = ["fr", "en", "de"];
const ZOOMS = { ere: null, siecle: 100, annee: 1.2, mois: 31 * T.DAY, jour: 1.2 * T.DAY, heure: 3 * T.HOUR };
const MIN_SPAN = 0.5 * T.HOUR;
const BIG_BANG = -T.AGE_UNIVERSE;
const POINT_ROWS = 3;
const BAR_ROWS = 2;
const ROW_H = 28;
const BAR_H = 22;
const PER_LANE = 40;

// Repères de la vue d'ensemble (âges connus, en années avant aujourd'hui)
const OVERVIEW_MARKS = [
  [13.8e9, "Big Bang"], [4.54e9, "Terre"], [66e6, "Fin des dinosaures"],
  [3e5, "Homo sapiens"], [5000, "Écriture"], [260, "Révolution industrielle"], [1, "1 an"],
];

const NOW = T.nowFyear();

const state = {
  t0: T.fyear(1945, 4, 23), t1: T.fyear(1945, 5, 24),
  lang: "fr",
  themes: new Set(Object.keys(THEMES)),
  lanes: [],            // [{id, name, qids, on}]
  countryLabels: {},    // qid -> libellé
  series: [],           // séries disponibles
  seriesOn: null,
  seriesPts: [],
  events: [],
  selected: null,
  stats: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, params = {}, signal) {
  const url = new URL(path, location.href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Vue (zoom / déplacement)
// ---------------------------------------------------------------------------

function laneWidth() {
  const tl = $("timeline");
  const label = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lane-label")) || 132;
  return Math.max(100, tl.clientWidth - label);
}
const X = (t, w = laneWidth()) => ((t - state.t0) / (state.t1 - state.t0)) * w;
const tAt = (x, w = laneWidth()) => state.t0 + (x / w) * (state.t1 - state.t0);

function setView(t0, t1) {
  let span = Math.max(MIN_SPAN, t1 - t0);
  const maxSpan = (NOW - BIG_BANG) * 1.03;
  if (span > maxSpan) span = maxSpan;
  let c = (t0 + t1) / 2;
  const lo = BIG_BANG - span * 0.02;
  const hi = NOW + Math.max(span * 0.1, T.DAY);
  if (c - span / 2 < lo) c = lo + span / 2;
  if (c + span / 2 > hi) c = hi - span / 2;
  state.t0 = c - span / 2;
  state.t1 = c + span / 2;
  scheduleRender();
  scheduleFetch();
  scheduleHash();
}

function zoomAround(t, factor) {
  setView(t - (t - state.t0) * factor, t + (state.t1 - t) * factor);
}

function centerOn(t, span) {
  setView(t - span / 2, t + span / 2);
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

async function fetchEvents() {
  const qids = activeQids();
  if (!qids.length) { state.events = []; scheduleRender(); return; }
  fetchCtl?.abort();
  fetchCtl = new AbortController();
  const span = state.t1 - state.t0;
  $("loading").hidden = false;
  try {
    const data = await api("/api/events", {
      from: state.t0 - span * 0.25, to: state.t1 + span * 0.25,
      countries: qids.join(","), themes: [...state.themes].join(","), per_lane: PER_LANE,
    }, fetchCtl.signal);
    state.events = data.events;
    scheduleRender();
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  } finally {
    $("loading").hidden = true;
  }
}

async function loadSeries(name) {
  state.seriesOn = name;
  state.seriesPts = [];
  if (name) {
    const d = await api("/api/series", { name });
    state.seriesPts = d.points;
  }
  scheduleRender();
}

function seriesAt(t) {
  const p = state.seriesPts;
  if (!p.length || t < p[0][0] || t > p[p.length - 1][0]) return null;
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= t) lo = m; else hi = m; }
  const [ta, va] = p[lo], [tb, vb] = p[hi];
  return tb === ta ? va : va + ((t - ta) / (tb - ta)) * (vb - va);
}

function eventLabel(ev) {
  const order = [state.lang, ...LANGS.filter((l) => l !== state.lang)];
  for (const l of order) if (ev.text[l]?.label) return ev.text[l].label;
  return ev.qid;
}

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
  const center = (state.t0 + state.t1) / 2;
  $("title").textContent = T.formatTitle(center, span, NOW);

  // Boutons de zoom : celui qui correspond le mieux à la largeur visible
  let best = null, bestD = Infinity;
  for (const [k, s] of Object.entries(ZOOMS)) {
    const d = Math.abs(Math.log((s ?? NOW - BIG_BANG) / span));
    if (d < bestD) { bestD = d; best = k; }
  }
  document.querySelectorAll(".zoom button").forEach((b) => b.classList.toggle("on", b.dataset.zoom === best && bestD < 1));

  renderRuler(w);
  renderLanes(w);
  renderCurve(w);
  renderOverview();
}

function renderRuler(w) {
  const { ticks } = T.ticks(state.t0, state.t1, w, 90, NOW);
  $("ruler").innerHTML = ticks.map((k) => `<div class="tick" style="left:${X(k.t, w).toFixed(1)}px">${esc(k.label)}</div>`).join("");
  const label = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lane-label")) || 132;
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

function renderLanes(w) {
  const lanes = state.lanes.filter((l) => l.on);
  const html = [];
  for (const lane of lanes) {
    const qset = new Set(lane.qids);
    const evs = state.events
      .filter((e) => state.themes.has(e.theme) && e.countries.some((c) => qset.has(c)))
      .sort((a, b) => b.sitelinks - a.sitelinks);
    const barRows = Array.from({ length: BAR_ROWS }, () => []);
    const ptRows = Array.from({ length: POINT_ROWS }, () => []);
    const items = [];
    let visible = 0;
    for (const ev of evs) {
      const x0 = X(ev.t0, w), x1 = X(ev.t1, w);
      if (x1 < 0 || x0 > w) continue;
      visible++;
      const th = THEMES[ev.theme] || THEMES.autre;
      const label = eventLabel(ev);
      const sel = state.selected === ev.qid ? " sel" : "";
      const vague = ev.precision !== null && ev.precision < 11 && !ev.span ? " vague" : "";
      const title = `${label} — ${T.formatDateShort(ev.t0, ev.precision, NOW)}`;
      const isBar = ev.span || x1 - x0 > 60;
      if (isBar) {
        const a = Math.max(x0, -2), b = Math.min(x1, w + 2);
        const row = placeRow(barRows, a, b);
        if (row < 0) { items.push(`<div class="dot" style="left:${a.toFixed(1)}px;background:${th.fg}" title="${esc(title)}"></div>`); continue; }
        const top = POINT_ROWS * ROW_H + 6 + row * BAR_H;
        items.push(`<button class="ev bar${ev.span ? " span" : ""}${sel}${vague}" data-qid="${ev.qid}" title="${esc(title)}" style="left:${a.toFixed(1)}px;width:${Math.max(b - a, 8).toFixed(1)}px;top:${top}px;background-color:${th.bg};color:${th.fg}">${esc(label)}</button>`);
      } else {
        const wl = Math.min(label.length * 6.6 + 20, 280);
        const row = placeRow(ptRows, x0, x0 + wl);
        if (row < 0) { items.push(`<div class="dot" style="left:${x0.toFixed(1)}px;background:${th.fg}" title="${esc(title)}"></div>`); continue; }
        const top = 6 + row * ROW_H;
        items.push(`<div class="pin" style="left:${x0.toFixed(1)}px;top:${top + 24}px;background:${th.fg}"></div>`);
        items.push(`<button class="ev${sel}${vague}" data-qid="${ev.qid}" title="${esc(title)}" style="left:${x0.toFixed(1)}px;max-width:${wl.toFixed(0)}px;top:${top}px;background:${th.bg};color:${th.fg}">${esc(label)}</button>`);
      }
    }
    const h = POINT_ROWS * ROW_H + BAR_ROWS * BAR_H + 14;
    html.push(`<div class="lane"><div class="lane-name">${esc(lane.name)}<span class="count">${visible} événement${visible > 1 ? "s" : ""}</span></div><div class="lane-body" style="height:${h}px">${items.join("")}</div></div>`);
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

function renderCurve(w) {
  const svg = $("curve");
  const p = state.seriesPts;
  const valEl = $("series-value");
  if (!state.seriesOn || p.length < 2) { svg.innerHTML = ""; valEl.textContent = ""; return; }
  const h = 300;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const pts = [];
  const step = Math.max(1, Math.floor(w / 300));
  for (let x = 0; x <= w; x += step) {
    const v = seriesAt(tAt(x, w));
    pts.push([x, v]);
  }
  const vals = pts.map((q) => q[1]).filter((v) => v !== null);
  if (!vals.length) { svg.innerHTML = ""; } else {
    const max = Math.max(...vals) || 1;
    let area = "", line = "";
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        const pts2 = seg.map(([x, y]) => `${x} ${y.toFixed(1)}`);
        line += `M${pts2.join(" L")} `;
        area += `M${seg[0][0]} ${h} L${pts2.join(" L")} L${seg[seg.length - 1][0]} ${h} Z `;
      }
      seg = [];
    };
    for (const [x, v] of pts) {
      if (v === null) { flush(); continue; }
      seg.push([x, h - (v / max) * (h * 0.85)]);
    }
    flush();
    svg.innerHTML = `<path d="${area}" fill="#6EA8FE" fill-opacity=".25"></path><path d="${line}" fill="none" stroke="#6EA8FE" stroke-width="2" vector-effect="non-scaling-stroke"></path>`;
  }
  const meta = state.series.find((s) => s.name === state.seriesOn);
  const v = seriesAt((state.t0 + state.t1) / 2);
  valEl.textContent = v === null ? `${meta?.label ?? state.seriesOn} : pas de donnée à cette date`
    : `${meta?.label ?? state.seriesOn} ≈ ${T.formatNumber(v)}${meta?.unit ? " " + meta.unit : ""} · courbe en fond`;
}

function renderOverview() {
  const bar = $("overview");
  const a = T.overviewX(state.t0, NOW) * 100, b = T.overviewX(state.t1, NOW) * 100;
  bar.innerHTML = OVERVIEW_MARKS.map(([age, name]) => `<div class="mark" style="left:${(T.overviewX(NOW - age, NOW) * 100).toFixed(2)}%">${esc(name)}</div>`).join("")
    + `<div class="view" style="left:${a.toFixed(2)}%;width:${Math.max(b - a, 0.4).toFixed(2)}%"></div>`;
}

// ---------------------------------------------------------------------------
// Détail d'un événement
// ---------------------------------------------------------------------------

function showDetail(ev) {
  state.selected = ev.qid;
  const th = THEMES[ev.theme] || THEMES.autre;
  const countries = ev.countries.map((c) => (c === "_" ? "—" : state.countryLabels[c] || c)).join(", ");
  const date = T.formatDateShort(ev.t0, ev.precision, NOW) + (ev.span ? ` → ${T.formatDateShort(ev.t1, ev.precision, NOW)}` : "");
  const descr = ev.text[state.lang]?.descr || ev.text.fr?.descr || ev.text.en?.descr || "";
  const langs = LANGS.filter((l) => ev.text[l]?.label).map((l) => `<div><b>${l.toUpperCase()}</b>${esc(ev.text[l].label)}</div>`).join("");
  const links = LANGS.filter((l) => ev.text[l]?.article)
    .map((l) => `<a href="https://${l}.wikipedia.org/wiki/${encodeURIComponent(ev.text[l].article.replace(/ /g, "_"))}" target="_blank" rel="noopener">Wikipédia ${l.toUpperCase()}</a>`).join("");
  const el = $("detail");
  el.innerHTML = `
    <button class="close" aria-label="Fermer">×</button>
    <h2>${esc(eventLabel(ev))}</h2>
    <div class="muted">${esc(descr)}</div>
    <dl>
      <dt>Date</dt><dd>${esc(date)}</dd>
      <dt>Précision</dt><dd>${esc(ev.precision_name || "?")}</dd>
      <dt>Pays</dt><dd>${esc(countries)}</dd>
      <dt>Thème</dt><dd><span style="color:${th.fg}">${esc(th.name)}</span></dd>
      <dt>Importance</dt><dd>présent dans ${ev.sitelinks} Wikipédias</dd>
    </dl>
    <div class="langs">${langs}</div>
    <div class="links">${links}<a href="https://www.wikidata.org/wiki/${ev.qid}" target="_blank" rel="noopener">Wikidata</a></div>`;
  el.hidden = false;
  el.querySelector(".close").addEventListener("click", () => { el.hidden = true; state.selected = null; scheduleRender(); });
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Colonne de gauche
// ---------------------------------------------------------------------------

function renderSidebar() {
  $("themes").innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<button class="chip${state.themes.has(k) ? "" : " off"}" data-theme="${k}" style="background:${t.bg};color:${t.fg}" aria-pressed="${state.themes.has(k)}">${esc(t.name)}</button>`).join("");
  $("langs").innerHTML = LANGS.map((l) => `<button class="lang${state.lang === l ? " on" : ""}" data-lang="${l}" aria-pressed="${state.lang === l}">${l.toUpperCase()}</button>`).join("");
  $("lanes-list").innerHTML = state.lanes.map((l, i) =>
    `<label><input type="checkbox" data-lane="${i}"${l.on ? " checked" : ""}> ${esc(l.name)}</label>`).join("");
  $("series-list").innerHTML = state.series.length
    ? [`<label><input type="radio" name="series" value=""${state.seriesOn ? "" : " checked"}> Aucune</label>`,
      ...state.series.map((s) => `<label><input type="radio" name="series" value="${esc(s.name)}"${state.seriesOn === s.name ? " checked" : ""}> ${esc(s.label || s.name)}</label>`)].join("")
    : `<div class="muted">Aucune série. Exemple :<br><code>python collector/collect.py series population &lt;csv OWID&gt;</code></div>`;
}

async function loadOtherCountries() {
  const d = await api("/api/countries");
  const grouped = new Set(state.lanes.flatMap((l) => l.qids));
  for (const c of d.countries) state.countryLabels[c.qid] = c.fr || c.en || c.qid;
  for (const l of state.lanes) for (const q of l.qids) if (!state.countryLabels[q]) state.countryLabels[q] = l.name;
  const others = d.countries.filter((c) => !grouped.has(c.qid)).slice(0, 80);
  $("other-countries").innerHTML = others.length
    ? others.map((c) => `<label><input type="checkbox" data-add="${c.qid}"> ${esc(c.fr || c.en || c.qid)}<span class="n">${c.n}</span></label>`).join("")
    : `<div class="muted">—</div>`;
}

function wireSidebar() {
  $("themes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme]");
    if (!b) return;
    const k = b.dataset.theme;
    state.themes.has(k) ? state.themes.delete(k) : state.themes.add(k);
    renderSidebar(); scheduleRender(); scheduleFetch();
  });
  $("langs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang]");
    if (!b) return;
    state.lang = b.dataset.lang;
    renderSidebar(); scheduleRender();
  });
  $("lanes-list").addEventListener("change", (e) => {
    const i = e.target.dataset.lane;
    if (i === undefined) return;
    state.lanes[+i].on = e.target.checked;
    scheduleRender(); scheduleFetch();
  });
  $("other-countries").addEventListener("change", (e) => {
    const q = e.target.dataset.add;
    if (!q) return;
    let lane = state.lanes.find((l) => l.id === `x-${q}`);
    if (!lane) { lane = { id: `x-${q}`, name: state.countryLabels[q] || q, qids: [q], on: true }; state.lanes.push(lane); }
    lane.on = e.target.checked;
    renderSidebar(); scheduleRender(); scheduleFetch();
  });
  $("series-list").addEventListener("change", (e) => {
    if (e.target.name === "series") loadSeries(e.target.value || null);
  });
}

// ---------------------------------------------------------------------------
// Interactions sur la frise
// ---------------------------------------------------------------------------

function laneX(clientX) {
  const r = $("timeline").getBoundingClientRect();
  const label = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lane-label")) || 132;
  return clientX - r.left - label;
}

function wireTimeline() {
  const tl = $("timeline");
  tl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const x = Math.max(0, laneX(e.clientX));
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(dy)) {
      const span = state.t1 - state.t0;
      const dx = (e.deltaX || dy) / laneWidth() * span;
      setView(state.t0 + dx, state.t1 + dx);
    } else {
      zoomAround(tAt(x), Math.exp(dy * 0.0015));
    }
  }, { passive: false });

  let drag = null;
  tl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".ev")) return;
    drag = { x: e.clientX, t0: state.t0, t1: state.t1, moved: false };
    tl.setPointerCapture(e.pointerId);
    tl.classList.add("dragging");
  });
  tl.addEventListener("pointermove", (e) => {
    const x = laneX(e.clientX);
    const hover = $("hover");
    if (x >= 0 && !drag) {
      const label = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lane-label")) || 132;
      hover.hidden = false;
      hover.style.left = `${label + x}px`;
      const span = state.t1 - state.t0;
      const t = tAt(x);
      const prec = span < 4 * T.DAY ? 12 : span < 120 * T.DAY ? 11 : span < 6 ? 10 : 9;
      hover.firstElementChild.textContent = T.formatDateShort(t, prec, NOW);
    } else hover.hidden = true;
    if (!drag) return;
    const dxPx = e.clientX - drag.x;
    if (Math.abs(dxPx) > 3) drag.moved = true;
    const dt = (dxPx / laneWidth()) * (drag.t1 - drag.t0);
    setView(drag.t0 - dt, drag.t1 - dt);
  });
  const end = () => { drag = null; tl.classList.remove("dragging"); };
  tl.addEventListener("pointerup", end);
  tl.addEventListener("pointercancel", end);
  tl.addEventListener("pointerleave", () => { $("hover").hidden = true; });
  tl.addEventListener("dblclick", (e) => {
    if (e.target.closest(".ev")) return;
    const x = laneX(e.clientX);
    if (x >= 0) zoomAround(tAt(x), 0.5);
  });
  tl.addEventListener("click", (e) => {
    const b = e.target.closest(".ev");
    if (!b) return;
    const ev = state.events.find((x) => x.qid === b.dataset.qid);
    if (ev) showDetail(ev);
  });
  tl.addEventListener("keydown", (e) => {
    const span = state.t1 - state.t0;
    const c = (state.t0 + state.t1) / 2;
    if (e.key === "ArrowLeft") { setView(state.t0 - span * 0.15, state.t1 - span * 0.15); e.preventDefault(); }
    else if (e.key === "ArrowRight") { setView(state.t0 + span * 0.15, state.t1 + span * 0.15); e.preventDefault(); }
    else if (e.key === "+" || e.key === "=") { zoomAround(c, 0.7); e.preventDefault(); }
    else if (e.key === "-") { zoomAround(c, 1 / 0.7); e.preventDefault(); }
  });

  $("overview").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = T.overviewT((e.clientX - r.left) / r.width, NOW);
    const age = Math.max(NOW - t, T.DAY);
    centerOn(t, Math.min(age * 0.8, NOW - BIG_BANG));
  });

  document.querySelectorAll(".zoom button").forEach((b) => b.addEventListener("click", () => {
    const s = ZOOMS[b.dataset.zoom];
    if (s === null) setView(BIG_BANG, NOW);
    else centerOn((state.t0 + state.t1) / 2, s);
  }));

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
    const prec = m[4] ? 3 * T.HOUR : m[3] ? 3 * T.DAY : 45 * T.DAY;
    return { t: T.fyear(astro, +m[2], +(m[3] || 1), +(m[4] || 0)) + (m[4] ? 0 : m[3] ? 0.5 * T.DAY : 0), span: prec };
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
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      const d = await api("/api/search", { q });
      list.innerHTML = d.events.length
        ? d.events.map((ev, i) => `<li><button data-i="${i}">${esc(eventLabel(ev))}<span class="sub">${esc(T.formatDateShort(ev.t0, ev.precision, NOW))}</span></button></li>`).join("")
        : `<li class="muted" style="padding:8px">Aucun résultat</li>`;
      list.hidden = false;
      list.onclick = (e) => {
        const b = e.target.closest("[data-i]");
        if (!b) return;
        const ev = d.events[+b.dataset.i];
        const span = ev.span ? (ev.t1 - ev.t0) * 1.4 : Math.max((ev.t1 - ev.t0) * 20, 14 * T.DAY);
        centerOn(ev.span ? (ev.t0 + ev.t1) / 2 : ev.t0, span);
        list.hidden = true;
        if (!state.events.some((x) => x.qid === ev.qid)) state.events.push(ev);
        showDetail(ev);
      };
    }, 250);
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
// Adresse de la page (#c=…&s=…) pour garder ou partager une vue
// ---------------------------------------------------------------------------

let hashTimer = null;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = (state.t0 + state.t1) / 2, s = state.t1 - state.t0;
    history.replaceState(null, "", `#c=${c.toPrecision(12)}&s=${s.toPrecision(6)}`);
  }, 300);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const c = parseFloat(p.get("c")), s = parseFloat(p.get("s"));
  if (Number.isFinite(c) && Number.isFinite(s) && s > 0) { state.t0 = c - s / 2; state.t1 = c + s / 2; }
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function init() {
  readHash();
  const [lanes, stats, series] = await Promise.all([
    fetch("lanes.json").then((r) => r.json()),
    api("/api/stats"),
    api("/api/series"),
  ]);
  state.lanes = lanes.lanes.map((l) => ({ ...l }));
  state.stats = stats;
  state.series = series.series;
  $("db-stats").textContent = stats.events
    ? `${stats.events.toLocaleString("fr-FR")} événements en base (${T.formatYear(stats.from, NOW)} → ${T.formatYear(stats.to, NOW)})`
    : "Base vide";
  renderSidebar();
  wireSidebar();
  wireTimeline();
  wireSearch();
  if (state.series.length) await loadSeries(state.series.find((s) => s.name === "population")?.name || state.series[0].name);
  renderSidebar();
  setView(state.t0, state.t1);
  loadOtherCountries().catch(console.error);
}

init().catch((e) => {
  console.error(e);
  $("empty").hidden = false;
  $("empty").textContent = `Impossible de joindre le serveur local (${e.message}). Lance : python server/server.py`;
});
