-- =============================================================================
-- Baserate — database schema for Supabase (Postgres)
-- Run this whole file once in the Supabase SQL editor (Database → SQL → New query)
-- on a fresh project. Then run seed_firms.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Settings
-- -----------------------------------------------------------------------------
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);

insert into public.app_settings (key, value) values
  ('k_anonymity', '5'),            -- any aggregate cell with fewer people than this is suppressed
  ('max_cell_share', '0.5'),       -- ...and any cell where one person contributes more than this share of the rows
  ('current_cycle', 'SA 2027'),    -- label shown on the form; edit as cycles roll over
  ('auto_approve', 'false'),       -- 'true' = unflagged finalized pipelines count immediately
  ('active_window_days', '30'),    -- an unfinalized pipeline unlocks the dashboard if the owner logged
  ('active_min_days', '1')         --   something on at least this many distinct days in this window
on conflict (key) do nothing;

create table if not exists public.allowed_domains (
  domain text primary key
);
insert into public.allowed_domains (domain) values
  ('college.harvard.edu'),
  ('g.harvard.edu'),
  ('fas.harvard.edu'),
  ('harvard.edu')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 1. Restrict sign-ups to allowed email domains
--    (magic-link sign-in creates an auth.users row; this trigger rejects it
--     before it exists if the domain is not on the list)
-- -----------------------------------------------------------------------------
create or replace function public.enforce_allowed_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d text;
begin
  d := lower(split_part(coalesce(new.email, ''), '@', 2));
  if not exists (select 1 from public.allowed_domains where domain = d) then
    raise exception 'Sign-ups are limited to school email addresses.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_allowed_domain on auth.users;
create trigger enforce_allowed_domain
  before insert on auth.users
  for each row execute function public.enforce_allowed_domain();

-- -----------------------------------------------------------------------------
-- 2. Profiles (one per auth user)
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, lower(new.email))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 3. Reference data: firms
-- -----------------------------------------------------------------------------
create table if not exists public.firms (
  id         serial primary key,
  name       text not null unique,
  tier       text not null check (tier in ('Bulge Bracket','Elite Boutique','Middle Market','Other')),
  sort_order int  not null default 100,
  active     boolean not null default true
);

-- -----------------------------------------------------------------------------
-- 4. Pipelines. One per person per cycle: a current recruit logs it live
--    ('in_progress'); someone who finished recruiting fills it in at once. Either
--    way it is finalized, reviewed, and only 'approved' pipelines feed aggregates.
-- -----------------------------------------------------------------------------
create table if not exists public.submissions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null unique references auth.users(id) on delete cascade,
  cycle                    text not null,
  class_year               int  not null check (class_year between 2024 and 2032),
  gpa_band                 text not null check (gpa_band in ('3.9+','3.7-3.89','3.5-3.69','3.3-3.49','<3.3','Prefer not to say')),
  prior_finance_internship boolean not null,
  finance_club_member      boolean not null default false,
  diversity_program        boolean not null default false,   -- e.g. early-insight / diversity pipeline programs
  outcome                  text check (outcome in ('Accepted an IB offer','Had IB offers, chose something else','No IB offer, took another role','No IB offer, still searching','Prefer not to say')),  -- set when finalized
  share_outreach           boolean not null default false,   -- consent: include who-you-contacted details in aggregates
  status                   text not null default 'in_progress' check (status in ('in_progress','pending','approved','rejected')),
  flags                    text[] not null default '{}',
  admin_notes              text,
  finalized_at             timestamptz,
  reviewed_at              timestamptz,
  created_at               timestamptz not null default now()
);

create table if not exists public.submission_firms (
  id              bigserial primary key,
  submission_id   uuid not null references public.submissions(id) on delete cascade,
  firm_id         int references public.firms(id),
  firm_name_other text,                       -- used when firm_id is null ("Other")
  referral        boolean not null default false,
  applied         boolean not null default false,
  first_round     boolean not null default false,
  superday        boolean not null default false,
  offer           boolean not null default false,
  accepted        boolean not null default false,
  closed          text check (closed in ('rejected','withdrew')),   -- null = still open (or ended in an offer)
  applied_on      date,
  first_round_on  date,
  superday_on     date,
  offer_on        date,
  closed_on       date,
  next_on         date,                       -- the owner's next date to watch at this firm
  next_kind       text check (next_kind in ('deadline','first_round','superday','follow_up','decision')),
  updated_at      timestamptz not null default now(),
  constraint firm_or_other check (firm_id is not null or nullif(trim(firm_name_other), '') is not null),
  constraint offer_not_rejected check (not (offer and closed = 'rejected')),
  constraint one_row_per_firm unique (submission_id, firm_id)
);
create index if not exists submission_firms_submission_idx on public.submission_firms(submission_id);
create index if not exists submission_firms_firm_idx on public.submission_firms(firm_id);

