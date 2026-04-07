-- UP: Beta email whitelist (CIV-7)
CREATE TABLE allowed_emails (
  email text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);

-- Seed with initial beta users
INSERT INTO allowed_emails (email) VALUES
  ('yigitcivilo@gmail.com');

-- DOWN
-- DROP TABLE allowed_emails;
