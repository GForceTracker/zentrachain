create table if not exists public.gforce_investment_plans (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 description text not null default '',
 min_amount numeric(20,2) not null default 50 check (min_amount > 0),
 max_amount numeric(20,2) not null default 2000 check (max_amount >= min_amount),
 duration_value integer not null default 1 check (duration_value > 0),
 duration_unit text not null default 'days' check (duration_unit in ('hours','days')),
 percentage numeric(9,4) not null default 0 check (percentage >= 0 and percentage <= 100),
 percentage_label text not null default 'illustrative target',
 is_active boolean not null default true,
 sort_order integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.gforce_investment_plans enable row level security;
drop policy if exists "Public can view active G-Force plans" on public.gforce_investment_plans;
create policy "Public can view active G-Force plans" on public.gforce_investment_plans for select to anon, authenticated using (is_active = true or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists "Admins manage G-Force plans" on public.gforce_investment_plans;
create policy "Admins manage G-Force plans" on public.gforce_investment_plans for all to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')) with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create index if not exists gforce_investment_plans_active_sort_idx on public.gforce_investment_plans(is_active, sort_order);
