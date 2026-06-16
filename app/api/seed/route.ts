import { NextResponse } from "next/server";
import { createServerSupabase, createServiceClient } from "@/lib/supabase/server";
import { DAVIS, DAVIS_TYPES, DAVIS_EVENTS } from "@/lib/seed-data";

export async function POST() {
  const session = createServerSupabase();
  const { data: { user } } = await session.auth.getUser();
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  if (!user) return NextResponse.redirect(new URL("/login", base), { status: 303 });

  const db = createServiceClient(); // elevated key — seeding bypasses RLS

  const slug = DAVIS.slug;
  const { data: cal, error: ce } = await db
    .from("calendars")
    .insert({ owner_id: user.id, name: DAVIS.name, slug, range_start: DAVIS.rangeStart, range_end: DAVIS.rangeEnd })
    .select().single();
  if (ce || !cal) return NextResponse.json({ error: ce?.message || "calendar insert failed" }, { status: 400 });

  await db.from("calendar_members").insert({ calendar_id: cal.id, user_id: user.id, role: "owner" });

  const typeRows = DAVIS_TYPES.map((t, i) => ({
    calendar_id: cal.id, name: t.name, color: t.color, icon: t.icon, highlight: t.highlight, sort_order: i,
  }));
  const { data: types } = await db.from("event_types").insert(typeRows).select();

  const keyToId = {};
  (types || []).forEach((row) => {
    const def = DAVIS_TYPES.find((t) => t.name === row.name);
    if (def) keyToId[def.key] = row.id;
  });

  const eventRows = DAVIS_EVENTS.map((ev) => ({
    calendar_id: cal.id, type_id: keyToId[ev.typeKey], title: ev.title,
    start_date: ev.start, end_date: ev.end, event_time: ev.time || "",
    status: ev.status || "confirmed", note: ev.note || "", source: "manual",
  }));
  await db.from("events").insert(eventRows);

  return NextResponse.redirect(new URL(`/c/${slug}`, base), { status: 303 });
}
