# Family Calendar

Shared, filterable family calendars. **Next.js (App Router) + Supabase + Vercel.**

Replaces a shared note with one source of truth: a continuous-scroll month calendar with per-type colours/icons, count-sorted filters, multi-day bulk add, multiple calendars (each its own URL + date range + event types), shareable live links, PDF export, and ICS import for a rental calendar synced with Booking.com / Airbnb.

## What's wired
- Auth (magic link) · multiple calendars · event types CRUD · events add/edit/delete · **multi-day bulk add** · filters sorted by event count · continuous month scroll · share links (RPC-backed, public) · PDF via print · ICS import (subscription row + hourly sync cron).
- Demo seed: the full Davis Summer dataset.

## Setup

```bash
npm install

# Supabase: create a project at supabase.com, then:
npx supabase login
npx supabase link --project-ref <YOUR_PROJECT_REF>
npx supabase db push        # applies supabase/migrations/0001_init.sql

cp .env.example .env.local   # fill in the values from Supabase → Settings → API
npm run dev
```

In Supabase → Authentication → URL Configuration, add `http://localhost:3000/auth/callback` (and your Vercel URL later) as a redirect URL.

Open http://localhost:3000, sign in, then click **Create Davis Summer demo** to seed.

## Deploy

```bash
git init && git add -A && git commit -m "init"
gh repo create family-calendar --private --source=. --push
```

Import the repo at **vercel.com/new**, add the same env vars (set `NEXT_PUBLIC_SITE_URL` to your Vercel domain), and deploy. The hourly ICS sync runs automatically (`vercel.json`).

## Env vars
See `.env.example`. `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` are server-only.

## Layout
- `supabase/migrations/0001_init.sql` — schema, RLS, `get_shared_view` RPC
- `app/c/[slug]/page.tsx` — loads data → `CalendarApp.tsx` (the UI)
- `app/c/[slug]/share/[token]/page.tsx` — public read-only view
- `app/api/sync/route.ts` — cron: refresh ICS feeds
- `app/api/seed/route.ts` — one-click demo seed
- `lib/` — Supabase clients, shared types, date helpers, seed data

## Notes / next steps
- **Delete event type** removes its events (FK `on delete cascade`). To reassign instead, change the FK to `on delete set null` and add a reassign step in `TypeManager`.
- **Image export (JPEG/PNG):** add `html-to-image` and capture the calendar node; PDF already works via the browser print dialog.
- **Inviting family members:** insert rows into `calendar_members` (a simple invite-by-email UI is a good follow-on).
# FamilyCalendar
