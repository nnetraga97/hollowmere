-- Hollowmere schema
--
-- Conventions enforced throughout (see docs/plan §3):
--   1. Random UUID entity identifiers.
--   2. Composite world-scoped primary keys: (world_id, <entity>_id).
--   3. Composite foreign keys, so a cross-world reference cannot be expressed.
--   4. INT8 for ticks and sequences.
--   5. Fixed-point INT8 for simulation values, SCALE = 10000.
--        unsigned magnitudes  0 .. 10000   (tension, heat, trust, importance)
--        signed magnitudes  -10000 .. 10000 (sentiment, valence, reputation, confidence)
--   6. No FLOAT columns anywhere except VECTOR embeddings, which are data the
--      rules never compute on directly (distance is quantised to fixed point).
--   7. TIMESTAMPTZ is operational metadata only. Simulation time is always tick.
--   8. STRING + CHECK rather than enums, which are painful to evolve.
--   9. JSONB only for structures the rules never compare or order on.
--  10. Scenario versions are immutable once published.
--  11. Append-only history + rebuildable current-state projections.
--  12. External commands carry a client idempotency key.
--  13. History carries (tick, seq) so every collection has a total order.

SET experimental_enable_temp_tables = false;

-- ===========================================================================
-- SECTION 1 — Static scenario definitions
--
-- Immutable once published. A change to any scenario content means a NEW
-- scenario_version_id, never an UPDATE. This is what lets a recorded world be
-- replayed years later: its scenario can never have drifted underneath it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS scenario_versions (
  scenario_version_id UUID NOT NULL DEFAULT gen_random_uuid(),
  version             STRING NOT NULL,
  name                STRING NOT NULL,
  -- Checksum of the canonical scenario JSON. The loader refuses to publish a
  -- version whose checksum already exists under a different id.
  checksum            STRING NOT NULL,
  schema_version      INT8 NOT NULL,
  -- The inciting event, applied once at instantiation. Stored here so a world
  -- can be rebuilt from the database alone, without the original JSON file.
  opening             JSONB NOT NULL DEFAULT '{}',
  published_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_version_id),
  UNIQUE (version),
  UNIQUE (checksum)
);

CREATE TABLE IF NOT EXISTS faction_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  faction_key         STRING NOT NULL,
  name                STRING NOT NULL,
  ideology            STRING NOT NULL,
  -- Resolved to an agent after agents are instantiated; kept as a key here
  -- because templates cannot reference per-world rows.
  leader_agent_key    STRING NOT NULL,
  -- Whether this faction can go to war. The unaligned (magistrate, clergy,
  -- physician) hold beliefs and spread gossip but are never a side, so the
  -- escalation and peace rules must be able to exclude them.
  belligerent         BOOL NOT NULL DEFAULT true,
  PRIMARY KEY (scenario_version_id, faction_key)
);

CREATE TABLE IF NOT EXISTS district_templates (
  scenario_version_id     UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  district_key            STRING NOT NULL,
  name                    STRING NOT NULL,
  controlling_faction_key STRING NULL,
  PRIMARY KEY (scenario_version_id, district_key),
  FOREIGN KEY (scenario_version_id, controlling_faction_key)
    REFERENCES faction_templates (scenario_version_id, faction_key)
);

CREATE TABLE IF NOT EXISTS location_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  location_key        STRING NOT NULL,
  district_key        STRING NOT NULL,
  name                STRING NOT NULL,
  -- Integer map coordinates. Phaser interpolates between them; the engine
  -- never does sub-tile arithmetic.
  x                   INT8 NOT NULL,
  y                   INT8 NOT NULL,
  -- Rumor hubs (the tavern, the market) transmit gossip more readily.
  gossip_bonus        INT8 NOT NULL DEFAULT 0 CHECK (gossip_bonus BETWEEN 0 AND 10000),
  PRIMARY KEY (scenario_version_id, location_key),
  FOREIGN KEY (scenario_version_id, district_key)
    REFERENCES district_templates (scenario_version_id, district_key)
);

CREATE TABLE IF NOT EXISTS route_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  from_location_key   STRING NOT NULL,
  to_location_key     STRING NOT NULL,
  cost                INT8 NOT NULL CHECK (cost > 0),
  PRIMARY KEY (scenario_version_id, from_location_key, to_location_key),
  FOREIGN KEY (scenario_version_id, from_location_key)
    REFERENCES location_templates (scenario_version_id, location_key),
  FOREIGN KEY (scenario_version_id, to_location_key)
    REFERENCES location_templates (scenario_version_id, location_key)
);

CREATE TABLE IF NOT EXISTS agent_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  agent_key           STRING NOT NULL,
  name                STRING NOT NULL,
  faction_key         STRING NOT NULL,
  home_location_key   STRING NOT NULL,
  work_location_key   STRING NOT NULL,
  -- Free-form character description handed to the model. Never compared by rules.
  persona             JSONB NOT NULL,
  -- Phase -> location_key schedule. Never compared by rules; resolved by lookup.
  routine             JSONB NOT NULL,
  -- Disposition knobs, fixed point.
  credulity           INT8 NOT NULL CHECK (credulity BETWEEN 0 AND 10000),
  talkativeness       INT8 NOT NULL CHECK (talkativeness BETWEEN 0 AND 10000),
  kindness            INT8 NOT NULL DEFAULT 5000 CHECK (kindness BETWEEN 0 AND 10000),
  engagement          INT8 NOT NULL DEFAULT 5000 CHECK (engagement BETWEEN 0 AND 10000),
  honesty             INT8 NOT NULL DEFAULT 5000 CHECK (honesty BETWEEN 0 AND 10000),
  PRIMARY KEY (scenario_version_id, agent_key),
  FOREIGN KEY (scenario_version_id, faction_key)
    REFERENCES faction_templates (scenario_version_id, faction_key),
  FOREIGN KEY (scenario_version_id, home_location_key)
    REFERENCES location_templates (scenario_version_id, location_key),
  FOREIGN KEY (scenario_version_id, work_location_key)
    REFERENCES location_templates (scenario_version_id, location_key)
);

ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS kindness INT8 NOT NULL DEFAULT 5000;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS engagement INT8 NOT NULL DEFAULT 5000;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS honesty INT8 NOT NULL DEFAULT 5000;
ALTER TABLE agent_templates DROP CONSTRAINT IF EXISTS check_kindness;
ALTER TABLE agent_templates ADD CONSTRAINT check_kindness CHECK (kindness BETWEEN 0 AND 10000);
ALTER TABLE agent_templates DROP CONSTRAINT IF EXISTS check_engagement;
ALTER TABLE agent_templates ADD CONSTRAINT check_engagement CHECK (engagement BETWEEN 0 AND 10000);
ALTER TABLE agent_templates DROP CONSTRAINT IF EXISTS check_honesty;
ALTER TABLE agent_templates ADD CONSTRAINT check_honesty CHECK (honesty BETWEEN 0 AND 10000);

