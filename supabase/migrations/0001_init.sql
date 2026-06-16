-- =====================================================================
-- Family Calendar — initial schema + RLS
-- Run with: supabase db push   (or paste into the Supabase SQL editor)
-- =====================================================================

create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at timestamptz default now()
);

create table if not exists calendars (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  name text not null,
  slug text not null unique,
  range_start date not null,
  range_end date not null,
  created_at timestamptz default now()
);

create table if not exists calendar_members (
  calendar_id uuid references calendars on delete cascade,
  user_id uuid references auth.users on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor','viewer')),
  primary key (calendar_id, user_id)
);

create table if not exists event_types (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars on delete cascade,
  name text not null,
  color text not null,
  icon text default '',
  highlight boolean default false,
  sort_order int default 0,
  created_at timestamptz default now()
);

create table if not exists calendar_subscriptions (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars on delete cascade,
  ics_url text not null,
  type_id uuid references event_types on delete set null,
  last_synced_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars on delete cascade,
  type_id uuid references event_types on delete cascade,
  title text not null,
  start_date date not null,
  end_date date not null,
  event_time text default '',
  status text not null default 'confirmed'
    check (status in ('confirmed','requested','tentative','needs-change')),
  note text default '',
  source text not null default 'manual' check (source in ('manual','imported')),
  external_uid text,
  subscription_id uuid references calendar_subscriptions on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists events_cal_start_idx on events (calendar_id, start_date);
create unique index if not exists events_sub_uid_idx
  on events (subscription_id, external_uid) where subscription_id is not null;

create table if not exists shared_views (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars on delete cascade,
  token text not null unique default encode(gen_random_bytes(12),'hex'),
  range_start date, range_end date,
  type_ids uuid[] default '{}',
  statuses text[] default '{}',
  is_live boolean default true,
  created_at timestamptz default now(),
  expires_at timestamptz
);

-- ------- membership helper (avoids recursive RLS) -------
create or replace function is_member(cal uuid)
returns boolean language sql security definer stable as $$
  select exists (select 1 from calendar_members m
                 where m.calendar_id = cal and m.user_id = auth.uid());
$$;

-- ------- enable RLS -------
alter table profiles enable row level security;
alter table calendars enable row level security;
alter table calendar_members enable row level security;
alter table event_types enable row level security;
alter table events enable row level security;
alter table calendar_subscriptions enable row level security;
alter table shared_views enable row level security;

-- profiles: self
drop policy if exists prof_self on profiles;
create policy prof_self on profiles for all using (id = auth.uid()) with check (id = auth.uid());

-- calendars
drop policy if exists cal_read on calendars;
create policy cal_read on calendars for select using (is_member(id));
drop policy if exists cal_insert on calendars;
create policy cal_insert on calendars for insert with check (owner_id = auth.uid());
drop policy if exists cal_update on calendars;
create policy cal_update on calendars for update using (owner_id = auth.uid());
drop policy if exists cal_delete on calendars;
create policy cal_delete on calendars for delete using (owner_id = auth.uid());

-- membership: you can read your own rows; owner manages list
drop policy if exists mem_self on calendar_members;
create policy mem_self on calendar_members for select using (user_id = auth.uid());
drop policy if exists mem_owner on calendar_members;
create policy mem_owner on calendar_members for all
  using (exists (select 1 from calendars c where c.id = calendar_id and c.owner_id = auth.uid()))
  with check (exists (select 1 from calendars c where c.id = calendar_id and c.owner_id = auth.uid()));
-- allow a creator to insert their own owner membership row
drop policy if exists mem_self_insert on calendar_members;
create policy mem_self_insert on calendar_members for insert with check (user_id = auth.uid());

-- child tables: members of the parent calendar get full access
drop policy if exists et_all on event_types;
create policy et_all on event_types for all using (is_member(calendar_id)) with check (is_member(calendar_id));
drop policy if exists ev_all on events;
create policy ev_all on events for all using (is_member(calendar_id)) with check (is_member(calendar_id));
drop policy if exists sub_all on calendar_subscriptions;
create policy sub_all on calendar_subscriptions for all using (is_member(calendar_id)) with check (is_member(calendar_id));
drop policy if exists sv_all on shared_views;
create policy sv_all on shared_views for all using (is_member(calendar_id)) with check (is_member(calendar_id));

-- ------- public share link (anon reads only the filtered slice) -------
create or replace function get_shared_view(p_token text)
returns jsonb language plpgsql security definer stable as $$
declare v shared_views; out jsonb;
begin
  select * into v from shared_views
    where token = p_token and (expires_at is null or expires_at > now());
  if not found then return null; end if;

  select jsonb_build_object(
    'calendar', (select to_jsonb(c) from calendars c where c.id = v.calendar_id),
    'view',     to_jsonb(v),
    'types',    (select coalesce(jsonb_agg(t),'[]') from event_types t where t.calendar_id = v.calendar_id),
    'events',   (select coalesce(jsonb_agg(e),'[]') from events e
                  where e.calendar_id = v.calendar_id
                    and (v.range_start is null or e.end_date   >= v.range_start)
                    and (v.range_end   is null or e.start_date <= v.range_end)
                    and (cardinality(v.type_ids) = 0 or e.type_id = any(v.type_ids))
                    and (cardinality(v.statuses) = 0 or e.status  = any(v.statuses)))
  ) into out;
  return out;
end; $$;

grant execute on function get_shared_view(text) to anon, authenticated;
