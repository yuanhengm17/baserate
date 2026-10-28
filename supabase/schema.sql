-- =============================================================================
-- Baserate MVP — database schema for Supabase (Postgres)
-- Run this whole file once in the Supabase SQL editor (Database → SQL → New query).
-- Then run seed_firms.sql.
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
  ('current_cycle', 'SA 2027'),    -- label shown on the form; edit as cycles roll over
  ('auto_approve', 'false')        -- 'true' = unflagged submissions unlock the dashboard immediately
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
-- 4. Submissions (one funnel per person) and per-firm rows
-- -----------------------------------------------------------------------------
create table if not exists public.submissions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null unique references auth.users(id) on delete cascade,
  cycle                    text not null,
  class_year               int  not null check (class_year between 2024 and 2032),
  gpa_band                 text not null check (gpa_band in ('3.9+','3.7-3.89','3.5-3.69','3.3-3.49','<3.3','Prefer not to say')),
  prior_finance_internship boolean not null,
  finance_club_member      boolean not null,
  diversity_program        boolean not null default false,   -- e.g. early-insight / diversity pipeline programs
  outcome                  text not null check (outcome in ('Accepted an IB offer','Had IB offers, chose something else','No IB offer, took another role','No IB offer, still searching','Prefer not to say')),
  status                   text not null default 'pending' check (status in ('pending','approved','rejected')),
  flags                    text[] not null default '{}',
  admin_notes              text,
  reviewed_at              timestamptz,
  created_at               timestamptz not null default now()
);

create table if not exists public.submission_firms (
  id              bigserial primary key,
  submission_id   uuid not null references public.submissions(id) on delete cascade,
  firm_id         int references public.firms(id),
  firm_name_other text,                       -- used when firm_id is null ("Other")
  coffee_chats    int  not null default 0 check (coffee_chats between 0 and 50),
  referral        boolean not null default false,
  applied         boolean not null default false,
  first_round     boolean not null default false,
  superday        boolean not null default false,
  offer           boolean not null default false,
  accepted        boolean not null default false,
  constraint firm_or_other check (firm_id is not null or nullif(trim(firm_name_other), '') is not null)
);
create index if not exists submission_firms_submission_idx on public.submission_firms(submission_id);
create index if not exists submission_firms_firm_idx on public.submission_firms(firm_id);

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

-- Dashboard access: approved submission OR admin
create or replace function public.has_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or exists (select 1 from public.submissions
                 where user_id = auth.uid() and status = 'approved');
$$;

create or replace function public.k_anon()
returns int
language sql
stable
as $$
  select coalesce((select value::int from public.app_settings where key = 'k_anonymity'), 5);
$$;

-- -----------------------------------------------------------------------------
-- 6. Row-level security
-- -----------------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.submissions      enable row level security;
alter table public.submission_firms enable row level security;
alter table public.firms            enable row level security;
alter table public.app_settings     enable row level security;
alter table public.allowed_domains  enable row level security;

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

-- submissions: insert/select your own; admins select/update all
drop policy if exists submissions_insert_own on public.submissions;
create policy submissions_insert_own on public.submissions
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists submissions_select_own on public.submissions;
create policy submissions_select_own on public.submissions
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists submissions_admin_update on public.submissions;
create policy submissions_admin_update on public.submissions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- submission_firms: insert/select rows that belong to your own submission; admins select all
drop policy if exists sf_insert_own on public.submission_firms;
create policy sf_insert_own on public.submission_firms
  for insert to authenticated with check (
    exists (select 1 from public.submissions s where s.id = submission_id and s.user_id = auth.uid())
  );
drop policy if exists sf_select_own on public.submission_firms;
create policy sf_select_own on public.submission_firms
  for select to authenticated using (
    public.is_admin() or
    exists (select 1 from public.submissions s where s.id = submission_id and s.user_id = auth.uid())
  );

