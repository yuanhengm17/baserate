# Baserate — project notes for Claude Code

## What this is
An investment-banking recruiting tracker and base-rate dashboard for college students. Current recruits
log their pipeline live: every firm, each stage with dates, and each action (outreach, coffee chats, info
sessions, firm and club events). Upperclassmen who finished recruiting can contribute a whole cycle at
once. Finished pipelines are reviewed, and approved ones feed anonymized aggregates: what each action is
worth, how long firms take, which kinds of contacts reply, and a personal "odds sheet". See README.md.
Keep the UI lean: each page shows only what a recruit acts on; detail goes behind a fold or is left out.

## Layout
- `web/` static front end, no build step. `app.js` = routes + views + Supabase client; `demo-backend.js` =
  in-browser synthetic backend used when `config.js` has `DEMO: true`; `styles.css`; `config.js` holds
  the Supabase URL/anon key (never commit real keys).
- `supabase/schema.sql` all tables, RLS, RPCs (run in Supabase SQL editor); `seed_firms.sql`.

## Data model
- `submissions` = one pipeline per person. Status `in_progress` (live, private) → `pending` (finalized,
  awaiting review) → `approved` / `rejected`. Only `approved` pipelines feed aggregates.
- `submission_firms` = one row per firm in a pipeline, with stage booleans and `*_on` dates.
- `touchpoints` = one row per action at a firm. Contacts are described only by coarse categories
  (`contact_level`, `connection`, `found_via`); there are no free-text fields.
- `pipeline_activity` = days a person logged something; drives "actively logging" access.
- `profiles.signup_source` = the `?src=` tag (or `ref:<host>`) of the first link a person used, saved
  once by `set_my_source()` on a new account. Admins see it only as counts (`admin_sources()`).
- `firm_notes` = the owner's private free-text notes and application link per firm. Owner-only RLS.
- `admin_secret` / `admin_unlock_attempts` = salted SHA-256 of the admin password; `unlock_admin()`
  makes the caller admin on a match, max 5 wrong tries per hour. Set it with
  `select public.set_admin_password('...')` in the SQL editor; never put the password in the repo.

## TEMPORARY exception (MVP pilot with the team and friends)
`web/events.js` sends every visit, page view and action, with the signed-in email, to the team's
Google Sheet (`EVENTS_URL` in `config.js`; the Sheet runs `tracking/Code.gs`). This is a deliberate,
temporary exception to rules 3 and 8; don't flag it or remove it unless asked. Before a wider launch,
remove it: delete `web/events.js`, its `<script>` tag in `index.html`, `EVENTS_URL` and `tracking/`.
The `track()` calls in `app.js` then do nothing. New user actions should call `track()`.

## Rules that must hold
1. Demo mode must keep working with no backend: any new backend method gets an equivalent in
   `demo-backend.js`, and the aggregate logic there must mirror the SQL (same rows, same order).
2. Every schema change is tested locally before shipping: Postgres + a mock `auth` schema
   (see "Testing" below). Never ship SQL that was not run.
3. Privacy is non-negotiable: dashboard/odds functions are `security definer`, return aggregates only,
   and never expose another user's rows. A cell is suppressed when it has fewer than `k_anonymity`
   people (default 5) or when one person contributes more than `max_cell_share` (default 0.5) of its
   rows. Row-level security stays on for every table.
4. Outreach details (`contact_level`, `connection`, `found_via`, `replied`, `led_to_chat`,
   `led_to_referral`) enter aggregates only from pipelines with `share_outreach = true`. Users can
   withdraw that consent and delete their own touchpoints at any time, with immediate effect.
5. Admins review finalized pipelines only. They never see live (`in_progress`) pipelines and never
   read `touchpoints` or `firm_notes`.
6. Access is give-to-get: the dashboard and odds are visible only to admins, users with an approved
   pipeline, or users actively logging (an `in_progress` pipeline with activity on at least
   `active_min_days` days within `active_window_days`).
7. Users cannot set their own status: pipelines are created and edited through RPCs, never by direct
   insert/update on `submissions`.
8. No scraping, no automation against LinkedIn, and no names or emails in any shared or aggregated
   data. The one exception is `firm_notes`: private free text only its owner can read, never used in
   aggregates. (A shared contacts list is being designed; until it is approved, none exists.)
9. Keep the front end vanilla HTML/CSS/JS. No framework, no bundler.
10. Sign-in is an emailed code (6–10 digits, set by Supabase's OTP length) (`signInWithOtp` + `verifyOtp` type `email`), not a link: school
    mail scanners consume links. The Supabase email templates must contain `{{ .Token }}`.

## Testing
- Front end: `cd web && python3 -m http.server 8000`, open http://localhost:8000 (demo mode).
- SQL: create a scratch Postgres database (PGlite under Node works if no Postgres is installed), run a
  mock auth schema (an `auth.users` table and an `auth.uid()` function reading
  `current_setting('request.jwt.claim.sub', true)`, plus `anon` and `authenticated` roles), then
  `schema.sql` and `seed_firms.sql`. Simulate users with `set_config('request.jwt.claim.sub', '<uuid>', false)`
  and `set role authenticated` to check RLS. Verify at least: non-school email rejected; a user cannot
  insert or approve their own submission; flagged pipeline stays pending; pending user gets no dashboard
  or odds rows; inactive live pipeline gets no rows; admin cannot read touchpoints or live pipelines;
  withdrawing outreach consent removes those rows from `dash_outreach`; anon gets nothing.
- Demo parity: load the demo's synthetic data into that database and compare every `dash_*` function
  and `my_odds()` with the demo backend's output.

## Conventions
- 12pt-plain language in UI copy; say what a control does.
- Flags on submissions are lowercase snake_case strings in `submissions.flags`.
- Dates in the DB are `date`, not timestamps, for stage dates (`applied_on` etc.), `occurred_on`,
  `next_on` and `active_on`.
- Ordering in aggregates must be deterministic; break ties with `collate "C"` or ids so the demo can match.
