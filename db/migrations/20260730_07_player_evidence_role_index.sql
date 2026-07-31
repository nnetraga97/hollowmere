CREATE UNIQUE INDEX IF NOT EXISTS world_player_evidence_case_role_uq
  ON world_player_evidence (world_id, player_id, role)
  WHERE role IS NOT NULL;
