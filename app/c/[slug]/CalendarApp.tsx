"use client";
import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  STATUSES, DOW, MONTH_NAMES, iso, slugify, fmtShort, addDays, minStr, tint,
  monthsBetween, eventToRow, typeToRow, rowToEvent, rowToType, newCalendarTypeRows,
  type Calendar, type EventType, type UIEvent,
} from "@/lib/types";

const EMOJI = ["🚣","⭐","🍽️","🧑‍🍳","🎶","🧹","🪂","🎉","🎓","🏖️","🍷","🎂","🏠","🏨","👥","🧑‍🤝‍🧑","✈️","🚗","🌙","🎯","⚽","🎾","🩺","🛒"];
const SWATCHES = ["#8FCB9B","#F2D06B","#EF9A9A","#90C2E7","#B9A6E3","#7FB5B5","#B08968","#6C8EBF","#C77DFF","#A3B565","#B0A08F","#F4A0C0","#EC6A5E","#E58C9B","#6BBF8A"];
const TODAY = new Date().toISOString().slice(0, 10);

// ===== QUICK VIEWS (the buttons under "Quick views" in the left filter rail) =====
// Add, remove, rename, or reorder freely. The page hot-reloads when you save.
//   name  = the button label
//   match = shows every event type whose NAME contains this text (case-insensitive)
//   match: null  = an "Everything" button that turns all types on
const PRESETS: { name: string; match: string | null }[] = [
  { name: "Everything",   match: null },
  { name: "Restaurants",  match: "restaurant" },
  { name: "Chef Nights",  match: "chef" },
  { name: "Boat days",    match: "boat" },
  { name: "Fiorella",     match: "fiorella" },
  { name: "House Guests", match: "house" },
  { name: "Travel",       match: "travel" },
];

type Props = {
  calendar: Calendar;
  initialTypes: EventType[];
  initialEvents: UIEvent[];
  allCalendars: { id: string; name: string; slug: string }[];
};

