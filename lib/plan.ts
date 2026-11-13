// Plan v2 model: where each person is on each day, plus events.
// Day-count rules are unchanged from v1 (see compute()).
import { SCHOOL_OFF } from "./plan2027";

export type Loc = "US" | "ES" | "EU";
export type Person = { id: string; name: string; color: string; sort: number; is_self: boolean; default_place: string | null; default_loc: Loc | null };
export type PDay = { person_id: string; day: string; place: string; loc: Loc | null; note: string | null };
export type PlanEvent = { id: string; title: string; start_day: string; end_day: string; place: string | null; category_id: string | null; must: boolean; note: string | null };
export type Category = { id: string; name: string; icon: string; color: string; sort: number; place?: string | null };

export const YEAR = 2027;
export const DAYS: string[] = (() => {
  const out: string[] = [];
  for (let m = 0; m < 12; m++) {
    const n = new Date(YEAR, m + 1, 0).getDate();
    for (let d = 1; d <= n; d++) out.push(`${YEAR}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
})();
export const DAY_INDEX: Record<string, number> = Object.fromEntries(DAYS.map((d, i) => [d, i]));

export const key = (personId: string, day: string) => personId + "|" + day;
export const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();

export type Where = { place: string; loc: Loc | null; note: string | null; explicit: boolean };
// where a person is on a day: their own row, else their default place, else unknown (null)
export function whereIs(p: Person, day: string, pd: Map<string, PDay>): Where | null {
  const r = pd.get(key(p.id, day));
  if (r) return { place: r.place, loc: r.loc, note: r.note, explicit: true };
  if (p.default_place) return { place: p.default_place, loc: p.default_loc, note: null, explicit: false };
  return null;
}

export type SDay = {
  d: string; loc: Loc; place: string; note: string; gap: boolean;
  us: number; es: number; eu: number; eur: number;
  off: string; fl: "" | "E" | "W"; prevLoc: Loc | null;
  places: string[]; // normalised places Steve is physically in that day
};

// Counting rules (unchanged): a day counts in every country Steve is physically in.
// Daytime Europe -> Miami: both. Overnight Miami -> Europe: departure day USA only,
// arrival day Europe only. Dec 31 2026 is treated as Europe (not Spain).
export function compute(self: Person | undefined, pd: Map<string, PDay>): SDay[] {
  let prevLoc: Loc = "EU";
  let prevPlace = "";
  const out: SDay[] = [];
  DAYS.forEach((d, i) => {
    const r = self ? pd.get(key(self.id, d)) : undefined;
    const gap = !r || !r.loc;
    const loc: Loc = (r && r.loc) || prevLoc;
    const place = r ? r.place : prevPlace || "?";
    const counts = new Set<Loc>([loc]);
    let fl: "" | "E" | "W" = "";
    if (loc !== prevLoc) {
      if (prevLoc === "US") { if (i > 0) out[i - 1].fl = "E"; }
      else { counts.add(prevLoc); if (loc === "US") fl = "W"; }
    }
    if (i === 0) { counts.clear(); counts.add(loc); }
    const us = counts.has("US") ? 1 : 0, es = counts.has("ES") ? 1 : 0, eu = counts.has("EU") ? 1 : 0;
    // physically in the previous place too, unless this is the arrival day of an overnight flight out of the USA
    const places = [norm(place)];
    if (i > 0 && norm(prevPlace) !== norm(place) && !(prevLoc === "US" && loc !== "US")) places.push(norm(prevPlace));
    out.push({ d, loc, place, note: (r && r.note) || "", gap, us, es, eu, eur: es || eu ? 1 : 0, off: SCHOOL_OFF[d] || "", fl, prevLoc: i === 0 ? null : prevLoc, places });
    prevLoc = loc; prevPlace = place;
  });
  return out;
}

// is this person in the same place as Steve that day?
export function together(p: Person, s: SDay, pd: Map<string, PDay>): boolean {
  const w = whereIs(p, s.d, pd);
  return !!w && s.places.includes(norm(w.place));
}

export const eventPlace = (e: PlanEvent, catMap: Record<string, Category>) => e.place || (e.category_id && catMap[e.category_id]?.place) || "";

export type Check = { kind: "event" | "school" | "visit" | "gap"; text: string; a: string; b: string; personId?: string };

// group a sorted list of days into consecutive runs
export function runs(days: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && DAY_INDEX[d] === DAY_INDEX[last[1]] + 1) last[1] = d; else out.push([d, d]);
  }
  return out;
}

export function fmt(d: string, long = false) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-GB", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" });
}
export const fmtRange = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`);

export function buildChecks(S: SDay[], people: Person[], pd: Map<string, PDay>, events: PlanEvent[], catMap: Record<string, Category>): Check[] {
  const out: Check[] = [];
  const byDay: Record<string, SDay> = Object.fromEntries(S.map((s) => [s.d, s]));
  // 1. must-attend events where Steve is somewhere else
  for (const e of [...events].sort((x, y) => x.start_day.localeCompare(y.start_day))) {
    const place = eventPlace(e, catMap);
    if (!e.must || !place) continue;
    const miss = DAYS.filter((d) => d >= e.start_day && d <= e.end_day && !byDay[d].places.includes(norm(place)));
    for (const [a, b] of runs(miss)) {
      const icon = e.category_id && catMap[e.category_id] ? catMap[e.category_id].icon + " " : "";
      out.push({ kind: "event", a, b, text: `${icon}${e.title} (${place}), ${fmtRange(a, b)}: you're in ${byDay[a].place}` });
    }
  }
  // 2. school-holiday days not spent in the same place as Mason
  const mason = people.find((p) => /mason/i.test(p.name));
  if (mason) {
    const miss = S.filter((s) => s.off && !together(mason, s, pd)).map((s) => s.d);
    for (const [a, b] of runs(miss)) {
      const w = whereIs(mason, a, pd);
      out.push({ kind: "school", a, b, personId: mason.id, text: `${byDay[a].off.replace(" (ASB)", "")}, ${fmtRange(a, b)}: you're in ${byDay[a].place}, ${mason.name} is in ${w ? w.place : "?"}` });
    }
  }
  // 3. visitors (people without a default place) in Spain while Steve is elsewhere
  for (const p of people.filter((x) => !x.is_self && !x.default_place)) {
    const miss = S.filter((s) => { const w = whereIs(p, s.d, pd); return !!w && w.loc === "ES" && !together(p, s, pd); });
    // split runs when the visitor's place changes
    let cur: { a: string; b: string; place: string } | null = null;
    const flush = () => { if (cur) out.push({ kind: "visit", a: cur.a, b: cur.b, personId: p.id, text: `${p.name} in ${cur.place}, ${fmtRange(cur.a, cur.b)}: you're in ${byDay[cur.a].place}` }); cur = null; };
    for (const s of miss) {
      const place = whereIs(p, s.d, pd)!.place;
      if (cur && DAY_INDEX[s.d] === DAY_INDEX[cur.b] + 1 && norm(cur.place) === norm(place)) cur.b = s.d;
      else { flush(); cur = { a: s.d, b: s.d, place }; }
    }
    flush();
  }
  // 4. days with no location for Steve
  for (const [a, b] of runs(S.filter((s) => s.gap).map((s) => s.d))) out.push({ kind: "gap", a, b, text: `No location set for you, ${fmtRange(a, b)}` });
  return out;
}

export const BASE_PLACES: { place: string; loc: Loc }[] = [
  { place: "Miami", loc: "US" }, { place: "Barcelona", loc: "ES" }, { place: "Calella de Palafrugell", loc: "ES" }, { place: "Philadelphia", loc: "US" },
];
