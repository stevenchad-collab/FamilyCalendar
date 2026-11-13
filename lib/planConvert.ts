// One-time conversion of the v1 plan (BASE + plan_days edits, fam/mi flags, category tags)
// into the v2 model (per-person days + events). Pure: no database access.
import { BASE, SCHOOL_OFF, type Loc } from "./plan2027";
import { compute, together, key, DAYS, type Person, type PDay } from "./plan";

export type LegacyRow = { day: string; loc: Loc | null; note: string | null; fam: boolean | null; mi: boolean | null; cats?: string[] | null };
type LegacyDay = { d: string; loc: Loc; n: string; fam: boolean; mi: boolean; cats: string[]; us: number; es: number; eu: number; fl: "" | "E" | "W" };

// v1 logic, kept verbatim so the conversion reproduces what the old page showed
export function legacyCompute(rows: LegacyRow[]): LegacyDay[] {
  const ov: Record<string, LegacyRow> = Object.fromEntries(rows.map((r) => [r.day, r]));
  let prev: Loc = "EU";
  const out: LegacyDay[] = [];
  BASE.forEach((b, i) => {
    const o = ov[b.d];
    const loc: Loc = (o && o.loc) || b.loc;
    const n = o && o.note !== null && o.note !== undefined ? o.note : b.n;
    const counts = new Set<Loc>([loc]);
    let fl: "" | "E" | "W" = "";
    if (loc !== prev) {
      if (prev === "US") { if (i > 0) out[i - 1].fl = "E"; }
      else { counts.add(prev); if (loc === "US") fl = "W"; }
    }
    if (i === 0) { counts.clear(); counts.add(loc); }
    const us = counts.has("US") ? 1 : 0, es = counts.has("ES") ? 1 : 0, eu = counts.has("EU") ? 1 : 0;
    const off = SCHOOL_OFF[b.d] || "";
    const famD = es === 1 || ((es || eu) === 1 && !!off) || /Philadelphia/i.test(n);
    const fam = o && o.fam !== null && o.fam !== undefined ? o.fam : famD;
    const mi = o && o.mi !== null && o.mi !== undefined ? o.mi : fam;
    out.push({ d: b.d, loc, n, fam, mi, cats: (o && o.cats) || [], us, es, eu, fl });
    prev = loc;
  });
  return out;
}

// best-effort place name from the old country bucket + free-text note
export function guessPlace(loc: Loc, note: string): string {
  const n = note || "";
  if (loc === "US") {
    if (/philadelphia|philly/i.test(n)) return "Philadelphia";
    if (/new york|nyc/i.test(n)) return "New York";
    if (/los angeles|ucla/i.test(n)) return "Los Angeles";
    return "Miami";
  }
  if (loc === "ES") {
    if (/calella|casa mediterrani|costa brava/i.test(n)) return "Calella de Palafrugell";
    if (/madrid/i.test(n)) return "Madrid";
    return "Barcelona";
  }
  if (/perpignan/i.test(n)) return "Perpignan";
  if (/ski/i.test(n)) return "Ski trip";
  return "Europe trip";
}

export const SEED_PEOPLE: Omit<Person, "id">[] = [
  { name: "Steve", color: "#193b4e", sort: 0, is_self: true, default_place: null, default_loc: null },
  { name: "Milsy", color: "#f2c14e", sort: 1, is_self: false, default_place: "Barcelona", default_loc: "ES" },
  { name: "Mason", color: "#7bd389", sort: 2, is_self: false, default_place: "Barcelona", default_loc: "ES" },
  { name: "Sierra", color: "#f49ac2", sort: 3, is_self: false, default_place: null, default_loc: null },
  { name: "Zoe", color: "#9ad1f5", sort: 4, is_self: false, default_place: null, default_loc: null },
];

export type Converted = {
  days: PDay[]; // person_id filled from the people passed in
  events: { title: string; start_day: string; end_day: string; category_id: string; must: boolean }[];
};

export function convert(rows: LegacyRow[], people: Person[], catNames: Record<string, string>): Converted {
  const L = legacyCompute(rows);
  const self = people.find((p) => p.is_self)!;
  const milsy = people.find((p) => /milsy/i.test(p.name));
  const mason = people.find((p) => /mason/i.test(p.name));
  const pd = new Map<string, PDay>();
  for (const x of L) pd.set(key(self.id, x.d), { person_id: self.id, day: x.d, place: guessPlace(x.loc, x.n), loc: x.loc, note: x.n || null });
  const S = compute(self, pd);
  // carry the old "with me" flags over as locations: where the flag disagrees with
  // "at home in Barcelona", put the person in Steve's place (or mark them away)
  const carry = (p: Person | undefined, flag: (x: LegacyDay) => boolean) => {
    if (!p) return;
    L.forEach((x, i) => {
      const now = together(p, S[i], pd);
      if (flag(x) && !now) pd.set(key(p.id, x.d), { person_id: p.id, day: x.d, place: S[i].place, loc: S[i].loc, note: null });
      else if (!flag(x) && now) pd.set(key(p.id, x.d), { person_id: p.id, day: x.d, place: "Away", loc: null, note: null });
    });
  };
  carry(mason, (x) => x.fam);
  carry(milsy, (x) => x.mi);
  // category tags on days -> one event per run of consecutive days
  const events: Converted["events"] = [];
  const open: Record<string, { start: string; end: string }> = {};
  const close = (id: string) => { const r = open[id]; if (r) events.push({ title: catNames[id] || "Activity", start_day: r.start, end_day: r.end, category_id: id, must: true }); delete open[id]; };
  DAYS.forEach((d, i) => {
    const cats = L[i].cats.filter((id) => catNames[id] !== undefined);
    for (const id of Object.keys(open)) if (!cats.includes(id)) close(id);
    for (const id of cats) { if (open[id]) open[id].end = d; else open[id] = { start: d, end: d }; }
  });
  for (const id of Object.keys(open)) close(id);
  return { days: Array.from(pd.values()), events };
}
