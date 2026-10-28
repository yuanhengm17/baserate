# Baserate — project notes for Claude Code

## What this is
Crowdsourced investment-banking recruiting funnels for college students. Upperclassmen who finished
recruiting contribute an anonymized firm-by-firm funnel (coffee chats, applied, first round, superday,
offer, including rejections) in exchange for an aggregate dashboard. Current recruits get base rates
for their profile and a personal "odds sheet"; a coffee-chat tracker measures whether that information
changes where they put effort. See README.md for the experiment design and deploy steps.

## Layout
- `web/` static front end, no build step. `app.js` = routes + views + Supabase client; `demo-backend.js` =
  in-browser synthetic backend used when `config.js` has `DEMO: true`; `styles.css`; `config.js` holds
  the Supabase URL/anon key (never commit real keys).
- `supabase/schema.sql` all tables, RLS, RPCs (run in Supabase SQL editor); `seed_firms.sql`; `metrics.sql`.
- `outreach.md` recruitment copy for the study.

## Rules that must hold
1. Demo mode must keep working with no backend: any new backend method gets an equivalent in
   `demo-backend.js`, and the aggregate logic there must mirror the SQL.
2. Every schema change is tested locally before shipping: Postgres + a mock `auth` schema
   (see "Testing" below). Never ship SQL that was not run.
3. Privacy is non-negotiable: dashboard/odds functions are `security definer`, return aggregates only,
   suppress any cell with fewer than `k_anonymity` people (default 5), and never expose another user's rows.
   Row-level security stays on for every table. Comparison-group participants never see the odds sheet.
4. Access is give-to-get: the dashboard is visible only to users with an approved submission (or admins).
5. No scraping, no automation against LinkedIn, no storing names or emails with funnel data.
6. Keep the front end vanilla HTML/CSS/JS. No framework, no bundler.

## Testing
- Front end: `cd web && python3 -m http.server 8000`, open http://localhost:8000 (demo mode).
- SQL: create a scratch Postgres database, run a mock auth schema (an `auth.users` table and an
  `auth.uid()` function reading `current_setting('request.jwt.claim.sub', true)`), then `schema.sql` and
  `seed_firms.sql`. Simulate users with `set_config('request.jwt.claim.sub', '<uuid>', false)` and
  `set role authenticated` to check RLS. Verify: non-school email rejected; flagged submission stays
  pending; pending user gets no dashboard rows; comparison participant gets no odds rows.

## Conventions
- 12pt-plain language in UI copy; say what a control does.
- Flags on submissions are lowercase snake_case strings in `submissions.flags`.
- Dates in the DB are `date`, not timestamps, for `logged_on` and `sheet_shown_on`.
