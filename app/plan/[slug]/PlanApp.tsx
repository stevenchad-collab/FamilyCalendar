"use client";
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { BASE, SCHOOL_OFF, type Loc } from "@/lib/plan2027";

export type PlanRow = { day: string; loc: Loc | null; note: string | null; fam: boolean | null; mi: boolean | null; cats?: string[] | null };
export type Category = { id: string; name: string; icon: string; color: string; sort: number };
type Override = { loc?: Loc; n?: string; fam?: boolean; mi?: boolean; cats?: string[] };
type Overrides = Record<string, Override>;
type Role = "owner" | "editor" | "viewer";
type View = "loc" | "mi" | "ma" | "fl" | "act" | "rng";

type Props = {
  calendar: { id: string; name: string; slug: string; ownerId: string };
  role: Role;
  initialRows: PlanRow[];
  initialCategories: Category[];
  allCalendars: { id: string; name: string; slug: string; kind: string }[];
  userEmail: string;
  userId: string;
};

const LOC: Record<Loc, { name: string; c: string }> = {
  US: { name: "USA (Miami)", c: "var(--p-us)" },
  ES: { name: "Spain", c: "var(--p-es)" },
  EU: { name: "Europe (not Spain)", c: "var(--p-eu)" },
};
const MN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const VIEWS: { id: View; name: string }[] = [
  { id: "loc", name: "Where I am" }, { id: "mi", name: "With Milsy" }, { id: "ma", name: "With Mason" },
  { id: "fl", name: "Transatlantic flights" }, { id: "act", name: "Activities" }, { id: "rng", name: "Date ranges" },
];

function rowsToOverrides(rows: PlanRow[]): Overrides {
  const o: Overrides = {};
  for (const r of rows) {
    const v: Override = {};
    if (r.loc) v.loc = r.loc;
    if (r.note !== null && r.note !== undefined) v.n = r.note;
    if (r.fam !== null && r.fam !== undefined) v.fam = r.fam;
    if (r.mi !== null && r.mi !== undefined) v.mi = r.mi;
    if (r.cats && r.cats.length) v.cats = r.cats;
    o[r.day] = v;
  }
  return o;
}
// "edited" = changed vs Claude's plan (location/note/flags); categories are tracked separately
const planEdited = (o?: Override) => !!o && (o.loc !== undefined || o.n !== undefined || o.fam !== undefined || o.mi !== undefined);
const isEmptyOv = (o: Override) => !planEdited(o) && !(o.cats && o.cats.length);

type Day = { d: string; loc: Loc; n: string; edited: boolean; us: number; es: number; eu: number; eur: number; off: string; fam: number; mi: number; fl: "" | "E" | "W"; prev: Loc | null; cats: string[] };

function compute(overrides: Overrides): Day[] {
  let prev: Loc = "EU"; // Dec 31 2026: drive to the Pyrenees
  const out: Day[] = [];
  BASE.forEach((b, i) => {
    const o = overrides[b.d] || {};
    const loc: Loc = o.loc || b.loc;
    const n = o.n !== undefined ? o.n : b.n;
    const counts = new Set<Loc>([loc]);
    let fl: "" | "E" | "W" = "";
    if (loc !== prev) {
      if (prev === "US") { if (i > 0) out[i - 1].fl = "E"; }
      else { counts.add(prev); if (loc === "US") fl = "W"; }
    }
    if (i === 0) { counts.clear(); counts.add(loc); }
    const us = counts.has("US") ? 1 : 0, es = counts.has("ES") ? 1 : 0, eu = counts.has("EU") ? 1 : 0;
    const eur = es || eu ? 1 : 0;
    const off = SCHOOL_OFF[b.d] || "";
    const famD = es === 1 || (eur === 1 && !!off) || /Philadelphia/i.test(n);
    const fam = o.fam !== undefined ? o.fam : famD;
    const mi = o.mi !== undefined ? o.mi : fam;
    out.push({ d: b.d, loc, n, edited: planEdited(overrides[b.d]), cats: o.cats || [], us, es, eu, eur, off, fam: fam ? 1 : 0, mi: mi ? 1 : 0, fl, prev: i === 0 ? null : prev });
    prev = loc;
  });
  return out;
}

