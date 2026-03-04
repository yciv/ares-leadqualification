-- UP

CREATE OR REPLACE FUNCTION score_leads_against_centroid(
  p_test_project_id uuid,
  p_centroid_id     uuid,
  p_centroid_vector vector(1536)
)
RETURNS TABLE (lead_id uuid, similarity float) AS $$
BEGIN
  RETURN QUERY
  SELECT
    id AS lead_id,
    (1 - (embedding <=> p_centroid_vector))::float AS similarity
  FROM leads
  WHERE project_id = p_test_project_id
    AND embedding IS NOT NULL;
END;
$$ LANGUAGE plpgsql;

-- DOWN
-- DROP FUNCTION IF EXISTS score_leads_against_centroid(uuid, uuid, vector(1536));
