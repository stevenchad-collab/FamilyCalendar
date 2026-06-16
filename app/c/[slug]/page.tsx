import { redirect, notFound } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { rowToCalendar, rowToType, rowToEvent } from "@/lib/types";
import CalendarApp from "./CalendarApp";

export default async function Page({ params }: { params: { slug: string } }) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // turn any pending email invites for this user into memberships
  await supabase.rpc("claim_invites");

  const { data: calRow } = await supabase.from("calendars").select("*").eq("slug", params.slug).single();
  if (!calRow) notFound();

  const [{ data: typeRows }, { data: eventRows }, { data: calList }] = await Promise.all([
    supabase.from("event_types").select("*").eq("calendar_id", calRow.id).order("sort_order"),
    supabase.from("events").select("*").eq("calendar_id", calRow.id),
    supabase.from("calendars").select("id,name,slug").order("created_at"),
  ]);

  return (
    <CalendarApp
      calendar={rowToCalendar(calRow)}
      initialTypes={(typeRows || []).map(rowToType)}
      initialEvents={(eventRows || []).map(rowToEvent)}
      allCalendars={(calList || []).map((c: any) => ({ id: c.id, name: c.name, slug: c.slug }))}
      userEmail={user.email || ""}
    />
  );
}
