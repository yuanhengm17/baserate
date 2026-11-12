# Baserate

Investment-banking recruiting is asynchronous and fragmented: dozens of firms, each with its own
timeline, and a long trail of coffee chats, info sessions and outreach that may or may not matter.
Baserate does two things:

1. **A pipeline tracker.** Current recruits log every firm, each stage with dates, and each action
   (outreach, coffee chats, info sessions, firm and club events). The board shows where each firm
   stands; "Needs attention" shows upcoming deadlines and interviews, and firms that have gone quiet
   for longer than they usually take.
2. **Base rates from people who went through it.** Finished pipelines are reviewed and pooled into an
   anonymized dashboard: what each action is worth, when firms move, which kinds of contacts reply,
   and a personal odds sheet.

```
baserate/
├── web/                 static front end (no build step)
│   ├── index.html
│   ├── app.js           routes, pipeline, dashboard, odds, admin; talks to Supabase
│   ├── demo-backend.js  synthetic in-browser data for previews (DEMO mode)
│   ├── styles.css
│   ├── events.js        TEMPORARY pilot event log to a Google Sheet
│   ├── favicon.svg
│   ├── _redirects       Netlify short links (/tt, /dm, /rc) that add a ?src= tag
│   └── config.js        ← paste your Supabase URL + anon key here
├── tracking/Code.gs     Apps Script for that Sheet (logger + report)
└── supabase/
    ├── schema.sql       tables, auth domain restriction, RLS, flags, aggregate RPCs
    └── seed_firms.sql   ~45 IB firms by tier
```

## Preview right now (no setup)

`cd web && python3 -m http.server 8000`, then open http://localhost:8000.
`config.js` ships with `DEMO: true`, so you get synthetic data from 90 pipelines and instant sign-in
with any email. On the pipeline page, "Demo: load a sample pipeline" fills the board. On the home
page, "Enter admin mode" opens the review queue. Nothing is saved anywhere except your browser.

## What a user sees

* **Sign in**: school email → a sign-in code arrives by email → type it in. There's no password and no
  link, because school mail scanners (Microsoft Safe Links) open sign-in links first and use them up.
* **First run**: one screen. Tap the firms you're recruiting for ("Select all" per tier) and answer the
  two questions the odds use (GPA band, prior internship). The board opens with those firms.
* **Pipeline** (`#/pipeline`): a one-line summary, what needs attention (next steps, overdue items,
  firms slower than usual), a board with one card per firm by stage, and the last few actions. Each card has a
  one-tap button for the next stage. Click a firm to set its stage or log today's coffee chat, outreach
  or event in one tap. Folded below: dates, a next step, a link to the application page, private notes
  (only you can see those; they are never shared or counted), and a form to log who you contacted. Settings (sharing, profile, finish
  your cycle, delete) are folded away at the bottom.
* **Add your whole cycle** (`#/submit`): for students who already finished: one table row per firm.
* **What works** (`#/dashboard`): three sections only:
  - which actions help (first-round rate with vs without each action);
  - who replies to outreach (reply rate by connection, seniority and how they were found; all firms
    or one firm);
  - how long firms take (typical days to a first round or rejection, and the months first rounds
    happen).
* **Locked preview.** Without access, "What works" and "My odds" show a blurred placeholder (fixed
  text, not data) with one step to unlock: sign up, start a pipeline, log something, or wait for review.
* **My odds** (`#/odds`): your own firms first, each with its first-round rate. Below that, firms
  you haven't added where students with your profile reach first rounds at twice the usual rate,
  with the best kind of contact to try there and a button to add the firm. Every other firm is
  folded away under "Other firms", so nobody sees odds for firms they chose to skip unless they
  open it. With no finished cycles yet, a note says so above your firms. The same rate shows when
  you open a firm on your pipeline.

## Privacy and access rules

* **Give-to-get.** The dashboard and odds are visible to admins, to anyone with an approved pipeline,
  and to anyone *actively logging*: an unfinished pipeline with something logged in the last 30 days.
  `active_window_days` and `active_min_days` in `app_settings` control this.
* **Only reviewed data counts.** Live pipelines never enter the totals. Finishing a pipeline runs
  consistency checks (`finalize_my_pipeline()`):
  - fewer than 3 applications;
  - no rejections with 5 or more applications;
  - offer rate above 60%;
  - a stage ticked without the previous one;
  - stage dates out of order;
  - implausible coffee-chat counts.

  Flagged pipelines wait for you. Unflagged ones wait too unless you switch on *auto-approve* on the
  admin page.
* **Aggregates only.** Every dashboard function is `security definer` and computes over approved
  pipelines server-side. A number is hidden when fewer than `k_anonymity` people (default 5) are
  behind it, or when one person makes up more than `max_cell_share` (default 50%) of its rows. Firms
  below the threshold are pooled into "Other {tier} firms".
* **No names, no contact directory.** Contacts are recorded only as categories (seniority, connection,
  how found) and there are no free-text fields. These outreach details enter the totals only for people
  who tick the opt-in box. They can untick it or delete any action at any time, and the totals update
  immediately. Firms and stages count either way.
* **Admins see less.** Admins review finished pipelines (email, profile, firm stages, flags). They
  never see live pipelines, and they cannot read the outreach log at all.
