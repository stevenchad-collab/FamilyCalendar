import { createClient } from "@supabase/supabase-js";
import { addDays, MONTH_NAMES, STATUSES, rowToCalendar, rowToType, rowToEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

const DOW_FULL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dowShort = (s: string) => { const [y, m, d] = s.split("-").map(Number); return DOW_FULL[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const fmtDate = (s: string) => { const [, m, d] = s.split("-").map(Number); return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`; };
const dayDiff = (a: string, b: string) => Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);

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

  // The shared view carries its own filtered date range (set when the link was created) —
  // this must be used for grouping, not the parent calendar's full range, otherwise the
  // page renders whatever span the whole calendar covers instead of the shared slice.
  const view = data.view || {};
  const rangeStart: string = view.range_start || cal.rangeStart;
  const rangeEnd: string = view.range_end || cal.rangeEnd;

  const statusChip = (s: string) => s === "confirmed" ? null : <span className={"sc sc--" + s}>{STATUSES.find((x) => x.id === s)?.label}</span>;

  const groups: Record<string, { e: any; dayNum: number; span: number }[]> = {};
  const sorted = [...events].sort((a: any, b: any) =>
    a.start !== b.start ? (a.start < b.start ? -1 : 1) : (a.time || "") < (b.time || "") ? -1 : (a.time || "") > (b.time || "") ? 1 : 0
  );
  for (const e of sorted) {
    const span = dayDiff(e.start, e.end) + 1;
    const from = e.start < rangeStart ? rangeStart : e.start;
    const to = e.end > rangeEnd ? rangeEnd : e.end;
    let cur = from;
    while (cur <= to) {
      const dayNum = dayDiff(e.start, cur) + 1;
      (groups[cur] = groups[cur] || []).push({ e, dayNum, span });
      cur = addDays(cur, 1);
    }
  }
  const dayGroups = Object.entries(groups).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return (
    <div className="app">
      <header className="topbar"><div className="switcher"><div className="switcher__btn"><span className="brand__mark">☀︎</span><span className="switcher__txt"><span className="switcher__name">{cal.name}</span><span className="switcher__url">shared view</span></span></div></div></header>
      <main className="main">
        <div className="list">
          <h1 className="monthname">Agenda</h1>
          {dayGroups.length === 0 && <div className="empty">Nothing to show for this link.</div>}
          {dayGroups.map(([day, evs]) => (
            <div className="lgroup" key={day}>
              <div className="lgroup__date">{dowShort(day)}, {fmtDate(day)}</div>
              <div className="lgroup__items">
                {evs.map(({ e, dayNum, span }: any) => {
                  const t = typeById[e.typeId];
                  return (
                    <div className="litem" style={{ cursor: "default" }} key={e.id + day}>
                      <span className="litem__sw" style={{ background: t?.color }} />
                      <span className="litem__icon">{t?.icon}</span>
                      <span className="litem__title">{e.title}{span > 1 && dayNum > 1 && <span className="litem__day"> (Day {dayNum} of {span})</span>}{e.imported && <span className="lock">🔒</span>}</span>
                      {e.time && <span className="litem__time">{e.time}</span>}
                      {statusChip(e.status)}
                      {e.note && <span className="litem__note">{e.note}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
