// Mode « sans serveur » : les mêmes réponses que server/server.py, calculées
// dans le navigateur à partir de data/strata.json (voir tools/export_static.py).
// Les récits comparés sont lus directement sur Wikipédia (API ouverte, origin=*).

import { PRECISION_NAMES_FR } from "./time.js";

const WORLD = "OWID_WRL";
const CAUSE_OUT = new Set(["P828", "P1478"]);
const EFFECT_OUT = new Set(["P1542", "P1536"]);
const LINK_NAMES = {
  P828: "cause", P1478: "cause", P1542: "consequence", P1536: "consequence",
  P155: "precede", P156: "suit", P361: "partie_de", P527: "comprend", P793: "evenement",
};
const REVERSE = { cause: "consequence", consequence: "cause", precede: "suit", suit: "precede", partie_de: "comprend", comprend: "partie_de", evenement: "partie_de" };

export async function loadStatic(base = "data/strata.json") {
  const r = await fetch(base);
  if (!r.ok) throw new Error(`données statiques introuvables (${r.status})`);
  return new StaticApi(await r.json());
}

class StaticApi {
  constructor(d) {
    this.d = d;
    this.events = d.events.map(([qid, t0, t1, precision, span, date, end, sitelinks, theme, subtheme, kind, countries]) =>
      ({ qid, t0, t1, precision, span: !!span, date, end, sitelinks, theme, subtheme, kind, is_event: kind !== "other", countries: countries.length ? countries : ["_"] }));
    this.byQid = new Map(this.events.map((e) => [e.qid, e]));
    this.people = d.people.map(([qid, birth, death, prec_birth, prec_death, birth_raw, sitelinks, domain, countries]) =>
      ({ qid, birth, death, prec_birth, prec_death, birth_raw, sitelinks, domain, countries: countries.length ? countries : ["_"] }));
    this.personBy = new Map(this.people.map((p) => [p.qid, p]));
    this.linksOut = new Map();
    this.linksIn = new Map();
    for (const [q, p, t] of d.links) {
      if (!this.linksOut.has(q)) this.linksOut.set(q, []);
      this.linksOut.get(q).push([p, t]);
      if (!this.linksIn.has(t)) this.linksIn.set(t, []);
      this.linksIn.get(t).push([p, q]);
    }
    this.personal = [];
  }

  text(qid, withSummary = false) {
    const t = this.d.texts[qid] || {};
    const out = {};
    for (const [lang, [label, descr, article, summary]] of Object.entries(t)) {
      out[lang] = { label, descr, article };
      if (withSummary) out[lang].summary = summary;
    }
    return out;
  }

  labels(qid) {
    const t = this.d.texts[qid];
    if (t) return Object.fromEntries(Object.entries(t).map(([l, v]) => [l, v[0]]));
    return this.d.labels[qid] || {};
  }

  ev(e, withSummary = false) {
    return { ...e, precision_name: PRECISION_NAMES_FR[e.precision] || "", text: this.text(e.qid, withSummary) };
  }

  pe(p, withSummary = false) {
    return { ...p, text: this.text(p.qid, withSummary) };
  }

  now() {
    const n = new Date();
    return n.getUTCFullYear() + (n.getUTCMonth() + n.getUTCDate() / 31) / 12;
  }

  async call(path, q) {
    const fn = {
      "/api/stats": this.stats, "/api/themes": this.themes, "/api/series": this.series, "/api/countries": this.countries,
      "/api/events": this.eventsApi, "/api/event": this.eventApi, "/api/search": this.search, "/api/people": this.peopleApi,
      "/api/person": this.personApi, "/api/rulers": this.rulers, "/api/chain": this.chain, "/api/density": this.density,
      "/api/coverage": this.coverage, "/api/onthisday": this.onthisday, "/api/compare": this.compare,
      "/api/personal": () => ({ events: [], static: true }),
    }[path];
    if (!fn) throw new Error(`${path} indisponible hors ligne`);
    return fn.call(this, q);
  }