export default function CalendarApp({ calendar, initialTypes, initialEvents, allCalendars }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const cal = calendar;

  const [types, setTypes] = useState<EventType[]>(initialTypes);
  const [events, setEvents] = useState<UIEvent[]>(initialEvents);
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(new Set(initialTypes.map((t) => t.id)));
  const [visibleStatus, setVisibleStatus] = useState<Set<string>>(new Set(STATUSES.map((s) => s.id)));
  const [filterStart, setFilterStart] = useState(cal.rangeStart);
  const [filterEnd, setFilterEnd] = useState(cal.rangeEnd);
  const [mode, setMode] = useState<"month" | "list">("month");
  const [modal, setModal] = useState<any>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const typeById = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);
  const months = useMemo(() => monthsBetween(cal.rangeStart, cal.rangeEnd), [cal.rangeStart, cal.rangeEnd]);

  // ---------- persistence ----------
  async function saveEvent(ui: UIEvent) {
    if (events.some((e) => e.id === ui.id)) {
      const { error } = await supabase.from("events").update(eventToRow(ui, cal.id)).eq("id", ui.id);
      if (error) return alert(error.message);
      setEvents((p) => p.map((e) => (e.id === ui.id ? ui : e)));
    } else {
      const { data, error } = await supabase.from("events").insert(eventToRow(ui, cal.id)).select().single();
      if (error) return alert(error.message);
      setEvents((p) => [...p, rowToEvent(data)]);
    }
  }
  async function saveMany(list: UIEvent[]) {
    const { data, error } = await supabase.from("events").insert(list.map((e) => eventToRow(e, cal.id))).select();
    if (error) return alert(error.message);
    setEvents((p) => [...p, ...(data || []).map(rowToEvent)]);
  }
  async function deleteEvent(id: string) {
    const { error } = await supabase.from("events").delete().eq("id", id);
    if (error) return alert(error.message);
    setEvents((p) => p.filter((e) => e.id !== id));
  }
  async function applyTypeDates(deleteIds: string[], addList: UIEvent[]) {
    if (deleteIds.length) {
      const { error } = await supabase.from("events").delete().in("id", deleteIds);
      if (error) return alert(error.message);
    }
    let inserted: UIEvent[] = [];
    if (addList.length) {
      const { data, error } = await supabase.from("events").insert(addList.map((e) => eventToRow(e, cal.id))).select();
      if (error) return alert(error.message);
      inserted = (data || []).map(rowToEvent);
    }
    setEvents((p) => [...p.filter((e) => !deleteIds.includes(e.id)), ...inserted]);
  }
  async function saveType(t: EventType, isNew: boolean) {
    if (isNew) {
      const { data, error } = await supabase.from("event_types").insert(typeToRow(t, cal.id)).select().single();
      if (error) return alert(error.message);
      setTypes((p) => [...p, rowToType(data)]);
      setVisibleTypes((v) => new Set([...v, data.id]));
    } else {
      const { error } = await supabase.from("event_types").update(typeToRow(t, cal.id)).eq("id", t.id);
      if (error) return alert(error.message);
      setTypes((p) => p.map((x) => (x.id === t.id ? t : x)));
    }
  }
  async function deleteType(id: string) {
    const { error } = await supabase.from("event_types").delete().eq("id", id);
    if (error) return alert(error.message);
    setTypes((p) => p.filter((x) => x.id !== id));
    setEvents((p) => p.filter((e) => e.typeId !== id));
  }
  async function createCalendar(name: string, start: string, end: string) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    let slug = slugify(name);
    let attempt = await supabase.from("calendars").insert({ owner_id: user.id, name, slug, range_start: start, range_end: end }).select().single();
    if (attempt.error) { slug = slug + "-" + Math.random().toString(36).slice(2, 5); attempt = await supabase.from("calendars").insert({ owner_id: user.id, name, slug, range_start: start, range_end: end }).select().single(); }
    if (attempt.error || !attempt.data) return alert(attempt.error?.message || "Could not create calendar");
    await supabase.from("calendar_members").insert({ calendar_id: attempt.data.id, user_id: user.id, role: "owner" });
    await supabase.from("event_types").insert(newCalendarTypeRows(attempt.data.id));
    router.push(`/c/${slug}`);
  }
  async function createShareLink() {
    const allOn = visibleTypes.size === types.length;
    const { data, error } = await supabase.from("shared_views").insert({
      calendar_id: cal.id, range_start: filterStart, range_end: filterEnd,
      type_ids: allOn ? [] : [...visibleTypes], statuses: [],
    }).select().single();
    if (error) { alert(error.message); return null; }
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/c/${cal.slug}/share/${data.token}`;
  }
  async function subscribeFeed(url: string, typeId: string) {
    const { data: sub } = await supabase.from("calendar_subscriptions").insert({ calendar_id: cal.id, ics_url: url, type_id: typeId }).select().single();
    const within = (d: string) => d >= cal.rangeStart && d <= cal.rangeEnd;
    const demo = [["Airbnb — guest stay", "2026-07-04", "2026-07-11"], ["Booking.com — guest stay", "2026-08-02", "2026-08-09"]]
      .filter((r) => within(r[1]))
      .map((r) => ({ calendar_id: cal.id, type_id: typeId, title: r[0], start_date: r[1], end_date: r[2], status: "confirmed", source: "imported", subscription_id: sub?.id }));
    const { data, error } = await supabase.from("events").insert(demo).select();
    if (error) return alert(error.message);
    setEvents((p) => [...p, ...(data || []).map(rowToEvent)]);
  }

  // ---------- derived ----------
  const overlapsRange = (e: UIEvent) => e.end >= filterStart && e.start <= filterEnd;
  const isVisible = (e: UIEvent) => visibleTypes.has(e.typeId) && visibleStatus.has(e.status) && overlapsRange(e);
  const eventsForDay = (d: string) => events.filter((e) => isVisible(e) && e.start <= d && e.end >= d);

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) if (overlapsRange(e) && visibleStatus.has(e.status)) c[e.typeId] = (c[e.typeId] || 0) + 1;
    return c;
  }, [events, filterStart, filterEnd, visibleStatus]);

  const railTypes = useMemo(
    () => [...types].sort((a, b) => (typeCounts[b.id] || 0) - (typeCounts[a.id] || 0) || a.name.localeCompare(b.name)),
    [types, typeCounts]
  );

  const toggleType = (id: string) => setVisibleTypes((v) => { const n = new Set(v); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleStatus = (id: string) => setVisibleStatus((v) => { const n = new Set(v); n.has(id) ? n.delete(id) : n.add(id); return n; });
  function applyPreset(p: any) {
    if (!p.match) setVisibleTypes(new Set(types.map((t) => t.id)));
    else setVisibleTypes(new Set(types.filter((t) => t.name.toLowerCase().includes(p.match)).map((t) => t.id)));
    setRailOpen(false);
  }
  const scrollToMonth = (key: string) => { const el = document.getElementById("m-" + key); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const fmtDate = (s: string) => { const [, m, d] = s.split("-").map(Number); return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`; };
  const statusChip = (s: string) => s === "confirmed" ? null : <span className={"sc sc--" + s}>{STATUSES.find((x) => x.id === s)?.label}</span>;
  const visibleCount = events.filter(isVisible).length;

  function DayCells({ mo }: { mo: any }) {
    const firstDow = (new Date(Date.UTC(mo.year, mo.m - 1, 1)).getUTCDay() + 6) % 7;
    const dim = new Date(Date.UTC(mo.year, mo.m, 0)).getUTCDate();
    const cells: any[] = [];
    for (let i = 0; i < firstDow; i++) cells.push(<div className="cell cell--empty" key={"e" + i} />);
    for (let d = 1; d <= dim; d++) {
      const dayIso = iso(mo.year, mo.m, d);
      const evs = eventsForDay(dayIso);
      const hl = evs.find((e) => typeById[e.typeId]?.highlight);
      const hlColor = hl ? typeById[hl.typeId].color : null;
      const titlesFor = (tid: string) => evs.filter((e) => e.typeId === tid).map((e) => e.title).join(", ");
      const daySummary = evs.length ? evs.map((e) => { const t = typeById[e.typeId]; return `${t?.icon ? t.icon + " " : ""}${e.title}${e.time ? " · " + e.time : ""}`; }).join("\n") : undefined;
      const iconTypes: EventType[] = []; const seenI = new Set<string>();
      for (const e of evs) {
        const t = typeById[e.typeId]; if (!t?.icon) continue;
        if (t.name.toLowerCase().includes("rental guests") && dayIso !== e.start && dayIso !== e.end) continue;
        if (seenI.has(t.id)) continue; seenI.add(t.id); iconTypes.push(t);
      }
      const bars: EventType[] = []; const seenB = new Set<string>();
      for (const e of evs) { const t = typeById[e.typeId]; if (!t || t.icon) continue; if (seenB.has(e.typeId)) continue; seenB.add(e.typeId); bars.push(t); }
      const isToday = dayIso === TODAY;
      cells.push(
        <button key={dayIso} className="cell" title={daySummary} onClick={() => setModal({ kind: "day", day: dayIso })}>
          <div className="cell__top">
            <span className={"date" + (isToday ? " date--today" : "")} style={hlColor ? { background: hlColor, color: "#1f3b2c" } : undefined} title={hl ? (titlesFor(hl.typeId) || typeById[hl.typeId].name) : undefined}>{d}</span>
            <span className="cell__icons" style={{ display: "inline-flex", gap: 2 }}>{iconTypes.slice(0, 2).map((t) => <span key={t.id} title={titlesFor(t.id) || t.name}>{t.icon}</span>)}</span>
          </div>
          <div className="bars">
            {bars.slice(0, 4).map((t) => <span key={t.id} className="bar" style={{ background: t.color }} title={titlesFor(t.id) || t.name} />)}
            {bars.length > 4 && <span className="bars__more">+{bars.length - 4}</span>}
          </div>
        </button>
      );
    }
    return <div className="grid">{cells}</div>;
  }

  const listGroups = useMemo(() => {
    const vis = events.filter(isVisible).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const g: Record<string, UIEvent[]> = {}; for (const e of vis) (g[e.start] = g[e.start] || []).push(e);
    return Object.entries(g);
  }, [events, visibleTypes, visibleStatus, filterStart, filterEnd]);

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="switcher">
          <button className="switcher__btn" onClick={() => setMenuOpen((v) => !v)}>
            <span className="brand__mark">☀︎</span>
            <span className="switcher__txt"><span className="switcher__name">{cal.name}</span><span className="switcher__url">/{cal.slug}</span></span>
            <span className="switcher__car">▾</span>
          </button>
          {menuOpen && (
            <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
              <div className="menu__label">Your calendars</div>
              {allCalendars.map((c) => (
                <button key={c.id} className={"menu__item" + (c.slug === cal.slug ? " is-on" : "")} onClick={() => router.push(`/c/${c.slug}`)}>
                  <span>{c.name}</span><span className="menu__url">/{c.slug}</span>
                </button>
              ))}
              <button className="menu__new" onClick={() => { setMenuOpen(false); setModal({ kind: "newcal" }); }}>+ New calendar</button>
            </div>
          )}
        </div>
        <div className="topbar__actions">
          <div className="seg">
            <button className={"seg__btn" + (mode === "month" ? " is-on" : "")} onClick={() => setMode("month")}>Month</button>
            <button className={"seg__btn" + (mode === "list" ? " is-on" : "")} onClick={() => setMode("list")}>List</button>
          </div>
          <button className="btn" onClick={() => setModal({ kind: "import" })}>Import</button>
          <button className="btn" onClick={() => setModal({ kind: "types" })}>Event types</button>
          <button className="btn" onClick={() => setModal({ kind: "share" })}>Share</button>
          <button className="btn" onClick={() => setModal({ kind: "bulk" })}>Bulk add</button>
          <button className="btn btn--primary" onClick={() => setModal({ kind: "event", event: null })}>+ Add event</button>
          <button className="btn btn--filter" onClick={() => setRailOpen(true)}>Filters</button>
        </div>
      </header>

      <div className="layout">
        <aside className={"rail no-print" + (railOpen ? " rail--open" : "")}>
          <div className="rail__scroll">
            <div className="rail__head"><span>Filters</span><button className="xbtn" onClick={() => setRailOpen(false)}>✕</button></div>
            <div className="sec-label">Quick views</div>
            <div className="presets">{PRESETS.map((p) => <button key={p.name} className="preset" onClick={() => applyPreset(p)}>{p.name}</button>)}</div>
            <div className="sec-label">Date range</div>
            <div className="range">
              <input type="date" min={cal.rangeStart} max={cal.rangeEnd} value={filterStart} onChange={(e) => setFilterStart(e.target.value)} />
              <span className="range__dash">→</span>
              <input type="date" min={cal.rangeStart} max={cal.rangeEnd} value={filterEnd} onChange={(e) => setFilterEnd(e.target.value)} />
            </div>
            <div className="sec-label sec-label--row"><span>Event types · by count</span><span><button className="link" onClick={() => setVisibleTypes(new Set(types.map((t) => t.id)))}>All</button><button className="link" onClick={() => setVisibleTypes(new Set())} style={{ marginLeft: 12 }}>None</button></span></div>
            <div className="types">
              {railTypes.map((t) => {
                const on = visibleTypes.has(t.id);
                return (
                  <div key={t.id} className={"trow" + (on ? "" : " trow--off")} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button onClick={() => toggleType(t.id)} title="Show / hide" style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: 0, cursor: "pointer", padding: 0, flex: "0 0 auto" }}>
                      <span className="trow__sw" style={{ background: t.color, borderRadius: t.highlight ? "50%" : "3px" }} />
                      <span className={"trow__check" + (on ? " is-on" : "")} />
                    </button>
                    <button onClick={() => setModal({ kind: "typedates", typeId: t.id })} title="Edit this type's dates" style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: 0, cursor: "pointer", padding: 0, flex: 1, textAlign: "left", color: "inherit", font: "inherit" }}>
                      <span className="trow__icon">{t.icon}</span>
                      <span className="trow__name" style={{ textDecoration: "underline", textDecorationColor: "rgba(0,0,0,.15)", textUnderlineOffset: 3 }}>{t.name}</span>
                    </button>
                    <span className="trow__count">{typeCounts[t.id] || 0}</span>
                  </div>
                );
              })}
            </div>
            <div className="sec-label">Status</div>
            <div className="status">{STATUSES.map((s) => <button key={s.id} className={"stog" + (visibleStatus.has(s.id) ? " is-on" : "")} onClick={() => toggleStatus(s.id)}>{s.label}</button>)}</div>
          </div>
        </aside>

        <main className="main">
          <div className="print-head">{cal.name} — {fmtDate(filterStart)} to {fmtDate(filterEnd)}</div>
          {mode === "month" && (
            <>
              <div className="jump no-print">
                {months.map((m) => <button key={m.key} className="jump__chip" onClick={() => scrollToMonth(m.key)}>{m.name.slice(0, 3)}{m.m === 1 ? " " + m.year : ""}</button>)}
                <span className="jump__count">{visibleCount} shown · scroll for more ↓</span>
              </div>
              <div className="months">
                {months.map((mo, idx) => (
                  <section className="monthblock" id={"m-" + mo.key} key={mo.key}>
                    <h1 className="monthname">{mo.name}{mo.m === 1 || idx === 0 ? <span className="monthname__yr"> {mo.year}</span> : null}</h1>
                    <div className="dow">{DOW.map((d, i) => <div key={i} className="dow__c">{d}</div>)}</div>
                    <DayCells mo={mo} />
                  </section>
                ))}
              </div>
            </>
          )}
          {mode === "list" && (
            <div className="list">
              <h1 className="monthname">Agenda</h1>
              {listGroups.length === 0 && <div className="empty">Nothing matches these filters.</div>}
              {listGroups.map(([day, evs]) => (
                <div className="lgroup" key={day}>
                  <div className="lgroup__date">{fmtDate(day)}</div>
                  <div className="lgroup__items">
                    {evs.map((e) => {
                      const t = typeById[e.typeId];
                      return (
                        <button className="litem" key={e.id} onClick={() => setModal({ kind: "event", event: e })}>
                          <span className="litem__sw" style={{ background: t.color }} />
                          <span className="litem__icon">{t.icon}</span>
                          <span className="litem__title">{e.title}{e.imported && <span className="lock">🔒</span>}</span>
                          {e.time && <span className="litem__time">{e.time}</span>}
                          {statusChip(e.status)}
                          {e.note && <span className="litem__note">{e.note}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      <button className="fab no-print" onClick={() => setModal({ kind: "event", event: null })} title="Add event">＋</button>

      {modal?.kind === "day" && (
        <Overlay onClose={() => setModal(null)} title={fmtDate(modal.day)}>
          {eventsForDay(modal.day).length === 0 && <div className="empty">No events with the current filters.</div>}
          {eventsForDay(modal.day).map((e) => {
            const t = typeById[e.typeId];
            return (
              <div className="dpitem" key={e.id}>
                <span className="dpitem__sw" style={{ background: t.color }} />
                <div className="dpitem__body">
                  <div className="dpitem__title">{t.icon} {e.title} {e.imported && <span className="lock">🔒</span>}</div>
                  <div className="dpitem__meta"><span className="chip">{t.name}</span>{e.time && <span className="muted">{e.time}</span>}{statusChip(e.status)}</div>
                  {e.note && <div className="dpitem__note">{e.note}</div>}
                  {!e.imported && <button className="link" onClick={() => setModal({ kind: "event", event: e })}>Edit</button>}
                </div>
              </div>
            );
          })}
          <button className="btn btn--primary wfull" onClick={() => setModal({ kind: "event", event: { start: modal.day } })}>+ Add event on {fmtDate(modal.day)}</button>
        </Overlay>
      )}

      {modal?.kind === "event" && (
        <EventEditor cal={cal} types={types} initial={modal.event}
          onClose={() => setModal(null)}
          onSave={(d: UIEvent) => { saveEvent(d); setModal(null); }}
          onDelete={(id: string) => { deleteEvent(id); setModal(null); }}
          onManageTypes={() => setModal({ kind: "types" })}
          onBulk={() => setModal({ kind: "bulk" })} />
      )}
      {modal?.kind === "bulk" && (
        <BulkAddModal cal={cal} types={types} onClose={() => setModal(null)} onSaveMany={(list: UIEvent[]) => { saveMany(list); setModal(null); }} />
      )}
      {modal?.kind === "typedates" && (
        <ManageTypeDatesModal cal={cal} type={typeById[modal.typeId]} events={events} onClose={() => setModal(null)} onApply={(del: string[], add: UIEvent[]) => { applyTypeDates(del, add); setModal(null); }} />
      )}
      {modal?.kind === "types" && (        <TypeManager types={types} events={events} onClose={() => setModal(null)} onSave={saveType} onDelete={deleteType} />
      )}
      {modal?.kind === "share" && (
        <ShareModal cal={cal} types={types} visibleTypes={visibleTypes} filterStart={filterStart} filterEnd={filterEnd} fmtDate={fmtDate} onCreateLink={createShareLink} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "import" && (
        <ImportModal types={types} onClose={() => setModal(null)} onSubscribe={subscribeFeed} />
      )}
      {modal?.kind === "newcal" && (
        <NewCalendarModal onClose={() => setModal(null)} onCreate={createCalendar} />
      )}
    </div>
  );
}

/* ---------- Event editor ---------- */
function EventEditor({ cal, types, initial, onClose, onSave, onDelete, onManageTypes, onBulk }: any) {
  const editing = initial && initial.id;
  const [f, setF] = useState<any>({
    id: initial?.id, title: initial?.title || "", typeId: initial?.typeId || types[0]?.id,
    start: initial?.start || cal.rangeStart, end: initial?.end && initial.end !== initial.start ? initial.end : "",
    time: initial?.time || "", status: initial?.status || "confirmed", note: initial?.note || "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  function save() {
    if (!f.title.trim()) return alert("Give the event a title.");
    if (!f.typeId) return alert("Pick an event type.");
    if (!f.start) return alert("Pick a start date.");
    let end = f.end || f.start; if (end < f.start) end = f.start;
    onSave({ id: f.id, typeId: f.typeId, title: f.title.trim(), start: f.start, end, time: f.time, status: f.status, note: f.note, imported: false });
  }
  return (
    <Overlay onClose={onClose} title={editing ? "Edit event" : "Add event"}>
      <label className="fld"><span>Title</span><input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Dinner at Margaritas" autoFocus /></label>
      {!editing && <button className="link bulklink" onClick={onBulk}>Adding lots of the same thing? Bulk add many dates →</button>}
      <label className="fld"><span>Event type</span>
        <select value={f.typeId} onChange={(e) => set("typeId", e.target.value)}>{types.map((t: EventType) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}</select>
        <button className="link" onClick={onManageTypes}>+ Manage / add types</button>
      </label>
      <div className="fld2">
        <label className="fld"><span>Start</span><input type="date" min={cal.rangeStart} max={cal.rangeEnd} value={f.start} onChange={(e) => set("start", e.target.value)} /></label>
        <label className="fld"><span>End <em>(optional)</em></span><input type="date" min={f.start} max={cal.rangeEnd} value={f.end} onChange={(e) => set("end", e.target.value)} /></label>
      </div>
      <div className="fld2">
        <label className="fld"><span>Time <em>(optional)</em></span><input value={f.time} onChange={(e) => set("time", e.target.value)} placeholder="20:30" /></label>
        <label className="fld"><span>Status</span><select value={f.status} onChange={(e) => set("status", e.target.value)}>{STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      </div>
      <label className="fld"><span>Notes <em>(optional)</em></span><input value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="Party of 6 · credit card" /></label>
      <div className="tedit__actions">
        {editing ? <button className="btn link--danger" onClick={() => onDelete(f.id)}>Delete</button> : <span />}
        <div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={save}>{editing ? "Save changes" : "Add event"}</button></div>
      </div>
    </Overlay>
  );
}

/* ---------- Bulk add (multi-day blocks) ---------- */
function BulkAddModal({ cal, types, onClose, onSaveMany }: any) {
  const months = monthsBetween(cal.rangeStart, cal.rangeEnd);
  const boat = types.find((t: EventType) => t.name.toLowerCase().includes("boat"));
  const [typeId, setTypeId] = useState(boat ? boat.id : types[0]?.id);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [blockLen, setBlockLen] = useState(1);
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [status, setStatus] = useState("confirmed");
  const [note, setNote] = useState("");
  const type = types.find((t: EventType) => t.id === typeId);
  const len = Math.max(1, Math.min(31, blockLen || 1));
  const toggle = (d: string) => setSel((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const selArr = [...sel].sort();
  const unit = len > 1 ? "block" : "date";

  const cover: Record<string, string> = {};
  for (const d of sel) for (let i = 0; i < len; i++) { const dd = addDays(d, i); if (dd > cal.rangeEnd) break; if (i === 0) cover[dd] = "start"; else if (cover[dd] !== "start") cover[dd] = "cont"; }

  function add() {
    if (!typeId) return alert("Pick an event type.");
    if (sel.size === 0) return alert("Tap the start dates you want to add.");
    onSaveMany(selArr.map((d) => ({ id: undefined, typeId, title: title.trim() || type.name, start: d, end: minStr(addDays(d, len - 1), cal.rangeEnd), time, status, note, imported: false })));
  }

  return (
    <Overlay onClose={onClose} title="Bulk add events" wide>
      <p className="modal__hint">Pick a type and a block length, then tap each start date — they don&apos;t have to be in a row. {len > 1 ? `Each tap adds a ${len}-day block.` : "Each tap adds one day."}</p>
      <div className="fld2">
        <label className="fld"><span>Event type</span><select value={typeId} onChange={(e) => setTypeId(e.target.value)}>{types.map((t: EventType) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}</select></label>
        <label className="fld"><span>Status <em>(all)</em></span><select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      </div>
      <div className="fld">
        <span>Block length</span>
        <div className="blocklen">
          {[1, 2, 3].map((n) => <button key={n} className={"blbtn" + (len === n ? " is-on" : "")} onClick={() => setBlockLen(n)}>{n} day{n > 1 ? "s" : ""}</button>)}
          <span className="blbtn--num"><input type="number" min="1" max="31" value={blockLen} onChange={(e) => setBlockLen(parseInt(e.target.value) || 1)} /> custom</span>
        </div>
      </div>
      <div className="fld2">
        <label className="fld"><span>Title <em>(optional)</em></span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type ? type.name : "Title"} /></label>
        <label className="fld"><span>Time <em>(optional)</em></span><input value={time} onChange={(e) => setTime(e.target.value)} placeholder="e.g. 10:00" /></label>
      </div>
      <div className="bulkbar"><span><strong style={{ color: type?.color }}>{sel.size}</strong> {unit}{sel.size === 1 ? "" : "s"} selected</span>{sel.size > 0 && <button className="link" onClick={() => setSel(new Set())}>Clear all</button>}</div>
      <div className="miniwrap">
        {months.map((mo) => {
          const firstDow = (new Date(Date.UTC(mo.year, mo.m - 1, 1)).getUTCDay() + 6) % 7;
          const dim = new Date(Date.UTC(mo.year, mo.m, 0)).getUTCDate();
          const cells: any[] = [];
          for (let i = 0; i < firstDow; i++) cells.push(<span className="mini-empty" key={"e" + i} />);
          for (let d = 1; d <= dim; d++) {
            const di = iso(mo.year, mo.m, d); const cv = cover[di];
            const style = cv === "start" ? { background: type?.color, borderColor: type?.color, color: "#1f3b2c" } : cv === "cont" ? { background: tint(type?.color || "#999", 0.28), borderColor: tint(type?.color || "#999", 0.5) } : undefined;
            cells.push(<button key={di} className={"minicell" + (cv ? " is-sel" : "")} style={style} onClick={() => toggle(di)}>{d}</button>);
          }
          return (<div className="minimonth" key={mo.key}><div className="minihead">{mo.name} {mo.year}</div><div className="minidow">{DOW.map((x, i) => <span key={i}>{x}</span>)}</div><div className="minigrid">{cells}</div></div>);
        })}
      </div>
      {selArr.length > 0 && <div className="selchips">{selArr.map((d) => <button key={d} className="selchip" onClick={() => toggle(d)}>{fmtShort(d)}{len > 1 ? `–${fmtShort(minStr(addDays(d, len - 1), cal.rangeEnd))}` : ""} ✕</button>)}</div>}
      <label className="fld bulknote"><span>Notes <em>(applied to all, optional)</em></span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="tedit__actions"><span /><div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={add}>Add {sel.size || ""} {unit}{sel.size === 1 ? "" : "s"}</button></div></div>
    </Overlay>
  );
}

/* ---------- Manage all dates for one type ---------- */
function ManageTypeDatesModal({ cal, type, events, onClose, onApply }: any) {
  const months = monthsBetween(cal.rangeStart, cal.rangeEnd);
  // events of this type that we can manage (skip imported/ICS ones)
  const mine = events.filter((e: UIEvent) => e.typeId === type.id && !e.imported);
  const evByStart = new Map<string, UIEvent>(mine.map((e: UIEvent) => [e.start, e]));
  const [sel, setSel] = useState<Set<string>>(() => new Set(mine.map((e: UIEvent) => e.start)));
  const selArr = [...sel].sort();

  // figure out which days are "continuation" days of an existing multi-day block
  const contDays = new Set<string>();
  for (const d of sel) {
    const ev = evByStart.get(d);
    if (ev && ev.end > ev.start) {
      let cur = addDays(ev.start, 1);
      while (cur <= ev.end) { contDays.add(cur); cur = addDays(cur, 1); }
    }
  }
  const toggle = (d: string) => {
    if (contDays.has(d)) return; // continuation day of a block — not directly togglable
    setSel((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  };

  // diff vs. what's saved
  const origStarts = new Set(mine.map((e: UIEvent) => e.start));
  const addedDates = selArr.filter((d) => !origStarts.has(d));
  const removed = mine.filter((e: UIEvent) => !sel.has(e.start));

  function apply() {
    const addList: UIEvent[] = addedDates.map((d) => ({ id: undefined as any, typeId: type.id, title: type.name, start: d, end: d, time: "", status: "confirmed", note: "", imported: false }));
    onApply(removed.map((e: UIEvent) => e.id), addList);
  }

  return (
    <Overlay onClose={onClose} title={`${type.icon ? type.icon + " " : ""}${type.name} — manage dates`} wide>
      <p className="modal__hint">Every saved date for this type is pre-selected. Tap to remove a date, or tap an empty day to add one. New dates are added as single days (use Bulk add for multi-day blocks). Imported feed dates aren&apos;t shown here.</p>

      <div className="bulkbar">
        <span><strong style={{ color: type.color }}>{sel.size}</strong> date{sel.size === 1 ? "" : "s"} · <span style={{ color: "#2c7a7b" }}>+{addedDates.length}</span> / <span style={{ color: "#c0392b" }}>−{removed.length}</span></span>
      </div>

      <div className="miniwrap">
        {months.map((mo) => {
          const firstDow = (new Date(Date.UTC(mo.year, mo.m - 1, 1)).getUTCDay() + 6) % 7;
          const dim = new Date(Date.UTC(mo.year, mo.m, 0)).getUTCDate();
          const cells: any[] = [];
          for (let i = 0; i < firstDow; i++) cells.push(<span className="mini-empty" key={"e" + i} />);
          for (let d = 1; d <= dim; d++) {
            const di = iso(mo.year, mo.m, d);
            const isStart = sel.has(di);
            const isCont = contDays.has(di);
            const style = isStart
              ? { background: type.color, borderColor: type.color, color: "#1f3b2c" }
              : isCont
                ? { background: tint(type.color, 0.28), borderColor: tint(type.color, 0.5) }
                : undefined;
            cells.push(<button key={di} className={"minicell" + (isStart || isCont ? " is-sel" : "")} style={style} onClick={() => toggle(di)}>{d}</button>);
          }
          return (
            <div className="minimonth" key={mo.key}>
              <div className="minihead">{mo.name} {mo.year}</div>
              <div className="minidow">{DOW.map((x, i) => <span key={i}>{x}</span>)}</div>
              <div className="minigrid">{cells}</div>
            </div>
          );
        })}
      </div>

      {selArr.length > 0 && (
        <div className="selchips">{selArr.map((d) => { const ev = evByStart.get(d); const lbl = ev && ev.end > ev.start ? `${fmtShort(d)}–${fmtShort(ev.end)}` : fmtShort(d); return <button key={d} className="selchip" onClick={() => toggle(d)}>{lbl} ✕</button>; })}</div>
      )}

      <div className="tedit__actions"><span /><div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={apply} disabled={addedDates.length === 0 && removed.length === 0}>Save changes</button></div></div>
    </Overlay>
  );
}

/* ---------- Manage event types ---------- */
function TypeManager({ types, events, onClose, onSave, onDelete }: any) {
  const [draft, setDraft] = useState<any>(null);
  function save() { if (!draft.name.trim()) return; if (draft.id) onSave(draft, false); else onSave({ ...draft }, true); setDraft(null); }
  function del(t: EventType) { const n = events.filter((e: UIEvent) => e.typeId === t.id).length; if (window.confirm(`Delete "${t.name}"?` + (n ? ` Its ${n} event(s) will be removed too.` : ""))) onDelete(t.id); }
  return (
    <Overlay onClose={onClose} title="Event types" wide>
      {!draft && (
        <>
          <p className="modal__hint">Each type carries its own colour + icon. Highlight types fill the date circle; the rest show as a coloured bar under the day.</p>
          <div className="tmlist">
            {types.map((t: EventType) => (
              <div className="tmrow" key={t.id}>
                <span className="tmrow__sw" style={{ background: t.color, borderRadius: t.highlight ? "50%" : "4px" }} />
                <span className="tmrow__icon">{t.icon || "·"}</span>
                <span className="tmrow__name">{t.name}{t.highlight && <em> · highlight</em>}</span>
                <button className="link" onClick={() => setDraft({ ...t })}>Edit</button>
                <button className="link link--danger" onClick={() => del(t)}>Delete</button>
              </div>
            ))}
          </div>
          <button className="btn btn--primary" onClick={() => setDraft({ name: "", color: SWATCHES[0], icon: "", highlight: false })}>+ New event type</button>
        </>
      )}
      {draft && (
        <div className="tedit">
          <label className="fld"><span>Name</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Tennis, Markets, Doctor…" autoFocus /></label>
          <div className="fld"><span>Colour</span><div className="swatches">{SWATCHES.map((c) => <button key={c} className={"sw" + (draft.color === c ? " is-on" : "")} style={{ background: c }} onClick={() => setDraft({ ...draft, color: c })} />)}<input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} /></div></div>
          <div className="fld"><span>Icon</span><div className="emojis"><button className={"emoji" + (draft.icon === "" ? " is-on" : "")} onClick={() => setDraft({ ...draft, icon: "" })}>none</button>{EMOJI.map((em) => <button key={em} className={"emoji" + (draft.icon === em ? " is-on" : "")} onClick={() => setDraft({ ...draft, icon: em })}>{em}</button>)}</div></div>
          <label className="fld fld--row"><input type="checkbox" checked={draft.highlight} onChange={(e) => setDraft({ ...draft, highlight: e.target.checked })} /><span>Fill the date circle (highlight style)</span></label>
          <div className="tedit__actions"><span /><div className="row-gap"><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn btn--primary" onClick={save}>Save type</button></div></div>
        </div>
      )}
    </Overlay>
  );
}

/* ---------- Share ---------- */
function ShareModal({ cal, types, visibleTypes, filterStart, filterEnd, fmtDate, onCreateLink, onClose }: any) {
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const chosen = types.filter((t: EventType) => visibleTypes.has(t.id));
  const allOn = chosen.length === types.length;
  async function copyLink() {
    const url = await onCreateLink();
    if (!url) return;
    setLink(url);
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2200); } catch {}
  }
  return (
    <Overlay onClose={onClose} title="Share this view">
      <div className="share__summary">
        <div className="share__row"><span className="muted">Calendar</span><strong>{cal.name} <span className="muted">/{cal.slug}</span></strong></div>
        <div className="share__row"><span className="muted">Dates</span><strong>{fmtDate(filterStart)} → {fmtDate(filterEnd)}</strong></div>
        <div className="share__row"><span className="muted">Showing</span><strong>{allOn ? "All event types" : chosen.length + " types"}</strong></div>
      </div>
      <p className="modal__hint">Save a PDF snapshot, or create a live link that always shows current plans for this date range and these types.</p>
      <div className="share__btns">
        <button className="btn btn--primary" onClick={() => window.print()}>Save as PDF</button>
        <button className="btn" onClick={copyLink}>{copied ? "Link copied ✓" : "Create live link"}</button>
      </div>
      {link && <div className="share__note" style={{ wordBreak: "break-all" }}>{link}</div>}
      <div className="share__note">Snapshot = frozen · Live link = always current. (Image/PNG export: add html-to-image — see build plan.)</div>
    </Overlay>
  );
}

/* ---------- Import ---------- */
function ImportModal({ types, onClose, onSubscribe }: any) {
  const [url, setUrl] = useState("");
  const [typeId, setTypeId] = useState(types[0]?.id);
  return (
    <Overlay onClose={onClose} title="Import a calendar">
      <p className="modal__hint">Subscribe by iCal/ICS link (Google Calendar → Settings → &quot;Secret address in iCal format&quot;) and map it to an event type. Real feeds refresh via the hourly sync job; this demo inserts a couple of sample bookings.</p>
      <label className="fld"><span>iCal / ICS URL</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" /></label>
      <label className="fld"><span>Show these as</span><select value={typeId} onChange={(e) => setTypeId(e.target.value)}>{types.map((t: EventType) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}</select></label>
      <button className="btn btn--primary" onClick={() => { if (!url.trim()) return alert("Paste the iCal/ICS link."); onSubscribe(url, typeId); onClose(); }}>Subscribe</button>
    </Overlay>
  );
}

/* ---------- New calendar ---------- */
function NewCalendarModal({ onClose, onCreate }: any) {
  const [name, setName] = useState("");
  const [start, setStart] = useState("2026-06-01");
  const [end, setEnd] = useState("2026-12-31");
  const slug = slugify(name || "new-calendar");
  return (
    <Overlay onClose={onClose} title="New calendar">
      <p className="modal__hint">Each calendar gets its own link, date range and event types (Activity, Restaurant, Hotel/Stay, Travel to start).</p>
      <label className="fld"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. School Year 2026–27" autoFocus /></label>
      <div className="urlprev">Link: <strong>/{slug}</strong></div>
      <div className="fld2">
        <label className="fld"><span>Range start</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="fld"><span>Range end</span><input type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <div className="tedit__actions"><span /><div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={() => name.trim() ? onCreate(name.trim(), start, end < start ? start : end) : alert("Name your calendar.")}>Create calendar</button></div></div>
    </Overlay>
  );
}

/* ---------- Overlay ---------- */
function Overlay({ children, onClose, title, wide }: any) {
  return (
    <div className="overlay no-print" onClick={onClose}>
      <div className={"modal" + (wide ? " modal--wide" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head"><h2>{title}</h2><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
