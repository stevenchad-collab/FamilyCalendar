import { createClient } from "@supabase/supabase-js";
import { monthsBetween, iso, MONTH_NAMES, DOW, rowToCalendar, rowToType, rowToEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: { slug: string; token: string } }) {
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data } = await anon.rpc("get_shared_view", { p_token: params.token });

  if (!data) {
    return <main style={{ maxWidth: 480, margin: "16vh auto", padding: 24 }}><h1 style={{ fontWeight: 800 }}>Link not found</h1><p style={{ color: "#6b8595" }}>This shared calendar link is invalid or has expired.</p></main>;
  }

  const cal = rowToCalendar(data.calendar);
  const types = (data.types || []).map(rowToType);
  const events = (data.events || []).map(rowToEvent);
  const typeById: Record<string, any> = Object.fromEntries(types.map((t: any) => [t.id, t]));
  const months = monthsBetween(cal.rangeStart, cal.rangeEnd);
  const onDay = (d: string) => events.filter((e: any) => e.start <= d && e.end >= d);

  return (
    <div className="app">
      <header className="topbar"><div className="switcher"><div className="switcher__btn"><span className="brand__mark">☀︎</span><span className="switcher__txt"><span className="switcher__name">{cal.name}</span><span className="switcher__url">shared view</span></span></div></div></header>
      <main className="main">
        <div className="months">
          {months.map((mo, idx) => {
            const firstDow = (new Date(Date.UTC(mo.year, mo.m - 1, 1)).getUTCDay() + 6) % 7;
            const dim = new Date(Date.UTC(mo.year, mo.m, 0)).getUTCDate();
            const cells: any[] = [];
            for (let i = 0; i < firstDow; i++) cells.push(<div className="cell cell--empty" key={"e" + i} />);
            for (let d = 1; d <= dim; d++) {
              const di = iso(mo.year, mo.m, d);
              const evs = onDay(di);
              const hl = evs.find((e: any) => typeById[e.typeId]?.highlight);
              const hlColor = hl ? typeById[hl.typeId].color : null;
              const icons = Array.from(new Set(evs.map((e: any) => typeById[e.typeId]?.icon).filter(Boolean)));
              const bars = Array.from(new Set(evs.map((e: any) => e.typeId))).map((id: any) => typeById[id]).filter((t: any) => t && !t.icon).slice(0, 4);
              return (
                <div key={di} className="cell">
                  <div className="cell__top"><span className="date" style={hlColor ? { background: hlColor, color: "#1f3b2c" } : undefined}>{d}</span><span className="cell__icons" style={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 2, flex: "1 1 auto", minWidth: 0, whiteSpace: "normal", overflow: "visible" }}>{icons.map((ic: any, i: number) => <span key={i}>{ic}</span>)}</span></div>
                  <div className="bars">{bars.map((t: any, i: number) => <span key={i} className="bar" style={{ background: t.color }} />)}</div>
                </div>
              );
            }
            return (
              <section className="monthblock" key={mo.key}>
                <h1 className="monthname">{mo.name}{idx === 0 ? <span className="monthname__yr"> {mo.year}</span> : null}</h1>
                <div className="dow">{DOW.map((x, i) => <div key={i} className="dow__c">{x}</div>)}</div>
                <div className="grid">{cells}</div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}
