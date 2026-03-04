-- UP

CREATE OR REPLACE FUNCTION get_centroid_for_domains(p_project_id uuid, p_domains text[])
RETURNS vector(1536) AS $$
BEGIN
  RETURN (
    SELECT avg(embedding)
    FROM leads
    WHERE project_id = p_project_id
      AND canonical_domain = ANY(p_domains)
      AND embedding IS NOT NULL
  );
END;
$$ LANGUAGE plpgsql;

-- DOWN
-- DROP FUNCTION IF EXISTS get_centroid_for_domains(uuid, text[]);
