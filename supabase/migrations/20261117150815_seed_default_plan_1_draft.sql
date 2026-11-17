insert into public.gforce_investment_plans
  (name, tagline, description, badge_label, min_amount, max_amount, duration_value, duration_unit, percentage, percentage_label, is_active, sort_order)
select
  'Plan 1',
  'Draft plan — edit before publishing',
  'This is a starter draft. Update the description, amount range, duration, illustrative percentage and logo in Admin → Investment Plans before publishing.',
  'DRAFT',
  50,
  2000,
  1,
  'days',
  0,
  'illustrative target',
  false,
  1
where not exists (
  select 1 from public.gforce_investment_plans where name = 'Plan 1'
);
