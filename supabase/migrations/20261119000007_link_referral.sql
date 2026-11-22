-- Referral linking RPC: lets a logged-in user attach themselves to a referrer code.
create or replace function public.link_referral(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referrer uuid;
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Authentication required'; end if;
  if p_code is null or btrim(p_code) = '' then raise exception 'Invalid referral code'; end if;
  select id into v_referrer from public.profiles
    where upper(referral_code) = upper(btrim(p_code)) limit 1;
  if not found then raise exception 'Referral code not found'; end if;
  if v_referrer = v_me then raise exception 'You cannot refer yourself'; end if;
  insert into public.referrals (referrer_id, referred_id)
  values (v_referrer, v_me)
  on conflict (referred_id) do nothing;
  return v_referrer;
end;
$$;

revoke all on function public.link_referral(text) from public;
grant execute on function public.link_referral(text) to authenticated;

-- Referrers may see basic info of members they invited.
drop policy if exists "Referrers read invited profiles" on public.profiles;
create policy "Referrers read invited profiles"
  on public.profiles for select to authenticated
  using (exists (
    select 1 from public.referrals r
    where r.referrer_id = (select auth.uid()) and r.referred_id = public.profiles.id
  ));
