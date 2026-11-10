-- For a project set up before sign-up source tracking (commit 23a34d6 or earlier):
-- run this once in the Supabase SQL editor. New projects get it from schema.sql.
-- Safe to run twice.
alter table public.profiles add column if not exists signup_source text
  check (signup_source ~ '^[a-z0-9_.:-]{1,60}$');


-- Record the caller's source tag. Only on a new account (first day) and only once, so a
-- later visit through some other link doesn't rewrite where they came from.
create or replace function public.set_my_source(p_src text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := left(regexp_replace(lower(coalesce(p_src, '')), '[^a-z0-9_.:-]', '', 'g'), 60);
begin
  if v = '' then return; end if;
  update public.profiles set signup_source = v
   where user_id = auth.uid() and signup_source is null
     and created_at > now() - interval '1 day';
end;
$$;

-- Sign-up funnel per source tag, for the admin page. Counts only.
create or replace function public.admin_sources()
returns table (source text, n_signed_up int, n_started int, n_active int, n_finished int, n_approved int)
language sql
stable
security definer
set search_path = public
as $$
  with active as (
    select user_id from public.pipeline_activity
     where active_on > current_date - public.setting_int('active_window_days', 30)
     group by user_id having count(*) >= public.setting_int('active_min_days', 1)),
       per as (
    select coalesce(p.signup_source, 'untagged') as source, p.user_id, s.status
      from public.profiles p
      left join public.submissions s on s.user_id = p.user_id)
  select source,
         count(*)::int,
         count(status)::int,
         count(*) filter (where status = 'in_progress' and user_id in (select user_id from active))::int,
         count(*) filter (where status in ('pending', 'approved', 'rejected'))::int,
         count(*) filter (where status = 'approved')::int
    from per
   where public.is_admin()
   group by source
   order by count(*) desc, source collate "C";
$$;

revoke all on function public.set_my_source(text) from public, anon, authenticated;
revoke all on function public.admin_sources()     from public, anon, authenticated;
grant execute on function public.set_my_source(text)             to authenticated;
grant execute on function public.admin_sources()                 to authenticated;
