-- UP: Add user ownership to projects + RLS on all lead-qual tables (CIV-7 + CIV-39)

-- 1. Add user_id to projects
ALTER TABLE projects
  ADD COLUMN user_id uuid REFERENCES auth.users(id);

-- 2. Backfill: assign all existing projects to the bootstrap user
-- Replace this UUID with the actual auth.users ID after first Google sign-in
-- Run: SELECT id FROM auth.users WHERE email = 'yigitcivilo@gmail.com';
-- UPDATE projects SET user_id = '<your-uuid>' WHERE user_id IS NULL;

-- 3. Enable RLS on all tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE centroids ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- 4. Projects: owner can CRUD their own projects
CREATE POLICY "Users can view own projects"
  ON projects FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can create own projects"
  ON projects FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own projects"
  ON projects FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete own projects"
  ON projects FOR DELETE
  USING (user_id = auth.uid());

-- 5. Leads: access via project ownership
CREATE POLICY "Users can view leads in own projects"
  ON leads FOR SELECT
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert leads in own projects"
  ON leads FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY "Users can update leads in own projects"
  ON leads FOR UPDATE
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- 6. Centroids: access via project ownership
CREATE POLICY "Users can view centroids in own projects"
  ON centroids FOR SELECT
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert centroids in own projects"
  ON centroids FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY "Users can update centroids in own projects"
  ON centroids FOR UPDATE
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- 7. Scoring runs: access via project ownership (either seed or test project)
CREATE POLICY "Users can view own scoring runs"
  ON scoring_runs FOR SELECT
  USING (
    seed_project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
    OR test_project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert own scoring runs"
  ON scoring_runs FOR INSERT
  WITH CHECK (
    seed_project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
    OR test_project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- 8. Allowed emails: authenticated users can check their own email only
CREATE POLICY "Users can check own email"
  ON allowed_emails FOR SELECT
  USING (email = auth.jwt() ->> 'email');

-- DOWN
-- ALTER TABLE projects DROP COLUMN user_id;
-- ALTER TABLE projects DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE centroids DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE scoring_runs DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE allowed_emails DISABLE ROW LEVEL SECURITY;
-- DROP POLICY "Users can view own projects" ON projects;
-- DROP POLICY "Users can create own projects" ON projects;
-- DROP POLICY "Users can update own projects" ON projects;
-- DROP POLICY "Users can delete own projects" ON projects;
-- DROP POLICY "Users can view leads in own projects" ON leads;
-- DROP POLICY "Users can insert leads in own projects" ON leads;
-- DROP POLICY "Users can update leads in own projects" ON leads;
-- DROP POLICY "Users can view centroids in own projects" ON centroids;
-- DROP POLICY "Users can insert centroids in own projects" ON centroids;
-- DROP POLICY "Users can update centroids in own projects" ON centroids;
-- DROP POLICY "Users can view own scoring runs" ON scoring_runs;
-- DROP POLICY "Users can insert own scoring runs" ON scoring_runs;
-- DROP POLICY "Users can check own email" ON allowed_emails;
