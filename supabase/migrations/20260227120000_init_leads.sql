-- UP
create table if not exists leads (
  id              uuid primary key default gen_random_uuid(),
  company_name    text not null,
  canonical_domain text not null unique,
  status          text not null default 'pending',
  linkup_data     jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- trigger to auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger leads_updated_at
  before update on leads
  for each row
  execute function update_updated_at();

-- DOWN
-- drop trigger if exists leads_updated_at on leads;
-- drop function if exists update_updated_at();
-- drop table if exists leads;
