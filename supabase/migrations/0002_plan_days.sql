-- =====================================================================
-- 2027 residency plan: a "plan" kind of calendar whose days are edited
-- in /plan/[slug]. Membership, invites and roles reuse calendar_members.
-- Run in the Supabase SQL editor (or: supabase db push).
-- =====================================================================

-- calendars gain a kind so the switcher can route plan calendars to /plan/<slug>
alter table calendars add column if not exists kind text not null default 'events'
  check (kind in ('events','plan'));

-- one row per edited day (days not present fall back to the plan built into the app)
create table if not exists plan_days (
  calendar_id uuid not null references calendars on delete cascade,
  day date not null,
  loc text check (loc in ('US','ES','EU')),
  note text,
  fam boolean,
  mi boolean,
  updated_at timestamptz default now(),
  updated_by uuid references auth.users on delete set null,
  primary key (calendar_id, day)
);

-- editor-or-owner check (viewers read only)
create or replace function can_edit(cal uuid)
returns boolean language sql security definer stable as $$
  select exists (select 1 from calendar_members m
                 where m.calendar_id = cal and m.user_id = auth.uid()
                   and m.role in ('owner','editor'));
$$;

alter table plan_days enable row level security;
drop policy if exists pd_read on plan_days;
create policy pd_read on plan_days for select using (is_member(calendar_id));
drop policy if exists pd_write on plan_days;
create policy pd_write on plan_days for all
  using (can_edit(calendar_id)) with check (can_edit(calendar_id));

-- let the owner change a joined member's role by email (editor <-> viewer)
create or replace function set_member_role(p_calendar uuid, p_email text, p_role text)
returns boolean language plpgsql security definer as $$
declare v_uid uuid;
begin
  if p_role not in ('editor','viewer') then raise exception 'bad role'; end if;
  if not exists (select 1 from calendars c where c.id = p_calendar and c.owner_id = auth.uid()) then
    raise exception 'not the owner';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then return false; end if;
  update calendar_members set role = p_role
    where calendar_id = p_calendar and user_id = v_uid and role <> 'owner';
  -- keep the invite row in step so the list shows the right role
  update calendar_invites set role = p_role where calendar_id = p_calendar and lower(email) = lower(p_email);
  return found;
end; $$;
grant execute on function set_member_role(uuid, text, text) to authenticated;

-- live updates for everyone who has the plan open
do $$ begin
  alter publication supabase_realtime add table plan_days;
exception when duplicate_object then null; end $$;