-- One row per action at a firm. No free-text fields, so there is nowhere to type a
-- name: contacts are described only by coarse categories.
create table if not exists public.touchpoints (
  id                 bigserial primary key,
  submission_firm_id bigint not null references public.submission_firms(id) on delete cascade,
  kind               text not null check (kind in ('outreach','coffee_chat','info_session','recruiting_event','club_event','other')),
  occurred_on        date,                    -- null = date not recorded (retrospective entries)
  contact_level      text check (contact_level in ('analyst','associate','vp_plus','recruiter')),
  connection         text check (connection in ('school_alum','club_alum','friend_family','none')),
  found_via          text check (found_via in ('alumni_directory','club','info_session','intro','manual_search')),
  replied            boolean,
  led_to_chat        boolean,
  led_to_referral    boolean,
  created_at         timestamptz not null default now(),
  constraint contact_fields_only_for_people check (
    kind in ('outreach','coffee_chat')
    or (contact_level is null and connection is null and found_via is null and replied is null and led_to_chat is null))
);
create index if not exists touchpoints_firm_idx on public.touchpoints(submission_firm_id);

-- The owner's private notes and application link for a firm. Free text (it may name
-- people), so: readable only by the owner (not admins), never used in any aggregate.
create table if not exists public.firm_notes (
  submission_firm_id bigint primary key references public.submission_firms(id) on delete cascade,
  application_url    text check (application_url is null or (application_url ~* '^https?://' and length(application_url) <= 500)),
  notes              text check (notes is null or length(notes) <= 5000),
  updated_at         timestamptz not null default now()
);

-- Days on which each person logged something (drives "actively logging" access).
create table if not exists public.pipeline_activity (
  user_id   uuid not null references auth.users(id) on delete cascade,
  active_on date not null,
  primary key (user_id, active_on)
);

create or replace function public.note_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into public.pipeline_activity (user_id, active_on) values (auth.uid(), current_date)
    on conflict do nothing;
  end if;
  return null;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sf_updated_at on public.submission_firms;
create trigger sf_updated_at before update on public.submission_firms
  for each row execute function public.touch_updated_at();
drop trigger if exists sf_activity on public.submission_firms;
create trigger sf_activity after insert or update on public.submission_firms
  for each statement execute function public.note_activity();
drop trigger if exists tp_activity on public.touchpoints;
create trigger tp_activity after insert or update on public.touchpoints
  for each statement execute function public.note_activity();

-- -----------------------------------------------------------------------------
-- 5. Helpers
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where user_id = auth.uid()), false);
$$;

create or replace function public.setting_int(p_key text, p_default int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value::int from public.app_settings where key = p_key), p_default);
$$;

create or replace function public.k_anon()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select public.setting_int('k_anonymity', 5);
$$;

create or replace function public.max_share()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value::numeric from public.app_settings where key = 'max_cell_share'), 0.5);
$$;

-- Actively logging: an unfinalized pipeline with activity on enough recent days.
create or replace function public.is_active_logger()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.submissions where user_id = auth.uid() and status = 'in_progress')
     and (select count(*) from public.pipeline_activity
           where user_id = auth.uid()
             and active_on > current_date - public.setting_int('active_window_days', 30))
         >= public.setting_int('active_min_days', 1);
$$;

-- Dashboard and odds access: admin, an approved pipeline, or actively logging.
create or replace function public.has_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or exists (select 1 from public.submissions where user_id = auth.uid() and status = 'approved')
      or public.is_active_logger();
$$;

-- -----------------------------------------------------------------------------
-- 6. Row-level security
-- -----------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.submissions       enable row level security;
alter table public.submission_firms  enable row level security;
alter table public.touchpoints       enable row level security;
alter table public.pipeline_activity enable row level security;
alter table public.firm_notes        enable row level security;
alter table public.firms             enable row level security;
alter table public.app_settings      enable row level security;
alter table public.allowed_domains   enable row level security;

-- profiles: see your own; admins see all
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- firms & settings: readable by any signed-in user
drop policy if exists firms_read on public.firms;
create policy firms_read on public.firms for select to authenticated using (true);
drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to authenticated using (true);
drop policy if exists settings_admin_write on public.app_settings;
create policy settings_admin_write on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- submissions: read and delete your own. Creating and editing go through RPCs so
-- nobody can set their own status. Admins read finalized pipelines (not live ones).
drop policy if exists submissions_select_own on public.submissions;
create policy submissions_select_own on public.submissions
  for select to authenticated using (user_id = auth.uid() or (public.is_admin() and status <> 'in_progress'));
drop policy if exists submissions_delete_own on public.submissions;
create policy submissions_delete_own on public.submissions
  for delete to authenticated using (user_id = auth.uid());

-- submission_firms: your own rows; write only while your pipeline is in progress.
-- Admins read rows of finalized pipelines for review.
drop policy if exists sf_select_own on public.submission_firms;
create policy sf_select_own on public.submission_firms
  for select to authenticated using (
    exists (select 1 from public.submissions s where s.id = submission_id
             and (s.user_id = auth.uid() or (public.is_admin() and s.status <> 'in_progress')))
  );
drop policy if exists sf_insert_own on public.submission_firms;
create policy sf_insert_own on public.submission_firms
  for insert to authenticated with check (
    exists (select 1 from public.submissions s where s.id = submission_id and s.user_id = auth.uid() and s.status = 'in_progress')
  );
