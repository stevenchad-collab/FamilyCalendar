"use client";
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  DAYS, DAY_INDEX, BASE_PLACES, key, norm, whereIs, compute, together, buildChecks, eventPlace, fmt, fmtRange,
  type Loc, type Person, type PDay, type PlanEvent, type Category, type SDay,
} from "@/lib/plan";

type Role = "owner" | "editor" | "viewer";
type View = "year" | "time" | "stays" | "events";

type Props = {
  calendar: { id: string; name: string; slug: string; ownerId: string };
  role: Role;
  people: Person[];
  initialDays: PDay[];
  initialEvents: PlanEvent[];
  initialCategories: Category[];
  allCalendars: { id: string; name: string; slug: string; kind: string }[];
  userEmail: string;
  userId: string;
};

const LOC: Record<Loc, { name: string; c: string }> = {
  US: { name: "USA", c: "var(--p-us)" },
  ES: { name: "Spain", c: "var(--p-es)" },
  EU: { name: "Rest of world", c: "var(--p-eu)" },
};
const MN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const VIEWS: { id: View; name: string }[] = [
  { id: "year", name: "Year" }, { id: "time", name: "Timeline" }, { id: "stays", name: "Stays" }, { id: "events", name: "Events" },
];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const EV_SELECT = "id,title,start_day,end_day,place,category_id,must,note";
const CAT_SELECT = "id,name,icon,color,sort,place";

