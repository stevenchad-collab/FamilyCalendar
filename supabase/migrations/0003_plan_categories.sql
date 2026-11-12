-- =====================================================================
-- Plan categories: user-defined activities (e.g. "Forum") with an icon
-- and colour, tagged onto days of a plan calendar. They do not affect
-- location or day counts. Run in the Supabase SQL editor.
-- =====================================================================

create table if not exists plan_categories (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars on delete cascade,
  name text not null,
  icon text not null default '•',
  color text not null default '#b8860b',
  sort int not null default 0,
  created_at timestamptz default now()
);
create index if not exists plan_categories_cal on plan_categories (calendar_id);

alter table plan_categories enable row level security;
drop policy if exists pc_read on plan_categories;
create policy pc_read on plan_categories for select using (is_member(calendar_id));
drop policy if exists pc_write on plan_categories;
create policy pc_write on plan_categories for all
  using (can_edit(calendar_id)) with check (can_edit(calendar_id));

-- category ids tagged on a day (null/empty = none)
alter table plan_days add column if not exists cats text[];

do $$ begin
  alter publication supabase_realtime add table plan_categories;
exception when duplicate_object then null; end $$;