-- -----------------------------------------------------------------------------
-- 7. Finalize a submission: run consistency checks, set flags, optionally auto-approve
--    The client calls this once after inserting the submission and its firm rows.
-- -----------------------------------------------------------------------------
create or replace function public.finalize_submission(p_submission_id uuid)
returns table (status text, flags text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flags      text[] := '{}';
  n_rows       int;
  n_applied    int;
  n_offers     int;
  n_rejected   int;   -- applied but no offer
  n_bad_order  int;   -- stage reached without the previous one
  n_chats_max  int;
  n_chats_sum  int;
  v_auto       boolean;
  v_owner      uuid;
begin
  select user_id into v_owner from public.submissions where id = p_submission_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Not your submission.';
  end if;

  select count(*),
         count(*) filter (where applied),
         count(*) filter (where offer),
         count(*) filter (where applied and not offer),
         count(*) filter (where (offer and not superday) or (superday and not first_round) or (first_round and not applied)),
         coalesce(max(coffee_chats), 0),
         coalesce(sum(coffee_chats), 0)
    into n_rows, n_applied, n_offers, n_rejected, n_bad_order, n_chats_max, n_chats_sum
    from public.submission_firms where submission_id = p_submission_id;

  if n_rows = 0 then
    raise exception 'Add at least one firm before submitting.';
  end if;
  if n_applied < 3 then v_flags := array_append(v_flags, 'fewer_than_3_applications'); end if;
  if n_applied >= 5 and n_rejected = 0 then v_flags := array_append(v_flags, 'no_rejections'); end if;
  if n_applied >= 5 and n_offers::numeric / n_applied > 0.6 then v_flags := array_append(v_flags, 'offer_rate_above_60pct'); end if;
  if n_bad_order > 0 then v_flags := array_append(v_flags, 'stage_without_previous_stage'); end if;
  if n_chats_max > 15 or n_chats_sum > 60 then v_flags := array_append(v_flags, 'implausible_coffee_chats'); end if;

  select value = 'true' into v_auto from public.app_settings where key = 'auto_approve';

  update public.submissions s
     set flags  = v_flags,
         status = case when coalesce(v_auto, false) and cardinality(v_flags) = 0 then 'approved' else 'pending' end,
         reviewed_at = case when coalesce(v_auto, false) and cardinality(v_flags) = 0 then now() else null end
   where s.id = p_submission_id;

  return query select s.status, s.flags from public.submissions s where s.id = p_submission_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. My status (what the gate screen shows)
-- -----------------------------------------------------------------------------
create or replace function public.my_status()
returns table (has_submission boolean, status text, has_access boolean, is_admin boolean, submitted_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.submissions where user_id = auth.uid()),
         (select s.status from public.submissions s where s.user_id = auth.uid()),
         public.has_access(),
         public.is_admin(),
         (select s.created_at from public.submissions s where s.user_id = auth.uid());
$$;

-- -----------------------------------------------------------------------------
-- 9. Dashboard aggregates — only approved submissions count, only callers with
--    access get rows, and any cell with fewer than k people is suppressed.
-- -----------------------------------------------------------------------------

-- Headline numbers
create or replace function public.dash_summary()
returns table (
  n_people int, n_firm_rows int, n_applications int,
  median_applications numeric,
  pct_first_round numeric, pct_superday numeric, pct_offer numeric,
  pct_people_with_offer numeric
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
  select case when public.has_access() then (select count(*)::int from s) end,
         case when public.has_access() then (select count(*)::int from f) end,
         case when public.has_access() then (select count(*)::int from f where applied) end,
         case when public.has_access() then (select percentile_cont(0.5) within group (order by apps)::numeric from per_person) end,
         case when public.has_access() then round(100.0 * (select count(*) from f where first_round) / nullif((select count(*) from f where applied), 0), 1) end,
         case when public.has_access() then round(100.0 * (select count(*) from f where superday)    / nullif((select count(*) from f where applied), 0), 1) end,
         case when public.has_access() then round(100.0 * (select count(*) from f where offer)       / nullif((select count(*) from f where applied), 0), 1) end,
         case when public.has_access() then round(100.0 * (select count(*) from per_person where any_offer) / nullif((select count(*) from per_person), 0), 1) end
  where public.has_access() and (select count(*) from s) >= public.k_anon();
$$;

-- Per-firm funnel (firms with fewer than k applicants are rolled into their tier)
create or replace function public.dash_firms()
returns table (
  label text, tier text, is_tier_rollup boolean,
  n_applied int, n_first_round int, n_superday int, n_offer int,
  avg_chats_offer numeric, avg_chats_no_offer numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id from public.submissions where status = 'approved'),
       f as (select sf.*, coalesce(fi.name, 'Other') as firm_name, coalesce(fi.tier, 'Other') as firm_tier
               from public.submission_firms sf
               join s on s.id = sf.submission_id
               left join public.firms fi on fi.id = sf.firm_id
              where sf.applied),
       by_firm as (
         select firm_name, firm_tier,
                count(*)::int as n_applied,
                count(*) filter (where first_round)::int as n_first_round,
                count(*) filter (where superday)::int as n_superday,
                count(*) filter (where offer)::int as n_offer,
                round(avg(coffee_chats) filter (where offer), 1) as avg_chats_offer,
                round(avg(coffee_chats) filter (where not offer), 1) as avg_chats_no_offer
           from f group by firm_name, firm_tier),
       shown as (
         select firm_name as label, firm_tier as tier, false as is_tier_rollup,
                n_applied, n_first_round, n_superday, n_offer, avg_chats_offer, avg_chats_no_offer
           from by_firm where n_applied >= public.k_anon()),
       rolled as (
         select 'Other ' || firm_tier || ' firms (small cells pooled)' as label, firm_tier as tier, true as is_tier_rollup,
                sum(n_applied)::int as n_applied, sum(n_first_round)::int as n_first_round,
                sum(n_superday)::int as n_superday, sum(n_offer)::int as n_offer,
                null::numeric as avg_chats_offer, null::numeric as avg_chats_no_offer
           from by_firm where n_applied < public.k_anon() group by firm_tier
         having sum(n_applied) >= public.k_anon())
  select * from (select * from shown union all select * from rolled) u
   where public.has_access()
   order by is_tier_rollup, tier, n_applied desc;
$$;

-- Networking effect: conversion by coffee-chat bucket, across all firm rows
create or replace function public.dash_networking()
returns table (
  bucket text, bucket_order int, n_applied int,
  pct_first_round numeric, pct_superday numeric, pct_offer numeric, n_people int
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id from public.submissions where status = 'approved'),
       f as (select sf.*,
                    case when coffee_chats = 0 then '0 chats'
                         when coffee_chats <= 2 then '1–2 chats'
                         else '3+ chats' end as bucket,
                    case when coffee_chats = 0 then 0 when coffee_chats <= 2 then 1 else 2 end as bucket_order
               from public.submission_firms sf join s on s.id = sf.submission_id
              where sf.applied)
  select bucket, bucket_order, count(*)::int,
         round(100.0 * count(*) filter (where first_round) / count(*), 1),
         round(100.0 * count(*) filter (where superday)    / count(*), 1),
         round(100.0 * count(*) filter (where offer)       / count(*), 1),
         count(distinct submission_id)::int
    from f
   where public.has_access()
   group by bucket, bucket_order
  having count(distinct submission_id) >= public.k_anon()
   order by bucket_order;
$$;

-- Referral effect
create or replace function public.dash_referral()
returns table (label text, n_applied int, pct_first_round numeric, pct_offer numeric, n_people int)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id from public.submissions where status = 'approved'),
       f as (select sf.* from public.submission_firms sf join s on s.id = sf.submission_id where sf.applied)
  select case when referral then 'With referral' else 'No referral' end,
         count(*)::int,
         round(100.0 * count(*) filter (where first_round) / count(*), 1),
         round(100.0 * count(*) filter (where offer) / count(*), 1),
         count(distinct submission_id)::int
    from f
   where public.has_access()
   group by referral
  having count(distinct submission_id) >= public.k_anon()
   order by 1;
$$;

-- Profile effect: by GPA band and by prior internship (per-person outcomes)
create or replace function public.dash_profile()
returns table (dimension text, label text, label_order int, n_people int, pct_people_first_round numeric, pct_people_offer numeric, avg_applications numeric)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select * from public.submissions where status = 'approved'),
       pp as (select s.id, s.gpa_band, s.prior_finance_internship,
                     bool_or(sf.first_round) as any_fr, bool_or(sf.offer) as any_offer,
                     count(*) filter (where sf.applied) as apps
                from s join public.submission_firms sf on sf.submission_id = s.id
               group by s.id, s.gpa_band, s.prior_finance_internship),
       gpa as (
         select 'GPA band'::text as dimension, gpa_band as label,
                case gpa_band when '3.9+' then 1 when '3.7-3.89' then 2 when '3.5-3.69' then 3 when '3.3-3.49' then 4 when '<3.3' then 5 else 9 end as label_order,
                count(*)::int as n_people,
                round(100.0 * count(*) filter (where any_fr) / count(*), 1) as pct_fr,
                round(100.0 * count(*) filter (where any_offer) / count(*), 1) as pct_offer,
                round(avg(apps), 1) as avg_apps
           from pp group by gpa_band),
       intern as (
         select 'Prior finance internship'::text, case when prior_finance_internship then 'Yes' else 'No' end,
                case when prior_finance_internship then 1 else 2 end,
                count(*)::int,
                round(100.0 * count(*) filter (where any_fr) / count(*), 1),
                round(100.0 * count(*) filter (where any_offer) / count(*), 1),
                round(avg(apps), 1)
           from pp group by prior_finance_internship)
  select * from (select * from gpa union all select * from intern) u
   where public.has_access() and n_people >= public.k_anon()
   order by dimension, label_order;