drop policy if exists sf_update_own on public.submission_firms;
create policy sf_update_own on public.submission_firms
  for update to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id and s.user_id = auth.uid() and s.status = 'in_progress'))
  with check (exists (select 1 from public.submissions s where s.id = submission_id and s.user_id = auth.uid() and s.status = 'in_progress'));
drop policy if exists sf_delete_own on public.submission_firms;
create policy sf_delete_own on public.submission_firms
  for delete to authenticated using (
    exists (select 1 from public.submissions s where s.id = submission_id and s.user_id = auth.uid() and s.status = 'in_progress')
  );

-- touchpoints: only the owner, never admins (admins can see emails, and joining the
-- two would tie a student to their outreach). Delete is allowed at any time.
drop policy if exists tp_select_own on public.touchpoints;
create policy tp_select_own on public.touchpoints
  for select to authenticated using (
    exists (select 1 from public.submission_firms sf join public.submissions s on s.id = sf.submission_id
             where sf.id = submission_firm_id and s.user_id = auth.uid())
  );
drop policy if exists tp_insert_own on public.touchpoints;
create policy tp_insert_own on public.touchpoints
  for insert to authenticated with check (
    exists (select 1 from public.submission_firms sf join public.submissions s on s.id = sf.submission_id
             where sf.id = submission_firm_id and s.user_id = auth.uid() and s.status = 'in_progress')
  );
drop policy if exists tp_update_own on public.touchpoints;
create policy tp_update_own on public.touchpoints
  for update to authenticated
  using (exists (select 1 from public.submission_firms sf join public.submissions s on s.id = sf.submission_id
                  where sf.id = submission_firm_id and s.user_id = auth.uid() and s.status = 'in_progress'))
  with check (exists (select 1 from public.submission_firms sf join public.submissions s on s.id = sf.submission_id
                       where sf.id = submission_firm_id and s.user_id = auth.uid() and s.status = 'in_progress'));
drop policy if exists tp_delete_own on public.touchpoints;
create policy tp_delete_own on public.touchpoints
  for delete to authenticated using (
    exists (select 1 from public.submission_firms sf join public.submissions s on s.id = sf.submission_id
             where sf.id = submission_firm_id and s.user_id = auth.uid())
  );

-- firm_notes: only the owner, at any pipeline status; never admins.
drop policy if exists notes_own on public.firm_notes;
create policy notes_own on public.firm_notes
  for all to authenticated
  using (exists (select 1 from public.submission_firms sf join public.submissions s on s.id = sf.submission_id
                  where sf.id = submission_firm_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.submission_firms sf join public.submissions s on s.id = sf.submission_id
                       where sf.id = submission_firm_id and s.user_id = auth.uid()));

-- pipeline_activity: read your own; written only by the trigger.
drop policy if exists activity_select_own on public.pipeline_activity;
create policy activity_select_own on public.pipeline_activity
  for select to authenticated using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 7. Your pipeline: create/edit, consent, finalize, reopen, delete