* **Users cannot set their own status.** Pipelines are created and edited through RPCs. Row-level
  security covers every table, and direct table privileges are revoked from `anon`.
* **Deletion.** "Delete my pipeline" removes every firm, action and activity record.

## Deploy for real (about 30 minutes)

`schema.sql` is written for a **fresh** Supabase project.

### 1. Supabase project
1. Create a free project at supabase.com. Pick a region near you.
2. **SQL Editor → New query**: paste all of `supabase/schema.sql`, run. Then paste
   `supabase/seed_firms.sql`, run.
3. **Project Settings → API**: copy the *Project URL* and the *anon public* key.

Sign-ups from non-school domains are rejected by a database trigger before the account
exists. Edit the `allowed_domains` table if you need to add a domain.

### 2. Make sign-in emails carry a code
Supabase's default emails contain a link. This app needs the code instead.
1. **Authentication → Emails → Templates**, edit both **Magic Link** and **Confirm signup**
   (new students get the second one). Set each subject to `Your Baserate sign-in code` and the body to:
   ```html
   <p>Your Baserate sign-in code is:</p>
   <h2>{{ .Token }}</h2>
   <p>It expires in one hour. If you didn't ask for it, ignore this email.</p>
   ```
2. **Authentication → Providers → Email**: keep Email enabled. If there's an *Email OTP length*
   setting, the page accepts any length from 6 to 10 digits.
3. **Authentication → URL Configuration**: set *Site URL* to where the site will live.

### 3. Set up an email sender (required)
Supabase's built-in mailer only delivers to members of your Supabase team, and only a few
emails an hour. Real students won't get codes until you add your own sender:
1. Create a free account at Resend (or Postmark), verify a domain you control, and create an SMTP
   key.
2. **Authentication → Emails → SMTP Settings**: enable custom SMTP and paste the host, port,
   username, password and a sender address on that domain.
3. **Authentication → Rate Limits**: raise *emails per hour* to fit your launch (e.g. 100).

### 4. Front end
1. Edit `web/config.js`: paste the URL and anon key, set `DEMO: false`. If `DEMO` is false but a key
   is missing, every page shows a "Not connected yet" banner and the site keeps running the demo.
2. Deploy the `web/` folder as a static site. Easiest: Vercel or Netlify, drag-and-drop
   the folder; or GitHub Pages. No build step.
3. Visit the site, sign in with your own school email, and check that the code arrives.

### 5. Make yourself admin
Set an admin password once in the SQL editor (it is stored only as a salted hash):
```sql
select public.set_admin_password('your-password');
```
Then sign in, click **Admin** in the footer, and enter it. Five wrong tries lock that account out of
the admin page for an hour. Or skip the password and flag yourself directly:
```sql
update public.profiles set is_admin = true where email = 'you@college.harvard.edu';
```
Admins see the review queue (emails, profiles, firm stages, flags of finished cycles); never live
pipelines, outreach logs or notes. To remove a test pipeline, use
"Delete my pipeline" on the pipeline page, or:
```sql
delete from public.submissions where user_id = (select user_id from public.profiles where email = 'you@college.harvard.edu');
```

### Measure where sign-ups come from
Add `?src=<tag>` to every link you post, one tag per place (`?src=sidechat`, `?src=hfac_groupchat`,
`?src=peer_yourname`). The admin page has a link builder. The first tag a visitor arrives with is
kept in their browser and saved on their account when they sign up (`profiles.signup_source`; an
untagged link from another site is saved as `ref:<site>`). "Where sign-ups come from" on the admin
page counts, per tag, how many signed up, started a pipeline, are logging now, finished and were
approved. Counts only; no per-person view. On Netlify, `/tt`, `/dm` and `/rc` redirect to the TikTok
tags.

### Pilot event log (temporary)
While the pilot is just the team and friends, `web/events.js` posts every visit, page view and action
(with a browser visitor ID, the `?src=` tag, and the email once signed in) to a Google Sheet. The
footer tells visitors. To set up your own Sheet: make a new Google Sheet, open **Extensions → Apps
Script**, paste in `tracking/Code.gs`, then **Deploy → New deployment → Web app** (execute as *Me*,
access *Anyone*). Paste the `/exec` URL into `EVENTS_URL` in `web/config.js`. In the Sheet,
**Baserate → Refresh report** builds per-source totals. The admin page's "Event log" fold shows what
this browser sent and can reset your visitor ID after testing. Set `EVENTS_URL` to `""` to stop
logging; delete `events.js` and `tracking/` to remove it.

### Settings (`app_settings`)
| key | default | meaning |
|---|---|---|
| `k_anonymity` | 5 | minimum people behind any number shown |
| `max_cell_share` | 0.5 | maximum share of a number's rows from one person |
| `active_window_days` | 30 | window for "actively logging" access |
| `active_min_days` | 1 | distinct days with activity needed in that window |
| `auto_approve` | false | approve unflagged finished pipelines immediately |
| `current_cycle` | SA 2027 | default cycle label on the forms |

## Things deliberately not built

Firm-side anything, other roles or schools, LinkedIn scraping or automation, a directory of individual
contacts, automated reminders by email.