$$;

-- -----------------------------------------------------------------------------
-- 10. Admin: review queue
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
         s.status, s.flags, s.admin_notes, s.created_at,
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.applied),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.first_round),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.superday),
         (select count(*)::int from public.submission_firms f where f.submission_id = s.id and f.offer),
         (select coalesce(sum(coffee_chats),0)::int from public.submission_firms f where f.submission_id = s.id)
    from public.submissions s
    join public.profiles p on p.user_id = s.user_id
   where public.is_admin()
   order by (s.status = 'pending') desc, s.created_at desc;
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
   where id = p_submission_id;
end;
$$;

-- Research-question metrics (admin only): completion count, rejection share, median firms
create or replace function public.admin_metrics()
returns table (
  n_submitted int, n_approved int, n_pending int, n_rejected int,
  pct_with_rejection numeric, median_firms numeric, median_applied numeric,
  n_last_7_days int
)
language sql
stable
security definer
set search_path = public
as $$
  with per as (
    select s.id, s.status, s.created_at,
           count(f.*) as n_firms,
           count(f.*) filter (where f.applied) as n_applied,
           bool_or(f.applied and not f.offer) as has_rejection
      from public.submissions s
      left join public.submission_firms f on f.submission_id = s.id
     group by s.id, s.status, s.created_at)
  select count(*)::int,
         count(*) filter (where status = 'approved')::int,
         count(*) filter (where status = 'pending')::int,
         count(*) filter (where status = 'rejected')::int,
         round(100.0 * count(*) filter (where has_rejection) / nullif(count(*), 0), 1),
         percentile_cont(0.5) within group (order by n_firms)::numeric,
         percentile_cont(0.5) within group (order by n_applied)::numeric,
         count(*) filter (where created_at > now() - interval '7 days')::int
    from per
   where public.is_admin();