CREATE TABLE IF NOT EXISTS claim_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  claim_key           STRING NOT NULL,
  text                STRING NOT NULL,
  subject_agent_key   STRING NOT NULL,
  -- Engine-known ground truth. 'unknown' is a first-class value: some claims
  -- are genuinely unresolvable, so not every accusation can be disproved.
  truth               STRING NOT NULL CHECK (truth IN ('true', 'false', 'unknown')),
  -- How damaging the claim is if believed.
  severity            INT8 NOT NULL CHECK (severity BETWEEN 0 AND 10000),
  PRIMARY KEY (scenario_version_id, claim_key),
  FOREIGN KEY (scenario_version_id, subject_agent_key)
    REFERENCES agent_templates (scenario_version_id, agent_key)
);

CREATE TABLE IF NOT EXISTS trigger_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  trigger_key         STRING NOT NULL,
  -- Allowlisted condition/effect DSL, validated on load. Never evaluated as code.
  condition           JSONB NOT NULL,
  effect              JSONB NOT NULL,
  priority            INT8 NOT NULL DEFAULT 0,
  once                BOOL NOT NULL DEFAULT true,
  PRIMARY KEY (scenario_version_id, trigger_key)
);

CREATE TABLE IF NOT EXISTS culprit_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  culprit_key         STRING NOT NULL,
  motive_key          STRING NOT NULL,
  profit_claim_key    STRING NOT NULL,
  record_claim_key    STRING NOT NULL,
  claim_truth         JSONB NOT NULL,
  PRIMARY KEY (scenario_version_id, culprit_key),
  FOREIGN KEY (scenario_version_id, culprit_key)
    REFERENCES agent_templates (scenario_version_id, agent_key),
  FOREIGN KEY (scenario_version_id, profit_claim_key)
    REFERENCES claim_templates (scenario_version_id, claim_key),
  FOREIGN KEY (scenario_version_id, record_claim_key)
    REFERENCES claim_templates (scenario_version_id, claim_key)
);

CREATE TABLE IF NOT EXISTS agent_goal_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  agent_key           STRING NOT NULL,
  goal_key            STRING NOT NULL,
  priority            INT8 NOT NULL,
  PRIMARY KEY (scenario_version_id, agent_key, goal_key),
  FOREIGN KEY (scenario_version_id, agent_key)
    REFERENCES agent_templates (scenario_version_id, agent_key)
);

CREATE TABLE IF NOT EXISTS scheme_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  scheme_key          STRING NOT NULL,
  ladder_index        INT8 NOT NULL,
  tactic              STRING NOT NULL CHECK (tactic IN
    ('blame_shift', 'corroborate_false', 'poison_the_well', 'feign_moderation',
     'redirect_suspicion', 'recruit_amplifier')),
  audience            STRING NOT NULL,
  claim_key           STRING NULL,
  condition           JSONB NOT NULL,
  PRIMARY KEY (scenario_version_id, scheme_key),
  UNIQUE (scenario_version_id, ladder_index),
  FOREIGN KEY (scenario_version_id, claim_key)
    REFERENCES claim_templates (scenario_version_id, claim_key)
);