export default function PlanApp({ calendar, role, people, initialDays, initialEvents, initialCategories, allCalendars, userEmail, userId }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const canWrite = role === "owner" || role === "editor";
  const isOwner = role === "owner";
  const self = useMemo(() => people.find((p) => p.is_self), [people]);
  const others = useMemo(() => people.filter((p) => !p.is_self), [people]);

  const [pd, setPd] = useState<Map<string, PDay>>(() => new Map(initialDays.map((r) => [key(r.person_id, r.day), r])));
  const [events, setEvents] = useState<PlanEvent[]>(initialEvents);
  const [cats, setCats] = useState<Category[]>(initialCategories);
  const [view, setView] = useState<View>("year");
  const [layers, setLayers] = useState<Set<string>>(() => new Set(["hol", "ev", ...people.filter((p) => !p.is_self && p.default_place).map((p) => p.id)]));
  const [selA, setSelA] = useState<string | null>(null);
  const [selB, setSelB] = useState<string | null>(null);
  const [selPeople, setSelPeople] = useState<Set<string>>(() => new Set(self ? [self.id] : []));
  const [noteDraft, setNoteDraft] = useState("");
  const [other, setOther] = useState<string | null>(null);
  const [staysPerson, setStaysPerson] = useState<string>(self?.id || "");
  const [evEdit, setEvEdit] = useState<PlanEvent | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [members, setMembers] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  const [status, setStatus] = useState<{ text: string; kind: "ok" | "busy" | "err" }>({ text: "", kind: "ok" });
  const dragging = useRef(false);

  // remember layer choices per browser
  useEffect(() => {
    try { const s = localStorage.getItem("plan-layers:" + calendar.id); if (s) setLayers(new Set(JSON.parse(s))); } catch {}
  }, [calendar.id]);
  const toggleLayer = (id: string) => setLayers((p) => {
    const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem("plan-layers:" + calendar.id, JSON.stringify(Array.from(n))); } catch {}
    return n;
  });

  // ---- persistence: coalesce edits, write only changed person-days ----
  const pending = useRef<Map<string, PDay | { del: true; person_id: string; day: string }>>(new Map());
  const timer = useRef<any>(null);
  const saving = useRef(false);

  const flush = useCallback(async () => {
    if (saving.current) { timer.current = setTimeout(flush, 500); return; }
    if (pending.current.size === 0) return;
    const batch = new Map(pending.current); pending.current = new Map();
    saving.current = true; setStatus({ text: "Saving…", kind: "busy" });
    const upserts: any[] = []; const dels: Record<string, string[]> = {};
    batch.forEach((v) => {
      if ("del" in v) (dels[v.person_id] = dels[v.person_id] || []).push(v.day);
      else upserts.push({ calendar_id: calendar.id, person_id: v.person_id, day: v.day, place: v.place, loc: v.loc, note: v.note, updated_at: new Date().toISOString(), updated_by: userId });
    });
    let err: string | null = null;
    for (let i = 0; i < upserts.length && !err; i += 400) {
      const { error } = await supabase.from("plan_person_days").upsert(upserts.slice(i, i + 400), { onConflict: "person_id,day" });
      if (error) err = error.message;
    }
    for (const pid of Object.keys(dels)) {
      if (err) break;
      const { error } = await supabase.from("plan_person_days").delete().eq("person_id", pid).in("day", dels[pid]);
      if (error) err = error.message;
    }
    saving.current = false;
    if (err) {
      batch.forEach((v, k) => { if (!pending.current.has(k)) pending.current.set(k, v); });
      setStatus({ text: `Save failed (${err}); retrying…`, kind: "err" });
      timer.current = setTimeout(flush, 4000);
    } else if (pending.current.size) { timer.current = setTimeout(flush, 300); }
    else setStatus({ text: "Saved", kind: "ok" });
  }, [calendar.id, supabase, userId]);

  const schedule = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(flush, 900); setStatus({ text: "Unsaved changes…", kind: "busy" }); }, [flush]);

  // write (or with row === null, clear) a set of person-days
  const writeDays = useCallback((changes: { person_id: string; day: string; row: Omit<PDay, "person_id" | "day"> | null }[]) => {
    if (!canWrite || !changes.length) return;
    setPd((prev) => {
      const next = new Map(prev);
      for (const c of changes) {
        const k = key(c.person_id, c.day);
        if (c.row === null) { if (next.has(k) || pending.current.has(k)) { next.delete(k); pending.current.set(k, { del: true, person_id: c.person_id, day: c.day }); } }
        else { const r: PDay = { person_id: c.person_id, day: c.day, ...c.row }; next.set(k, r); pending.current.set(k, r); }
      }
      return next;
    });
    schedule();
  }, [canWrite, schedule]);

  // ---- live updates from other editors ----
  useEffect(() => {
    const ch = supabase.channel(`plan_person_days:${calendar.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_person_days", filter: `calendar_id=eq.${calendar.id}` }, (payload: any) => {
        const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as PDay | undefined;
        if (!row?.day || !row.person_id) return;
        const k = key(row.person_id, row.day);
        if (pending.current.has(k)) return;
        setPd((prev) => {
          const next = new Map(prev);
          if (payload.eventType === "DELETE") next.delete(k);
          else next.set(k, { person_id: row.person_id, day: row.day, place: row.place, loc: row.loc, note: row.note });
          return next;
        });
      }).subscribe();
    const ch2 = supabase.channel(`plan_events:${calendar.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_events", filter: `calendar_id=eq.${calendar.id}` }, async () => {
        const { data } = await supabase.from("plan_events").select(EV_SELECT).eq("calendar_id", calendar.id);
        if (data) setEvents(data as PlanEvent[]);
      }).subscribe();
    const ch3 = supabase.channel(`plan_categories:${calendar.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_categories", filter: `calendar_id=eq.${calendar.id}` }, async () => {
        const { data } = await supabase.from("plan_categories").select(CAT_SELECT).eq("calendar_id", calendar.id).order("sort").order("created_at");
        if (data) setCats(data as Category[]);
      }).subscribe();
    return () => { supabase.removeChannel(ch); supabase.removeChannel(ch2); supabase.removeChannel(ch3); };
  }, [supabase, calendar.id]);

  useEffect(() => {
    const h = () => { if (pending.current.size) flush(); };
    const up = () => { dragging.current = false; };
    window.addEventListener("beforeunload", h); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("beforeunload", h); window.removeEventListener("mouseup", up); };
  }, [flush]);

  // ---- derived ----
  const S = useMemo(() => compute(self, pd), [self, pd]);
  const catMap = useMemo(() => Object.fromEntries(cats.map((c) => [c.id, c])) as Record<string, Category>, [cats]);
  const tog = useMemo(() => Object.fromEntries(others.map((p) => [p.id, S.map((s) => together(p, s, pd))])) as Record<string, boolean[]>, [others, S, pd]);
  const t = useMemo(() => {
    const t = { us: 0, es: 0, eu: 0, eur: 0, E: 0, W: 0 };
    for (const x of S) { t.us += x.us; t.es += x.es; t.eu += x.eu; t.eur += x.eur; if (x.fl === "E") t.E++; if (x.fl === "W") t.W++; }
    return t;
  }, [S]);
  const margin = t.us - t.es;
  const aug = S.filter((x) => x.d.startsWith("2027-08")).every((x) => x.loc === "ES");
  const sortedEvents = useMemo(() => [...events].sort((a, b) => a.start_day.localeCompare(b.start_day) || a.title.localeCompare(b.title)), [events]);
  const evByDay = useMemo(() => {
    const m: Record<string, PlanEvent[]> = {};
    for (const e of sortedEvents) for (let i = DAY_INDEX[e.start_day] ?? 0; i <= (DAY_INDEX[e.end_day] ?? -1); i++) (m[DAYS[i]] = m[DAYS[i]] || []).push(e);
    return m;
  }, [sortedEvents]);
  const checks = useMemo(() => buildChecks(S, people, pd, events, catMap), [S, people, pd, events, catMap]);
  const conflictDays = useMemo(() => {
    const s = new Set<string>();
    for (const c of checks) if (c.kind === "event") for (let i = DAY_INDEX[c.a]; i <= DAY_INDEX[c.b]; i++) s.add(DAYS[i]);
    return s;
  }, [checks]);
  const places = useMemo(() => {
    const m = new Map<string, { place: string; loc: Loc; n: number }>();
    // fixed order so buttons don't move while editing: the usual four, then the 10 most-used others A-Z
    BASE_PLACES.forEach((b) => m.set(norm(b.place), { ...b, n: 0 }));
    pd.forEach((r) => { if (!r.loc) return; const k = norm(r.place); const cur = m.get(k); if (cur) cur.n++; else m.set(k, { place: r.place, loc: r.loc, n: 1 }); });
    const all = Array.from(m.values());
    const rest = all.slice(BASE_PLACES.length).sort((a, b) => b.n - a.n).slice(0, 10).sort((a, b) => a.place.localeCompare(b.place));
    return [...all.slice(0, BASE_PLACES.length), ...rest];
  }, [pd]);

  // ---- selection ----
  const range = useMemo(() => {
    if (!selA) return null;
    const b = selB || selA; const [a, z] = selA <= b ? [selA, b] : [b, selA];
    return { a, b: z, days: DAYS.slice(DAY_INDEX[a], DAY_INDEX[z] + 1) };
  }, [selA, selB]);
  const inSel = (d: string) => !!range && d >= range.a && d <= range.b;
  const select = (a: string | null, b: string | null = null) => { setSelA(a); setSelB(b); setOther(null); };
  const pressDay = (d: string, shift = false) => {
    if (selA && (shift || !selB)) { setSelB(d); } else { select(d); }
    dragging.current = true;
  };
  const enterDay = (d: string) => { if (dragging.current && selA && d !== (selB || selA)) setSelB(d); };
  const dayHandlers = (d: string) => ({
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); pressDay(d, e.shiftKey); },
    onMouseEnter: () => enterDay(d),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pressDay(d, e.shiftKey); dragging.current = false; } },
  });
  useEffect(() => {
    // prefill the note box when every selected day (first selected person) shares one note
    if (!range) { setNoteDraft(""); return; }
    const pid = Array.from(selPeople)[0]; if (!pid) return;
    const notes = new Set(range.days.map((d) => pd.get(key(pid, d))?.note || ""));
    setNoteDraft(notes.size === 1 ? Array.from(notes)[0] : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selA, selB, selPeople]);

  const applyPlace = (place: string, loc: Loc) => {
    if (!range || !place.trim()) return;
    const note = noteDraft.trim() || null;
    const changes: Parameters<typeof writeDays>[0] = [];
    for (const p of people.filter((x) => selPeople.has(x.id))) {
      const isDefault = !!p.default_place && norm(p.default_place) === norm(place) && !note;
      for (const d of range.days) changes.push({ person_id: p.id, day: d, row: isDefault ? null : { place: place.trim(), loc, note } });
    }
    writeDays(changes); setOther(null);
  };
  const applyNote = (v: string) => {
    if (!range) return;
    const changes: Parameters<typeof writeDays>[0] = [];
    for (const pid of Array.from(selPeople)) for (const d of range.days) {
      const r = pd.get(key(pid, d)); if (r && (r.note || "") !== v.trim()) changes.push({ person_id: pid, day: d, row: { place: r.place, loc: r.loc, note: v.trim() || null } });
    }
    writeDays(changes);
  };
  // put the selected people wherever Steve is on each selected day
  const applyWithMe = () => {
    if (!range) return;
    const changes: Parameters<typeof writeDays>[0] = [];
    for (const p of others.filter((x) => selPeople.has(x.id))) for (const d of range.days) {
      const s = S[DAY_INDEX[d]];
      const isDefault = !!p.default_place && norm(p.default_place) === norm(s.place);
      changes.push({ person_id: p.id, day: d, row: isDefault ? null : { place: s.place, loc: s.loc, note: null } });
    }
    writeDays(changes);
  };
  const clearSel = () => {
    if (!range) return;
    const changes: Parameters<typeof writeDays>[0] = [];
    for (const p of others.filter((x) => selPeople.has(x.id))) for (const d of range.days) changes.push({ person_id: p.id, day: d, row: null });
    writeDays(changes);
  };

  // ---- events ----
  const newEvent = (a: string, b: string): PlanEvent => ({ id: "", title: "", start_day: a, end_day: b, place: null, category_id: null, must: true, note: null });
  async function saveEvent(e: PlanEvent) {
    const row = { calendar_id: calendar.id, title: e.title.trim(), start_day: e.start_day, end_day: e.end_day < e.start_day ? e.start_day : e.end_day, place: e.place?.trim() || null, category_id: e.category_id || null, must: e.must, note: e.note?.trim() || null, updated_by: userId };
    const q = e.id ? supabase.from("plan_events").update(row).eq("id", e.id) : supabase.from("plan_events").insert(row);
    const { data, error } = await q.select(EV_SELECT).single();
    if (error || !data) { alert(error?.message || "Could not save the event"); return; }
    setEvents((p) => [...p.filter((x) => x.id !== data.id), data as PlanEvent]); setEvEdit(null);
  }
  async function deleteEvent(e: PlanEvent) {
    setEvents((p) => p.filter((x) => x.id !== e.id)); setEvEdit(null);
    const { error } = await supabase.from("plan_events").delete().eq("id", e.id);
    if (error) alert(error.message);
  }

  async function signOut() { await supabase.auth.signOut(); window.location.href = "/login"; }

  const evIcon = (e: PlanEvent) => (e.category_id && catMap[e.category_id]?.icon) || "◆";
  const evColor = (e: PlanEvent) => (e.category_id && catMap[e.category_id]?.color) || "#5f6b73";
  const dayTip = (s: SDay, i: number) => {
    const who = others.map((p) => { const w = whereIs(p, s.d, pd); return w ? `${p.name}: ${w.place}` : ""; }).filter(Boolean).join(", ");
    const fl = s.fl === "E" ? " · fly Miami → Europe (overnight)" : s.fl === "W" ? " · fly Europe → Miami" : "";
    const ev = (evByDay[s.d] || []).map((e) => evIcon(e) + " " + e.title).join(", ");
    return `${fmt(s.d)} · ${s.place} (${LOC[s.loc].name})${fl}${s.off ? " · ★ " + s.off : ""}${s.note ? " · " + s.note : ""}${who ? " · " + who : ""}${ev ? " · " + ev : ""}`;
  };

  const selInfo = range && range.a === range.b ? S[DAY_INDEX[range.a]] : null;

  return (
    <div className="app plan">
      <header className="topbar no-print">
        <div className="switcher">
          <button className="switcher__btn" onClick={() => setMenuOpen((v) => !v)}>
            <span className="brand__mark">✈︎</span>
            <span className="switcher__txt"><span className="switcher__name">{calendar.name}</span><span className="switcher__url">/plan/{calendar.slug}</span></span>
            <span className="switcher__car">▾</span>
          </button>
          {menuOpen && (
            <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
              <div className="menu__label">Your calendars</div>
              {allCalendars.map((c) => (
                <button key={c.id} className={"menu__item" + (c.slug === calendar.slug ? " is-on" : "")} onClick={() => router.push(c.kind === "plan" ? `/plan/${c.slug}` : `/c/${c.slug}`)}>
                  <span>{c.name}</span><span className="menu__url">/{c.slug}</span>
                </button>
              ))}
              {isOwner && <button className="menu__new" onClick={() => { setMenuOpen(false); setMembers(true); }}>✉️ Invite &amp; permissions</button>}
              <button className="menu__new" onClick={signOut}>🚪 Sign out{userEmail ? ` (${userEmail})` : ""}</button>
            </div>
          )}
        </div>
        <div className="topbar__actions">
          <span className={"plan__status plan__status--" + status.kind}>{!canWrite ? "View only" : status.text}</span>
          {canWrite && <button className="btn" onClick={() => setEvEdit(newEvent(range?.a || DAYS[0], range?.b || range?.a || DAYS[0]))}>＋ Event</button>}
          {canWrite && <button className="btn" onClick={() => setCatsOpen(true)}>🏷️ Categories</button>}
        </div>
      </header>

      <main className="plan__main">
        <div className="plan__totals">
          <span><b>{t.us}</b>USA</span><span><b>{t.es}</b>Spain</span>
          <span className={"plan__chk plan__chk--" + (margin >= 37 ? "ok" : margin > 0 ? "warn" : "bad")}>USA − Spain = {margin}{margin < 37 ? " (target ≥40)" : ""}</span>
          <span><b>{t.eu}</b>Rest of world</span>
          {others.filter((p) => p.default_place || tog[p.id]?.some(Boolean)).map((p) => <span key={p.id}><b>{tog[p.id].filter(Boolean).length}</b>with {p.name}</span>)}
          <span><b>{t.E + t.W}</b>flights</span>
          <span className={"plan__chk plan__chk--" + (t.es < 183 ? "ok" : "bad")}>Spain &lt; 183</span>
          <span className={"plan__chk plan__chk--" + (aug ? "ok" : "bad")}>August in Spain</span>
        </div>

        <details className={"plan__checks" + (checks.length ? " has" : "")} open={checks.length > 0 && checks.length <= 8}>
          <summary>{checks.length ? `⚠ ${checks.length} thing${checks.length > 1 ? "s" : ""} to look at` : "✓ No conflicts: every must-attend event and school holiday is covered"}</summary>
          {checks.map((c, i) => (
            <button key={i} className={"plan__check plan__check--" + c.kind} onClick={() => { select(c.a, c.b); if (view === "stays" || view === "events") setView("time"); }}>{c.text}</button>
          ))}
        </details>

        <div className="plan__tabs" role="tablist">
          {VIEWS.map((v) => <button key={v.id} role="tab" aria-selected={view === v.id} className={"preset" + (view === v.id ? " is-on" : "")} onClick={() => setView(v.id)}>{v.name}{v.id === "events" && events.length ? ` (${events.length})` : ""}</button>)}
        </div>

        {(view === "year" || view === "time") && (
          <div className="plan__layers">
            <span className="lbl">Show:</span>
            {others.map((p) => <button key={p.id} className={"layer" + (layers.has(p.id) ? " is-on" : "")} aria-pressed={layers.has(p.id)} onClick={() => toggleLayer(p.id)}><i className="pdot" style={{ background: p.color }} />{p.name}</button>)}
            <button className={"layer" + (layers.has("hol") ? " is-on" : "")} aria-pressed={layers.has("hol")} onClick={() => toggleLayer("hol")}>★ School holidays</button>
            <button className={"layer" + (layers.has("ev") ? " is-on" : "")} aria-pressed={layers.has("ev")} onClick={() => toggleLayer("ev")}>◆ Events</button>
            <button className={"layer" + (layers.has("fl") ? " is-on" : "")} aria-pressed={layers.has("fl")} onClick={() => toggleLayer("fl")}>✈ Flights</button>
          </div>
        )}

        {view === "year" && <>
          <div className="plan__legend">
            {(Object.keys(LOC) as Loc[]).map((k) => <span key={k}><i className="sw" style={{ background: LOC[k].c }} />{LOC[k].name}</span>)}
            <span><i className="sw" style={{ background: "linear-gradient(135deg,var(--p-es) 50%,var(--p-us) 50%)" }} />Travel day, counts in both</span>
            <span><i className="pdot" style={{ background: "var(--ink)" }} /> in the same place as you</span>
            <span><i className="pdot ring" style={{ borderColor: "var(--ink)" }} /> in Spain without you (Sierra, Zoe)</span>
            <span>{canWrite ? "Click a day, then a second day (or drag) to pick a range." : ""}</span>
          </div>
          <div className="plan__months">
            {MN.map((name, mo) => {
              const md = S.filter((x) => +x.d.slice(5, 7) === mo + 1);
              const lead = (new Date(2027, mo, 1).getDay() + 6) % 7;
              return (
                <div className="plan__month" key={name}>
                  <h3>{name}<span>{md.reduce((a, x) => a + x.us, 0)} US · {md.reduce((a, x) => a + x.es, 0)} ES</span></h3>
                  <div className="plan__grid">
                    {["M","T","W","T","F","S","S"].map((x, i) => <div className="plan__dow" key={i}>{x}</div>)}
                    {Array.from({ length: lead }).map((_, i) => <div key={"e" + i} />)}
                    {md.map((x) => {
                      const i = DAY_INDEX[x.d];
                      const two = x.prevLoc && x.prevLoc !== x.loc && x.prevLoc !== "US" ? LOC[x.prevLoc].c : "";
                      const evs = layers.has("ev") ? evByDay[x.d] || [] : [];
                      const cls = "plan__day " + (two ? "two" : "on") + (inSel(x.d) ? " sel" : "") + (evs.length && conflictDays.has(x.d) ? " clash" : "");
                      return (
                        <button key={x.d} className={cls} style={{ ["--c" as any]: two || LOC[x.loc].c, ["--c2" as any]: LOC[x.loc].c }} title={dayTip(x, i)} {...dayHandlers(x.d)}>
                          {layers.has("hol") && x.off && <span className="star">★</span>}
                          {evs.length > 0 && <span className="evi">{evIcon(evs[0])}</span>}
                          {layers.has("fl") && x.fl && <span className="fli">✈</span>}
                          {+x.d.slice(8)}
                          <span className="dots">
                            {others.filter((p) => layers.has(p.id)).map((p) => {
                              if (tog[p.id][i]) return <i key={p.id} className="pdot" style={{ background: p.color }} />;
                              const w = !p.default_place ? whereIs(p, x.d, pd) : null;
                              return w && w.loc === "ES" ? <i key={p.id} className="pdot ring" style={{ borderColor: p.color }} /> : null;
                            })}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>}

        {view === "time" && <div className="plan__legend">
          {(Object.keys(LOC) as Loc[]).map((k) => <span key={k}><i className="sw" style={{ background: LOC[k].c }} />{LOC[k].name}</span>)}
          <span><i className="sw" style={{ background: "var(--p-es)" }} />solid = in the same place as you</span>
          <span><i className="sw" style={{ background: "color-mix(in srgb,var(--p-es) 22%,#fff)" }} />pale = somewhere you are not</span>
        </div>}
        {view === "time" && <Timeline S={S} people={people} pd={pd} tog={tog} layers={layers} sortedEvents={sortedEvents} catMap={catMap} conflictDays={conflictDays}
          range={range} dayHandlers={dayHandlers} evIcon={evIcon} evColor={evColor}
          onSeg={(pid, a, b) => { select(a, b); setSelPeople(new Set([pid])); }} onEvent={(e) => setEvEdit(e)} />}

        {view === "stays" && <Stays S={S} people={people} pd={pd} tog={tog} person={staysPerson} setPerson={setStaysPerson} canWrite={canWrite}
          onNote={(pid, days, v) => writeDays(days.map((d) => { const r = pd.get(key(pid, d))!; return { person_id: pid, day: d, row: { place: r.place, loc: r.loc, note: v.trim() || null } }; }))}
          onPick={(pid, a, b) => { select(a, b); setSelPeople(new Set([pid])); }} write={writeDays} places={places} />}

        {view === "events" && (
          <div className="plan__tablewrap">
            <table className="plan__ranges">
              <thead><tr><th>When</th><th>Event</th><th>Where</th><th>Type</th><th>Must be there</th><th>Status</th></tr></thead>
              <tbody>
                {sortedEvents.length === 0 && <tr><td colSpan={6} className="no">No events yet.{canWrite ? " Use ＋ Event to add a match, forum day or anything you want to be in town for." : ""}</td></tr>}
                {sortedEvents.map((e) => {
                  const place = eventPlace(e, catMap);
                  const bad = DAYS.slice(DAY_INDEX[e.start_day], DAY_INDEX[e.end_day] + 1).filter((d) => conflictDays.has(d));
                  const c = e.category_id ? catMap[e.category_id] : null;
                  return (
                    <tr key={e.id} className="clk" onClick={() => setEvEdit(e)}>
                      <td className="n">{fmtRange(e.start_day, e.end_day)}</td>
                      <td><b>{evIcon(e)} {e.title}</b>{e.note ? <span className="meta"> · {e.note}</span> : null}</td>
                      <td>{place || <span className="no">—</span>}</td>
                      <td>{c ? <span className="pill" style={{ background: c.color }}>{c.icon} {c.name}</span> : <span className="no">—</span>}</td>
                      <td>{e.must ? "Yes" : <span className="no">Optional</span>}</td>
                      <td>{!place ? <span className="no">No place set</span> : !e.must ? <span className="no">—</span> : bad.length ? <span className="bad">✗ You&apos;re in {S[DAY_INDEX[bad[0]]].place}</span> : <span className="yes">✓ You&apos;re there</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="plan__note">A day counts in a country if you are physically there at any point, so a daytime Europe to Miami flight day counts on both sides (half-filled). An overnight Miami to Europe flight counts the departure day in the USA and the arrival day in Europe only. “With” someone means being in the same place that day: Barcelona and Calella de Palafrugell are different places. Milsy and Mason are in Barcelona unless a stay says otherwise. Fall 2027 school holidays are assumed from the 2026-27 ASB pattern.</p>
      </main>

      {range && (
        <div className="plan__sheet">
          <div className="row">
            <span className="title">{range.a === range.b ? fmt(range.a, true) : `${fmtRange(range.a, range.b)} · ${range.days.length} days`}</span>
            <span className="dates">
              <input type="date" aria-label="From" value={range.a} min={DAYS[0]} max={DAYS[DAYS.length - 1]} onChange={(e) => { const v = e.target.value; if (DAY_INDEX[v] === undefined) return; setSelA(v); setSelB(v > range.b ? v : range.b); }} />
              <span>to</span>
              <input type="date" aria-label="To" value={range.b} min={DAYS[0]} max={DAYS[DAYS.length - 1]} onChange={(e) => { const v = e.target.value; if (DAY_INDEX[v] === undefined) return; setSelA(v < range.a ? v : range.a); setSelB(v); }} />
            </span>
            {selInfo && <span className="meta">
              {selInfo.place} ({LOC[selInfo.loc].name}){selInfo.fl ? (selInfo.fl === "E" ? " · fly Miami → Europe tonight" : " · fly Europe → Miami") : ""}{selInfo.off ? " · ★ " + selInfo.off : ""}
              {others.map((p) => { const w = whereIs(p, selInfo.d, pd); return w ? ` · ${p.name}: ${w.place}` : ""; }).join("")}
              {(evByDay[selInfo.d] || []).map((e) => ` · ${evIcon(e)} ${e.title}`).join("")}
            </span>}
            {!selInfo && !selB && <span className="meta">Click another day to finish the range</span>}
            {canWrite && <span className={"meta plan__status--" + status.kind}>{status.text || "Changes save as you make them"}</span>}
            <button className="btn x" onClick={() => select(null)}>Done</button>
          </div>
          {canWrite && <>
            <div className="row">
              <span className="lbl">Who</span>
              <span className="meta">pick who, then click where they are:</span>
              {people.map((p) => <button key={p.id} className="locbtn who" style={{ ["--c" as any]: "var(--ink)" }} aria-pressed={selPeople.has(p.id)} onClick={() => setSelPeople((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}><i className="pdot" style={{ background: p.color }} />{p.name}</button>)}
            </div>
            <div className="row">
              <span className="lbl">Where</span>
              {others.some((p) => selPeople.has(p.id)) && (() => {
                const sel = others.filter((p) => selPeople.has(p.id));
                const on = sel.every((p) => range.days.every((d) => tog[p.id][DAY_INDEX[d]]));
                return <button className="locbtn" style={{ ["--c" as any]: "var(--ink)" }} aria-pressed={on} onClick={applyWithMe}>{on ? "✓ " : ""}With me (same place as Steve)</button>;
              })()}
              {places.map((pl) => {
                const on = selPeople.size > 0 && people.filter((p) => selPeople.has(p.id)).every((p) => range.days.every((d) => norm(whereIs(p, d, pd)?.place) === norm(pl.place)));
                return <button key={pl.place} className="locbtn" style={{ ["--c" as any]: LOC[pl.loc].c }} aria-pressed={on} disabled={!selPeople.size} onClick={() => applyPlace(pl.place, pl.loc)}><i className="sw" style={{ background: LOC[pl.loc].c }} />{pl.place}</button>;
              })}
              {other === null
                ? <button className="btn" disabled={!selPeople.size} onClick={() => setOther("")}>Somewhere else…</button>
                : <>
                    <input type="text" className="short" autoFocus value={other} placeholder="Place, e.g. Lisbon" onChange={(e) => setOther(e.target.value)} />
                    <span className="meta">then pick the country to save:</span>
                    {(Object.keys(LOC) as Loc[]).map((k) => <button key={k} className="locbtn" style={{ ["--c" as any]: LOC[k].c }} disabled={!other.trim()} onClick={() => applyPlace(other, k)}>in {LOC[k].name}</button>)}
                  </>}
            </div>
            <div className="row">
              <span className="lbl">Note</span>
              <input type="text" value={noteDraft} placeholder="Optional note for these days" onChange={(e) => setNoteDraft(e.target.value)} onBlur={() => applyNote(noteDraft)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyNote(noteDraft); } }} />
              {others.some((p) => selPeople.has(p.id) && range.days.some((d) => pd.has(key(p.id, d)))) && <button className="btn" onClick={clearSel}>Clear (back to home / unknown)</button>}
              <button className="btn" onClick={() => setEvEdit(newEvent(range.a, range.b))}>＋ Event on {range.a === range.b ? "this day" : "these days"}</button>
            </div>
          </>}
        </div>
      )}

      {evEdit && <EventModal ev={evEdit} cats={cats} places={places.map((p) => p.place)} canWrite={canWrite} onSave={saveEvent} onDelete={deleteEvent} onClose={() => setEvEdit(null)} />}
      {catsOpen && <CategoriesModal calendarId={calendar.id} supabase={supabase} cats={cats} setCats={setCats} onClose={() => setCatsOpen(false)} />}
      {members && <MembersModal calendarId={calendar.id} supabase={supabase} onClose={() => setMembers(false)} />}
    </div>
  );
}

function NoteInput({ value, disabled, onCommit, placeholder }: { value: string; disabled: boolean; onCommit: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const commit = () => { if (v !== value) onCommit(v); };
  return <input type="text" value={v} disabled={disabled} placeholder={placeholder || "Note (optional)"} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />;
}

// ---- Timeline: one row per person, plus school holidays and events, month by month ----
function Timeline({ S, people, pd, tog, layers, sortedEvents, catMap, conflictDays, range, dayHandlers, evIcon, evColor, onSeg, onEvent }: {
  S: SDay[]; people: Person[]; pd: Map<string, PDay>; tog: Record<string, boolean[]>; layers: Set<string>; sortedEvents: PlanEvent[]; catMap: Record<string, Category>; conflictDays: Set<string>;
  range: { a: string; b: string; days: string[] } | null; dayHandlers: (d: string) => any; evIcon: (e: PlanEvent) => string; evColor: (e: PlanEvent) => string;
  onSeg: (personId: string, a: string, b: string) => void; onEvent: (e: PlanEvent) => void;
}) {
  const rows = people.filter((p) => p.is_self || layers.has(p.id));
  return (
    <div className="tl">
      {MN.map((name, mo) => {
        const md = S.filter((x) => +x.d.slice(5, 7) === mo + 1);
        const n = md.length, first = md[0].d, last = md[n - 1].d;
        const col = (d: string) => DAY_INDEX[d] - DAY_INDEX[first] + 2;
        // person segments: runs of the same place (and same with-you status)
        const segs = rows.map((p) => {
          const out: { a: string; b: string; place: string; loc: Loc | null; tg: boolean; home: boolean }[] = [];
          for (const x of md) {
            const w = whereIs(p, x.d, pd); if (!w) continue;
            const tg = p.is_self || tog[p.id][DAY_INDEX[x.d]];
            const l = out[out.length - 1];
            if (l && DAY_INDEX[l.b] + 1 === DAY_INDEX[x.d] && norm(l.place) === norm(w.place) && l.tg === tg) l.b = x.d;
            else out.push({ a: x.d, b: x.d, place: w.place, loc: w.loc, tg, home: !w.explicit });
          }
          return out;
        });
        const hol: { a: string; b: string; name: string }[] = [];
        if (layers.has("hol")) for (const x of md) { if (!x.off) continue; const l = hol[hol.length - 1]; if (l && DAY_INDEX[l.b] + 1 === DAY_INDEX[x.d] && l.name === x.off) l.b = x.d; else hol.push({ a: x.d, b: x.d, name: x.off }); }
        // events: greedy lanes
        const lanes: PlanEvent[][] = [];
        if (layers.has("ev")) for (const e of sortedEvents) {
          if (e.end_day < first || e.start_day > last) continue;
          let lane = lanes.find((l) => l[l.length - 1].end_day < e.start_day);
          if (!lane) { lane = []; lanes.push(lane); }
          lane.push(e);
        }
        let r = 1;
        const selCols = range && range.b >= first && range.a <= last ? [col(range.a < first ? first : range.a), col(range.b > last ? last : range.b)] : null;
        const totalRows = 1 + rows.length + (layers.has("hol") ? 1 : 0) + Math.max(lanes.length, layers.has("ev") ? 1 : 0);
        return (
          <div className="tl__month" key={name}>
            <h3>{name}</h3>
            <div className="tl__scroll">
              <div className="tl__grid" style={{ gridTemplateColumns: `74px repeat(${n}, minmax(22px, 1fr))` }}>
                {selCols && <div className="tl__sel" style={{ gridColumn: `${selCols[0]} / ${selCols[1] + 1}`, gridRow: `1 / span ${totalRows}` }} />}
                <div className="tl__lbl" style={{ gridRow: 1, gridColumn: 1 }} />
                {md.map((x) => {
                  const dow = new Date(x.d + "T12:00:00").getDay();
                  return <button key={x.d} className={"tl__day" + (dow === 0 || dow === 6 ? " we" : "")} style={{ gridRow: 1, gridColumn: col(x.d) }} title={fmt(x.d)} {...dayHandlers(x.d)}><span>{DOW[dow]}</span>{+x.d.slice(8)}</button>;
                })}
                {rows.map((p, pi) => {
                  r++;
                  return <React.Fragment key={p.id}>
                    <div className="tl__lbl" style={{ gridRow: r, gridColumn: 1 }}><i className="pdot" style={{ background: p.color }} />{p.is_self ? "You" : p.name}</div>
                    {segs[pi].map((s) => (
                      <button key={s.a} className={"tl__seg" + (s.tg ? "" : " apart") + (s.home ? " home" : "")} style={{ gridRow: r, gridColumn: `${col(s.a)} / ${col(s.b) + 1}`, ["--c" as any]: s.loc ? LOC[s.loc].c : "#8a979e" }}
                        title={`${p.name}: ${s.place}, ${fmtRange(s.a, s.b)}${p.is_self ? "" : s.tg ? " (with you)" : " (apart)"}`} onClick={() => onSeg(p.id, s.a, s.b)}>{s.place}</button>
                    ))}
                  </React.Fragment>;
                })}
                {layers.has("hol") && (() => { r++; return <>
                  <div className="tl__lbl" style={{ gridRow: r, gridColumn: 1 }}>★ School off</div>
                  {hol.map((h) => <div key={h.a} className="tl__seg hol" style={{ gridRow: r, gridColumn: `${col(h.a)} / ${col(h.b) + 1}` }} title={`${h.name}, ${fmtRange(h.a, h.b)}`}>{h.name.replace(" (ASB)", "")}</div>)}
                </>; })()}
                {layers.has("ev") && (lanes.length ? lanes : [[]]).map((lane, li) => { r++; return <React.Fragment key={li}>
                  <div className="tl__lbl" style={{ gridRow: r, gridColumn: 1 }}>{li === 0 ? "◆ Events" : ""}</div>
                  {lane.map((e) => {
                    const a = e.start_day < first ? first : e.start_day, b = e.end_day > last ? last : e.end_day;
                    const clash = DAYS.slice(DAY_INDEX[a], DAY_INDEX[b] + 1).some((d) => conflictDays.has(d)) && e.must && !!eventPlace(e, catMap);
                    return <button key={e.id} className={"tl__seg ev" + (clash ? " clash" : "")} style={{ gridRow: r, gridColumn: `${col(a)} / ${col(b) + 1}`, ["--c" as any]: evColor(e) }} title={`${e.title}${eventPlace(e, catMap) ? " · " + eventPlace(e, catMap) : ""} · ${fmtRange(e.start_day, e.end_day)}${clash ? " · you're not there" : ""}`} onClick={() => onEvent(e)}>{evIcon(e)}{a === b ? "" : " " + e.title}</button>;
                  })}
                </React.Fragment>; })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Stays: one person's year as a list of date ranges ----
type StayRow = { a: string; b: string; days: string[]; place: string; loc: Loc | null; notes: string[]; explicit: boolean; tg: number; hol: number; fl: string[] };
type Change = { person_id: string; day: string; row: Omit<PDay, "person_id" | "day"> | null };

// date box that commits when you stop typing/picking (or leave the field), so half-typed dates never move a stay
function DateBox({ value, min, max, disabled, onCommit, label }: { value: string; min?: string; max?: string; disabled?: boolean; onCommit: (v: string) => void; label: string }) {
  const [v, setV] = useState(value);
  const t = useRef<any>(null);
  useEffect(() => { setV(value); }, [value]);
  const ok = (x: string) => DAY_INDEX[x] !== undefined && (!min || x >= min) && (!max || x <= max);
  const commit = (x: string) => { clearTimeout(t.current); if (x && x !== value && ok(x)) onCommit(x); else if (x !== value) setV(value); };
  return <input type="date" aria-label={label} value={v} min={min} max={max} disabled={disabled}
    onChange={(e) => { const x = e.target.value; setV(x); clearTimeout(t.current); t.current = setTimeout(() => commit(x), 900); }}
    onBlur={() => commit(v)} onKeyDown={(e) => { if (e.key === "Enter") commit(v); }} />;
}

function Stays({ S, people, pd, tog, person, setPerson, canWrite, onNote, onPick, write, places }: {
  S: SDay[]; people: Person[]; pd: Map<string, PDay>; tog: Record<string, boolean[]>; person: string; setPerson: (id: string) => void; canWrite: boolean;
  onNote: (personId: string, days: string[], v: string) => void; onPick: (personId: string, a: string, b: string) => void; write: (c: Change[]) => void; places: { place: string; loc: Loc }[];
}) {
  const p = people.find((x) => x.id === person) || people[0];
  const [arm, setArm] = useState(false);
  const [nw, setNw] = useState<{ a: string; b: string; place: string; loc: Loc | ""; note: string }>({ a: "", b: "", place: "", loc: "", note: "" });
  const nwOk = DAY_INDEX[nw.a] !== undefined && DAY_INDEX[nw.b] !== undefined && nw.a <= nw.b && !!nw.place.trim() && !!nw.loc;
  const setPlace = (v: string) => { const k = places.find((x) => norm(x.place) === norm(v)); setNw((o) => ({ ...o, place: v, loc: k ? k.loc : o.loc })); };
  const addStay = () => {
    if (!nwOk || !p) return;
    const note = nw.note.trim() || null;
    const home = !!p.default_place && norm(p.default_place) === norm(nw.place) && !note;
    write(DAYS.slice(DAY_INDEX[nw.a], DAY_INDEX[nw.b] + 1).map((d) => ({ person_id: p.id, day: d, row: home ? null : { place: nw.place.trim(), loc: nw.loc as Loc, note } })));
    setNw({ a: "", b: "", place: "", loc: "", note: "" });
  };
  // one row per run of consecutive days in the same place (notes do not split a stay)
  const rows = useMemo(() => {
    const out: StayRow[] = [];
    if (!p) return out;
    for (const s of S) {
      const w = whereIs(p, s.d, pd); if (!w) continue;
      const l = out[out.length - 1];
      const tg = !p.is_self && tog[p.id][DAY_INDEX[s.d]] ? 1 : 0;
      const fl = p.is_self && s.fl ? [s.fl === "E" ? "→EU" : "→MIA"] : [];
      if (l && DAY_INDEX[l.b] + 1 === DAY_INDEX[s.d] && norm(l.place) === norm(w.place) && l.explicit === w.explicit) {
        l.b = s.d; l.days.push(s.d); l.tg += tg; l.hol += s.off ? 1 : 0; l.fl.push(...fl);
        if (w.note && !l.notes.includes(w.note)) l.notes.push(w.note);
      } else out.push({ a: s.d, b: s.d, days: [s.d], place: w.place, loc: w.loc, notes: w.note ? [w.note] : [], explicit: w.explicit, tg, hol: s.off ? 1 : 0, fl });
    }
    return out;
  }, [S, p, pd, tog]);
  if (!p) return null;

  const vals = (r: StayRow) => ({ place: r.place, loc: r.loc, note: r.notes.length === 1 ? r.notes[0] : null });
  // move a stay's start or end. Days it grows into take its place; days it gives up go to the
  // neighbouring stay (for people with a home base, or no neighbour, they go back to home / unknown).
  const move = (i: number, a: string, b: string) => {
    const r = rows[i];
    if (a > b) return; // a stay cannot end before it starts
    const ch: Change[] = [];
    const prev = rows[i - 1], next = rows[i + 1];
    for (let k = DAY_INDEX[a]; k <= DAY_INDEX[b]; k++) if (DAYS[k] < r.a || DAYS[k] > r.b) ch.push({ person_id: p.id, day: DAYS[k], row: vals(r) });
    for (const d of r.days) {
      if (d >= a && d <= b) continue;
      const nb = d < a ? prev : next;
      const adjacent = nb && nb.explicit && (d < a ? DAY_INDEX[nb.b] + 1 === DAY_INDEX[r.a] : DAY_INDEX[r.b] + 1 === DAY_INDEX[nb.a]);
      if (adjacent) ch.push({ person_id: p.id, day: d, row: vals(nb!) });
      else if (!p.is_self) ch.push({ person_id: p.id, day: d, row: null });
      // for Steve with no neighbouring stay, leave the day as it is rather than create a gap
    }
    write(ch);
  };
  const explicitDays = rows.filter((r) => r.explicit).reduce((n, r) => n + r.days.length, 0);
  const resetAll = () => {
    if (!arm) { setArm(true); setTimeout(() => setArm(false), 4000); return; }
    write(rows.filter((r) => r.explicit).flatMap((r) => r.days.map((d) => ({ person_id: p.id, day: d, row: null }))));
    setArm(false);
  };
  return (
    <>
      <div className="plan__layers">
        <span className="lbl">Whose stays:</span>
        {people.map((x) => <button key={x.id} className={"layer" + (x.id === p.id ? " is-on" : "")} onClick={() => { setPerson(x.id); setArm(false); }}><i className="pdot" style={{ background: x.color }} />{x.name}</button>)}
        {canWrite && !p.is_self && explicitDays > 0 && <button className="btn mrg" style={{ marginLeft: "auto" }} onClick={resetAll}>{arm ? `Click again: clears ${explicitDays} days` : p.default_place ? `Reset ${p.name} to ${p.default_place} all year` : `Clear all of ${p.name}'s stays`}</button>}
      </div>
      <div className="plan__tablewrap">
        <table className="plan__ranges">
          <thead><tr><th>From</th><th>To</th><th>Days</th><th>Place</th><th>{p.is_self ? "Flights" : "With you"}</th><th>School holiday</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {canWrite && (
              <tr className="addrow">
                <td className="n"><input type="date" aria-label="New stay from" value={nw.a} min={DAYS[0]} max={DAYS[DAYS.length - 1]} onChange={(e) => setNw((o) => ({ ...o, a: e.target.value, b: !o.b || o.b < e.target.value ? e.target.value : o.b }))} /></td>
                <td className="n"><input type="date" aria-label="New stay to" value={nw.b} min={nw.a || DAYS[0]} max={DAYS[DAYS.length - 1]} onChange={(e) => setNw((o) => ({ ...o, b: e.target.value }))} /></td>
                <td className="n">{nwOk ? DAY_INDEX[nw.b] - DAY_INDEX[nw.a] + 1 : ""}</td>
                <td colSpan={3}>
                  <span className="dcell">
                    <input type="text" className="place" list="stay-places" aria-label="Place" placeholder="Place" value={nw.place} onChange={(e) => setPlace(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addStay(); }} />
                    <select aria-label="Country" value={nw.loc} onChange={(e) => setNw((o) => ({ ...o, loc: e.target.value as Loc | "" }))}>
                      <option value="">Country…</option>{(Object.keys(LOC) as Loc[]).map((k) => <option key={k} value={k}>{LOC[k].name}</option>)}
                    </select>
                  </span>
                  <datalist id="stay-places">{places.map((x) => <option key={x.place} value={x.place} />)}</datalist>
                </td>
                <td><input type="text" aria-label="Note" placeholder="Note (optional)" value={nw.note} onChange={(e) => setNw((o) => ({ ...o, note: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") addStay(); }} /></td>
                <td><button className="btn btn--primary mrg" disabled={!nwOk} onClick={addStay}>＋ Add stay</button></td>
              </tr>
            )}
            {rows.length === 0 && <tr><td colSpan={8} className="no">Nothing entered for {p.name} yet.{canWrite ? " Use the row above to add a stay." : ""}</td></tr>}
            {rows.map((r, i) => {
              const edit = canWrite && r.explicit;
              const dow = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short" });
              return (
                <tr key={r.a + r.place}>
                  <td className="n">{edit ? <span className="dcell"><i>{dow(r.a)}</i><DateBox label="From" value={r.a} min={DAYS[0]} max={r.b} onCommit={(v) => move(i, v, r.b)} /></span> : fmt(r.a)}</td>
                  <td className="n">{edit ? <span className="dcell"><i>{dow(r.b)}</i><DateBox label="To" value={r.b} min={r.a} max={DAYS[DAYS.length - 1]} onCommit={(v) => move(i, r.a, v)} /></span> : r.a === r.b ? "" : fmt(r.b)}</td>
                  <td className="n">{r.days.length}</td>
                  <td><span className="pill" style={{ background: r.loc ? LOC[r.loc].c : "#8a979e" }}>{r.place}</span>{!r.explicit ? <span className="meta"> home</span> : null}</td>
                  <td className="n">{p.is_self ? r.fl.join(" ") : r.tg === r.days.length ? <span className="yes">Yes</span> : r.tg ? `${r.tg} of ${r.days.length}` : <span className="no">—</span>}</td>
                  <td>{r.hol ? `★ ${r.hol === r.days.length ? "all" : r.hol}` : <span className="no">—</span>}</td>
                  <td>{r.explicit ? <NoteInput key={r.a + r.notes.join("|")} value={r.notes.join(" · ")} disabled={!canWrite} placeholder="Add a note for these days" onCommit={(v) => onNote(p.id, r.days, v)} /> : null}</td>
                  <td>{canWrite && <button className="btn mrg" onClick={() => onPick(p.id, r.a, r.b)}>{r.explicit ? "Change place" : "Change"}</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canWrite && <p className="plan__note">Change a From or To date to move where a stay begins or ends: the stay next to it grows or shrinks to match, so there are never gaps or overlaps. Consecutive days in the same place are always one stay.</p>}
    </>
  );
}

function EventModal({ ev, cats, places, canWrite, onSave, onDelete, onClose }: { ev: PlanEvent; cats: Category[]; places: string[]; canWrite: boolean; onSave: (e: PlanEvent) => void; onDelete: (e: PlanEvent) => void; onClose: () => void }) {
  const [e, setE] = useState<PlanEvent>(ev);
  const [arm, setArm] = useState(false);
  const cat = cats.find((c) => c.id === e.category_id);
  const set = (patch: Partial<PlanEvent>) => setE((p) => ({ ...p, ...patch }));
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(x) => x.stopPropagation()}>
        <div className="modal__head"><h2>{ev.id ? "Event" : "New event"}</h2><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="modal__body">
          <label className="fld"><span>What</span><input type="text" autoFocus value={e.title} disabled={!canWrite} placeholder="Tennis final, Forum, board meeting…" onChange={(x) => set({ title: x.target.value })} /></label>
          <div className="fld2">
            <label className="fld"><span>From</span><input type="date" value={e.start_day} min="2027-01-01" max="2027-12-31" disabled={!canWrite} onChange={(x) => set({ start_day: x.target.value, end_day: e.end_day < x.target.value ? x.target.value : e.end_day })} /></label>
            <label className="fld"><span>To</span><input type="date" value={e.end_day} min={e.start_day} max="2027-12-31" disabled={!canWrite} onChange={(x) => set({ end_day: x.target.value })} /></label>
          </div>
          <div className="fld2">
            <label className="fld"><span>Where</span><input type="text" list="plan-places" value={e.place || ""} disabled={!canWrite} placeholder={cat?.place ? `${cat.place} (from ${cat.name})` : "Barcelona"} onChange={(x) => set({ place: x.target.value })} /></label>
            <label className="fld"><span>Type</span><select value={e.category_id || ""} disabled={!canWrite} onChange={(x) => set({ category_id: x.target.value || null })}><option value="">None</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}</select></label>
          </div>
          <datalist id="plan-places">{places.map((p) => <option key={p} value={p} />)}</datalist>
          <label className="fld fld--row"><input type="checkbox" checked={e.must} disabled={!canWrite} onChange={(x) => set({ must: x.target.checked })} /> <span>I need to be there (warn me if my plan has me somewhere else)</span></label>
          <label className="fld"><span>Note</span><input type="text" value={e.note || ""} disabled={!canWrite} onChange={(x) => set({ note: x.target.value })} /></label>
          {canWrite && <div className="tedit__actions">
            {ev.id && <button className="btn" onClick={() => { if (!arm) { setArm(true); setTimeout(() => setArm(false), 4000); return; } onDelete(ev); }}>{arm ? "Click again to delete" : "Delete"}</button>}
            <button className="btn btn--primary" disabled={!e.title.trim() || !e.start_day || !e.end_day} onClick={() => onSave(e)}>Save</button>
          </div>}
        </div>
      </div>
    </div>
  );
}

function MembersModal({ calendarId, supabase, onClose }: { calendarId: string; supabase: any; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [roleNew, setRoleNew] = useState<"editor" | "viewer">("viewer");
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = async () => setRows((await supabase.from("calendar_invites").select("*").eq("calendar_id", calendarId).order("created_at", { ascending: false })).data || []);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);
  async function add() {
    const clean = email.trim().toLowerCase(); if (!clean) return;
    setBusy(true);
    const { error } = await supabase.from("calendar_invites").insert({ calendar_id: calendarId, email: clean, role: roleNew });
    if (error) alert(error.message);
    setEmail(""); await refresh(); setBusy(false);
  }
  async function setRole(r: any, role: "editor" | "viewer") {
    const { error } = await supabase.rpc("set_member_role", { p_calendar: calendarId, p_email: r.email, p_role: role });
    if (error) alert(error.message);
    if (!r.claimed_at) await supabase.from("calendar_invites").update({ role }).eq("id", r.id);
    await refresh();
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head"><h2>Invite &amp; permissions</h2><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="modal__body">
          <p className="modal__hint">Editors can change where people are, notes and events. Viewers see the live plan. People are added the first time they sign in with that exact email.</p>
          <div className="fld2" style={{ alignItems: "flex-end" }}>
            <label className="fld"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="milsy@example.com" onKeyDown={(e) => { if (e.key === "Enter") add(); }} /></label>
            <label className="fld"><span>Role</span><select value={roleNew} onChange={(e) => setRoleNew(e.target.value as any)}><option value="viewer">Viewer</option><option value="editor">Editor</option></select></label>
            <button className="btn btn--primary" onClick={add} disabled={busy || !email.trim()}>Invite</button>
          </div>
          <div className="sec-label">People</div>
          {rows.length === 0 && <div className="empty">No invites yet.</div>}
          <div className="tmlist">
            {rows.map((r) => (
              <div className="tmrow" key={r.id}>
                <span className="tmrow__name">{r.email}</span>
                <select value={r.role || "editor"} onChange={(e) => setRole(r, e.target.value as any)}><option value="viewer">Viewer</option><option value="editor">Editor</option></select>
                <span className="chip" style={{ background: r.claimed_at ? "#e3f3ec" : "#fdf0e0", color: r.claimed_at ? "#1f7a52" : "#9a6312" }}>{r.claimed_at ? "Joined" : "Pending"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const PALETTE = ["#b8860b", "#2a8f9d", "#c8562b", "#2f7d4f", "#7a3e8f", "#1f5fa8", "#b3261e", "#5f6b73"];

function CategoriesModal({ calendarId, supabase, cats, setCats, onClose }: {
  calendarId: string; supabase: any; cats: Category[];
  setCats: React.Dispatch<React.SetStateAction<Category[]>>; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏛️");
  const [place, setPlace] = useState("");
  const [color, setColor] = useState(PALETTE[cats.length % PALETTE.length]);
  const [busy, setBusy] = useState(false);
  const [armDel, setArmDel] = useState<string | null>(null);
  async function add() {
    const n = name.trim(); if (!n) return;
    setBusy(true);
    const { data, error } = await supabase.from("plan_categories")
      .insert({ calendar_id: calendarId, name: n, icon: icon.trim() || "•", color, place: place.trim() || null, sort: cats.length })
      .select(CAT_SELECT).single();
    setBusy(false);
    if (error || !data) { alert(error?.message || "Could not add category"); return; }
    setCats((p) => (p.some((c) => c.id === data.id) ? p : [...p, data as Category]));
    setName(""); setPlace(""); setColor(PALETTE[(cats.length + 1) % PALETTE.length]);
  }
  async function update(c: Category, patch: Partial<Category>) {
    setCats((p) => p.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
    const { error } = await supabase.from("plan_categories").update(patch).eq("id", c.id);
    if (error) alert(error.message);
  }
  async function del(c: Category) {
    if (armDel !== c.id) { setArmDel(c.id); setTimeout(() => setArmDel(null), 4000); return; }
    setCats((p) => p.filter((x) => x.id !== c.id));
    const { error } = await supabase.from("plan_categories").delete().eq("id", c.id);
    if (error) alert(error.message);
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head"><h2>Event types</h2><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="modal__body">
          <p className="modal__hint">Types group events, like 🏛️ Forum, and give them an icon and colour. A usual place (e.g. Barcelona) applies to every event of that type that has no place of its own. Deleting a type keeps its events.</p>
          <div className="fld2" style={{ alignItems: "flex-end" }}>
            <label className="fld catico"><span>Icon</span><input type="text" value={icon} maxLength={8} onChange={(e) => setIcon(e.target.value)} /></label>
            <label className="fld"><span>Name</span><input type="text" value={name} placeholder="Forum" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} /></label>
            <label className="fld"><span>Usual place</span><input type="text" value={place} placeholder="Barcelona" onChange={(e) => setPlace(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} /></label>
            <label className="fld catcol"><span>Colour</span><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
            <button className="btn btn--primary" onClick={add} disabled={busy || !name.trim()}>Add</button>
          </div>
          <div className="sec-label">Your types</div>
          {cats.length === 0 && <div className="empty">None yet.</div>}
          <div className="tmlist">
            {cats.map((c) => (
              <div className="tmrow catrow" key={c.id}>
                <span className="catico"><NoteInput value={c.icon} disabled={false} placeholder="Icon" onCommit={(v) => update(c, { icon: v.trim() || "•" })} /></span>
                <span className="tmrow__name"><NoteInput value={c.name} disabled={false} placeholder="Name" onCommit={(v) => { if (v.trim()) update(c, { name: v.trim() }); }} /></span>
                <span className="tmrow__name"><NoteInput value={c.place || ""} disabled={false} placeholder="Usual place" onCommit={(v) => update(c, { place: v.trim() || null })} /></span>
                <span className="catcol"><input type="color" value={c.color} onChange={(e) => update(c, { color: e.target.value })} /></span>
                <button className="btn" onClick={() => del(c)}>{armDel === c.id ? "Tap again to delete" : "Delete"}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
