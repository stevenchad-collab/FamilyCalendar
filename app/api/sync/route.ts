import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import ical from "node-ical";

// Triggered by Vercel Cron (see vercel.json). Pulls each subscription's ICS
// feed and upserts events keyed by (subscription_id, external_uid).
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createServiceClient();
  const { data: subs } = await db.from("calendar_subscriptions").select("*");
  let total = 0;

  for (const s of subs ?? []) {
    try {
      const feed = await ical.async.fromURL(s.ics_url);
      const rows = Object.values(feed)
        .filter((e: any) => e.type === "VEVENT")
        .map((e: any) => ({
          calendar_id: s.calendar_id,
          type_id: s.type_id,
          title: e.summary ?? "Booked",
          start_date: new Date(e.start).toISOString().slice(0, 10),
          end_date: new Date(e.end ?? e.start).toISOString().slice(0, 10),
          status: "confirmed",
          source: "imported",
          external_uid: e.uid,
          subscription_id: s.id,
        }));
      if (rows.length) {
        await db.from("events").upsert(rows, { onConflict: "subscription_id,external_uid" });
        total += rows.length;
      }
      await db.from("calendar_subscriptions").update({ last_synced_at: new Date().toISOString() }).eq("id", s.id);
    } catch (err: any) {
      console.error("sync failed for", s.id, err?.message);
    }
  }
  return NextResponse.json({ ok: true, synced: total });
}
