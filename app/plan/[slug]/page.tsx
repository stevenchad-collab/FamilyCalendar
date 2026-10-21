import { redirect, notFound } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
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
    const { data: created, error } = await supabase
      .from("calendars")
      .insert({ owner_id: user.id, name: "Steve's 2027", slug: DEFAULT_SLUG, range_start: "2027-01-01", range_end: "2027-12-31", kind: "plan" })
      .select().single();
    if (error || !created) throw new Error(error?.message || "could not create plan calendar");
    await supabase.from("calendar_members").insert({ calendar_id: created.id, user_id: user.id, role: "owner" });
    if (SEED.length) {
      await supabase.from("plan_days").insert(SEED.map((s) => ({
        calendar_id: created.id, day: s.day, loc: s.loc ?? null, note: s.note ?? null, fam: s.fam ?? null, mi: s.mi ?? null, updated_by: user.id,
      })));
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
