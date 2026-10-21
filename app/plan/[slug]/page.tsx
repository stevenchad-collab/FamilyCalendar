import { redirect, notFound } from "next/navigation";
import { createServerSupabase, createServiceClient } from "@/lib/supabase/server";
import { SEED } from "@/lib/plan2027";
import PlanApp, { type PlanRow } from "./PlanApp";
import "../plan.css";

const OWNER_EMAIL = "stevenchad@gmail.com";
const DEFAULT_SLUG = "steve-2027";

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

  const [{ data: member }, { data: rows }, { data: calList }] = await Promise.all([
    supabase.from("calendar_members").select("role").eq("calendar_id", cal.id).eq("user_id", user.id).maybeSingle(),
    supabase.from("plan_days").select("day,loc,note,fam,mi").eq("calendar_id", cal.id),
    supabase.from("calendars").select("id,name,slug,kind").order("created_at"),
  ]);
  const role = (member?.role as "owner" | "editor" | "viewer" | undefined) || "viewer";

  return (
    <PlanApp
      calendar={{ id: cal.id, name: cal.name, slug: cal.slug, ownerId: cal.owner_id }}
      role={role}
      initialRows={(rows || []) as PlanRow[]}
      allCalendars={(calList || []).map((c: any) => ({ id: c.id, name: c.name, slug: c.slug, kind: c.kind || "events" }))}
      userEmail={user.email || ""}
      userId={user.id}
    />
  );
}
