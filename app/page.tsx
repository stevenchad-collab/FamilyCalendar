import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: cals } = await supabase
    .from("calendars")
    .select("slug")
    .order("created_at", { ascending: true })
    .limit(1);

  if (cals && cals.length) redirect(`/c/${cals[0].slug}`);

  // No calendars yet — offer to seed the demo.
  return (
    <main style={{ maxWidth: 520, margin: "12vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 30, fontWeight: 800 }}>Welcome 👋</h1>
      <p style={{ color: "#6b8595", marginTop: 8 }}>
        You don&apos;t have any calendars yet. Seed the Davis Summer demo to get started, then edit freely.
      </p>
      <form action="/api/seed" method="post" style={{ marginTop: 16 }}>
        <button className="btn btn--primary" type="submit">Create Davis Summer demo</button>
      </form>
    </main>
  );
}