$$;

-- -----------------------------------------------------------------------------
-- 11. Grants (Supabase: authenticated role calls RPCs; anon gets nothing)
-- -----------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon;
grant execute on function public.finalize_submission(uuid)       to authenticated;
grant execute on function public.my_status()                     to authenticated;
grant execute on function public.dash_summary()                  to authenticated;
grant execute on function public.dash_firms()                    to authenticated;
grant execute on function public.dash_networking()               to authenticated;
grant execute on function public.dash_referral()                 to authenticated;
grant execute on function public.dash_profile()                  to authenticated;
grant execute on function public.admin_submissions()             to authenticated;
grant execute on function public.admin_set_status(uuid, text, text) to authenticated;
grant execute on function public.admin_metrics()                 to authenticated;
grant execute on function public.is_admin()                      to authenticated;
grant execute on function public.has_access()                    to authenticated;
grant execute on function public.k_anon()                        to authenticated;

grant usage on schema public to authenticated;
grant select on public.firms, public.app_settings, public.profiles, public.submissions, public.submission_firms to authenticated;
grant insert on public.submissions, public.submission_firms to authenticated;
grant update on public.submissions, public.app_settings to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- =============================================================================
-- 12. Coffee-chat tracking (the behavior the research question measures)
-- =============================================================================

