"use client";
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { BASE, SCHOOL_OFF, type Loc } from "@/lib/plan2027";

export type PlanRow = { day: string; loc: Loc | null; note: string | null; fam: boolean | null; mi: boolean | null };
type Override = { loc?: Loc; n?: string; fam?: boolean; mi?: boolean };
type Overrides = Record<string, Override>;
type Role = "owner" | "editor" | "viewer";
type View = "loc" | "mi" | "ma" | "fl" | "rng";

type Props = {
  calendar: { id: string; name: string; slug: string; ownerId: string };
  role: Role;
  initialRows: PlanRow[];
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
  { id: "fl", name: "Transatlantic flights" }, { id: "rng", name: "Date ranges" },
];

function rowsToOverrides(rows: PlanRow[]): Overrides {
  const o: Overrides = {};
  for (const r of rows) {
    const v: Override = {};
    if (r.loc) v.loc = r.loc;
    if (r.note !== null && r.note !== undefined) v.n = r.note;
    if (r.fam !== null && r.fam !== undefined) v.fam = r.fam;
    if (r.mi !== null && r.mi !== undefined) v.mi = r.mi;
    o[r.day] = v;
  }
  return o;
}

type Day = { d: string; loc: Loc; n: string; edited: boolean; us: number; es: number; eu: number; eur: number; off: string; fam: number; mi: number; fl: "" | "E" | "W"; prev: Loc | null };

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
    out.push({ d: b.d, loc, n, edited: !!overrides[b.d], us, es, eu, eur, off, fam: fam ? 1 : 0, mi: mi ? 1 : 0, fl, prev: i === 0 ? null : prev });
    prev = loc;
  });
  return out;
}

function fmt(d: string, long = false) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-GB", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" });
}