-- ===========================================================================
-- SECTION 2 — Worlds
--
-- One private world per player. Every table below is world-scoped.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS worlds (
  world_id            UUID NOT NULL DEFAULT gen_random_uuid(),
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions (scenario_version_id),
  -- Together with the scenario version and the ordered command log, this seed
  -- fully determines a stub run.
  seed                INT8 NOT NULL,
  current_tick        INT8 NOT NULL DEFAULT 0,
  -- Monotonic counter assigning a total order to external commands.
  command_seq         INT8 NOT NULL DEFAULT 0,
  status              STRING NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'ended', 'expired')),
  ending              STRING NULL
                        CHECK (ending IS NULL OR ending IN ('war', 'peace', 'exposed', 'expired')),
  -- Fixed point: 10000 is realtime. Raised for headless tests and video capture.
  time_scale          INT8 NOT NULL DEFAULT 10000 CHECK (time_scale > 0),
  active_runtime_ms   INT8 NOT NULL DEFAULT 0,
  -- Additional ticks owed by completed player conversations. Only the
  -- lease-holding scheduler drains this projection, one back-to-back tick at a
  -- time; normal cadence ticks never decrement it.
  time_debt_ticks     INT8 NOT NULL DEFAULT 0 CHECK (time_debt_ticks >= 0),

  -- Operational metadata only. None of this is simulation time.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner         STRING NULL,
  lease_expires_at    TIMESTAMPTZ NULL,

  PRIMARY KEY (world_id),
  -- A world is only ended if it has an ending, and vice versa.
  CONSTRAINT ending_matches_status
    CHECK ((status = 'ended') = (ending IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS worlds_schedulable_idx
  ON worlds (status, lease_expires_at);

ALTER TABLE worlds
  ADD COLUMN IF NOT EXISTS time_debt_ticks INT8 NOT NULL DEFAULT 0;
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS check_time_debt_ticks;
ALTER TABLE worlds ADD CONSTRAINT check_time_debt_ticks CHECK (time_debt_ticks >= 0);

-- Existing databases predate the exposed ending.
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS check_ending_ending;
ALTER TABLE worlds ADD CONSTRAINT check_ending_ending
  CHECK (ending IS NULL OR ending IN ('war', 'peace', 'exposed', 'expired'));

-- ---------------------------------------------------------------------------
-- Per-world instantiation of scenario content.
--
-- Factions and locations are materialised per world so that every downstream
-- foreign key can be composite. That is what makes a cross-world reference
-- structurally impossible rather than merely discouraged.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS world_factions (
  world_id    UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  faction_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  faction_key STRING NOT NULL,
  name        STRING NOT NULL,
  ideology    STRING NOT NULL,
  belligerent BOOL NOT NULL DEFAULT true,
  PRIMARY KEY (world_id, faction_id),
  UNIQUE (world_id, faction_key)
);

CREATE TABLE IF NOT EXISTS world_locations (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  location_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  location_key STRING NOT NULL,
  district_key STRING NOT NULL,
  name         STRING NOT NULL,
  x            INT8 NOT NULL,
  y            INT8 NOT NULL,
  gossip_bonus INT8 NOT NULL DEFAULT 0 CHECK (gossip_bonus BETWEEN 0 AND 10000),
  -- Which faction currently holds the district. Mutable: control can change.
  controlling_faction_id UUID NULL,
  PRIMARY KEY (world_id, location_id),
  UNIQUE (world_id, location_key),
  FOREIGN KEY (world_id, controlling_faction_id)
    REFERENCES world_factions (world_id, faction_id)
);

CREATE TABLE IF NOT EXISTS world_routes (
  world_id         UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  from_location_id UUID NOT NULL,
  to_location_id   UUID NOT NULL,
  cost             INT8 NOT NULL CHECK (cost > 0),
  PRIMARY KEY (world_id, from_location_id, to_location_id),
  FOREIGN KEY (world_id, from_location_id)
    REFERENCES world_locations (world_id, location_id),
  FOREIGN KEY (world_id, to_location_id)
    REFERENCES world_locations (world_id, location_id)
);

-- ===========================================================================
-- SECTION 3 — Mutable current-state projections
--
-- Every table here is derivable from the append-only history in Section 4.
-- They exist for read speed, and a rebuild-and-compare is an acceptance test.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS world_agents (
  world_id       UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id       UUID NOT NULL DEFAULT gen_random_uuid(),
  agent_key      STRING NOT NULL,
  name           STRING NOT NULL,
  faction_id     UUID NOT NULL,
  home_location_id UUID NOT NULL,
  work_location_id UUID NOT NULL,
  location_id    UUID NOT NULL,
  persona        JSONB NOT NULL,
  routine        JSONB NOT NULL,
  credulity      INT8 NOT NULL CHECK (credulity BETWEEN 0 AND 10000),
  talkativeness  INT8 NOT NULL CHECK (talkativeness BETWEEN 0 AND 10000),
  kindness       INT8 NOT NULL DEFAULT 5000 CHECK (kindness BETWEEN 0 AND 10000),
  engagement     INT8 NOT NULL DEFAULT 5000 CHECK (engagement BETWEEN 0 AND 10000),
  honesty        INT8 NOT NULL DEFAULT 5000 CHECK (honesty BETWEEN 0 AND 10000),
  -- Character state only. Spotlight membership is ephemeral and never stored.
  status         STRING NOT NULL DEFAULT 'alive'
                   CHECK (status IN ('alive', 'injured', 'missing', 'dead', 'detained')),
  current_plan   JSONB NULL,
  current_action STRING NULL,
  updated_tick   INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, agent_id),
  UNIQUE (world_id, agent_key),
  FOREIGN KEY (world_id, faction_id) REFERENCES world_factions (world_id, faction_id),
  FOREIGN KEY (world_id, home_location_id) REFERENCES world_locations (world_id, location_id),
  FOREIGN KEY (world_id, work_location_id) REFERENCES world_locations (world_id, location_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id)
);

CREATE INDEX IF NOT EXISTS world_agents_by_location_idx
  ON world_agents (world_id, location_id);

-- Existing databases predate detention as a non-lethal terminal agent state.
ALTER TABLE world_agents DROP CONSTRAINT IF EXISTS check_status;
ALTER TABLE world_agents ADD CONSTRAINT check_status
  CHECK (status IN ('alive', 'injured', 'missing', 'dead', 'detained'));

ALTER TABLE world_agents ADD COLUMN IF NOT EXISTS kindness INT8 NOT NULL DEFAULT 5000;
ALTER TABLE world_agents ADD COLUMN IF NOT EXISTS engagement INT8 NOT NULL DEFAULT 5000;
ALTER TABLE world_agents ADD COLUMN IF NOT EXISTS honesty INT8 NOT NULL DEFAULT 5000;
ALTER TABLE world_agents DROP CONSTRAINT IF EXISTS check_kindness;
ALTER TABLE world_agents ADD CONSTRAINT check_kindness CHECK (kindness BETWEEN 0 AND 10000);
ALTER TABLE world_agents DROP CONSTRAINT IF EXISTS check_engagement;
ALTER TABLE world_agents ADD CONSTRAINT check_engagement CHECK (engagement BETWEEN 0 AND 10000);
ALTER TABLE world_agents DROP CONSTRAINT IF EXISTS check_honesty;
ALTER TABLE world_agents ADD CONSTRAINT check_honesty CHECK (honesty BETWEEN 0 AND 10000);

-- Faction leadership, added now that agents exist.
ALTER TABLE world_factions
  ADD COLUMN IF NOT EXISTS leader_agent_id UUID NULL;

CREATE TABLE IF NOT EXISTS world_relationships (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  src_agent_id UUID NOT NULL,
  dst_agent_id UUID NOT NULL,
  sentiment    INT8 NOT NULL DEFAULT 0 CHECK (sentiment BETWEEN -10000 AND 10000),
  trust        INT8 NOT NULL DEFAULT 5000 CHECK (trust BETWEEN 0 AND 10000),
  updated_tick INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, src_agent_id, dst_agent_id),
  CONSTRAINT no_self_relationship CHECK (src_agent_id != dst_agent_id),
  FOREIGN KEY (world_id, src_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, dst_agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_claims (
  world_id          UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  claim_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  claim_key         STRING NOT NULL,
  text              STRING NOT NULL,
  subject_agent_id  UUID NOT NULL,
  truth             STRING NOT NULL CHECK (truth IN ('true', 'false', 'unknown')),
  severity          INT8 NOT NULL CHECK (severity BETWEEN 0 AND 10000),
  -- Claims invented by the player at runtime have no template.
  authored          BOOL NOT NULL DEFAULT true,
  locked            BOOL NOT NULL DEFAULT false,
  created_tick      INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, claim_id),
  UNIQUE (world_id, claim_key),
  FOREIGN KEY (world_id, subject_agent_id) REFERENCES world_agents (world_id, agent_id)
);

ALTER TABLE world_claims
  ADD COLUMN IF NOT EXISTS locked BOOL NOT NULL DEFAULT false;

-- What each agent currently believes. Projection of belief_updates.
CREATE TABLE IF NOT EXISTS agent_beliefs (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  claim_id     UUID NOT NULL,
  -- Signed: negative confidence means actively disbelieving the claim.
  confidence   INT8 NOT NULL CHECK (confidence BETWEEN -10000 AND 10000),
  updated_tick INT8 NOT NULL,
  PRIMARY KEY (world_id, agent_id, claim_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id)
);

CREATE TABLE IF NOT EXISTS world_state (
  world_id         UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  global_tension   INT8 NOT NULL DEFAULT 0 CHECK (global_tension BETWEEN 0 AND 10000),
  escalation_stage STRING NOT NULL DEFAULT 'calm'
    CHECK (escalation_stage IN
      ('calm', 'suspicion', 'accusations', 'trials', 'first_blood', 'war')),
  -- Ticks the peace conditions have held continuously. Peace requires a
  -- sustained streak, so a single calm moment cannot end the story.
  peace_streak     INT8 NOT NULL DEFAULT 0,
  day              INT8 NOT NULL DEFAULT 0,
  phase            STRING NOT NULL DEFAULT 'morning'
    CHECK (phase IN ('morning', 'midday', 'evening', 'night')),
  PRIMARY KEY (world_id)
);

-- Per-faction tension. A separate table rather than JSONB on world_state,
-- because the rules compare and order on these values every tick.
CREATE TABLE IF NOT EXISTS world_faction_state (
  world_id            UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  faction_id          UUID NOT NULL,
  tension             INT8 NOT NULL DEFAULT 0 CHECK (tension BETWEEN 0 AND 10000),
  -- Whether this faction's leader would currently accept terms. A precondition
  -- of the peace ending, and set by rules rather than by the model.
  willing_to_negotiate BOOL NOT NULL DEFAULT false,
  updated_tick        INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, faction_id),
  FOREIGN KEY (world_id, faction_id) REFERENCES world_factions (world_id, faction_id)
);

