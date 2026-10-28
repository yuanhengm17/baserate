# Baserate MVP

Crowdsourced investment-banking recruiting funnels. Students who finished recruiting
submit a firm-by-firm retrospective (networked → applied → first round → superday → offer);
in exchange they unlock an aggregate dashboard. Nothing individual is ever shown.

This repo is the smallest thing that tests the research question:

> When juniors and seniors who completed IB recruiting are asked to submit a full-funnel
> retrospective, do at least 40 of the first 100 complete it within one week, with at least
> 80% including at least one rejection?

```
baserate-mvp/
├── web/                 static front end (no build step)
│   ├── index.html
│   ├── app.js           routes, form, dashboard, admin; talks to Supabase
│   ├── demo-backend.js  synthetic in-browser data for previews (DEMO mode)
│   ├── styles.css
│   └── config.js        ← paste your Supabase URL + anon key here
├── supabase/
│   ├── schema.sql       tables, auth domain restriction, RLS, flags, aggregate RPCs
│   ├── seed_firms.sql   ~45 IB firms by tier
│   └── metrics.sql      queries for the research-question metrics and study readout
└── outreach.md          email / GroupMe copy for the 100-person ask
```

## Preview right now (no setup)

Open `web/index.html` in a browser (or `cd web && python3 -m http.server 8000`).
`config.js` ships with `DEMO: true`, so you get synthetic data, instant sign-in with any
email, a working form, the gate, the dashboard, and an admin queue with flagged examples
(on the home page, use "Enter admin mode"). Nothing is saved anywhere except your browser.

## Deploy for real (about 30 minutes)

### 1. Supabase project
1. Create a free project at supabase.com. Pick a region near you.
2. **SQL Editor → New query**: paste all of `supabase/schema.sql`, run. Then paste
   `supabase/seed_firms.sql`, run.
3. **Authentication → Providers → Email**: keep Email enabled with magic link / OTP on
   (the default). No password setup is needed.
4. **Authentication → URL Configuration**: set *Site URL* to where the site will live
   (e.g. `https://baserate.vercel.app`) and add the same URL (and `http://localhost:8000`
   for local testing) under *Redirect URLs*.
5. **Project Settings → API**: copy the *Project URL* and the *anon public* key.

Sign-ups from non-school domains are rejected by a database trigger before the account
exists. Edit the `allowed_domains` table if you need to add a domain.

> Email limits: Supabase's built-in mailer allows only a few emails per hour on the free
> tier. For a 100-person push, set up a custom SMTP sender (Authentication → SMTP Settings)
> with a free Resend or Postmark account; it takes ten minutes and removes the cap.

### 2. Front end
1. Edit `web/config.js`: paste the URL and anon key, set `DEMO: false`.
2. Deploy the `web/` folder as a static site. Easiest: Vercel or Netlify, drag-and-drop
   the folder; or GitHub Pages. No build step.
3. Visit the site, sign in with your own school email, submit a test funnel.

### 3. Make yourself admin
In the SQL editor:
```sql
update public.profiles set is_admin = true where email = 'you@college.harvard.edu';
```
Refresh the site: an **Admin** link appears with the review queue and the research-question
metrics. Delete your test submission before the real launch:
```sql
delete from public.submissions where user_id = (select user_id from public.profiles where email = 'you@college.harvard.edu');
```

## How the gate and the data-quality checks work

* **Give-to-get.** Dashboard RPCs return rows only when `has_access()` is true: the caller
  has an *approved* submission (or is an admin). Pending and rejected users see nothing.
* **Review before unlock.** `finalize_submission()` runs consistency checks and sets flags:
  fewer than 3 applications; no rejections (with ≥5 applications); offer rate above 60%;
  a stage ticked without the previous one; implausible coffee-chat counts. Flagged
  submissions wait for you; unflagged ones wait too unless you switch on *auto-approve* in
  the admin page (recommended once you trust the inflow — it removes a day of friction).
* **Aggregates only.** Every dashboard function is `security definer` and computes over
  approved submissions server-side. Any cell with fewer than `k_anonymity` people
  (default 5) is suppressed; firms under the threshold are pooled into "Other {tier} firms".
  Change `k` in `app_settings` if needed.
* **No names in the data.** `submissions` holds a GPA *band*, booleans, and an outcome —
  no free text about the person. Emails live only in `profiles` and are visible only to
  admins, for support and de-duplication.
* **Row-level security** prevents any signed-in user from reading another user's rows
  even if they call the tables directly with the anon key.

## Running the experiment

1. Pick your 100: finance-club alumni lists, house lists, seniors you know. Record who was
   asked and when (a private spreadsheet is fine; it never goes into the app).
2. Send the message in `outreach.md`. Promise exactly one thing: contributors see the
   aggregate a week later and nobody else does.
3. Day 7: run `supabase/metrics.sql` (or read the tiles on the Admin page) and write down:
   completions out of 100, share with ≥1 rejection, median firms per funnel.
4. Decide. ≥40 and ≥80% and median ≥10 → build the sophomore live tracker next.
   <20 → students will not supply the data; rethink the supply mechanism before anything else.

## Coffee-chat tracking (the behavior the research question measures)

The research question is about behavior change, so the app tracks it:

* **Track chats** (`#/track`): a participant sets a profile once (GPA band, prior internship),
  then logs every coffee-chat request they send: date, firm, requests sent, replies so far.
  They see their requests per week, split into *baseline* and *after* once a sheet date is set,
  and (treatment group only, after unlock) how many went to their high-odds firms.
* **My odds** (`#/odds`): the intervention. For the participant's profile, the first-round rate at
  every firm computed from approved funnels, with fallback to all profiles or the tier when a cell
  has fewer than `k` people, and firms at ≥2× their average marked high odds. Unlocked only for
  treatment participants from their sheet date (or anyone with an approved funnel / admins).
  Comparison participants never see it.
* **Admin → Study readout**: per participant, set group and sheet date; the table shows weekly
  requests at high-odds firms before vs after, the ratio, and pass/fail at 1.25× (≥2 per week if
  baseline was zero), plus the comparison group's drift. Tiles show "x of 10 pass".

Running the five-week test with this app:
1. Weeks 1–2: participants sign in and log (baseline). Collect funnels from upperclassmen in parallel
   and approve them so odds can be computed.
2. Week 3: in Admin → Study readout, set each treatment participant's sheet date to today and the
   comparison participants' to the same date (they still never see odds). Walk each treatment
   participant through their odds sheet in person.
3. Weeks 3–5: participants keep logging. Read the result on the Admin page; `metrics.sql` has the
   same query for the SQL editor.

## Things deliberately not built

Firm-side anything, other roles or schools, LinkedIn scraping, automated reminders, dashboard
polish. Each is downstream of the one question this build answers.
