-- Plan labels no longer use the word "illustrative".
alter table public.gforce_investment_plans
  alter column percentage_label set default 'target';
update public.gforce_investment_plans
  set percentage_label = 'target',
      updated_at = now()
  where percentage_label ilike '%illustrative%' or percentage_label = 'sample';
