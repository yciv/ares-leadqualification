-- UP
ALTER TABLE projects ADD COLUMN clustering_metadata jsonb DEFAULT NULL;

-- DOWN
-- ALTER TABLE projects DROP COLUMN clustering_metadata;
