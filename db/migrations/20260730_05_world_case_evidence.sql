CREATE TABLE IF NOT EXISTS world_case_evidence (
  world_id        UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  role            STRING NOT NULL CHECK (role IN
                    ('tamper_sign', 'tamper_comparator', 'culprit_access',
                     'murder_opportunity', 'escalation_provenance')),
  holder_agent_id UUID NULL,
  claim_id        UUID NOT NULL,
  kind            STRING NOT NULL CHECK (kind IN ('provenance', 'contradiction', 'record')),
  accused_id      UUID NULL,
  PRIMARY KEY (world_id, role),
  FOREIGN KEY (world_id, holder_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id),
  FOREIGN KEY (world_id, accused_id) REFERENCES world_agents (world_id, agent_id)
);