CREATE TABLE IF NOT EXISTS world_rumors (
  world_id        UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  rumor_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL,
  origin_event_id UUID NULL,
  heat            INT8 NOT NULL CHECK (heat BETWEEN 0 AND 10000),
  valence         INT8 NOT NULL CHECK (valence BETWEEN -10000 AND 10000),
  created_tick    INT8 NOT NULL,
  updated_tick    INT8 NOT NULL,
  PRIMARY KEY (world_id, rumor_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id)
);

-- Hot rumors are selected every tick; this index keeps that a range scan.
CREATE INDEX IF NOT EXISTS world_rumors_heat_idx
  ON world_rumors (world_id, heat DESC);

CREATE TABLE IF NOT EXISTS world_players (
  world_id    UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  player_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  session_id  STRING NOT NULL,
  name        STRING NOT NULL DEFAULT 'the outsider',
  profile     JSONB NOT NULL DEFAULT '{}',
  location_id UUID NOT NULL,
  PRIMARY KEY (world_id, player_id),
  UNIQUE (world_id, session_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id)
);

ALTER TABLE world_players
  ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS player_reputation (
  world_id   UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  player_id  UUID NOT NULL,
  faction_id UUID NOT NULL,
  reputation INT8 NOT NULL DEFAULT 0 CHECK (reputation BETWEEN -10000 AND 10000),
  updated_tick INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, player_id, faction_id),
  FOREIGN KEY (world_id, player_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, faction_id) REFERENCES world_factions (world_id, faction_id)
);