  stats() {
    const t = this.events.map((e) => e.t0);
    return { events: this.events.length, from: Math.min(...t), to: Math.max(...t), series: this.d.series_meta.map((s) => s.name), static: true };
  }

  themes() {
    const counts = {};
    for (const e of this.events) if (e.kind === "event") counts[`${e.theme}.${e.subtheme}`] = (counts[`${e.theme}.${e.subtheme}`] || 0) + 1;
    const themes = this.d.taxonomy.map((t) => ({
      ...t, n: Object.entries(counts).filter(([k]) => k.startsWith(`${t.id}.`)).reduce((a, [, v]) => a + v, 0),
      subs: t.subs.map((s) => ({ ...s, n: counts[`${t.id}.${s.id}`] || 0 })),
    }));
    return { themes, person_domains: this.d.person_domains };
  }

  series(q) {
    if (!q.name) return { series: this.d.series_meta };
    const pts = this.d.series[q.name] || {};
    const ents = (q.entities || WORLD).split(",").filter(Boolean);
    return { meta: this.d.series_meta.find((s) => s.name === q.name) || null, points: Object.fromEntries(ents.map((e) => [e, pts[e] || []])) };
  }

  countries() {
    const n = {};
    for (const e of this.events) for (const c of e.countries) if (c !== "_") n[c] = (n[c] || 0) + 1;
    return {
      countries: Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 400)
        .map(([qid, k]) => ({ qid, n: k, fr: this.d.labels[qid]?.fr, en: this.d.labels[qid]?.en, iso3: this.d.iso[qid] || null })),
    };
  }

  eventsApi(q) {
    const from = +q.from, to = +q.to, per = +(q.per_lane || 25);
    const themes = new Set((q.themes || "").split(",").filter(Boolean));
    const subOff = new Set((q.sub_off || "").split(",").filter(Boolean));
    const kinds = new Set((q.kinds || "event").split(",").filter(Boolean));
    const countries = new Set((q.countries || "").split(",").filter(Boolean));
    const buckets = new Map();
    for (const e of this.events) {
      if (e.t0 > to || e.t1 < from || !kinds.has(e.kind)) continue;
      if (themes.size && !themes.has(e.theme)) continue;
      if (subOff.has(`${e.theme}.${e.subtheme}`)) continue;
      for (const c of e.countries) {
        if (countries.size && !countries.has(c)) continue;
        if (!buckets.has(c)) buckets.set(c, []);
        buckets.get(c).push(e);
      }
    }
    const out = new Map();
    for (const list of buckets.values()) {
      list.sort((a, b) => b.sitelinks - a.sitelinks);
      for (const e of list.slice(0, per)) out.set(e.qid, e);
    }
    for (const qid of (q.extra || "").split(",").filter(Boolean)) {
      const e = this.byQid.get(qid);
      if (e && e.t0 <= to && e.t1 >= from) out.set(qid, e);
    }
    return { events: [...out.values()].map((e) => this.ev(e)) };
  }

  eventApi(q) {
    const e = this.byQid.get(q.qid);
    if (!e) return { event: null };
    const ev = this.ev(e, true);
    const pairs = [
      ...(this.linksOut.get(e.qid) || []).map(([p, t]) => [LINK_NAMES[p] || p, t]),
      ...(this.linksIn.get(e.qid) || []).map(([p, s]) => [REVERSE[LINK_NAMES[p]] || "lie", s]),
    ];
    const seen = new Set();
    ev.links = pairs.filter(([k, t]) => !seen.has(k + t) && seen.add(k + t)).map(([kind, qid]) => {
      const t = this.byQid.get(qid);
      return { kind, qid, labels: this.labels(qid), t0: t ? t.t0 : null, precision: t ? t.precision : null };
    });
    ev.same_day = (e.precision || 0) >= 11
      ? this.events.filter((x) => x.qid !== e.qid && x.kind === "event" && (x.precision || 0) >= 11 && x.date?.slice(0, 11) === e.date?.slice(0, 11))
        .sort((a, b) => b.sitelinks - a.sitelinks).slice(0, 15).map((x) => this.ev(x))
      : [];
    ev.wiki_count = Object.keys(this.d.wikis[e.qid] || {}).length;
    return { event: ev };
  }

  search(q) {
    const term = (q.q || "").toLowerCase();
    if (term.length < 2) return { events: [] };
    const hits = this.events.filter((e) => Object.values(this.d.texts[e.qid] || {}).some((v) => (v[0] || "").toLowerCase().includes(term)));
    hits.sort((a, b) => (b.is_event - a.is_event) || b.sitelinks - a.sitelinks);
    return { events: hits.slice(0, 25).map((e) => this.ev(e)) };
  }

  peopleApi(q) {
    const from = +q.from, to = +q.to, per = +(q.per_lane || 12), now = this.now();
    const countries = new Set((q.countries || "").split(",").filter(Boolean));
    const off = new Set((q.domains_off || "").split(",").filter(Boolean));
    const buckets = new Map();
    for (const p of this.people) {
      const end = p.death ?? Math.min(p.birth + 100, now);
      if (p.birth > to || end < from || off.has(p.domain)) continue;
      for (const c of p.countries) {
        if (countries.size && !countries.has(c)) continue;
        if (!buckets.has(c)) buckets.set(c, []);
        buckets.get(c).push(p);
      }
    }
    const out = new Map();
    for (const list of buckets.values()) {
      list.sort((a, b) => b.sitelinks - a.sitelinks);
      for (const p of list.slice(0, per)) out.set(p.qid, p);
    }
    return { people: [...out.values()].map((p) => this.pe(p)) };
  }

  personApi(q) {
    const p = this.personBy.get(q.qid);
    if (!p) return { person: null };
    const end = p.death ?? this.now();
    const out = this.pe(p, true);
    out.contemporaries = this.people.filter((x) => x.qid !== p.qid && x.birth <= end && (x.death ?? x.birth + 100) >= p.birth)
      .sort((a, b) => b.sitelinks - a.sitelinks).slice(0, 20).map((x) => this.pe(x));
    out.offices = this.d.terms.filter((t) => t[2] === p.qid).map(([country, role, , t0, t1]) => ({ country, role, t0, t1, country_label: this.d.labels[country] || {} }));
    return { person: out };
  }

  rulers(q) {
    const from = +q.from, to = +q.to, now = this.now();
    const countries = new Set((q.countries || "").split(",").filter((c) => c && c !== "_"));
    const terms = this.d.terms.filter(([c, , , t0, t1]) => countries.has(c) && t0 <= to && (t1 ?? now) >= from)
      .map(([country, role, person, t0, t1]) => ({ country, role, person, t0, t1, labels: this.d.labels[person] || this.labels(person) }));
    const states = this.d.states.filter(([qid]) => countries.has(qid)).map(([qid, t0, t1]) => ({ qid, t0, t1, labels: this.d.labels[qid] || {} }));
    return { terms, states };
  }

  chain(q) {
    const want = (q.dir || "causes") === "causes";
    const fwd = want ? CAUSE_OUT : EFFECT_OUT, back = want ? EFFECT_OUT : CAUSE_OUT;
    const seen = new Set([q.qid]);
    const nodes = [];
    let frontier = [q.qid];
    for (let level = 1; level <= Math.min(+(q.depth || 4), 8) && frontier.length; level++) {
      const next = [];
      for (const cur of frontier) {
        const found = [
          ...(this.linksOut.get(cur) || []).filter(([p]) => fwd.has(p)).map(([, t]) => t),
          ...(this.linksIn.get(cur) || []).filter(([p]) => back.has(p)).map(([, s]) => s),
        ];
        for (const t of found) {
          if (seen.has(t)) continue;
          seen.add(t);
          const e = this.byQid.get(t);
          nodes.push({ qid: t, parent: cur, level, labels: this.labels(t), t0: e ? e.t0 : null, precision: e ? e.precision : null });
          next.push(t);
        }
      }
      frontier = next.slice(0, 60);
    }
    return { qid: q.qid, dir: want ? "causes" : "consequences", nodes };
  }

  density(q) {
    const from = +q.from, to = +q.to, bins = Math.max(10, Math.min(+(q.bins || 120), 400));
    const width = (to - from) / bins;
    const countries = (q.countries || "").split(",").filter(Boolean);
    const set = new Set(countries);
    const counts = Object.fromEntries(countries.map((c) => [c, new Array(bins).fill(0)]));
    for (const e of this.events) {
      if (e.kind !== "event" || e.t0 < from || e.t0 >= to) continue;
      const b = Math.floor((e.t0 - from) / width);
      for (const c of e.countries) if (set.has(c) && b >= 0 && b < bins) counts[c][b]++;
    }
    return { from, to, bins, counts };
  }

  coverage(q) {
    const from = +q.from, to = +q.to, mid = (from + to) / 2;
    const n = {};
    for (const e of this.events) if (e.kind === "event" && e.t0 <= to && e.t1 >= from) for (const c of e.countries) if (c !== "_") n[c] = (n[c] || 0) + 1;
    const pop = this.d.series.population || {};
    return {
      countries: Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([qid, k]) => {
        const iso3 = this.d.iso[qid] || null;
        const pts = iso3 ? pop[iso3] : null;
        let population = null;
        if (pts && pts.length) population = pts.reduce((best, p) => (Math.abs(p[0] - mid) < Math.abs(best[0] - mid) ? p : best))[1];
        return { qid, n: k, fr: this.d.labels[qid]?.fr, en: this.d.labels[qid]?.en, iso3, population, per_million: population ? k / (population / 1e6) : null };
      }),
    };
  }

  onthisday(q) {
    const md = `-${String(q.m).padStart(2, "0")}-${String(q.d).padStart(2, "0")}T`;
    const events = this.events.filter((e) => (e.precision || 0) >= 11 && e.kind !== "other" && e.date?.includes(md))
      .sort((a, b) => b.sitelinks - a.sitelinks).slice(0, 60).sort((a, b) => a.t0 - b.t0).map((e) => this.ev(e));
    const births = this.people.filter((p) => (p.prec_birth || 0) >= 11 && p.birth_raw?.includes(md))
      .sort((a, b) => b.sitelinks - a.sitelinks).slice(0, 20).sort((a, b) => a.birth - b.birth).map((p) => this.pe(p));
    return { m: +q.m, d: +q.d, events, births };
  }

  async compare(q) {
    const titles = this.d.wikis[q.qid] || {};
    const known = this.d.texts[q.qid] || {};
    this.cache ??= {};
    const pages = Object.entries(titles).map(([lang, title]) => {
      const c = this.cache[`${q.qid}|${lang}`];
      return { lang, title, summary: c?.summary ?? known[lang]?.[3] ?? null, length: c?.length ?? null };
    });
    const errors = [];
    for (const lang of (q.fetch || "").split(",").filter(Boolean).slice(0, 15)) {
      const page = pages.find((p) => p.lang === lang);
      if (!page || (page.summary && page.length)) continue;
      try {
        const url = `https://${lang}.wikipedia.org/w/api.php?origin=*&action=query&prop=extracts|info&exintro=1&explaintext=1&redirects=1&formatversion=2&format=json&titles=${encodeURIComponent(page.title)}`;
        const data = await (await fetch(url)).json();
        const p = data.query?.pages?.[0] || {};
        let text = (p.extract || "").replace(/\s+/g, " ").trim();
        if (text.length > 1500) text = text.slice(0, 1500).replace(/\s\S*$/, "") + " …";
        page.summary = text;
        page.length = p.length ?? null;
        this.cache[`${q.qid}|${lang}`] = { summary: text, length: page.length };
      } catch (e) {
        errors.push(`${lang} : ${e.message}`);
      }
    }
    return { qid: q.qid, pages: pages.sort((a, b) => a.lang.localeCompare(b.lang)), errors };
  }
}
