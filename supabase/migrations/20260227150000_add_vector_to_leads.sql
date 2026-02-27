-- UP
create extension if not exists vector with schema extensions;
alter table leads add column embedding vector(1536);

-- DOWN
-- alter table leads drop column embedding;
-- Do not drop the extension in down migration to avoid breaking other tables.