-- -----------------------------------------------------------------------------
create or replace function public.upsert_my_pipeline(
  p_cycle text, p_class_year int, p_gpa text, p_intern boolean,
  p_club boolean, p_diversity boolean, p_share_outreach boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_status text;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  select id, status into v_id, v_status from public.submissions where user_id = auth.uid();
  if v_id is null then
    insert into public.submissions (user_id, cycle, class_year, gpa_band, prior_finance_internship,
                                    finance_club_member, diversity_program, share_outreach)
    values (auth.uid(), p_cycle, p_class_year, p_gpa, p_intern, p_club, p_diversity, p_share_outreach)
    returning id into v_id;
  elsif v_status <> 'in_progress' then
    raise exception 'Reopen your pipeline to edit it.';
  else
    update public.submissions
       set cycle = p_cycle, class_year = p_class_year, gpa_band = p_gpa, prior_finance_internship = p_intern,
           finance_club_member = p_club, diversity_program = p_diversity, share_outreach = p_share_outreach
     where id = v_id;
  end if;
  insert into public.pipeline_activity (user_id, active_on) values (auth.uid(), current_date) on conflict do nothing;
  return v_id;
end;
$$;

-- Consent can be given or withdrawn at any time, whatever the pipeline's status.
create or replace function public.set_share_outreach(p_share boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.submissions set share_outreach = p_share where user_id = auth.uid();
$$;

-- Finalize: run consistency checks, set flags, optionally auto-approve.
create or replace function public.finalize_my_pipeline(p_outcome text)
returns table (status text, flags text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id         uuid;
  v_status     text;
  v_flags      text[] := '{}';
  n_rows       int;
  n_applied    int;
  n_offers     int;
  n_rejected   int;   -- applied but no offer
  n_bad_order  int;   -- stage reached without the previous one
  n_bad_dates  int;   -- a stage dated before the previous stage
  n_chats_max  int;
  n_chats_sum  int;
  v_auto       boolean;
begin
  select s.id, s.status into v_id, v_status from public.submissions s where s.user_id = auth.uid();
  if v_id is null then raise exception 'Start a pipeline first.'; end if;
  if v_status <> 'in_progress' then raise exception 'Already finalized.'; end if;
  if p_outcome is null then raise exception 'Say how the cycle ended.'; end if;

  select count(*),
         count(*) filter (where applied),
         count(*) filter (where offer),
         count(*) filter (where applied and not offer),
         count(*) filter (where (offer and not superday) or (superday and not first_round) or (first_round and not applied)),
         count(*) filter (where first_round_on < applied_on or superday_on < first_round_on or offer_on < superday_on)
    into n_rows, n_applied, n_offers, n_rejected, n_bad_order, n_bad_dates
    from public.submission_firms where submission_id = v_id;

  select coalesce(max(n), 0), coalesce(sum(n), 0) into n_chats_max, n_chats_sum
    from (select count(*) as n from public.touchpoints t join public.submission_firms sf on sf.id = t.submission_firm_id
           where sf.submission_id = v_id and t.kind = 'coffee_chat' group by sf.id) c;

  if n_rows = 0 then
    raise exception 'Add at least one firm before submitting.';
  end if;
  if n_applied < 3 then v_flags := array_append(v_flags, 'fewer_than_3_applications'); end if;
  if n_applied >= 5 and n_rejected = 0 then v_flags := array_append(v_flags, 'no_rejections'); end if;
  if n_applied >= 5 and n_offers::numeric / n_applied > 0.6 then v_flags := array_append(v_flags, 'offer_rate_above_60pct'); end if;
  if n_bad_order > 0 then v_flags := array_append(v_flags, 'stage_without_previous_stage'); end if;
  if n_bad_dates > 0 then v_flags := array_append(v_flags, 'stage_dates_out_of_order'); end if;
  if n_chats_max > 15 or n_chats_sum > 60 then v_flags := array_append(v_flags, 'implausible_coffee_chats'); end if;

  select value = 'true' into v_auto from public.app_settings where key = 'auto_approve';

  update public.submissions s
     set outcome = p_outcome,
         flags  = v_flags,
         status = case when coalesce(v_auto, false) and cardinality(v_flags) = 0 then 'approved' else 'pending' end,
         finalized_at = now(),
         reviewed_at = case when coalesce(v_auto, false) and cardinality(v_flags) = 0 then now() else null end
   where s.id = v_id;

  return query select s.status, s.flags from public.submissions s where s.id = v_id;
end;
$$;

-- Back to in progress (to keep logging or fix something). Leaves the aggregates
-- until it is finalized and approved again.
create or replace function public.reopen_my_pipeline()
returns void
language sql
security definer
set search_path = public
as $$
  update public.submissions
     set status = 'in_progress', flags = '{}', finalized_at = null, reviewed_at = null
   where user_id = auth.uid();
$$;

create or replace function public.delete_my_pipeline()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.submissions where user_id = auth.uid();
  delete from public.pipeline_activity where user_id = auth.uid();
$$;

-- -----------------------------------------------------------------------------
-- 8. My status and my own rows
-- -----------------------------------------------------------------------------
create or replace function public.my_status()
returns table (has_submission boolean, status text, has_access boolean, is_admin boolean,
               is_active_logger boolean, share_outreach boolean, submitted_at timestamptz,
               cycle text, class_year int, gpa_band text, prior_finance_internship boolean,
               finance_club_member boolean, diversity_program boolean)
language sql
stable
security definer
set search_path = public
as $$
  select s.id is not null, s.status, public.has_access(), public.is_admin(), public.is_active_logger(),
         coalesce(s.share_outreach, false), s.finalized_at,
         s.cycle, s.class_year, s.gpa_band, s.prior_finance_internship, s.finance_club_member, s.diversity_program
    from (select 1) x left join public.submissions s on s.user_id = auth.uid();
$$;

create or replace function public.my_pipeline()
returns table (
  id bigint, firm_id int, label text, tier text, referral boolean,
  applied boolean, first_round boolean, superday boolean, offer boolean, accepted boolean, closed text,
  applied_on date, first_round_on date, superday_on date, offer_on date, closed_on date,
  next_on date, next_kind text, updated_at timestamptz,
  n_actions int, n_outreach int, n_replied int, last_action_on date,
  application_url text, notes text
)
language sql
stable
security definer
set search_path = public
as $$
  select sf.id, sf.firm_id, coalesce(f.name, sf.firm_name_other), coalesce(f.tier, 'Other'), sf.referral,
         sf.applied, sf.first_round, sf.superday, sf.offer, sf.accepted, sf.closed,
         sf.applied_on, sf.first_round_on, sf.superday_on, sf.offer_on, sf.closed_on,
         sf.next_on, sf.next_kind, sf.updated_at,
         (select count(*)::int from public.touchpoints t where t.submission_firm_id = sf.id),
         (select count(*)::int from public.touchpoints t where t.submission_firm_id = sf.id and t.kind = 'outreach'),
         (select count(*)::int from public.touchpoints t where t.submission_firm_id = sf.id and t.kind = 'outreach' and t.replied),
         (select max(t.occurred_on) from public.touchpoints t where t.submission_firm_id = sf.id),
         n.application_url, n.notes
    from public.submission_firms sf
    join public.submissions s on s.id = sf.submission_id
    left join public.firms f on f.id = sf.firm_id
    left join public.firm_notes n on n.submission_firm_id = sf.id
   where s.user_id = auth.uid()
   order by coalesce(f.sort_order, 1000), 3;
$$;

create or replace function public.my_touchpoints()
returns table (
  id bigint, submission_firm_id bigint, kind text, occurred_on date,
  contact_level text, connection text, found_via text,
  replied boolean, led_to_chat boolean, led_to_referral boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.submission_firm_id, t.kind, t.occurred_on, t.contact_level, t.connection, t.found_via,
         t.replied, t.led_to_chat, t.led_to_referral
    from public.touchpoints t
    join public.submission_firms sf on sf.id = t.submission_firm_id
    join public.submissions s on s.id = sf.submission_id
   where s.user_id = auth.uid()
   order by t.occurred_on desc nulls last, t.id desc;
$$;

-- -----------------------------------------------------------------------------
-- 9. Dashboard aggregates. Only approved pipelines count, only callers with access
--    get rows, and a cell is suppressed when it has fewer than k people or one
--    person contributes more than max_cell_share of its rows.
-- -----------------------------------------------------------------------------

-- Headline numbers
create or replace function public.dash_summary()
returns table (
  n_people int, n_firm_rows int, n_applications int,
  median_applications numeric,
  pct_first_round numeric, pct_superday numeric, pct_offer numeric,
  pct_people_with_offer numeric, n_actions int
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id from public.submissions where status = 'approved'),
       f as (select sf.* from public.submission_firms sf join s on s.id = sf.submission_id),
       per_person as (select submission_id, count(*) filter (where applied) as apps,
                             bool_or(offer) as any_offer
                      from f group by submission_id)
  select (select count(*)::int from s),
         (select count(*)::int from f),
         (select count(*)::int from f where applied),
         (select percentile_cont(0.5) within group (order by apps)::numeric from per_person),
         round(100.0 * (select count(*) from f where first_round) / nullif((select count(*) from f where applied), 0), 1),
         round(100.0 * (select count(*) from f where superday)    / nullif((select count(*) from f where applied), 0), 1),
         round(100.0 * (select count(*) from f where offer)       / nullif((select count(*) from f where applied), 0), 1),
         round(100.0 * (select count(*) from per_person where any_offer) / nullif((select count(*) from per_person), 0), 1),
         (select count(*)::int from public.touchpoints t join f on f.id = t.submission_firm_id)
  where public.has_access()
    and (select count(*) from s) >= public.k_anon()
    and (select max(apps) from per_person) <= public.max_share() * (select sum(apps) from per_person);
$$;

-- What each action is worth: per application, first-round and offer rates with vs
-- without that action at the firm on or before the application date (undated
-- actions count as before). Plus a coffee-chat count breakdown.
create or replace function public.dash_actions()
returns table (action text, action_order int, grp text, grp_order int,
               n_applied int, n_people int, pct_first_round numeric, pct_offer numeric)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id from public.submissions where status = 'approved'),
       a as (select sf.* from public.submission_firms sf join s on s.id = sf.submission_id where sf.applied),
       t as (select tp.submission_firm_id, tp.kind, count(*) as n
               from public.touchpoints tp join a on a.id = tp.submission_firm_id
              where tp.occurred_on is null or a.applied_on is null or tp.occurred_on <= a.applied_on
              group by 1, 2),
       kinds(action, action_order) as (values
         ('coffee_chat', 1), ('outreach', 2), ('info_session', 3), ('recruiting_event', 4), ('club_event', 5), ('referral', 6)),
       cells as (
         select k.action, k.action_order,
                case when has then 'With' else 'Without' end as grp,
                case when has then 1 else 2 end as grp_order,
                x.submission_id, x.first_round, x.offer
           from kinds k cross join a x
           cross join lateral (select (k.action = 'referral' and x.referral)
                                   or exists (select 1 from t where t.submission_firm_id = x.id and t.kind = k.action) as has) h
         union all
         select 'coffee_chat_count', 0,
                case when coalesce(c.n, 0) = 0 then '0 chats' when c.n <= 2 then '1–2 chats' else '3+ chats' end,
                case when coalesce(c.n, 0) = 0 then 1 when c.n <= 2 then 2 else 3 end,
                x.submission_id, x.first_round, x.offer
           from a x left join t c on c.submission_firm_id = x.id and c.kind = 'coffee_chat'),
       per as (select action, grp, submission_id, count(*) as c from cells group by 1, 2, 3),
       ok as (select action, grp from per group by 1, 2
              having count(*) >= public.k_anon() and max(c) <= public.max_share() * sum(c))
  select c.action, c.action_order, c.grp, c.grp_order,
         count(*)::int, count(distinct c.submission_id)::int,
         round(100.0 * count(*) filter (where c.first_round) / count(*), 1),
         round(100.0 * count(*) filter (where c.offer) / count(*), 1)
    from cells c join ok on ok.action = c.action and ok.grp = c.grp
   where public.has_access()
   group by 1, 2, 3, 4
   order by 2, 4;
$$;

-- How long things take, per firm and overall. Each median needs k people behind it.
-- Months are reported as the 25th–75th percentile of when first rounds happened,
-- counted in a recruiting year that starts in August.
create or replace function public.dash_timing()
returns table (label text, tier text, is_overall boolean, n_people int,
               med_days_to_first_round numeric, med_days_to_rejection numeric,
               med_days_first_round_to_superday numeric, med_days_superday_to_offer numeric,
               first_round_month_from int, first_round_month_to int)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id from public.submissions where status = 'approved'),
       a as (select sf.*, fi.name as firm_name, fi.tier as firm_tier
               from public.submission_firms sf join s on s.id = sf.submission_id
               join public.firms fi on fi.id = sf.firm_id
              where sf.applied and sf.applied_on is not null),
       g as (select firm_name as label, firm_tier as tier, false as is_overall, a.* from a
             union all
             select 'All firms', null, true, a.* from a),
       calc as (
         select label, tier, is_overall,
                count(distinct submission_id) as n_people,
                count(distinct submission_id) filter (where first_round_on is not null) as n_fr,
                count(distinct submission_id) filter (where closed = 'rejected' and closed_on is not null) as n_rej,
                count(distinct submission_id) filter (where superday_on is not null and first_round_on is not null) as n_sd,
                count(distinct submission_id) filter (where offer_on is not null and superday_on is not null) as n_of,
                percentile_cont(0.5) within group (order by first_round_on - applied_on) filter (where first_round_on is not null) as d_fr,
                percentile_cont(0.5) within group (order by closed_on - applied_on) filter (where closed = 'rejected' and closed_on is not null) as d_rej,
                percentile_cont(0.5) within group (order by superday_on - first_round_on) filter (where superday_on is not null and first_round_on is not null) as d_sd,
                percentile_cont(0.5) within group (order by offer_on - superday_on) filter (where offer_on is not null and superday_on is not null) as d_of,
                percentile_disc(0.25) within group (order by (extract(month from first_round_on)::int + 4) % 12) filter (where first_round_on is not null) as m_from,
                percentile_disc(0.75) within group (order by (extract(month from first_round_on)::int + 4) % 12) filter (where first_round_on is not null) as m_to
           from g group by label, tier, is_overall)
  select label, tier, is_overall, n_people::int,
         case when n_fr  >= public.k_anon() then round(d_fr::numeric) end,
         case when n_rej >= public.k_anon() then round(d_rej::numeric) end,
         case when n_sd  >= public.k_anon() then round(d_sd::numeric) end,
         case when n_of  >= public.k_anon() then round(d_of::numeric) end,
         case when n_fr  >= public.k_anon() then (m_from + 7) % 12 + 1 end,
         case when n_fr  >= public.k_anon() then (m_to + 7) % 12 + 1 end
    from calc
   where public.has_access() and n_people >= public.k_anon()
   order by is_overall desc, n_people desc, label collate "C";
$$;

-- Who replies: outcomes of outreach by kind of contact, overall (firm_id null) and
-- per firm. Only pipelines whose owner opted in to sharing outreach details count.
create or replace function public.dash_outreach()
returns table (firm_id int, label text, dimension text, value text,
               n_outreach int, n_people int, pct_replied numeric, pct_chat numeric, pct_referral numeric)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id from public.submissions where status = 'approved' and share_outreach),
       o as (select t.*, sf.submission_id, sf.firm_id, fi.name as firm_name
               from public.touchpoints t
               join public.submission_firms sf on sf.id = t.submission_firm_id
               join s on s.id = sf.submission_id
               left join public.firms fi on fi.id = sf.firm_id
              where t.kind = 'outreach'),
       dims as (
         select submission_id, firm_id, firm_name, 'contact_level' as dimension, contact_level as value, replied, led_to_chat, led_to_referral from o where contact_level is not null
         union all
         select submission_id, firm_id, firm_name, 'connection', connection, replied, led_to_chat, led_to_referral from o where connection is not null
         union all
         select submission_id, firm_id, firm_name, 'found_via', found_via, replied, led_to_chat, led_to_referral from o where found_via is not null),
       cells as (
         select 0 as fkey, null::int as firm_id, 'All firms' as label, d.* from (select dimension, value, submission_id, replied, led_to_chat, led_to_referral from dims) d
         union all
         select firm_id, firm_id, firm_name, dimension, value, submission_id, replied, led_to_chat, led_to_referral from dims where firm_id is not null),
       per as (select fkey, dimension, value, submission_id, count(*) as c from cells group by 1, 2, 3, 4),
       ok as (select fkey, dimension, value from per group by 1, 2, 3
              having count(*) >= public.k_anon() and max(c) <= public.max_share() * sum(c))
  select c.firm_id, c.label, c.dimension, c.value,
         count(*)::int, count(distinct c.submission_id)::int,
         round(100.0 * count(*) filter (where c.replied) / count(*), 1),
         round(100.0 * count(*) filter (where c.led_to_chat) / count(*), 1),
         round(100.0 * count(*) filter (where c.led_to_referral) / count(*), 1)
    from cells c join ok on ok.fkey = c.fkey and ok.dimension = c.dimension and ok.value = c.value
   where public.has_access()
   group by c.fkey, c.firm_id, c.label, c.dimension, c.value
   order by c.fkey, c.dimension, 7 desc, c.value collate "C";
$$;

-- -----------------------------------------------------------------------------
-- 10. Odds sheet: first-round rate at every firm for the caller's profile.
--     Fallback order: profile cell → firm (all profiles) → tier → nothing.
--     "High odds" needs a solid (≥k people) firm-level rate at ≥2× the average.
--     odds_for() is internal; callers use my_odds(), which checks access.
-- -----------------------------------------------------------------------------
create or replace function public.odds_for(p_gpa text, p_intern boolean)
returns table (firm_id int, label text, tier text, rate numeric, n int, basis text, is_high boolean, avg_rate numeric, avg_basis text)
language sql stable security definer set search_path = public as $$
  with s as (select id, gpa_band, prior_finance_internship from public.submissions where status = 'approved'),
       r as (select sf.firm_id, sf.first_round, s.id as sid, (s.gpa_band = p_gpa and s.prior_finance_internship = p_intern) as mine
               from public.submission_firms sf join s on s.id = sf.submission_id where sf.applied and sf.firm_id is not null),
       avg_c as (
         select case when count(distinct sid) filter (where mine) >= public.k_anon()
                     then round(100.0 * count(*) filter (where mine and first_round) / nullif(count(*) filter (where mine), 0), 1)
                     when count(distinct sid) >= public.k_anon()
                     then round(100.0 * count(*) filter (where first_round) / nullif(count(*), 0), 1) end as avg_rate,
                case when count(distinct sid) filter (where mine) >= public.k_anon() then 'your profile' else 'all profiles' end as avg_basis
           from r),
       by_firm as (
         select f.id as firm_id, f.name, f.tier,
                count(distinct r.sid) filter (where r.mine) as n_mine, count(distinct r.sid) as n_all,
                round(100.0 * count(r.*) filter (where r.mine and r.first_round) / nullif(count(r.*) filter (where r.mine), 0), 1) as rate_mine,
                round(100.0 * count(r.*) filter (where r.first_round) / nullif(count(r.*), 0), 1) as rate_all
           from public.firms f left join r on r.firm_id = f.id where f.active group by f.id, f.name, f.tier),
       by_tier as (
         select f.tier,
                count(distinct r.sid) filter (where r.mine) as n_mine, count(distinct r.sid) as n_all,
                round(100.0 * count(r.*) filter (where r.mine and r.first_round) / nullif(count(r.*) filter (where r.mine), 0), 1) as rate_mine,
                round(100.0 * count(r.*) filter (where r.first_round) / nullif(count(r.*), 0), 1) as rate_all
           from public.firms f left join r on r.firm_id = f.id group by f.tier),
       pick as (
         select b.firm_id, b.name, b.tier, b.n_all,
                case when b.n_mine >= public.k_anon() then b.rate_mine
                     when b.n_all  >= public.k_anon() then b.rate_all
                     when t.n_mine >= public.k_anon() then t.rate_mine
                     when t.n_all  >= public.k_anon() then t.rate_all end as rate,
                case when b.n_mine >= public.k_anon() then 'your profile'
                     when b.n_all  >= public.k_anon() then 'all profiles'
                     when t.n_all  >= public.k_anon() then 'tier average (too few at this firm)'
                     else 'not enough data' end as basis
           from by_firm b join by_tier t on t.tier = b.tier)
  select p.firm_id, p.name, p.tier, p.rate, p.n_all::int, p.basis,
         (p.n_all >= public.k_anon() and coalesce(p.rate, 0) > 0
           and a.avg_rate is not null and p.rate >= 2 * a.avg_rate) as is_high,
         a.avg_rate, a.avg_basis
    from pick p cross join avg_c a
   order by p.rate desc nulls last, p.n_all desc, p.firm_id;
$$;

create or replace function public.my_odds()
returns table (firm_id int, label text, tier text, rate numeric, n int, basis text, is_high boolean, avg_rate numeric, avg_basis text)
language plpgsql stable security definer set search_path = public as $$
declare s record;
begin
  if not public.has_access() then return; end if;
  select * into s from public.submissions where user_id = auth.uid();
  if s is null then return; end if;
  return query select * from public.odds_for(s.gpa_band, s.prior_finance_internship);
end; $$;

-- -----------------------------------------------------------------------------
-- 11. Admin: review queue (finalized pipelines only; live ones are private)
-- -----------------------------------------------------------------------------
create or replace function public.admin_submissions()
returns table (
  id uuid, email text, cycle text, class_year int, gpa_band text,
  prior_finance_internship boolean, finance_club_member boolean, outcome text,
  status text, flags text[], admin_notes text, created_at timestamptz,
  n_firms int, n_applied int, n_first_round int, n_superday int, n_offer int, total_chats int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, p.email, s.cycle, s.class_year, s.gpa_band,
         s.prior_finance_internship, s.finance_club_member, s.outcome,
         s.status, s.flags, s.admin_notes, s.finalized_at,
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.applied),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.first_round),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.superday),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.offer),
         (select count(*)::int from public.touchpoints t join public.submission_firms f on f.id = t.submission_firm_id
           where f.submission_id = s.id and t.kind = 'coffee_chat')
    from public.submissions s
    join public.profiles p on p.user_id = s.user_id
   where public.is_admin() and s.status <> 'in_progress'
   order by (s.status = 'pending') desc, s.finalized_at desc;