export default function PlanApp({ calendar, role, initialRows, allCalendars, userEmail, userId }: Props) {
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
      else upserts.push({ calendar_id: calendar.id, day, loc: v.loc ?? null, note: v.n ?? null, fam: v.fam ?? null, mi: v.mi ?? null, updated_at: new Date().toISOString(), updated_by: userId });
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
        if (patch === null) { delete next[d]; pending.current.set(d, null); }
        else { next[d] = { ...(prev[d] || {}), ...patch }; pending.current.set(d, next[d]); }
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
  const nEdited = Object.keys(overrides).length;
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
          <span className={"plan__status plan__status--" + status.kind}>
            {!canWrite ? "View only" : status.text || (nEdited ? `${nEdited} day${nEdited > 1 ? "s" : ""} edited` : "Claude's plan, no edits")}
          </span>
          {canWrite && nEdited > 0 && (
            <button className="btn" onClick={() => { if (!armReset) { setArmReset(true); setTimeout(() => setArmReset(false), 4000); return; } edit(Object.keys(overrides), null); setArmReset(false); }}>
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
          {view === "rng" && <span>One row per stretch of consecutive days with the same location, note and family flags. Edit a note and press Enter (or click away) to apply it to every day in that row. “Merge up” makes a row identical to the one above it.</span>}
        </div>

        {view === "rng" ? <Ranges C={C} canWrite={canWrite} edit={edit} /> : (
          <div className="plan__months">
            {MN.map((name, mo) => {
              const md = C.filter((x) => +x.d.slice(5, 7) === mo + 1);
              const lead = (new Date(2027, mo, 1).getDay() + 6) % 7;
              const cnt = view === "fl" ? md.filter((x) => x.fl).length : view === "loc" ? md.filter((x) => x.off).length : md.reduce((a, x) => a + (view === "mi" ? x.mi : x.fam), 0);
              return (
                <div className="plan__month" key={name}>
                  <h3>{name}<span>{view === "loc" ? `${cnt} holiday` : `${cnt} / ${md.length}`}</span></h3>
                  <div className="plan__grid">
                    {["M","T","W","T","F","S","S"].map((x, i) => <div className="plan__dow" key={i}>{x}</div>)}
                    {Array.from({ length: lead }).map((_, i) => <div key={"e" + i} />)}
                    {md.map((x) => {
                      let on = false, col = "", two = "", split = false, star = false;
                      if (view === "fl") { on = !!x.fl; col = x.fl === "E" ? "var(--p-fe)" : "var(--p-fw)"; }
                      else if (view === "loc") { on = true; col = LOC[x.loc].c; if (x.prev && x.prev !== x.loc && x.prev !== "US") two = LOC[x.prev].c; star = !!x.off; }
                      else { on = (view === "mi" ? x.mi : x.fam) === 1; col = view === "mi" ? "var(--p-mi)" : "var(--p-ma)"; }
                      const cls = "plan__day" + (on ? (two ? " two" : split ? " split" : " on") : "") + (x.edited ? " edited" : "") + (sel === x.d ? " sel" : "");
                      const flTxt = x.fl === "E" ? " · Fly Miami → Europe (overnight)" : x.fl === "W" ? " · Fly Europe → Miami" : "";
                      const tip = `${x.d} · ${LOC[x.loc].name}${flTxt}${x.off ? " · " + x.off : ""}${x.n ? " · " + x.n : ""}`;
                      return (
                        <button key={x.d} className={cls} style={{ ["--c" as any]: two || col, ["--c2" as any]: col }} title={tip} onClick={() => setSel(sel === x.d ? null : x.d)}>
                          {star && <span className="star">★</span>}{+x.d.slice(8)}
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

      {selDay && selBase && (
        <div className="plan__sheet">
          <div className="row"><span className="title">{fmt(selDay.d, true)}</span><span className="meta">{selDay.off || "School day"}{selDay.fl ? (selDay.fl === "E" ? " · fly Miami → Europe tonight" : " · fly Europe → Miami") : ""}</span><button className="btn x" onClick={() => setSel(null)}>Close</button></div>
          <div className="row">{(Object.keys(LOC) as Loc[]).map((k) => <button key={k} className="locbtn" style={{ ["--c" as any]: LOC[k].c }} aria-pressed={selDay.loc === k} disabled={!canWrite} onClick={() => edit([selDay.d], { loc: k })}>{LOC[k].name}</button>)}</div>
          <div className="row">
            <label><input type="checkbox" checked={!!selDay.fam} disabled={!canWrite} onChange={(e) => edit([selDay.d], { fam: e.target.checked })} /> Milsy &amp; Mason with me</label>
            <label><input type="checkbox" checked={!!selDay.mi} disabled={!canWrite} onChange={(e) => edit([selDay.d], { mi: e.target.checked })} /> Milsy with me</label>
          </div>
          <div className="row">
            <NoteInput key={selDay.d} value={selDay.n} disabled={!canWrite} onCommit={(v) => edit([selDay.d], { n: v })} />
            {selDay.edited && canWrite && <button className="btn" onClick={() => edit([selDay.d], null)}>Reset day</button>}
            <span className="meta">Claude&apos;s plan: {LOC[selBase.loc].name}{selBase.n ? " · " + selBase.n : ""}</span>
          </div>
        </div>
      )}

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

function Ranges({ C, canWrite, edit }: { C: Day[]; canWrite: boolean; edit: (days: string[], patch: Override | null) => void }) {
  const rows = useMemo(() => {
    const rows: { start: string; end: string; loc: Loc; n: string; fam: number; mi: number; days: Day[] }[] = [];
    for (const x of C) {
      const last = rows[rows.length - 1];
      if (last && last.loc === x.loc && last.n === x.n && last.fam === x.fam && last.mi === x.mi) { last.end = x.d; last.days.push(x); }
      else rows.push({ start: x.d, end: x.d, loc: x.loc, n: x.n, fam: x.fam, mi: x.mi, days: [x] });
    }
    return rows;
  }, [C]);
  const yn = (b: number) => (b ? <span className="yes">Yes</span> : <span className="no">—</span>);
  return (
    <div className="plan__tablewrap">
      <table className="plan__ranges">
        <thead><tr><th>From</th><th>To</th><th>Days</th><th>Location</th><th>Milsy &amp; Mason</th><th>Milsy</th><th>School holiday</th><th>Flights</th><th>Note</th><th></th></tr></thead>
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
                <td><NoteInput key={r.start + r.n} value={r.n} disabled={!canWrite} placeholder="Add a note for these days" onCommit={(v) => edit(r.days.map((x) => x.d), { n: v })} /></td>
                <td>{i > 0 && canWrite && <button className="btn mrg" title="Give these days the same location, flags and note as the row above" onClick={() => { const a = rows[i - 1]; edit(r.days.map((x) => x.d), { loc: a.loc, n: a.n, fam: !!a.fam, mi: !!a.mi }); }}>Merge up</button>}</td>
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
