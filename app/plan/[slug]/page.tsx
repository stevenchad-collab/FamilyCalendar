import { redirect, notFound } from "next/navigation";
import { createServerSupabase, createServiceClient } from "@/lib/supabase/server";
import { SEED } from "@/lib/plan2027";
import { convert, SEED_PEOPLE, type LegacyRow } from "@/lib/planConvert";
import type { Person, PDay, PlanEvent, Category } from "@/lib/plan";
import PlanApp from "./PlanApp";
import "../plan.css";

const OWNER_EMAIL = "stevenchad@gmail.com";
const DEFAULT_SLUG = "steve-2027";
const PEOPLE_SELECT = "id,name,color,sort,is_self,default_place,default_loc";

function Notice({ title, text }: { title: string; text: string }) {
  return <div className="app plan"><main className="plan__main"><h2>{title}</h2><p className="plan__note">{text}</p></main></div>;
}

// read every row of a table for one calendar (PostgREST caps a single request at 1000 rows)
async function fetchAll<T>(client: any, table: string, select: string, calendarId: string, order: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = client.from(table).select(select).eq("calendar_id", calendarId);
    for (const o of order) q = q.order(o);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data || []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// One-time upgrade: copy the v1 plan (built-in base + plan_days edits) into the per-person tables.
// plan_days is left untouched as a backup.
async function upgradeToPeople(admin: any, calendarId: string, userId: string) {
  const { data: people, error } = await admin.from("plan_people")
    .insert(SEED_PEOPLE.map((p) => ({ ...p, calendar_id: calendarId }))).select(PEOPLE_SELECT);
  if (error || !people) return; // someone else is already doing it (unique name per calendar)
  try {
    const legacy = await fetchAll<LegacyRow>(admin, "plan_days", "day,loc,note,fam,mi,cats", calendarId, ["day"]);
    const { data: cats } = await admin.from("plan_categories").select("id,name").eq("calendar_id", calendarId);
    const names = Object.fromEntries((cats || []).map((c: any) => [c.id, c.name]));
    const c = convert(legacy, people as Person[], names);
    const rows = c.days.map((d) => ({ ...d, calendar_id: calendarId, updated_by: userId }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error: e } = await admin.from("plan_person_days").insert(rows.slice(i, i + 500));
      if (e) throw new Error(e.message);
    }
    if (c.events.length) {
      const { error: e } = await admin.from("plan_events").insert(c.events.map((ev) => ({ ...ev, calendar_id: calendarId, updated_by: userId })));
      if (e) throw new Error(e.message);
    }
  } catch (err) {
    // leave nothing half-done: removing the people cascades to their days, so the next visit retries
    await admin.from("plan_events").delete().eq("calendar_id", calendarId);
    await admin.from("plan_people").delete().eq("calendar_id", calendarId);
    throw err;
  }
}

export default async function Page({ params }: { params: { slug: string } }) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await supabase.rpc("claim_invites");

  let { data: cal } = await supabase.from("calendars").select("*").eq("slug", params.slug).single();

  // First visit by the owner: create the plan calendar and load Steve's edits once.
  if (!cal && params.slug === DEFAULT_SLUG && (user.email || "").toLowerCase() === OWNER_EMAIL) {
    // one-time setup runs with the service role (server only): RLS blocks a server-side insert+read
    const admin = createServiceClient();
    const { data: created, error } = await admin
      .from("calendars")
      .insert({ owner_id: user.id, name: "Steve's 2027", slug: DEFAULT_SLUG, range_start: "2027-01-01", range_end: "2027-12-31", kind: "plan" })
      .select().single();
    if (error || !created) throw new Error(error?.message || "could not create plan calendar");
    const { error: mErr } = await admin.from("calendar_members").insert({ calendar_id: created.id, user_id: user.id, role: "owner" });
    if (mErr) throw new Error(mErr.message);
    if (SEED.length) {
      const { error: sErr } = await admin.from("plan_days").insert(SEED.map((s) => ({
        calendar_id: created.id, day: s.day, loc: s.loc ?? null, note: s.note ?? null, fam: s.fam ?? null, mi: s.mi ?? null, updated_by: user.id,
      })));
      if (sErr) throw new Error(sErr.message);
    }
    cal = created;
  }
  if (!cal) notFound();
  if (cal.kind !== "plan") redirect(`/c/${cal.slug}`);

  const { data: member } = await supabase.from("calendar_members").select("role").eq("calendar_id", cal.id).eq("user_id", user.id).maybeSingle();
  const role = (member?.role as "owner" | "editor" | "viewer" | undefined) || "viewer";

  let { data: people, error: pErr } = await supabase.from("plan_people").select(PEOPLE_SELECT).eq("calendar_id", cal.id).order("sort");
  if (pErr) return <Notice title="One step left" text="This version of the plan needs the database update in supabase/migrations/0004_plan_people_events.sql. Run it in the Supabase SQL Editor, then reload this page." />;
  if (!people || people.length === 0) {
    if (role !== "owner") return <Notice title="Plan is being upgraded" text="The owner needs to open this page once to finish the upgrade. Please check back shortly." />;
    await upgradeToPeople(createServiceClient(), cal.id, user.id);
    people = (await supabase.from("plan_people").select(PEOPLE_SELECT).eq("calendar_id", cal.id).order("sort")).data;
  }

  const [days, { data: evRows }, { data: calList }, { data: catRows }] = await Promise.all([
    fetchAll<PDay>(supabase, "plan_person_days", "person_id,day,place,loc,note", cal.id, ["person_id", "day"]),
    supabase.from("plan_events").select("id,title,start_day,end_day,place,category_id,must,note").eq("calendar_id", cal.id),
    supabase.from("calendars").select("id,name,slug,kind").order("created_at"),
    supabase.from("plan_categories").select("id,name,icon,color,sort,place").eq("calendar_id", cal.id).order("sort").order("created_at"),
  ]);

  return (
    <PlanApp
      calendar={{ id: cal.id, name: cal.name, slug: cal.slug, ownerId: cal.owner_id }}
      role={role}
      people={(people || []) as Person[]}
      initialDays={days}
      initialEvents={(evRows || []) as PlanEvent[]}
      initialCategories={(catRows || []) as Category[]}
      allCalendars={(calList || []).map((c: any) => ({ id: c.id, name: c.name, slug: c.slug, kind: c.kind || "events" }))}
      userEmail={user.email || ""}
      userId={user.id}
    />
  );
}
