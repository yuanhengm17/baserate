-- Research-question metrics. Run in the Supabase SQL editor as the project owner
-- (bypasses RLS). The Admin page shows the same numbers live.

-- 1. Completions over time (how many of the first 100 invited finished within a week?)
with daily as (
  select created_at::date as day, count(*) as submissions_that_day
    from public.submissions group by 1)
select day, submissions_that_day, sum(submissions_that_day) over (order by day) as cumulative
  from daily order by day;

-- 2. The three thresholds in one row
with per as (
  select s.id,
         count(f.*)                                  as n_firms,
         count(f.*) filter (where f.applied)         as n_applied,
         bool_or(f.applied and not f.offer)          as has_rejection
    from public.submissions s
    left join public.submission_firms f on f.submission_id = s.id
   group by s.id)
select count(*)                                                       as n_submitted,
       round(100.0 * count(*) filter (where has_rejection) / nullif(count(*),0), 1) as pct_with_rejection,
       percentile_cont(0.5) within group (order by n_firms)            as median_firms,
       percentile_cont(0.5) within group (order by n_applied)          as median_applied,
       count(*) filter (where cardinality((select flags from public.submissions x where x.id = per.id)) > 0) as n_flagged
  from per;

-- 3. Selection-bias check: offer share among contributors vs what you know about the cohort
select outcome, count(*) from public.submissions group by 1 order by 2 desc;

-- 4. Who contributed (admin only, for follow-ups; never leaves this console)
select p.email, s.status, s.flags, s.created_at
  from public.submissions s join public.profiles p on p.user_id = s.user_id
 order by s.created_at desc;


-- 5. Study readout (same as the Admin page): weekly requests at high-odds firms before vs after
--    the sheet date, per participant. Pass = ratio >= 1.25 (or >= 2/week if baseline was 0).
select email, study_group, sheet_shown_on, high_firms, n_logs, baseline_per_week, after_per_week, ratio, passes
  from public.admin_study_readout();
-- Note: admin_study_readout() checks is_admin() via auth.uid(); in the SQL editor (no JWT) it
-- returns no rows. Either run it from the Admin page, or use this owner-level version:
with tr as (select t.*, p.email from public.trackers t join public.profiles p on p.user_id = t.user_id),
     hi as (select tr.user_id, o.firm_id from tr, public.odds_for(tr.gpa_band, tr.prior_finance_internship) o where o.is_high)
select tr.email, tr.study_group, tr.sheet_shown_on,
       sum(c.requests) filter (where c.firm_id in (select firm_id from hi where hi.user_id = tr.user_id) and c.logged_on <  tr.sheet_shown_on) as before_hi_total,
       sum(c.requests) filter (where c.firm_id in (select firm_id from hi where hi.user_id = tr.user_id) and c.logged_on >= tr.sheet_shown_on) as after_hi_total,
       min(c.logged_on) as first_log, max(c.logged_on) as last_log
  from tr left join public.chat_logs c on c.user_id = tr.user_id
 group by tr.email, tr.study_group, tr.sheet_shown_on order by 2, 1;
