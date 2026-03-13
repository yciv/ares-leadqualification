-- UP
ALTER TABLE leads
  ADD COLUMN text_similarity    float DEFAULT NULL,
  ADD COLUMN numeric_similarity float DEFAULT NULL,
  ADD COLUMN completeness_score float DEFAULT NULL;

ALTER TABLE centroids
  ADD COLUMN numeric_features jsonb DEFAULT NULL;

-- DOWN
-- ALTER TABLE leads
--   DROP COLUMN text_similarity,
--   DROP COLUMN numeric_similarity,
--   DROP COLUMN completeness_score;
-- ALTER TABLE centroids DROP COLUMN numeric_features;
