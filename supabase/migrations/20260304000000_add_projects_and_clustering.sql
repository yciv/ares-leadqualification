-- UP

CREATE TYPE project_type_enum AS ENUM ('seed', 'test', 'live');

CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text,
  description  text,
  project_type project_type_enum,
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE leads
  ADD COLUMN project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN source_tag    text,
  ADD COLUMN fit_score     float,
  ADD COLUMN cluster_label text,
  ADD COLUMN routing_flag  text,
  ADD COLUMN scored_at     timestamptz;

CREATE INDEX idx_leads_project ON leads(project_id);
CREATE INDEX idx_leads_cluster ON leads(cluster_label);

CREATE TABLE centroids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  cluster_label   text,
  centroid_vector vector(1536),
  lead_count      int,
  avg_fit_score   float,
  notes           text,
  created_at      timestamptz DEFAULT now(),
  UNIQUE(project_id, cluster_label)
);

CREATE TABLE scoring_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_project_id  uuid REFERENCES projects(id),
  test_project_id  uuid REFERENCES projects(id),
  run_at           timestamptz DEFAULT now(),
  leads_scored     int,
  notes            text
);

ALTER PUBLICATION supabase_realtime ADD TABLE leads;

-- DOWN
--
-- ALTER PUBLICATION supabase_realtime DROP TABLE leads;
-- DROP TABLE scoring_runs;
-- DROP TABLE centroids;
-- DROP INDEX idx_leads_cluster;
-- DROP INDEX idx_leads_project;
-- ALTER TABLE leads
--   DROP COLUMN scored_at,
--   DROP COLUMN routing_flag,
--   DROP COLUMN cluster_label,
--   DROP COLUMN fit_score,
--   DROP COLUMN source_tag,
--   DROP COLUMN project_id;
-- DROP TABLE projects;
-- DROP TYPE project_type_enum;
