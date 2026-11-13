-- =====================================================================
-- Plan v2: where each person is (per person, per day), plus events.
--   plan_people       who is tracked on a plan (Steve, Milsy, Mason, ...)
--   plan_person_days  one row per person per day: place + country bucket
--                     (a person with a default place only needs rows for
--                      the days they are somewhere else)
--   plan_events       titled, dated things to be present for
-- The old plan_days table is left untouched as a backup; the app copies
-- it into the new tables the first time the owner opens the plan.
-- Safe to run more than once. Run in the Supabase SQL editor.
-- =====================================================================

create table if not exists plan_people (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars on delete cascade,
  name text not null,
  color text not null default '#5f6b73',
  sort int not null default 0,
  is_self boolean not null default false,
  default_place text,
  default_loc text check (default_loc in ('US','ES','EU')),
  created_at timestamptz default now(),
  unique (calendar_id, name)
);

create table if not exists plan_person_days (
  calendar_id uuid not null references calendars on delete cascade,
  person_id uuid not null references plan_people on delete cascade,
  day date not null,
  place text not null,
  loc text check (loc in ('US','ES','EU')),
  note text,
  updated_at timestamptz default now(),
  updated_by uuid references auth.users on delete set null,
  primary key (person_id, day)
);
create index if not exists plan_person_days_cal on plan_person_days (calendar_id);

create table if not exists plan_events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars on delete cascade,
  title text not null,
  start_day date not null,
  end_day date not null,
  place text,
  category_id uuid references plan_categories on delete set null,
  must boolean not null default true,
  note text,
  created_at timestamptz default now(),
  updated_by uuid references auth.users on delete set null,
  check (end_day >= start_day)
);
create index if not exists plan_events_cal on plan_events (calendar_id);

-- a category can carry a usual place (e.g. Forum -> Barcelona) used when an event has none
alter table plan_categories add column if not exists place text;

alter table plan_people enable row level security;
alter table plan_person_days enable row level security;
alter table plan_events enable row level security;

drop policy if exists pp_read on plan_people;
create policy pp_read on plan_people for select using (is_member(calendar_id));
drop policy if exists pp_write on plan_people;
create policy pp_write on plan_people for all using (can_edit(calendar_id)) with check (can_edit(calendar_id));

drop policy if exists ppd_read on plan_person_days;
create policy ppd_read on plan_person_days for select using (is_member(calendar_id));
drop policy if exists ppd_write on plan_person_days;
create policy ppd_write on plan_person_days for all using (can_edit(calendar_id)) with check (can_edit(calendar_id));

drop policy if exists pe_read on plan_events;
create policy pe_read on plan_events for select using (is_member(calendar_id));
drop policy if exists pe_write on plan_events;
create policy pe_write on plan_events for all using (can_edit(calendar_id)) with check (can_edit(calendar_id));

-- live updates (replica identity full so deletes carry calendar_id for the filter)
alter table plan_person_days replica identity full;
alter table plan_events replica identity full;
alter table plan_people replica identity full;
do $$ begin alter publication supabase_realtime add table plan_person_days; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table plan_events; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table plan_people; exception when duplicate_object then null; end $$;
