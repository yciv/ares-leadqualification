-- UP
ALTER TABLE leads ADD COLUMN numeric_features jsonb DEFAULT NULL;

-- DOWN
-- ALTER TABLE leads DROP COLUMN numeric_features;