CREATE TABLE IF NOT EXISTS player_agent_relationships (
  world_id    UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  player_id   UUID NOT NULL,
  agent_id    UUID NOT NULL,
  trust       INT8 NOT NULL DEFAULT 5000 CHECK (trust BETWEEN 0 AND 10000),
  affinity    INT8 NOT NULL DEFAULT 0 CHECK (affinity BETWEEN -10000 AND 10000),
  fear        INT8 NOT NULL DEFAULT 0 CHECK (fear BETWEEN 0 AND 10000),
  respect     INT8 NOT NULL DEFAULT 0 CHECK (respect BETWEEN -10000 AND 10000),
  impression  STRING NULL,
  updated_tick INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, player_id, agent_id),
  FOREIGN KEY (world_id, player_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

-- Two independent, recoverable relationship arcs. `stage` is authored-scene
-- progression, not exclusivity: the same player may commit to both candidates.
-- Flags live in a normalized child table because branching rules compare them;
-- JSONB is reserved for recorded/display-only payloads in this schema.
CREATE TABLE IF NOT EXISTS player_romance_arcs (
  world_id       UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  player_id      UUID NOT NULL,
  agent_id       UUID NOT NULL,
  stage          INT8 NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 6),
  status         STRING NOT NULL DEFAULT 'open' CHECK (status IN
                   ('open', 'growing', 'courting', 'committed', 'platonic',
                    'complicated', 'strained')),
  last_event_tick INT8 NULL,
  updated_tick   INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, player_id, agent_id),
  FOREIGN KEY (world_id, player_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS player_romance_flags (
  world_id    UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  player_id   UUID NOT NULL,
  agent_id    UUID NOT NULL,
  flag_key    STRING NOT NULL,
  gained_tick INT8 NOT NULL,
  PRIMARY KEY (world_id, player_id, agent_id, flag_key),
  FOREIGN KEY (world_id, player_id, agent_id)
    REFERENCES player_romance_arcs (world_id, player_id, agent_id) ON DELETE CASCADE
);

-- Append-only authored-scene history. The spoken response and aftermath are
-- recorded so later UI/prompt rendering never changes old choices if content is
-- edited in a future scenario version.
CREATE TABLE IF NOT EXISTS player_romance_events (
  world_id          UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  romance_event_id  UUID NOT NULL,
  player_id         UUID NOT NULL,
  agent_id          UUID NOT NULL,
  tick              INT8 NOT NULL,
  seq               INT8 NOT NULL,
  command_seq       INT8 NOT NULL,
  scene_key         STRING NOT NULL,
  choice_key        STRING NOT NULL,
  response          STRING NOT NULL,
  aftermath         STRING NOT NULL,
  impression        STRING NOT NULL,
  status_after      STRING NOT NULL CHECK (status_after IN
                      ('open', 'growing', 'courting', 'committed', 'platonic',
                       'complicated', 'strained')),
  revealed_claim_keys JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (world_id, romance_event_id),
  UNIQUE (world_id, player_id, agent_id, scene_key),
  UNIQUE (world_id, tick, seq),
  UNIQUE (world_id, command_seq),
  FOREIGN KEY (world_id, player_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_agent_reflection_state (
  world_id              UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id              UUID NOT NULL,
  accumulated_importance INT8 NOT NULL DEFAULT 0 CHECK (accumulated_importance >= 0),
  last_reflection_tick  INT8 NULL,
  PRIMARY KEY (world_id, agent_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_culprit (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  motive_key   STRING NOT NULL,
  exposed_tick INT8 NULL,
  PRIMARY KEY (world_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_agent_goals (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  goal_key     STRING NOT NULL,
  priority     INT8 NOT NULL,
  status       STRING NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended', 'achieved', 'abandoned')),
  updated_tick INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, agent_id, goal_key),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_scheme_state (
  world_id           UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id           UUID NOT NULL,
  posture            STRING NOT NULL DEFAULT 'press'
                       CHECK (posture IN ('press', 'lie_low', 'redirect', 'force')),
  ladder_index       INT8 NOT NULL DEFAULT 0,
  current_tactic     STRING NULL,
  target_agent_id    UUID NULL,
  claim_id           UUID NULL,
  executes_until     INT8 NOT NULL DEFAULT 0,
  next_strategy_tick INT8 NOT NULL DEFAULT 0,
  updated_tick       INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, agent_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, target_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id)
);

CREATE TABLE IF NOT EXISTS world_budget (
  world_id        UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  inference_calls INT8 NOT NULL DEFAULT 0,
  tokens_in       INT8 NOT NULL DEFAULT 0,
  tokens_out      INT8 NOT NULL DEFAULT 0,
  -- Integer micro-dollars. Money is fixed point for the same reason the
  -- simulation is.
  est_cost_micros INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id)
);

-- Durable multi-turn player conversations. These rows double as replay
-- recordings and are deliberately preserved by rewind; ids are position-derived
-- by the engine rather than generated by the database.
CREATE TABLE IF NOT EXISTS world_conversation_sessions (
  world_id          UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  conversation_id   UUID NOT NULL,
  player_id         UUID NOT NULL,
  target_agent_id   UUID NOT NULL,
  location_id       UUID NOT NULL,
  status            STRING NOT NULL CHECK (status IN
                      ('open', 'closing', 'closed', 'timed_out', 'abandoned')),
  opened_tick       INT8 NOT NULL,
  closed_tick       INT8 NULL,
  next_turn_ordinal INT8 NOT NULL DEFAULT 0,
  closing_ordinal   INT8 NULL,
  turn_count        INT8 NOT NULL DEFAULT 0,
  time_cost_ticks   INT8 NOT NULL DEFAULT 0 CHECK (time_cost_ticks BETWEEN 0 AND 3),
  close_idempotency_key STRING NULL,
  summary           STRING NULL,
  relationship_impression STRING NULL,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at       TIMESTAMPTZ NOT NULL,
  closed_at         TIMESTAMPTZ NULL,
  PRIMARY KEY (world_id, conversation_id),
  UNIQUE (world_id, close_idempotency_key),
  FOREIGN KEY (world_id, player_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, target_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_held_conversation_per_world_idx
  ON world_conversation_sessions (world_id)
  WHERE status IN ('open', 'closing');

CREATE TABLE IF NOT EXISTS world_conversation_participants (
  world_id        UUID NOT NULL,
  conversation_id UUID NOT NULL,
  agent_id        UUID NOT NULL,
  role            STRING NOT NULL CHECK (role IN ('target', 'observer')),
  PRIMARY KEY (world_id, conversation_id, agent_id),
  FOREIGN KEY (world_id, conversation_id)
    REFERENCES world_conversation_sessions (world_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_conversation_turns (
  world_id          UUID NOT NULL,
  conversation_id   UUID NOT NULL,
  turn_id           UUID NOT NULL,
  ordinal           INT8 NOT NULL,
  status            STRING NOT NULL CHECK (status IN ('reserved', 'completed', 'fallback')),
  player_text       STRING NOT NULL,
  reply             STRING NULL,
  speech_act        STRING NULL,
  structured_outcome JSONB NOT NULL DEFAULT '{}',
  input_hash        STRING NULL,
  prompt_version    STRING NULL,
  model_id          STRING NULL,
  budget_tier       STRING NOT NULL DEFAULT 'normal' CHECK (budget_tier IN
                       ('normal', 'background_degraded', 'critical_only', 'exhausted')),
  tokens_in         INT8 NOT NULL DEFAULT 0,
  tokens_out        INT8 NOT NULL DEFAULT 0,
  latency_ms        INT8 NOT NULL DEFAULT 0,
  deadline_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ NULL,
  PRIMARY KEY (world_id, turn_id),
  UNIQUE (world_id, conversation_id, ordinal),
  FOREIGN KEY (world_id, conversation_id)
    REFERENCES world_conversation_sessions (world_id, conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS conversation_turns_pending_idx
  ON world_conversation_turns (world_id, status, deadline_at);

-- ===========================================================================
-- SECTION 4 — Append-only history
--
-- Rows here are INSERTed and never UPDATEd or DELETEd. Every table carries
-- (tick, seq) so that replay has a total order independent of storage order.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS world_events (
  world_id       UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  event_id       UUID NOT NULL DEFAULT gen_random_uuid(),
  tick           INT8 NOT NULL,
  seq            INT8 NOT NULL,
  location_id    UUID NULL,
  actor_agent_id UUID NULL,
  kind           STRING NOT NULL CHECK (kind IN
    ('dialogue', 'accusation', 'movement', 'escalation', 'player_command', 'trigger')),
  payload        JSONB NOT NULL DEFAULT '{}',
  description    STRING NOT NULL,
  -- Operational. Recorded so the AS OF SYSTEM TIME demo has real commit
  -- timestamps to aim at; never used as simulation time.
  commit_ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, event_id),
  UNIQUE (world_id, tick, seq),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id),
  FOREIGN KEY (world_id, actor_agent_id) REFERENCES world_agents (world_id, agent_id)
);

-- Perception reads "what happened here recently".
CREATE INDEX IF NOT EXISTS world_events_perception_idx
  ON world_events (world_id, location_id, tick DESC);

CREATE TABLE IF NOT EXISTS world_memories (
  world_id         UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  memory_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL,
  tick             INT8 NOT NULL,
  seq              INT8 NOT NULL,
  kind             STRING NOT NULL CHECK (kind IN
    ('observation', 'reflection', 'plan', 'rumor', 'dialogue')),
  content          STRING NOT NULL,
  -- Titan Text Embeddings V2. Float data, but the rules never arithmetic on it
  -- directly: cosine distance is quantised to fixed point at the boundary.
  embedding        VECTOR(1024) NOT NULL,
  importance       INT8 NOT NULL CHECK (importance BETWEEN 0 AND 10000),
  subject_agent_id UUID NULL,
  claim_id         UUID NULL,
  PRIMARY KEY (world_id, memory_id),
  UNIQUE (world_id, tick, seq),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, subject_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id)
);

-- ANN scoping. Retrieval is always "this agent's memories in this world", so
-- BOTH columns belong in the index prefix: with world_id alone the optimizer
-- cannot satisfy the agent_id predicate from the index and falls back to a
-- scan-and-filter, quietly losing the index entirely.
--
-- The cosine opclass must also match the <=> operator used by retrieval; an
-- l2 index simply will not be chosen for a cosine query.
CREATE VECTOR INDEX IF NOT EXISTS world_memories_embedding_idx
  ON world_memories (world_id, agent_id, embedding vector_cosine_ops);

-- Retrieval draws candidates three ways — nearest, most important, most recent —
-- so that a highly important memory can still surface even when it is
-- lexically distant from the situation at hand. These two indexes serve the
-- latter two draws.
CREATE INDEX IF NOT EXISTS world_memories_by_agent_idx
  ON world_memories (world_id, agent_id, tick DESC);

CREATE INDEX IF NOT EXISTS world_memories_by_importance_idx
  ON world_memories (world_id, agent_id, importance DESC);

-- Retrieval bumps recency by appending here rather than mutating the memory,
-- which is what keeps world_memories genuinely append-only.
CREATE TABLE IF NOT EXISTS memory_accesses (
  world_id      UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  access_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  memory_id     UUID NOT NULL,
  accessed_tick INT8 NOT NULL,
  PRIMARY KEY (world_id, access_id),
  FOREIGN KEY (world_id, memory_id) REFERENCES world_memories (world_id, memory_id)
);

CREATE TABLE IF NOT EXISTS memory_source_edges (
  world_id        UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  edge_id         UUID NOT NULL,
  memory_id       UUID NOT NULL,
  source_kind     STRING NOT NULL CHECK (source_kind IN ('memory', 'event', 'turn')),
  source_memory_id UUID NULL,
  source_event_id UUID NULL,
  source_turn_id  UUID NULL,
  PRIMARY KEY (world_id, edge_id),
  FOREIGN KEY (world_id, memory_id) REFERENCES world_memories (world_id, memory_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, source_memory_id) REFERENCES world_memories (world_id, memory_id),
  FOREIGN KEY (world_id, source_event_id) REFERENCES world_events (world_id, event_id),
  FOREIGN KEY (world_id, source_turn_id) REFERENCES world_conversation_turns (world_id, turn_id),
  CONSTRAINT exactly_one_memory_source CHECK (
    (CASE WHEN source_memory_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN source_event_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN source_turn_id IS NULL THEN 0 ELSE 1 END) = 1)
);

CREATE TABLE IF NOT EXISTS player_agent_relationship_updates (
  world_id      UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  update_id     UUID NOT NULL,
  player_id     UUID NOT NULL,
  agent_id      UUID NOT NULL,
  tick          INT8 NOT NULL,
  seq           INT8 NOT NULL,
  trust_delta   INT8 NOT NULL DEFAULT 0,
  affinity_delta INT8 NOT NULL DEFAULT 0,
  fear_delta    INT8 NOT NULL DEFAULT 0,
  respect_delta INT8 NOT NULL DEFAULT 0,
  impression    STRING NULL,
  conversation_id UUID NULL,
  PRIMARY KEY (world_id, update_id),
  UNIQUE (world_id, tick, seq),
  FOREIGN KEY (world_id, player_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, conversation_id)
    REFERENCES world_conversation_sessions (world_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS world_inference_usage (
  world_id      UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  usage_id      UUID NOT NULL,
  category      STRING NOT NULL CHECK (category IN
                  ('player_turn', 'conversation_summary', 'npc_dialogue',
                   'reflection', 'planning', 'instigator', 'embedding', 'other')),
  source_key    STRING NOT NULL,
  attempt       INT8 NOT NULL DEFAULT 0,
  model_id      STRING NOT NULL,
  calls         INT8 NOT NULL DEFAULT 1,
  tokens_in     INT8 NOT NULL DEFAULT 0,
  tokens_out    INT8 NOT NULL DEFAULT 0,
  est_cost_micros INT8 NOT NULL DEFAULT 0,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, usage_id),
  UNIQUE (world_id, category, source_key, attempt)
);

-- "When was this memory last touched" is a descending-limit-1 lookup.
CREATE INDEX IF NOT EXISTS memory_accesses_recency_idx
  ON memory_accesses (world_id, memory_id, accessed_tick DESC);

CREATE TABLE IF NOT EXISTS belief_updates (
  world_id         UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  belief_update_id UUID NOT NULL DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL,
  claim_id         UUID NOT NULL,
  tick             INT8 NOT NULL,
  seq              INT8 NOT NULL,
  confidence       INT8 NOT NULL CHECK (confidence BETWEEN -10000 AND 10000),
  cause_event_id   UUID NULL,
  PRIMARY KEY (world_id, belief_update_id),
  UNIQUE (world_id, tick, seq),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id),
  FOREIGN KEY (world_id, cause_event_id) REFERENCES world_events (world_id, event_id)
);

-- "What did this agent believe at tick T" — the product's history mechanism.
CREATE INDEX IF NOT EXISTS belief_updates_history_idx
  ON belief_updates (world_id, agent_id, claim_id, tick DESC);

CREATE TABLE IF NOT EXISTS world_rumor_spread (
  world_id       UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  rumor_id       UUID NOT NULL,
  agent_id       UUID NOT NULL,
  received_tick  INT8 NOT NULL,
  -- The telephone effect: the wording this particular agent received.
  distorted_text STRING NOT NULL,
  from_agent_id  UUID NULL,
  PRIMARY KEY (world_id, rumor_id, agent_id),
  FOREIGN KEY (world_id, rumor_id) REFERENCES world_rumors (world_id, rumor_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, from_agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_rumor_tellings (
  world_id      UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  telling_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  rumor_id      UUID NOT NULL,
  claim_id      UUID NOT NULL,
  from_agent_id UUID NULL,
  to_agent_id   UUID NOT NULL,
  event_id      UUID NULL,
  tick          INT8 NOT NULL,
  seq           INT8 NOT NULL,
  channel       STRING NOT NULL CHECK (channel IN ('gossip', 'dialogue', 'accusation', 'player')),
  PRIMARY KEY (world_id, telling_id),
  UNIQUE (world_id, tick, seq),
  FOREIGN KEY (world_id, rumor_id) REFERENCES world_rumors (world_id, rumor_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id),
  FOREIGN KEY (world_id, from_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, to_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, event_id) REFERENCES world_events (world_id, event_id)
);

CREATE INDEX IF NOT EXISTS world_rumor_tellings_source_idx
  ON world_rumor_tellings (world_id, to_agent_id, claim_id, tick DESC);

CREATE TABLE IF NOT EXISTS world_hearings (
  world_id       UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  hearing_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  convener_id    UUID NOT NULL,
  location_id    UUID NOT NULL,
  due_tick       INT8 NOT NULL,
  status         STRING NOT NULL DEFAULT 'announced' CHECK (status IN
                   ('announced', 'gathering', 'in_session', 'resolved', 'abandoned')),
  reveal_claim_id UUID NULL,
  announced_tick INT8 NOT NULL,
  resolved_tick  INT8 NULL,
  PRIMARY KEY (world_id, hearing_id),
  FOREIGN KEY (world_id, convener_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id),
  FOREIGN KEY (world_id, reveal_claim_id) REFERENCES world_claims (world_id, claim_id)
);

CREATE TABLE IF NOT EXISTS world_agent_commitments (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  hearing_id   UUID NULL,
  location_id  UUID NOT NULL,
  due_tick     INT8 NOT NULL,
  source       STRING NOT NULL CHECK (source IN ('player', 'trigger', 'agent')),
  response     STRING NOT NULL CHECK (response IN ('come', 'decline', 'come_but_tell_someone')),
  status       STRING NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'kept', 'broken')),
  created_tick INT8 NOT NULL,
  PRIMARY KEY (world_id, agent_id, due_tick),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, hearing_id) REFERENCES world_hearings (world_id, hearing_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id)
);

CREATE TABLE IF NOT EXISTS world_player_evidence (
  world_id    UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  player_id   UUID NOT NULL,
  evidence_id UUID NOT NULL DEFAULT gen_random_uuid(),
  kind        STRING NOT NULL CHECK (kind IN ('provenance', 'contradiction', 'record')),
  telling_id  UUID NULL,
  event_id    UUID NULL,
  claim_id    UUID NULL,
  accused_id  UUID NULL,
  genuine     BOOL NOT NULL,
  found_tick  INT8 NOT NULL,
  PRIMARY KEY (world_id, evidence_id),
  UNIQUE (world_id, player_id, kind, telling_id, event_id),
  FOREIGN KEY (world_id, player_id) REFERENCES world_players (world_id, player_id),
  FOREIGN KEY (world_id, telling_id) REFERENCES world_rumor_tellings (world_id, telling_id),
  FOREIGN KEY (world_id, event_id) REFERENCES world_events (world_id, event_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id),
  FOREIGN KEY (world_id, accused_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS world_state_history (
  world_id         UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  tick             INT8 NOT NULL,
  global_tension   INT8 NOT NULL CHECK (global_tension BETWEEN 0 AND 10000),
  escalation_stage STRING NOT NULL CHECK (escalation_stage IN
    ('calm', 'suspicion', 'accusations', 'trials', 'first_blood', 'war')),
  PRIMARY KEY (world_id, tick)
);

CREATE TABLE IF NOT EXISTS trigger_firings (
  world_id    UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  trigger_key STRING NOT NULL,
  fired_tick  INT8 NOT NULL,
  -- A `once` trigger cannot fire twice because trigger_key is the key.
  PRIMARY KEY (world_id, trigger_key)
);

CREATE TABLE IF NOT EXISTS cognition_records (
  world_id       UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  record_id      UUID NOT NULL DEFAULT gen_random_uuid(),
  tick           INT8 NOT NULL,
  agent_id       UUID NOT NULL,
  task           STRING NOT NULL DEFAULT 'plan' CHECK (task IN
                   ('plan', 'reflect', 'dialogue', 'strategy', 'attendance')),
  -- Hash of the exact prompt inputs. Replay matches on this, so a changed
  -- prompt is detected rather than silently replayed against stale decisions.
  input_hash     STRING NOT NULL,
  decision       JSONB NOT NULL,
  model_id       STRING NOT NULL,
  prompt_version STRING NOT NULL,
  tokens_in      INT8 NOT NULL DEFAULT 0,
  tokens_out     INT8 NOT NULL DEFAULT 0,
  latency_ms     INT8 NOT NULL DEFAULT 0,
  -- Vectors for the memories this decision formed, so a replay can write those
  -- memories without calling an embedding model. Without them a recording is
  -- not self-contained: replaying it would require the provider that made it to
  -- still be reachable, which is the dependency replay exists to remove.
  --
  -- Deliberately real VECTOR columns rather than numbers inside `decision`:
  -- 1024 floats as JSON text is several times the size, for no gain.
  -- NULL when the decision formed no memory — a degraded round, or a
  -- reflection that was not taken.
  observation_vector VECTOR(1024) NULL,
  reflection_vector  VECTOR(1024) NULL,
  PRIMARY KEY (world_id, record_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);

-- For databases created before the vectors were recorded.
ALTER TABLE cognition_records
  ADD COLUMN IF NOT EXISTS observation_vector VECTOR(1024) NULL;
ALTER TABLE cognition_records
  ADD COLUMN IF NOT EXISTS reflection_vector VECTOR(1024) NULL;
ALTER TABLE cognition_records
  ADD COLUMN IF NOT EXISTS task STRING NOT NULL DEFAULT 'plan';
ALTER TABLE cognition_records DROP CONSTRAINT IF EXISTS check_task;
ALTER TABLE cognition_records ADD CONSTRAINT check_task
  CHECK (task IN ('plan', 'reflect', 'dialogue', 'strategy', 'attendance'));

CREATE INDEX IF NOT EXISTS cognition_records_replay_idx
  ON cognition_records (world_id, tick, agent_id);

-- Dialogue prompt grounding asks whether an agent historically planted a
-- scheme claim as of a simulated tick. Keep that interactive lookup scoped to
-- the world's agent and the small strategy subset rather than scanning every
-- per-tick cognition row.
CREATE INDEX IF NOT EXISTS cognition_records_agent_task_tick_idx
  ON cognition_records (world_id, agent_id, task, tick);

-- The backstop against a duplicate tick under split-brain: two schedulers can
-- race, but only one can insert (world_id, tick).
CREATE TABLE IF NOT EXISTS world_tick_commits (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  tick         INT8 NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms  INT8 NOT NULL DEFAULT 0,
  retry_count  INT8 NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, tick)
);

CREATE TABLE IF NOT EXISTS world_commands (
  world_id        UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  command_id      UUID NOT NULL DEFAULT gen_random_uuid(),
  -- Client-provided. A retried request is a no-op returning the first outcome.
  idempotency_key STRING NOT NULL,
  command_seq     INT8 NOT NULL,
  kind            STRING NOT NULL CHECK (kind IN
    ('converse', 'conversation_start', 'conversation_turn', 'conversation_close',
     'finalize_conversation', 'summon', 'move_player', 'restart', 'set_time_scale',
     'romance_choice')),
  payload         JSONB NOT NULL DEFAULT '{}',
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_tick    INT8 NULL,
  PRIMARY KEY (world_id, command_id),
  UNIQUE (world_id, idempotency_key),
  UNIQUE (world_id, command_seq)
);

ALTER TABLE world_commands DROP CONSTRAINT IF EXISTS check_kind;
ALTER TABLE world_commands ADD CONSTRAINT check_kind
  CHECK (kind IN ('converse', 'conversation_start', 'conversation_turn',
                  'conversation_close', 'finalize_conversation', 'summon',
                  'move_player', 'restart', 'set_time_scale', 'romance_choice'));

-- Pending commands are drained in order each tick.
CREATE INDEX IF NOT EXISTS world_commands_pending_idx
  ON world_commands (world_id, applied_tick, command_seq);
