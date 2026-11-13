create or replace function public.bootstrap_first_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_count bigint;
  v_updated integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(48291, 20261113);

  select count(*) into v_admin_count
  from public.profiles
  where role = 'admin';

  if v_admin_count > 0 then
    raise exception 'Initial administrator has already been configured';
  end if;

  update public.profiles
  set role = 'admin', updated_at = pg_catalog.now()
  where id = p_user_id;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Authenticated account profile was not found';
  end if;

  return true;
end;
$$;

revoke all on function public.bootstrap_first_admin(uuid) from public;
revoke all on function public.bootstrap_first_admin(uuid) from anon;
revoke all on function public.bootstrap_first_admin(uuid) from authenticated;
grant execute on function public.bootstrap_first_admin(uuid) to service_role;
