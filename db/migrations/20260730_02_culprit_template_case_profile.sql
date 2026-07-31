ALTER TABLE culprit_templates
  ADD COLUMN IF NOT EXISTS case_profile JSONB NOT NULL DEFAULT '{}';
