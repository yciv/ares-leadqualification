-- UP
alter table leads add column standardized_data jsonb;

-- DOWN
-- alter table leads drop column standardized_data;
