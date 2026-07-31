CREATE ROLE IF NOT EXISTS hollowmere_runtime LOGIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE world_case_evidence
  TO hollowmere_runtime;