function fmt(d: string, long = false) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-GB", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" });
}

export default function PlanApp({ calendar, role, initialRows, initialCategories, allCalendars, userEmail, userId }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const canWrite = role === "owner" || role === "editor";
  const isOwner = role === "owner";

  const [overrides, setOverrides] = useState<Overrides>(() => rowsToOverrides(initialRows));
  const [view, setView] = useState<View>("loc");
  const [sel, setSel] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [members, setMembers] = useState(false);
  const [status, setStatus] = useState<{ text: string; kind: "ok" | "busy" | "err" }>({ text: "", kind: "ok" });
  const [armReset, setArmReset] = useState(false);
  const [cats, setCats] = useState<Category[]>(initialCategories);
  const [catsOpen, setCatsOpen] = useState(false);
  const [multi, setMulti] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // ---- persistence: coalesce edits, write only changed days ----
  const pending = useRef<Map<string, Override | null>>(new Map());
  const timer = useRef<any>(null);
  const saving = useRef(false);

  const flush = useCallback(async () => {
    if (saving.current) { timer.current = setTimeout(flush, 500); return; }
    if (pending.current.size === 0) return;
    const batch = new Map(pending.current); pending.current = new Map();
    saving.current = true; setStatus({ text: "Saving…", kind: "busy" });
    const upserts: any[] = [], deletes: string[] = [];
    batch.forEach((v, day) => {
      if (v === null) deletes.push(day);
      else upserts.push({ calendar_id: calendar.id, day, loc: v.loc ?? null, note: v.n ?? null, fam: v.fam ?? null, mi: v.mi ?? null, cats: v.cats && v.cats.length ? v.cats : null, updated_at: new Date().toISOString(), updated_by: userId });
    });
    let err: string | null = null;
    if (upserts.length) { const { error } = await supabase.from("plan_days").upsert(upserts, { onConflict: "calendar_id,day" }); if (error) err = error.message; }
    if (!err && deletes.length) { const { error } = await supabase.from("plan_days").delete().eq("calendar_id", calendar.id).in("day", deletes); if (error) err = error.message; }
    saving.current = false;
    if (err) {
      batch.forEach((v, k) => { if (!pending.current.has(k)) pending.current.set(k, v); });
      setStatus({ text: `Save failed (${err}); retrying…`, kind: "err" });
      timer.current = setTimeout(flush, 4000);
    } else if (pending.current.size) { timer.current = setTimeout(flush, 300); }
    else setStatus({ text: "Saved", kind: "ok" });
  }, [calendar.id, supabase, userId]);

  const schedule = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(flush, 900); setStatus({ text: "Unsaved changes…", kind: "busy" }); }, [flush]);

  const edit = useCallback((days: string[], patch: Override | null) => {
    if (!canWrite) return;
    setOverrides((prev) => {
      const next = { ...prev };
      for (const d of days) {
        // reset (patch === null) clears plan edits but keeps the day's categories
        const keep = prev[d]?.cats;
        const merged: Override = patch === null ? (keep && keep.length ? { cats: keep } : {}) : { ...(prev[d] || {}), ...patch };
        if (isEmptyOv(merged)) { delete next[d]; pending.current.set(d, null); }
        else { next[d] = merged; pending.current.set(d, merged); }
      }
      return next;
    });
    schedule();
  }, [canWrite, schedule]);

  // ---- live updates from other editors ----
  useEffect(() => {
    const ch = supabase.channel(`plan_days:${calendar.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_days", filter: `calendar_id=eq.${calendar.id}` }, (payload: any) => {
        const row = (payload.new?.day ? payload.new : payload.old) as PlanRow | undefined;
        if (!row?.day || pending.current.has(row.day)) return;
        setOverrides((prev) => {
          const next = { ...prev };
          if (payload.eventType === "DELETE") delete next[row.day];
          else next[row.day] = rowsToOverrides([payload.new])[row.day];
          return next;
        });
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, calendar.id]);

  useEffect(() => {
    const ch = supabase.channel(`plan_categories:${calendar.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_categories", filter: `calendar_id=eq.${calendar.id}` }, async () => {
        const { data } = await supabase.from("plan_categories").select("id,name,icon,color,sort").eq("calendar_id", calendar.id).order("sort").order("created_at");
        if (data) setCats(data as Category[]);
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, calendar.id]);

  useEffect(() => {
    const h = () => { if (pending.current.size) flush(); };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [flush]);

  // ---- derived ----
  const C = useMemo(() => compute(overrides), [overrides]);
  const t = useMemo(() => {
    const t = { us: 0, es: 0, eu: 0, eur: 0, fam: 0, mi: 0, E: 0, W: 0 };
    for (const x of C) { t.us += x.us; t.es += x.es; t.eu += x.eu; t.eur += x.eur; t.fam += x.fam; t.mi += x.mi; if (x.fl === "E") t.E++; if (x.fl === "W") t.W++; }
    return t;
  }, [C]);
  const margin = t.us - t.es;
  const aug = C.filter((x) => x.d.startsWith("2027-08")).every((x) => x.loc === "ES");
  const nEdited = Object.values(overrides).filter(planEdited).length;
  const catMap = useMemo(() => Object.fromEntries(cats.map((c) => [c.id, c])) as Record<string, Category>, [cats]);
  const catCount = useMemo(() => { const m: Record<string, number> = {}; for (const x of C) for (const id of x.cats) m[id] = (m[id] || 0) + 1; return m; }, [C]);
  const dayCats = (x: Day) => x.cats.map((id) => catMap[id]).filter(Boolean) as Category[];
  const setCatOn = (days: string[], id: string, on: boolean) => {
    for (const d of days) {
      const cur = overrides[d]?.cats || [];
      if (on === cur.includes(id)) continue;
      edit([d], { cats: on ? [...cur, id] : cur.filter((c) => c !== id) });
    }
  };
  const togglePick = (d: string) => setPicked((p) => { const n = new Set(p); if (n.has(d)) n.delete(d); else n.add(d); return n; });
  const fillRange = () => {
    const ds = Array.from(picked).sort(); if (ds.length < 2) return;
    const a = ds[0], b = ds[ds.length - 1];
    setPicked(new Set(BASE.map((x) => x.d).filter((d) => d >= a && d <= b)));
  };
  const selDay = sel ? C.find((x) => x.d === sel) : null;
  const selBase = sel ? BASE.find((x) => x.d === sel) : null;

  async function signOut() { await supabase.auth.signOut(); window.location.href = "/login"; }

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
          {canWrite && <button className="btn" onClick={() => setCatsOpen(true)}>🏷️ Categories</button>}
          <span className={"plan__status plan__status--" + status.kind}>
            {!canWrite ? "View only" : status.text || (nEdited ? `${nEdited} day${nEdited > 1 ? "s" : ""} edited` : "Claude's plan, no edits")}
          </span>
          {canWrite && nEdited > 0 && (
            <button className="btn" onClick={() => { if (!armReset) { setArmReset(true); setTimeout(() => setArmReset(false), 4000); return; } edit(Object.keys(overrides).filter((d) => planEdited(overrides[d])), null); setArmReset(false); }}>
              {armReset ? "Click again to reset all" : "Reset all edits"}
            </button>
          )}
        </div>
      </header>

      <main className="plan__main">
        <div className="plan__totals">
          <span><b>{t.us}</b>USA</span><span><b>{t.es}</b>Spain</span>
          <span className={"plan__chk plan__chk--" + (margin >= 37 ? "ok" : margin > 0 ? "warn" : "bad")}>USA − Spain = {margin}{margin < 37 ? " (target ≥40)" : ""}</span>
          <span><b>{t.eu}</b>Europe (not Spain)</span><span><b>{t.eur}</b>any Europe</span>
          <span><b>{t.fam}</b>with Milsy &amp; Mason</span><span><b>{t.mi}</b>with Milsy</span><span><b>{t.E + t.W}</b>flights</span>
          <span className={"plan__chk plan__chk--" + (t.es < 183 ? "ok" : "bad")}>Spain &lt; 183</span>
          <span className={"plan__chk plan__chk--" + (aug ? "ok" : "bad")}>August in Spain</span>
        </div>

        <div className="plan__tabs" role="tablist">
          {VIEWS.map((v) => <button key={v.id} role="tab" aria-selected={view === v.id} className={"preset" + (view === v.id ? " is-on" : "")} onClick={() => setView(v.id)}>{v.name}</button>)}
          {canWrite && <button className={"preset" + (multi ? " is-on" : "")} style={{ marginLeft: "auto" }} onClick={() => { setMulti((v) => !v); setPicked(new Set()); setSel(null); }}>{multi ? "✓ Done selecting" : "☐ Select days"}</button>}
        </div>

        <div className="plan__legend">
          {view === "loc" && <>
            <span><i className="sw" style={{ background: "var(--p-us)" }} />USA ({t.us})</span>
            <span><i className="sw" style={{ background: "var(--p-es)" }} />Spain ({t.es})</span>
            <span><i className="sw" style={{ background: "var(--p-eu)" }} />Europe outside Spain ({t.eu})</span>
            <span><i className="sw" style={{ background: "linear-gradient(135deg,var(--p-es) 50%,var(--p-us) 50%)" }} />Travel day, counts in both</span>
            <span>★ school holiday (ASB)</span></>}
          {view === "mi" && <><span><i className="sw" style={{ background: "var(--p-mi)" }} />Together</span><span><i className="sw" />Apart</span></>}
          {view === "ma" && <><span><i className="sw" style={{ background: "var(--p-ma)" }} />Together</span><span><i className="sw" />Apart</span></>}
          {view === "fl" && <><span><i className="sw" style={{ background: "var(--p-fe)" }} />Depart Miami ({t.E}, overnight)</span><span><i className="sw" style={{ background: "var(--p-fw)" }} />Depart Europe ({t.W}, land same day)</span></>}
          {view === "act" && (cats.length
            ? cats.map((c) => <span key={c.id}><i className="sw" style={{ background: c.color }} />{c.icon} {c.name} ({catCount[c.id] || 0})</span>)
            : <span>No categories yet{canWrite ? ". Add one with 🏷️ Categories, then tap a day (or use Select days) to mark it." : "."}</span>)}
          {view === "rng" && <span>One row per stretch of consecutive days with the same location, note and family flags. Edit a note and press Enter (or click away) to apply it to every day in that row. “Merge up” makes a row identical to the one above it.</span>}
        </div>

        {view === "rng" ? <Ranges C={C} canWrite={canWrite} edit={edit} catMap={catMap} /> : (
          <div className="plan__months">
            {MN.map((name, mo) => {
              const md = C.filter((x) => +x.d.slice(5, 7) === mo + 1);
              const lead = (new Date(2027, mo, 1).getDay() + 6) % 7;
              const cnt = view === "act" ? md.filter((x) => x.cats.length).length : view === "fl" ? md.filter((x) => x.fl).length : view === "loc" ? md.filter((x) => x.off).length : md.reduce((a, x) => a + (view === "mi" ? x.mi : x.fam), 0);
              return (
                <div className="plan__month" key={name}>
                  <h3>{name}<span>{view === "loc" ? `${cnt} holiday` : `${cnt} / ${md.length}`}</span></h3>
                  <div className="plan__grid">
                    {["M","T","W","T","F","S","S"].map((x, i) => <div className="plan__dow" key={i}>{x}</div>)}
                    {Array.from({ length: lead }).map((_, i) => <div key={"e" + i} />)}
                    {md.map((x) => {
                      const dc = dayCats(x);
                      let on = false, col = "", two = "", split = false, star = false;
                      if (view === "fl") { on = !!x.fl; col = x.fl === "E" ? "var(--p-fe)" : "var(--p-fw)"; }
                      else if (view === "act") { on = dc.length > 0; col = dc[0]?.color || ""; }
                      else if (view === "loc") { on = true; col = LOC[x.loc].c; if (x.prev && x.prev !== x.loc && x.prev !== "US") two = LOC[x.prev].c; star = !!x.off; }
                      else { on = (view === "mi" ? x.mi : x.fam) === 1; col = view === "mi" ? "var(--p-mi)" : "var(--p-ma)"; }
                      const cls = "plan__day" + (on ? (two ? " two" : split ? " split" : " on") : "") + (x.edited ? " edited" : "") + (sel === x.d || picked.has(x.d) ? " sel" : "");
                      const flTxt = x.fl === "E" ? " · Fly Miami → Europe (overnight)" : x.fl === "W" ? " · Fly Europe → Miami" : "";
                      const tip = `${x.d} · ${LOC[x.loc].name}${flTxt}${x.off ? " · " + x.off : ""}${x.n ? " · " + x.n : ""}${dc.length ? " · " + dc.map((c) => c.icon + " " + c.name).join(", ") : ""}`;
                      return (
                        <button key={x.d} className={cls} style={{ ["--c" as any]: two || col, ["--c2" as any]: col }} title={tip} onClick={() => (multi ? togglePick(x.d) : setSel(sel === x.d ? null : x.d))}>
                          {star && <span className="star">★</span>}{+x.d.slice(8)}{dc.length > 0 && <span className="cats">{dc.slice(0, 2).map((c) => c.icon).join("")}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="plan__note">A day counts in a country if you are physically there at any point, so a daytime Europe to Miami flight day counts on both sides (half-filled). An overnight Miami to Europe flight counts the departure day in the USA and the arrival day in Europe only. With Milsy &amp; Mason = Spain days, school-holiday days in Europe, and the Philadelphia Thanksgiving days; With Milsy defaults to the same days — tick “Milsy with me” on a day to add her. Fall 2027 school holidays are assumed from the 2026-27 ASB pattern. Dots mark edited days.</p>
      </main>

      {!multi && selDay && selBase && (
        <div className="plan__sheet">
          <div className="row"><span className="title">{fmt(selDay.d, true)}</span><span className="meta">{selDay.off || "School day"}{selDay.fl ? (selDay.fl === "E" ? " · fly Miami → Europe tonight" : " · fly Europe → Miami") : ""}</span><button className="btn x" onClick={() => setSel(null)}>Close</button></div>
          <div className="row">{(Object.keys(LOC) as Loc[]).map((k) => <button key={k} className="locbtn" style={{ ["--c" as any]: LOC[k].c }} aria-pressed={selDay.loc === k} disabled={!canWrite} onClick={() => edit([selDay.d], { loc: k })}>{LOC[k].name}</button>)}</div>
          <div className="row">
            <label><input type="checkbox" checked={!!selDay.fam} disabled={!canWrite} onChange={(e) => edit([selDay.d], { fam: e.target.checked })} /> Milsy &amp; Mason with me</label>
            <label><input type="checkbox" checked={!!selDay.mi} disabled={!canWrite} onChange={(e) => edit([selDay.d], { mi: e.target.checked })} /> Milsy with me</label>
          </div>
          {(cats.length > 0 || canWrite) && (
            <div className="row">
              {cats.map((c) => { const on = selDay.cats.includes(c.id); return <button key={c.id} className="locbtn" style={{ ["--c" as any]: c.color }} aria-pressed={on} disabled={!canWrite} onClick={() => setCatOn([selDay.d], c.id, !on)}>{c.icon} {c.name}</button>; })}
              {canWrite && <button className="btn" onClick={() => setCatsOpen(true)}>{cats.length ? "Edit categories" : "＋ Add a category (e.g. Forum)"}</button>}
            </div>
          )}
          <div className="row">
            <NoteInput key={selDay.d} value={selDay.n} disabled={!canWrite} onCommit={(v) => edit([selDay.d], { n: v })} />
            {selDay.edited && canWrite && <button className="btn" onClick={() => edit([selDay.d], null)}>Reset day</button>}
            <span className="meta">Claude&apos;s plan: {LOC[selBase.loc].name}{selBase.n ? " · " + selBase.n : ""}</span>
          </div>
        </div>
      )}

      {multi && (
        <div className="plan__sheet">
          <div className="row">
            <span className="title">{picked.size} day{picked.size === 1 ? "" : "s"} selected</span>
            <span className="meta">Tap days to select{picked.size > 1 ? "; Fill range selects every day between the first and last" : ""}</span>
            {picked.size > 1 && <button className="btn" onClick={fillRange}>Fill range</button>}
            {picked.size > 0 && <button className="btn" onClick={() => setPicked(new Set())}>Clear</button>}
            <button className="btn x" onClick={() => { setMulti(false); setPicked(new Set()); }}>Done</button>
          </div>
          <div className="row">
            {cats.map((c) => {
              const days = Array.from(picked);
              const all = days.length > 0 && days.every((d) => (overrides[d]?.cats || []).includes(c.id));
              return <button key={c.id} className="locbtn" style={{ ["--c" as any]: c.color }} aria-pressed={all} disabled={!days.length} title={all ? "Remove from selected days" : "Add to selected days"} onClick={() => setCatOn(days, c.id, !all)}>{all ? "✓ " : "+ "}{c.icon} {c.name}</button>;
            })}
            <button className="btn" onClick={() => setCatsOpen(true)}>{cats.length ? "Edit categories" : "＋ Add a category (e.g. Forum)"}</button>
          </div>
        </div>
      )}

      {catsOpen && <CategoriesModal calendarId={calendar.id} supabase={supabase} cats={cats} setCats={setCats} onDelete={(id) => setCatOn(Object.keys(overrides), id, false)} onClose={() => setCatsOpen(false)} />}
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

function Ranges({ C, canWrite, edit, catMap }: { C: Day[]; canWrite: boolean; edit: (days: string[], patch: Override | null) => void; catMap: Record<string, Category> }) {
  const rows = useMemo(() => {
    const rows: { start: string; end: string; loc: Loc; n: string; fam: number; mi: number; ck: string; days: Day[] }[] = [];
    for (const x of C) {
      const last = rows[rows.length - 1];
      if (last && last.loc === x.loc && last.n === x.n && last.fam === x.fam && last.mi === x.mi && last.ck === x.cats.join(",")) { last.end = x.d; last.days.push(x); }
      else rows.push({ start: x.d, end: x.d, loc: x.loc, n: x.n, fam: x.fam, mi: x.mi, ck: x.cats.join(","), days: [x] });
    }
    return rows;
  }, [C]);
  const yn = (b: number) => (b ? <span className="yes">Yes</span> : <span className="no">—</span>);
  return (
    <div className="plan__tablewrap">
      <table className="plan__ranges">
        <thead><tr><th>From</th><th>To</th><th>Days</th><th>Location</th><th>Milsy &amp; Mason</th><th>Milsy</th><th>School holiday</th><th>Flights</th><th>Activities</th><th>Note</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const hol = r.days.filter((x) => x.off).length;
            const fl = r.days.filter((x) => x.fl).map((x) => (x.fl === "E" ? "→EU" : "→MIA")).join(" ");
            const edited = r.days.some((x) => x.edited);
            return (
              <tr key={r.start}>
                <td className="n">{fmt(r.start)}</td><td className="n">{r.start === r.end ? "" : fmt(r.end)}</td><td className="n">{r.days.length}</td>
                <td><span className="pill" style={{ background: LOC[r.loc].c }}>{LOC[r.loc].name}</span>{edited ? " •" : ""}</td>
                <td>{yn(r.fam)}</td><td>{yn(r.mi)}</td><td>{hol ? `★ ${hol === r.days.length ? "all" : hol}` : "—"}</td><td className="n">{fl}</td>
                <td>{r.days[0].cats.map((id) => catMap[id]).filter(Boolean).map((c) => <span key={c.id} className="pill" style={{ background: c.color, marginRight: 4 }}>{c.icon} {c.name}</span>)}</td>
                <td><NoteInput key={r.start + r.n} value={r.n} disabled={!canWrite} placeholder="Add a note for these days" onCommit={(v) => edit(r.days.map((x) => x.d), { n: v })} /></td>
                <td>{i > 0 && canWrite && <button className="btn mrg" title="Give these days the same location, flags and note as the row above" onClick={() => { const a = rows[i - 1]; edit(r.days.map((x) => x.d), { loc: a.loc, n: a.n, fam: !!a.fam, mi: !!a.mi, cats: a.days[0].cats }); }}>Merge up</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
          <p className="modal__hint">Editors can change days, notes and flags. Viewers see the live plan. People are added the first time they sign in with that exact email.</p>
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

function CategoriesModal({ calendarId, supabase, cats, setCats, onDelete, onClose }: {
  calendarId: string; supabase: any; cats: Category[];
  setCats: React.Dispatch<React.SetStateAction<Category[]>>; onDelete: (id: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏛️");
  const [color, setColor] = useState(PALETTE[cats.length % PALETTE.length]);
  const [busy, setBusy] = useState(false);
  const [armDel, setArmDel] = useState<string | null>(null);
  async function add() {
    const n = name.trim(); if (!n) return;
    setBusy(true);
    const { data, error } = await supabase.from("plan_categories")
      .insert({ calendar_id: calendarId, name: n, icon: icon.trim() || "•", color, sort: cats.length })
      .select("id,name,icon,color,sort").single();
    setBusy(false);
    if (error || !data) { alert(error?.message || "Could not add category"); return; }
    setCats((p) => (p.some((c) => c.id === data.id) ? p : [...p, data as Category]));
    setName(""); setColor(PALETTE[(cats.length + 1) % PALETTE.length]);
  }
  async function update(c: Category, patch: Partial<Category>) {
    setCats((p) => p.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
    const { error } = await supabase.from("plan_categories").update(patch).eq("id", c.id);
    if (error) alert(error.message);
  }
  async function del(c: Category) {
    if (armDel !== c.id) { setArmDel(c.id); setTimeout(() => setArmDel(null), 4000); return; }
    onDelete(c.id);
    setCats((p) => p.filter((x) => x.id !== c.id));
    const { error } = await supabase.from("plan_categories").delete().eq("id", c.id);
    if (error) alert(error.message);
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head"><h2>Categories</h2><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="modal__body">
          <p className="modal__hint">Categories mark activities on days, like 🏛️ Forum. Each shows as an icon on its days and in the Activities view. They don&apos;t change where you are or any of the day counts.</p>
          <div className="fld2" style={{ alignItems: "flex-end" }}>
            <label className="fld catico"><span>Icon</span><input type="text" value={icon} maxLength={8} onChange={(e) => setIcon(e.target.value)} /></label>
            <label className="fld"><span>Name</span><input type="text" value={name} placeholder="Forum" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} /></label>
            <label className="fld catcol"><span>Colour</span><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
            <button className="btn btn--primary" onClick={add} disabled={busy || !name.trim()}>Add</button>
          </div>
          <div className="sec-label">Your categories</div>
          {cats.length === 0 && <div className="empty">None yet.</div>}
          <div className="tmlist">
            {cats.map((c) => (
              <div className="tmrow catrow" key={c.id}>
                <span className="catico"><NoteInput value={c.icon} disabled={false} placeholder="Icon" onCommit={(v) => update(c, { icon: v.trim() || "•" })} /></span>
                <span className="tmrow__name"><NoteInput value={c.name} disabled={false} placeholder="Name" onCommit={(v) => { if (v.trim()) update(c, { name: v.trim() }); }} /></span>
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