$$;

create or replace function public.admin_set_status(p_submission_id uuid, p_status text, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_status not in ('pending','approved','rejected') then raise exception 'Bad status.'; end if;
  update public.submissions
     set status = p_status, reviewed_at = now(),
         admin_notes = coalesce(p_notes, admin_notes)
   where id = p_submission_id and status <> 'in_progress';
end;
$$;

-- Counts for the admin page
create or replace function public.admin_metrics()
returns table (
  n_in_progress int, n_active int, n_pending int, n_approved int, n_rejected int,
  n_finalized_last_7_days int, pct_with_rejection numeric, median_firms numeric, n_sharing_outreach int
)
language sql
stable
security definer
set search_path = public
as $$
  with per as (
    select s.id, s.user_id, s.status, s.finalized_at, s.share_outreach,
           count(f.*) as n_firms,
           bool_or(f.applied and not f.offer) as has_rejection
      from public.submissions s
      left join public.submission_firms f on f.submission_id = s.id
     group by s.id),
       active as (
    select user_id from public.pipeline_activity
     where active_on > current_date - public.setting_int('active_window_days', 30)
     group by user_id having count(*) >= public.setting_int('active_min_days', 1))
  select count(*) filter (where status = 'in_progress')::int,
         count(*) filter (where status = 'in_progress' and user_id in (select user_id from active))::int,
         count(*) filter (where status = 'pending')::int,
         count(*) filter (where status = 'approved')::int,
         count(*) filter (where status = 'rejected')::int,
         count(*) filter (where finalized_at > now() - interval '7 days')::int,
         round(100.0 * count(*) filter (where status <> 'in_progress' and has_rejection) / nullif(count(*) filter (where status <> 'in_progress'), 0), 1),
         percentile_cont(0.5) within group (order by n_firms) filter (where status <> 'in_progress')::numeric,
         count(*) filter (where share_outreach and status <> 'in_progress')::int
    from per
   where public.is_admin();
$$;

-- Admin password: a signed-in user who enters it becomes admin. Checked server-side
-- against a salted hash nobody can read; 5 wrong tries per hour per account.
-- Set or change it in the SQL editor: select public.set_admin_password('...');
create table if not exists public.admin_secret (
  id   int primary key default 1 check (id = 1),
  salt text not null,
  hash text not null
);
create table if not exists public.admin_unlock_attempts (
  user_id      uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
alter table public.admin_secret          enable row level security;
alter table public.admin_unlock_attempts enable row level security;

create or replace function public.set_admin_password(p_password text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.admin_secret (id, salt, hash)
  select 1, x.salt, encode(sha256(convert_to(x.salt || p_password, 'UTF8')), 'hex')
    from (select gen_random_uuid()::text as salt) x
  on conflict (id) do update set salt = excluded.salt, hash = excluded.hash;
$$;

create or replace function public.unlock_admin(p_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if (select count(*) from public.admin_unlock_attempts
       where user_id = auth.uid() and attempted_at > now() - interval '1 hour') >= 5 then
    raise exception 'Too many wrong tries. Wait an hour.';
  end if;
  select * into s from public.admin_secret where id = 1;
  if s is not null and encode(sha256(convert_to(s.salt || coalesce(p_password, ''), 'UTF8')), 'hex') = s.hash then
    update public.profiles set is_admin = true where user_id = auth.uid();
    return true;
  end if;
  insert into public.admin_unlock_attempts (user_id) values (auth.uid());
  return false;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Grants (Supabase: authenticated role calls RPCs; anon gets nothing).
--     Supabase grants table privileges to anon/authenticated by default, so they
--     are revoked here and RLS is the second line.
-- -----------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;

grant execute on function public.is_admin()                      to authenticated;
grant execute on function public.has_access()                    to authenticated;
grant execute on function public.upsert_my_pipeline(text, int, text, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.set_share_outreach(boolean)     to authenticated;
grant execute on function public.finalize_my_pipeline(text)      to authenticated;
grant execute on function public.reopen_my_pipeline()            to authenticated;
grant execute on function public.delete_my_pipeline()            to authenticated;
grant execute on function public.my_status()                     to authenticated;
grant execute on function public.my_pipeline()                   to authenticated;
grant execute on function public.my_touchpoints()                to authenticated;
grant execute on function public.dash_summary()                  to authenticated;
grant execute on function public.dash_actions()                  to authenticated;
grant execute on function public.dash_timing()                   to authenticated;
grant execute on function public.dash_outreach()                 to authenticated;
grant execute on function public.my_odds()                       to authenticated;
grant execute on function public.admin_submissions()             to authenticated;
grant execute on function public.admin_set_status(uuid, text, text) to authenticated;
grant execute on function public.admin_metrics()                 to authenticated;
grant execute on function public.unlock_admin(text)              to authenticated;

grant usage on schema public to authenticated;
grant select on public.firms, public.app_settings, public.profiles, public.submissions,
                public.submission_firms, public.touchpoints, public.pipeline_activity to authenticated;
grant insert, update, delete on public.submission_firms, public.touchpoints, public.firm_notes to authenticated;
grant select on public.firm_notes to authenticated;
grant delete on public.submissions to authenticated;
grant update on public.app_settings to authenticated;
grant usage, select on all sequences in schema public to authenticated;