-- One tracker per participant: their profile (drives the odds sheet), study group,
-- and the date the odds sheet was shown (post period starts). Admin sets group/date.
create table if not exists public.trackers (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  gpa_band                 text not null check (gpa_band in ('3.9+','3.7-3.89','3.5-3.69','3.3-3.49','<3.3')),
  prior_finance_internship boolean not null,
  study_group              text not null default 'treatment' check (study_group in ('treatment','comparison')),
  sheet_shown_on           date,
  created_at               timestamptz not null default now()
);

create table if not exists public.chat_logs (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  firm_id         int references public.firms(id),
  firm_name_other text,
  logged_on       date not null default current_date,
  requests        int not null default 1 check (requests between 1 and 20),
  replies         int not null default 0 check (replies between 0 and 20),
  created_at      timestamptz not null default now(),
  constraint chat_firm_or_other check (firm_id is not null or nullif(trim(firm_name_other), '') is not null)
);
create index if not exists chat_logs_user_idx on public.chat_logs(user_id, logged_on);

alter table public.trackers  enable row level security;
alter table public.chat_logs enable row level security;

drop policy if exists trackers_select on public.trackers;
create policy trackers_select on public.trackers for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists chat_select on public.chat_logs;
create policy chat_select on public.chat_logs for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists chat_insert on public.chat_logs;
create policy chat_insert on public.chat_logs for insert to authenticated with check (user_id = auth.uid());
drop policy if exists chat_delete on public.chat_logs;
create policy chat_delete on public.chat_logs for delete to authenticated using (user_id = auth.uid());

