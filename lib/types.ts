// Shared types, helpers, and DB<->UI mappers.

export type Status = "confirmed" | "requested" | "tentative" | "needs-change";

export type EventType = {
  id: string; name: string; color: string; icon: string; highlight: boolean;
};
export type UIEvent = {
  id: string; typeId: string; title: string; start: string; end: string;
  time: string; status: Status; note: string; imported: boolean;
};
export type Calendar = {
  id: string; name: string; slug: string; rangeStart: string; rangeEnd: string;
};

export const STATUSES: { id: Status; label: string }[] = [
  { id: "confirmed", label: "Confirmed" },
  { id: "requested", label: "Requested" },
  { id: "tentative", label: "Tentative" },
  { id: "needs-change", label: "Needs change" },
];

export const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const DOW = ["M","T","W","T","F","S","S"];

export const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "calendar";
export const fmtShort = (s: string) => { const [, m, d] = s.split("-").map(Number); return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`; };
export const addDays = (s: string, n: number) => { const [y, m, d] = s.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); };
export const minStr = (a: string, b: string) => (a < b ? a : b);
export const tint = (hex: string, a: number) => { let h = hex.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

export function monthsBetween(startIso: string, endIso: string) {
  let [y, m] = startIso.split("-").map(Number);
  const [ey, em] = endIso.split("-").map(Number);
  const out: { year: number; m: number; key: string; name: string }[] = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push({ year: y, m, key: `${y}-${pad(m)}`, name: MONTH_NAMES[m - 1] });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// DB row -> UI
export const rowToEvent = (r: any): UIEvent => ({
  id: r.id, typeId: r.type_id, title: r.title, start: r.start_date, end: r.end_date,
  time: r.event_time || "", status: r.status, note: r.note || "", imported: r.source === "imported",
});
export const rowToType = (r: any): EventType => ({ id: r.id, name: r.name, color: r.color, icon: r.icon || "", highlight: !!r.highlight });
export const rowToCalendar = (r: any): Calendar => ({ id: r.id, name: r.name, slug: r.slug, rangeStart: r.range_start, rangeEnd: r.range_end });

// UI -> DB row (for writes)
export const eventToRow = (e: UIEvent, calendarId: string) => ({
  calendar_id: calendarId, type_id: e.typeId, title: e.title,
  start_date: e.start, end_date: e.end, event_time: e.time,
  status: e.status, note: e.note, source: e.imported ? "imported" : "manual",
});
export const typeToRow = (t: EventType, calendarId: string) => ({
  calendar_id: calendarId, name: t.name, color: t.color, icon: t.icon, highlight: t.highlight,
});

export function newCalendarTypeRows(calendarId: string) {
  return [
    { calendar_id: calendarId, name: "Activity",   color: "#A3B565", icon: "🎯", highlight: false, sort_order: 0 },
    { calendar_id: calendarId, name: "Restaurant", color: "#E58C9B", icon: "🍽️", highlight: false, sort_order: 1 },
    { calendar_id: calendarId, name: "Hotel/Stay", color: "#90C2E7", icon: "🏨", highlight: false, sort_order: 2 },
    { calendar_id: calendarId, name: "Travel",     color: "#6C8EBF", icon: "✈️", highlight: false, sort_order: 3 },
  ];
}