-- Participants may only set their own profile; group and date are admin-only.
create or replace function public.upsert_my_tracker(p_gpa text, p_intern boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.trackers (user_id, gpa_band, prior_finance_internship)
  values (auth.uid(), p_gpa, p_intern)
  on conflict (user_id) do update set gpa_band = excluded.gpa_band, prior_finance_internship = excluded.prior_finance_internship;
end; $$;

create or replace function public.admin_set_tracker(p_user_id uuid, p_group text, p_sheet_date date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  update public.trackers set study_group = p_group, sheet_shown_on = p_sheet_date where user_id = p_user_id;
end; $$;

-- Odds for a profile, from approved funnels. Fallback order: profile cell → firm (all
-- profiles) → tier. "High odds" needs a solid (≥k) firm-level rate at ≥2× the profile's average.
create or replace function public.odds_for(p_gpa text, p_intern boolean)
returns table (firm_id int, label text, tier text, rate numeric, n int, basis text, is_high boolean, avg_rate numeric, avg_basis text)
language sql stable security definer set search_path = public as $$
  with s as (select id, gpa_band, prior_finance_internship from public.submissions where status = 'approved'),
       r as (select sf.firm_id, sf.first_round, (s.gpa_band = p_gpa and s.prior_finance_internship = p_intern) as mine
               from public.submission_firms sf join s on s.id = sf.submission_id where sf.applied and sf.firm_id is not null),
       avg_c as (
         select case when count(*) filter (where mine) >= public.k_anon()
                     then round(100.0 * count(*) filter (where mine and first_round) / nullif(count(*) filter (where mine), 0), 1)
                     else round(100.0 * count(*) filter (where first_round) / nullif(count(*), 0), 1) end as avg_rate,
                case when count(*) filter (where mine) >= public.k_anon() then 'your profile' else 'all profiles' end as avg_basis
           from r),
       by_firm as (
         select f.id as firm_id, f.name, f.tier,
                count(r.*) filter (where r.mine) as n_mine, count(r.*) as n_all,
                round(100.0 * count(r.*) filter (where r.mine and r.first_round) / nullif(count(r.*) filter (where r.mine), 0), 1) as rate_mine,
                round(100.0 * count(r.*) filter (where r.first_round) / nullif(count(r.*), 0), 1) as rate_all
           from public.firms f left join r on r.firm_id = f.id where f.active group by f.id, f.name, f.tier),
       by_tier as (
         select f.tier,
                count(r.*) filter (where r.mine) as n_mine, count(r.*) as n_all,
                round(100.0 * count(r.*) filter (where r.mine and r.first_round) / nullif(count(r.*) filter (where r.mine), 0), 1) as rate_mine,
                round(100.0 * count(r.*) filter (where r.first_round) / nullif(count(r.*), 0), 1) as rate_all
           from public.firms f left join r on r.firm_id = f.id group by f.tier)
  select b.firm_id, b.name, b.tier,
         case when b.n_mine >= public.k_anon() then b.rate_mine
              when b.n_all  >= public.k_anon() then b.rate_all
              when t.n_mine >= public.k_anon() then t.rate_mine
              else t.rate_all end as rate,
         b.n_all::int,
         case when b.n_mine >= public.k_anon() then 'your profile'
              when b.n_all  >= public.k_anon() then 'all profiles'
              else 'tier average (too few at this firm)' end as basis,
         (b.n_all >= public.k_anon()
           and coalesce(case when b.n_mine >= public.k_anon() then b.rate_mine else b.rate_all end, 0) > 0
           and coalesce(case when b.n_mine >= public.k_anon() then b.rate_mine else b.rate_all end, 0) >= 2 * coalesce(a.avg_rate, 0)
           and a.avg_rate is not null) as is_high,
         a.avg_rate, a.avg_basis
    from by_firm b join by_tier t on t.tier = b.tier cross join avg_c a
   order by rate desc nulls last, b.n_all desc;
$$;

-- Who may see an odds sheet: admins, anyone with an approved funnel, or a treatment
-- participant whose sheet date has arrived. Comparison participants never see it.
create or replace function public.can_see_odds()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_access()
      or exists (select 1 from public.trackers t where t.user_id = auth.uid()
                  and t.study_group = 'treatment' and t.sheet_shown_on is not null and t.sheet_shown_on <= current_date);
$$;

create or replace function public.my_tracker()
returns table (has_tracker boolean, gpa_band text, prior_finance_internship boolean, study_group text, sheet_shown_on date, can_see_odds boolean)
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trackers where user_id = auth.uid()),
         t.gpa_band, t.prior_finance_internship, t.study_group, t.sheet_shown_on, public.can_see_odds()
    from (select 1) x left join public.trackers t on t.user_id = auth.uid();
$$;

create or replace function public.my_odds()
returns table (firm_id int, label text, tier text, rate numeric, n int, basis text, is_high boolean, avg_rate numeric, avg_basis text)
language plpgsql stable security definer set search_path = public as $$
declare t record;
begin
  if not public.can_see_odds() then return; end if;
  select * into t from public.trackers where user_id = auth.uid();
  if t is null then return; end if;
  return query select * from public.odds_for(t.gpa_band, t.prior_finance_internship);
end; $$;

-- Weekly series for the caller: total requests, requests at their high-odds firms, replies.
create or replace function public.my_chat_series()
returns table (week_start date, requests int, requests_high int, replies int, period text)
language sql stable security definer set search_path = public as $$
  with t as (select * from public.trackers where user_id = auth.uid()),
       hi as (select o.firm_id from t, public.odds_for(t.gpa_band, t.prior_finance_internship) o where o.is_high)
  select date_trunc('week', c.logged_on)::date,
         sum(c.requests)::int,
         coalesce(sum(c.requests) filter (where c.firm_id in (select firm_id from hi)), 0)::int,
         sum(c.replies)::int,
         case when (select study_group from t) = 'comparison' then 'comparison'
              when (select sheet_shown_on from t) is not null and c.logged_on >= (select sheet_shown_on from t) then 'after'
              else 'baseline' end
    from public.chat_logs c where c.user_id = auth.uid()
   group by 1, 5 order by 1;
$$;

create or replace function public.my_chat_logs()
returns table (id bigint, logged_on date, firm text, requests int, replies int, is_high boolean)
language sql stable security definer set search_path = public as $$
  with t as (select * from public.trackers where user_id = auth.uid()),
       hi as (select o.firm_id from t, public.odds_for(t.gpa_band, t.prior_finance_internship) o where o.is_high)
  select c.id, c.logged_on, coalesce(f.name, c.firm_name_other), c.requests, c.replies,
         (c.firm_id in (select firm_id from hi)) and public.can_see_odds()
    from public.chat_logs c left join public.firms f on f.id = c.firm_id
   where c.user_id = auth.uid() order by c.logged_on desc, c.id desc limit 200;
$$;

-- Admin: the research-question readout per participant.
create or replace function public.admin_study_readout()
returns table (
  user_id uuid, email text, study_group text, sheet_shown_on date, gpa_band text, prior_finance_internship boolean,
  high_firms text, n_logs int, baseline_per_week numeric, after_per_week numeric, ratio numeric, passes boolean
)
language sql stable security definer set search_path = public as $$
  with tr as (select t.*, p.email from public.trackers t join public.profiles p on p.user_id = t.user_id),
       hi as (select tr.user_id, o.firm_id, o.label from tr, public.odds_for(tr.gpa_band, tr.prior_finance_internship) o where o.is_high),
       span as (select user_id, min(logged_on) as first_day, max(logged_on) as last_day, count(*) as n_logs from public.chat_logs group by user_id),
       agg as (
         select tr.user_id,
                sum(c.requests) filter (where c.firm_id in (select firm_id from hi where hi.user_id = tr.user_id) and tr.sheet_shown_on is not null and c.logged_on <  tr.sheet_shown_on) as before_hi,
                sum(c.requests) filter (where c.firm_id in (select firm_id from hi where hi.user_id = tr.user_id) and tr.sheet_shown_on is not null and c.logged_on >= tr.sheet_shown_on) as after_hi
           from tr left join public.chat_logs c on c.user_id = tr.user_id group by tr.user_id),
       calc as (
         select tr.user_id, tr.email, tr.study_group, tr.sheet_shown_on, tr.gpa_band, tr.prior_finance_internship,
                (select string_agg(label, ', ' order by label) from hi where hi.user_id = tr.user_id) as high_firms,
                coalesce(s.n_logs, 0)::int as n_logs,
                round(coalesce(a.before_hi, 0) / greatest(1, round((tr.sheet_shown_on - s.first_day) / 7.0)), 2) as baseline_per_week,
                round(coalesce(a.after_hi, 0)  / greatest(1, round((s.last_day - tr.sheet_shown_on + 1) / 7.0)), 2) as after_per_week
           from tr left join span s on s.user_id = tr.user_id left join agg a on a.user_id = tr.user_id)
  select user_id, email, study_group, sheet_shown_on, gpa_band, prior_finance_internship, high_firms, n_logs,
         baseline_per_week, after_per_week,
         case when baseline_per_week > 0 then round(after_per_week / baseline_per_week, 2) end as ratio,
         case when sheet_shown_on is null then false
              when baseline_per_week > 0 then after_per_week / baseline_per_week >= 1.25
              else after_per_week >= 2 end as passes
    from calc
   where public.is_admin()
   order by study_group, email;
$$;

grant execute on function public.upsert_my_tracker(text, boolean)      to authenticated;
grant execute on function public.admin_set_tracker(uuid, text, date)   to authenticated;
grant execute on function public.odds_for(text, boolean)               to authenticated;
grant execute on function public.can_see_odds()                        to authenticated;
grant execute on function public.my_tracker()                          to authenticated;
grant execute on function public.my_odds()                             to authenticated;
grant execute on function public.my_chat_series()                      to authenticated;
grant execute on function public.my_chat_logs()                        to authenticated;
grant execute on function public.admin_study_readout()                 to authenticated;
grant select on public.trackers, public.chat_logs to authenticated;
grant insert, delete on public.chat_logs to authenticated;
