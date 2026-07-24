# Hollowmere — implementation plan

---

## STATUS — 2026-07-24

**Phase 1 (engine): 8 of 12 milestones complete. 130 tests passing, typecheck clean.**

| # | Milestone | State | Evidence |
|---|---|---|---|
| 1 | Preflight gate | **done** | 9/9 checks, `./scripts/preflight.sh`, repeatable against Cloud |
| 2 | Conventions module | **done** | 47 tests — `fixedpoint` / `rng` / `decay` |
| 3 | Schema + DB layer | **done** | 32 tables, 8 conformance tests |
| 4 | Scenario + loader | **done** | 23 tests, 40 agents, allowlisted trigger DSL |
| 5 | Inference layer | **done** | 20 tests, stub + Bedrock behind one interface |
| 6 | Retrieval | **done** | 14 tests incl. query-plan assertion |
| 7 | Gossip + beliefs | **done** | 18 tests incl. polarization + misinformation |
| 8 | Tension / stages / peace / triggers | **next** | — |
| 9 | `runTick` + scheduler | pending | — |
| 10 | `converse` | pending | — |
| 11 | Harness | pending | — |
| 12 | Debug dashboard | pending | — |

### Verified against the real cluster (CockroachDB v26.2.4, 3-node Docker)

- Cross-world foreign key reference **rejected by the database**.
- Zero float/decimal columns outside `VECTOR` embeddings.
- Duplicate `(world_id, tick)` commit **rejected** — the split-brain backstop.
- ANN query plan shows `vector search` + `prefix spans` scoped to one world.
- Belief projection rebuilt from append-only history matches the live projection exactly.
- Two houses **polarize** rather than converge on a shared accusation.
- A claim the engine knows is **false** still reaches actionable belief.

### Decisions changed during implementation

Each of these came from the code disagreeing with the plan, not from preference.

1. **`world_state.faction_tension` JSONB → `world_faction_state` table.** Convention 9
   forbids JSONB for values the rules compare, and per-faction tension is compared
   every tick.
2. **`agent_beliefs.confidence` is signed.** An agent must be able to *actively
   disbelieve* a claim, or the `dispute`/`defend` speech acts have nothing to move.
3. **Vector index prefix is `(world_id, agent_id, embedding)`, not `(world_id, embedding)`.**
   Retrieval is always per-agent; with only `world_id` the optimizer cannot satisfy
   the `agent_id` predicate from the index and silently falls back to scan-and-filter.
   Caught only by asserting the plan — results were correct throughout.
4. **Retrieval draws candidates three ways, not ANN-first.** `nearest ∪ most_important
   ∪ most_recent`, then exact integer re-rank. ANN-first made relevance a gatekeeper,
   so an important-but-lexically-distant memory could never be recalled.
5. **`scenario_versions.opening` is a real column**, not a reserved `__opening__`
   trigger row, so a world is rebuildable from the database alone.
6. **`faction_templates.belligerent`** added — the unaligned (magistrate, priest,
   physician) carry gossip but are never a side in the war.
7. **Gossip writes no `world_memories`.** Hearing is recorded in `world_rumor_spread`
   + a belief update; embedding into a retrievable memory happens in cognition, only
   for agents who actually think. Embedding every retelling for 40 agents costs far
   more than it buys.
8. **Stub embeddings are a signed hashing vectoriser** with stopword filtering and
   3 hashes per token — not random vectors. Random vectors would make every
   retrieval test vacuous; the first two versions produced measurable false
   similarity from stopwords and from single-hash collisions.

### Blocked / waiting

- **Bedrock model access.** AWS account created 2026-07-24 and is minutes old.
  Credentials, IAM (`AmazonBedrockFullAccess`), region, and entitlement all verify
  clean; only `authorizationStatus` is `NOT_AUTHORIZED`, which is fresh-account
  propagation. Nothing to fix — retry `npm run check:bedrock`. The engine runs
  fully on `INFERENCE_MODE=stub` meanwhile, which is why this blocks nothing.

### Known gaps to address next

- `loadListeners` runs one query per rumor-holder per tick. Fine at current scale,
  but it is the obvious hot spot once ticks run continuously.
- Distortion costs one model call per reworded retelling; capped by
  `GOSSIP.distortionChance` and skippable via `allowDistortion`, but not yet wired
  to the per-world budget.

---

**A visual stress test for persistent multi-agent memory, misinformation propagation, and transactional consistency — presented as a playable town.**

*(Crucible-inspired in dynamics only. Original town, characters, and text — no reproduction of Miller's work.)*

---

## 1. Context and positioning

Submission for the **CockroachDB AI hackathon** (cockroachdb-ai.devpost.com), deadline **Aug 18 2026**. Priority is a **competitive, complete submission** over a deeper engine.

The player is an **outsider** in a town of ~40 AI NPCs split across two **factions**. Suspicion and accusations propagate person-to-person; a **tension engine** escalates through named stages toward war. Left alone, the town destroys itself. The player influences it through **conversation**.

**Judging frame — do not present this as "an AI game."** Present it as an executable testbed for:
- **Persistent multi-agent memory** at concurrent scale (40 agents × N isolated worlds × vector retrieval).
- **Misinformation propagation** — how a false claim spreads, distorts, and hardens into belief.
- **Transactional consistency** under genuine contention (player writes vs. scheduler writes on shared state).
- **Intervention analysis** — measuring whether a targeted action changed a trajectory.

The town is the visualization; the substrate is the product.

---

## 2. Locked decisions

### Product
| Decision | Value |
|---|---|
| Goal | Competitive complete submission by Aug 18 |
| Isolation | **One private world per player.** `world_id` on every mutable row |
| Identity | Anonymous, signed session cookie. No accounts |
| World lifecycle | Pause after 10 min inactivity · expire after 24 h · **30 min active-runtime cap** · explicit "Restart town" |
| **Game loop length** | **A full arc may take the entire 30 minutes.** Pacing is not constrained by video length — the demo video is shot and edited afterward |
| Determinism | Stub runs **exactly reproducible** from `{scenarioVersion, seed, playerCommands}` |
| Product history | Reconstructed **by simulation tick** from append-only history |
| `AS OF SYSTEM TIME` | Separate **database-resilience demonstration** using recorded commit timestamps — never the product history mechanism |
| Escalation | Tension fluctuates; **stages never reverse**. Peace reachable through `trials`; `first_blood` is the normal point of no return |
| Hard triggers | Authored critical events (murder, armed attack, leader assassination) jump **straight to `war`** regardless of tension |
| Peace | **Rules-determined, never LLM-declared** |

### Technical
| Decision | Value |
|---|---|
| Language | TypeScript throughout |
| Inference | **Bedrock Claude Haiku** (cognition + dialogue) · **Titan Text Embeddings V2, 1024-dim** · deterministic **stub** · Nova Lite fallback |
| Dev database | Local **3-node Docker** CockroachDB cluster |
| Prod database | **CockroachDB Cloud** |
| Hosting | **AWS ECS/Fargate** — web service + scheduler service |
| CRDB tools (first-class) | **Distributed Vector Indexing**, **Managed MCP Server** (powers the read-only *Town Investigator*) |
| CRDB tool (third) | **`ccloud`** — repeatable provisioning + operational diagnostics |
| Cadence | Rules tick **5 s** = 15 in-world min (96 ticks/day) · cognition every **30 s**, ≤2 NPCs (burst ≤6) · conversations immediate |
| Canonical arc | Unattended run reaches `war` in **192–288 ticks**; hard ceiling **360 ticks** (30 min at 1×) |
| `time_scale` | Fixed-point multiplier. Used for **headless tests and video editing**, not to rescue pacing |

---

## 3. Schema conventions (hard rules)

These are non-negotiable and apply to every table.

1. **Random UUID entity identifiers** — `UUID DEFAULT gen_random_uuid()`. No sequential IDs (also avoids range hotspots).
2. **Composite world-scoped primary keys** — `PRIMARY KEY (world_id, <entity>_id)` on every per-world table.
3. **Composite foreign keys** — every per-world FK references `(world_id, <entity>_id)`, making a cross-world reference structurally impossible.
4. **`INT8` for ticks and command sequences.**
5. **Fixed-point integers for all simulation values.** `SCALE = 10000`.
   - `tension`, `heat`, `trust`, `importance`: `0 .. 10000`
   - `sentiment`, `valence`, `reputation`, `confidence`: `-10000 .. 10000`
6. **No floating point anywhere in deterministic rules.** All rule arithmetic is integer. A single helper module defines `fpMul(a,b) = (a*b)/SCALE` and `fpDiv`, both **truncating toward zero**. Exponential decay comes from a **precomputed integer lookup table**, never `Math.exp`.
7. **`TIMESTAMPTZ` is operational metadata only** — logging, leases, expiry, and the `AS OF SYSTEM TIME` demo. **Simulation time is always `tick INT8`.**
8. **`STRING` + `CHECK` constraints instead of database enums** — enums are painful to evolve.
9. **`JSONB` only for genuinely variable structures** — personas, plans, trigger definitions, event payloads. Never for values the rules compare or order on.
10. **Immutable scenario versions.** Published scenario rows are never edited; a change means a new `scenario_version_id`.
11. **Append-only history + mutable current-state projections.** History tables are insert-only; projections are derived and rebuildable from history.
12. **Every external command carries a client-provided idempotency key**, unique per world.
13. **Every deterministic collection is explicitly ordered** — every query feeding rule logic has an `ORDER BY` over a total key. No reliance on natural order.

---

## 4. Architecture

```
Browser ── Next.js (ECS service)
   │         session cookie → one world
   │         SSE for dialogue · ~1s poll for panels
   ▼
Engine package (imported by both services)
   │
   ├── web service   → converse() on demand, immediate
   └── scheduler svc → runTick() per owned world, lease-guarded
                            │
   ┌────────────────────────┴────────────────────────┐
   ▼                                                 ▼
CockroachDB Cloud                            Bedrock (Haiku + Titan)
   ▲
   └── Managed MCP Server → Town Investigator (read-only role)
```

**Two services, one database.** Player writes and scheduler writes genuinely contend on shared per-world rows — that contention *is* the serializable-isolation demonstration, not a staged one.

**Scheduler ownership.** A world advances only under a database-backed **lease** with expiry. The loop is a **non-overlapping async loop**, never bare `setInterval`. `world_tick_commits` carries `PRIMARY KEY (world_id, tick)`, so a duplicate tick is impossible even under split-brain.

---

## 5. Data model

### Static scenario definitions — immutable once published
```
scenario_versions   scenario_version_id UUID PK, version STRING, name STRING,
                    checksum STRING, published_at TIMESTAMPTZ
faction_templates   PK (scenario_version_id, faction_key)
agent_templates     PK (scenario_version_id, agent_key)   persona JSONB, routine JSONB
district_templates  PK (scenario_version_id, district_key)
location_templates  PK (scenario_version_id, location_key)  x INT8, y INT8
route_templates     PK (scenario_version_id, from_location_key, to_location_key)  cost INT8
claim_templates     PK (scenario_version_id, claim_key)
                    truth STRING CHECK (truth IN ('true','false','unknown'))
trigger_templates   PK (scenario_version_id, trigger_key)
                    condition JSONB, effect JSONB, priority INT8, once BOOL
```

### Per-world instantiation
Factions and locations are instantiated per world so composite FKs can enforce isolation.
```
worlds              world_id UUID PK
                    scenario_version_id UUID NOT NULL REFERENCES scenario_versions
                    seed INT8, current_tick INT8, command_seq INT8
                    status STRING CHECK IN ('active','paused','ended','expired')
                    ending STRING NULL CHECK IN ('war','peace','expired')
                    time_scale INT8 NOT NULL DEFAULT 10000
                    active_runtime_ms INT8
                    created_at / last_activity_at / lease_expires_at TIMESTAMPTZ
                    lease_owner STRING NULL

world_factions      PK (world_id, faction_id)   faction_key STRING
world_locations     PK (world_id, location_id)  location_key STRING, district_key STRING, x INT8, y INT8
world_routes        PK (world_id, from_location_id, to_location_id)  cost INT8
```

### Mutable current-state projections
```
world_agents        PK (world_id, agent_id)
                    agent_key STRING, persona JSONB
                    FK (world_id, faction_id) → world_factions
                    FK (world_id, location_id) → world_locations
                    status STRING CHECK IN ('alive','injured','missing','dead')
                    current_plan JSONB, current_action STRING, updated_tick INT8

world_relationships PK (world_id, src_agent_id, dst_agent_id)
                    sentiment INT8 CHECK (-10000..10000)
                    trust INT8 CHECK (0..10000)
                    updated_tick INT8

agent_beliefs       PK (world_id, agent_id, claim_id)
                    confidence INT8 CHECK (-10000..10000), updated_tick INT8

world_state         PK (world_id)
                    global_tension INT8 CHECK (0..10000)
                    faction_tension JSONB
                    escalation_stage STRING CHECK IN
                      ('calm','suspicion','accusations','trials','first_blood','war')
                    day INT8, phase STRING

world_rumors        PK (world_id, rumor_id)
                    FK (world_id, claim_id), FK (world_id, origin_event_id)
                    heat INT8 (0..10000), valence INT8 (-10000..10000), created_tick INT8

world_players       PK (world_id, player_id)  session_id STRING, FK (world_id, location_id)
player_reputation   PK (world_id, player_id, faction_id)  reputation INT8 (-10000..10000)
world_budget        PK (world_id)  inference_calls INT8, tokens_in INT8, tokens_out INT8,
                    est_cost_micros INT8
```

### Append-only history
Every history row carries `(tick INT8, seq INT8)` and is ordered by `(world_id, tick, seq)` — the total order that makes replay deterministic.
```
world_events        PK (world_id, event_id)   UNIQUE (world_id, tick, seq)
                    FK (world_id, location_id), FK (world_id, actor_agent_id)
                    kind STRING CHECK IN ('dialogue','accusation','movement',
                                          'escalation','player_command','trigger')
                    payload JSONB, description STRING
                    commit_ts TIMESTAMPTZ            -- operational only

world_memories      PK (world_id, memory_id)  UNIQUE (world_id, tick, seq)
                    FK (world_id, agent_id)
                    kind STRING CHECK IN ('observation','reflection','plan','rumor','dialogue')
                    content STRING, embedding VECTOR(1024)
                    importance INT8 CHECK (0..10000)
                    subject_agent_id UUID NULL, claim_id UUID NULL, created_tick INT8

memory_accesses     PK (world_id, access_id)  FK (world_id, memory_id), accessed_tick INT8
belief_updates      PK (world_id, belief_update_id)  UNIQUE (world_id, tick, seq)
                    FK (world_id, agent_id), FK (world_id, claim_id)
                    confidence INT8, cause_event_id UUID
world_rumor_spread  PK (world_id, rumor_id, agent_id)  received_tick INT8, distorted_text STRING
world_state_history PK (world_id, tick)  global_tension INT8, escalation_stage STRING
world_claims        PK (world_id, claim_id)  claim_key STRING, text STRING,
                    subject_agent_id UUID, truth STRING CHECK IN ('true','false','unknown')
trigger_firings     PK (world_id, trigger_key)  fired_tick INT8
cognition_records   PK (world_id, record_id)  tick INT8, FK (world_id, agent_id),
                    input_hash STRING, decision JSONB, model_id STRING,
                    prompt_version STRING, tokens_in/out INT8, latency_ms INT8
world_tick_commits  PK (world_id, tick)  committed_at TIMESTAMPTZ, duration_ms INT8, retry_count INT8
world_commands      PK (world_id, command_id)  UNIQUE (world_id, idempotency_key)
                    command_seq INT8, kind STRING CHECK, payload JSONB,
                    received_at TIMESTAMPTZ, applied_tick INT8 NULL
```

**Why this shape:**
- `world_memories` is genuinely append-only — access tracking lives in `memory_accesses`.
- **Belief is first-class.** `world_claims` + `belief_updates` durably answer "what did this agent believe at tick T"; `agent_beliefs` is the rebuildable projection.
- **Truth ≠ belief.** `truth` may be `unknown`, so ambiguity is real and a false claim can still reach high confidence.
- Spotlight membership is **ephemeral per tick**, never persisted. `world_agents.status` is character state only.

---

## 6. Engine contracts

### `runTick(worldId, tick)`
Steps 1–3 and 5–7 are deterministic integer rule logic. Only step 4 touches Bedrock.

1. **Advance + perceive** — bump phase; gather new `world_events` per location, ordered by `(tick, seq)`.
2. **Gossip diffusion (all agents, rules)** — spread hot rumors along relationship edges; write `world_rumor_spread`, memories, and `belief_updates`; shift sentiment; accrue tension.
3. **Spotlight selection** — ephemeral: near player · in a fresh salient event · just hit by a hot rumor. ≤2 normally, ≤6 burst.
4. **Cognition (spotlit agents, concurrent, Haiku)** — perceive → retrieve → maybe reflect → plan. **Entirely outside any transaction.** Captured to `cognition_records`.
5. **Routine advancement (ambient, rules)** — one route segment toward the phase's scheduled location.
6. **Commit (`SERIALIZABLE`)** — apply movement, actions, rumor seeds, relationship/tension/belief writes, and pending `world_commands`. **Database work only** inside the retry callback. Idempotent on `(world_id, tick)`.
7. **Escalation + triggers** — recompute tension; monotonic stage transitions; evaluate triggers by `(priority, trigger_key)`; check peace conditions.

### Retrieval — integer scoring
`score = w_r·recency + w_i·importance + w_l·relevance`, all fixed-point `0..10000`:
- `recency` — integer **decay lookup table** indexed by `Δticks` since last access (from `memory_accesses`), clamped. No `Math.exp`.
- `importance` — stored fixed-point.
- `relevance` — vector distance **quantized to fixed-point at the boundary**, before any rule arithmetic.

Fetch `k_candidates` ordered by `(distance, memory_id)`, re-rank exactly with integer math, tie-break on `memory_id`, then append `memory_accesses`. **The exact re-ranker is tested separately from approximate-index recall** — they fail differently. Deterministic runs use a deterministic candidate ordering so ANN variability cannot leak into rule outcomes.

### Gossip
`heat` decays by a fixed-point factor per tick. Transmission probability `p = fpMul(fpMul(base, heat), fpMul(rel_weight, colocation))`, compared against the seeded integer PRNG. On transmit: receiver gains a (sometimes distorted) rumor memory **and a `belief_updates` row**; sentiment shifts by `valence × faction_alignment` (in-group defends, out-group believes). Cross-faction accusations raise tension.

### Escalation and peace
Stages `calm → suspicion → accusations → trials → first_blood → war`. Tension rises and falls; **stages never reverse**. Entering a stage emits an event and biases NPC behavior more accusatory — the self-reinforcing loop that yields war under no input.

**Peace (rules only, never LLM):** both faction leaders willing to negotiate · global tension below threshold · no critical hostile rumor above heat threshold · **sustained K consecutive ticks**. Reachable through `trials`. Dialogue moves the inputs; Claude cannot declare the outcome.

**Hard triggers** (murder, armed attack, leader assassination) jump directly to `war` from any stage.

### `converse(worldId, agentId, playerText, idempotencyKey)` — ordered for durability
1. **Record the command** in `world_commands` (unique idempotency key) and **persist the player utterance** as a `world_event` — before any model call. A retried request with the same key is a no-op returning the original outcome.
2. **Classify** into `accuse | defend | corroborate | dispute | reconcile | threaten | inform | inquire | smalltalk`, resolving subject and `claim_id` separately with an **`unknown` fallback rather than guessing**.
3. **Apply effects transactionally** — rumor seed/boost, sentiment shift, `belief_updates`, reputation.
4. **Stream the NPC reply**, then persist the completed response.

Streaming failure after step 3 leaves state correct. Classification failure leaves the utterance durably recorded with effects skipped, never half-applied.

### Movement
Scenario defines a **logical location graph** with integer coordinates and routes. NPCs traverse one segment per tick. No tile collision or pathfinding in the engine — Phaser interpolates coordinates later.

### Determinism contract (stub mode)
Integer PRNG seeded per `(world_id, tick)` · stable agent ordering by `agent_id` · explicit `ORDER BY` on every rule-feeding query · captured cognition results · deterministic commit ordering · **no wall-clock and no floating point in rules**. Real-model runs are **replayable** from `cognition_records` with zero Bedrock calls, though not bit-for-bit reproducible.

### Trigger language
Small **allowlisted, validated** condition/effect DSL — integer comparisons over tension, stage, tick, relationships, rumor heat, belief confidence; effects from a fixed verb set. Scenario JSON is **schema-versioned and validated on load**. **Never interpret arbitrary code from scenario data.**

---

## 7. Concurrency and correctness

- **Serializable by default**; client-side retry on SQLSTATE `40001`, with `retry_count` recorded.
- **Correct claim:** not "one wins, one loses." Both transactions may commit in a valid serial order after retry. The test asserts **no lost update, no torn state, and ≥1 observed retry**.
- **No inference inside a retryable transaction** — a retry would re-bill inference and could duplicate streamed output.
- **Tick leases** prevent two schedulers advancing one world; `PRIMARY KEY (world_id, tick)` on `world_tick_commits` is the backstop.
- **Command idempotency** — every external command is deduplicated on `(world_id, idempotency_key)`.

---

## 8. Production readiness

| Area | Implementation |
|---|---|
| Logging | Structured JSON: `world_id`, `tick`, phase, duration |
| Metrics | Tick latency · inference latency · retry counts · spotlight size · scheduler lag |
| Cost | Per-world token and estimated-cost accounting in `world_budget` |
| Health | Scheduler heartbeat, lease age, stalled-world detection |
| Budget control | Per-world inference cap → **fall back to deterministic cognition** when exhausted |
| Abuse control | 30 min active runtime per world · conversation rate limiting · session-scoped worlds |
| Prompt injection | Player and NPC text are **untrusted data**. Classification output is allowlist-validated; model output never selects effects directly and never triggers tools |
| Least privilege | Dedicated **read-only role** for the dashboard and the MCP Town Investigator |

---

## 9. Repo structure

```
/db          schema.sql, migrations
/scenario    versioned JSON (factions, agents, districts, routes, claims, triggers) + validating loader
/engine      runTick.ts, converse.ts, cognition/, gossip.ts, tension.ts, peace.ts, beliefs.ts,
             triggers.ts, retrieval.ts, movement.ts, fixedpoint.ts, rng.ts,
             bedrock.ts (+stub), db.ts, api.ts
/scheduler   loop.ts (lease-guarded, non-overlapping), worker.ts
/harness     sim.ts (headless: seed → N ticks → scripted commands → chronicle/tension/social report)
             repl.ts (talk, tick, graph, belief, where)
/web         Next.js: session→world, /api (converse SSE, world, graph, chronicle, belief, investigator)
             debug dashboard → later the Phaser client
/infra       docker-compose (3-node CRDB), ECS task definitions
/scripts     seed-scenario, ccloud provisioning, node-kill rehearsal, replay
```

---

## 10. Milestones

### Phase 1 — Engine (current phase)
1. **Preflight.** Stand up the 3-node Docker cluster. **Verify on the actual version:** `VECTOR` column support, `CREATE VECTOR INDEX` syntax, and the `feature.vector_index.enabled` cluster setting. Confirm GC TTL for the `AS OF SYSTEM TIME` demo window. *Gate: no retrieval work before this passes.*
2. **Conventions module first.** `fixedpoint.ts` + `rng.ts` + decay tables, fully unit-tested. Everything downstream depends on them.
3. **Schema + scenario loader.** Full static/per-world split with composite keys and CHECK constraints; validating versioned loader; seed one world (2 factions, 6 districts, ~40 agents, claims, triggers).
4. **DB layer.** Pool, serializable helper with `40001` retry + counter, lease helpers, idempotent tick commit, command dedupe.
5. **Inference layer.** Bedrock Haiku + Titan behind one interface; deterministic stub; `cognition_records` capture.
6. **Retrieval.** Integer scoring + `memory_accesses`; exact re-ranker tested independently of index recall.
7. **Gossip + beliefs.** Diffusion, distortion, sentiment, `belief_updates`, projection rebuild.
8. **Tension, stages, peace, triggers.** Monotonic stages; rules-based peace; hard triggers; allowlisted DSL.
9. **`runTick` + scheduler.** Full pipeline; lease-guarded non-overlapping loop; `time_scale`.
10. **`converse`.** Durability-ordered flow; 9-way classification; idempotent commands.
11. **Harness.** Headless scenario runner + interactive REPL.
12. **Debug dashboard.** Read-only Next.js: tables, force-directed social graph, chronicle, tension curve, belief-by-tick inspector. *(No decorative status indicators.)*

### Phase 2 — Game client
Phaser 3 over the same engine API. CC0 assets (Kenney.nl / LPC) — **not** Stardew's. Game-first viewport, WASD, walk-up dialogue via SSE, toggle panels for social graph + chronicle.

### Phase 3 — Cloud + AWS
`ccloud` provisioning · migrate to CockroachDB Cloud · **Managed MCP + Town Investigator** (read-only role) · ECS/Fargate web + scheduler · optional S3 chronicle exports.

### Phase 4 — Submission
Node-kill resilience rehearsal · `AS OF SYSTEM TIME` commit-timestamp demo · observability dashboard · README (feature map, tool citations, attribution) · record and edit the 3-min video from a full 30-min run.

---

## 11. Acceptance tests

**Conventions**
- No floating-point value reaches any rule path (lint/type gate on the rules modules).
- Every rule-feeding query has an explicit `ORDER BY` (audited).
- Cross-world FK violation is rejected by the database (attempt to reference another world's row must fail).
- Re-inserting a published scenario row is rejected.

**Determinism**
- Same `{scenarioVersion, seed, playerCommands}` under stub → **byte-identical** event, belief, and tension sequences across runs and across machines.
- Replay from `cognition_records` reproduces a real-model run with **zero Bedrock calls**.
- Projections (`agent_beliefs`, `world_state`) rebuilt from history match the live projections exactly.

**Simulation**
- **Fail state:** unattended stub run reaches `war` within **192–288 ticks** and never exceeds **360**, deterministically, under the canonical seed.
- **Stage monotonicity:** across a long randomized batch, no stage ever decreases.
- **Peace path:** a scripted reconciliation transcript reaches the peaceful ending before `first_blood`; the same transcript after `first_blood` does **not**.
- **Hard trigger:** a murder event from `suspicion` jumps directly to `war`.
- **Gossip:** a seeded rumor reaches the expected agent set; belief confidence rises for receivers and not for non-receivers.
- **Truth independence:** a claim with `truth = 'false'` still reaches high belief confidence — misinformation propagates.

**Database**
- **Retrieval:** exact re-ranker returns the known-correct top-k; `memory_accesses` appended; `world_memories` never updated (assert zero row mutations).
- **Isolation:** concurrent `converse` and `runTick` writes on `world_state` → **no lost update, no torn state, ≥1 observed `40001` retry**.
- **Tick safety:** two schedulers racing one world → exactly one `world_tick_commits` row per tick, no duplicate effects.
- **Command idempotency:** the same `idempotency_key` submitted twice applies effects once.
- **World isolation:** activity in world A produces **zero** row changes in world B.
- **Time travel:** `AS OF SYSTEM TIME` at a recorded commit timestamp returns pre-rumor state; tick-based reconstruction agrees with it.
- **Resilience:** `docker kill` one node mid-tick → ticks continue committing, no memory or belief loss.

**Safety**
- Prompt-injection corpus in player and NPC text never produces an effect outside the allowlist.
- Read-only role cannot write; MCP surface rejects mutations.
- Exhausted world budget degrades to deterministic cognition without erroring.

---

## 12. Prerequisites

- **Docker** — local 3-node cluster.
- **AWS**: Bedrock model access for **Claude Haiku** + **Titan Text Embeddings V2** in the target region; credentials local. (~$116 credits.) All rule systems build and test against the **stub** without Bedrock.
- **CockroachDB Cloud** account + **`ccloud`** — Phase 3 only.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| **Scope** — engine + game + cloud + AWS in ~3.5 weeks | Phase 1 is the product. Phases 2–4 layer on; each independently cuttable |
| Vector index syntax/setting differs by version | Preflight gates all retrieval work |
| ANN recall variability leaking into deterministic rules | Deterministic candidate ordering + exact integer re-rank + `memory_id` tie-break |
| Inference cost across isolated worlds | Cognition ≤2 NPCs/30 s · per-world budget · deterministic fallback · Nova fallback |
| **Fargate is not free** (~$10–20/mo always-on scheduler) | Deliberate trade for a judgeable public deployment; covered by credits. Scale to zero outside demo windows |
| `AS OF SYSTEM TIME` bounded by GC window | Product history uses ticks; time-travel is a scoped resilience demo inside the window |
| Emergent escalation tuning eats time | Tension/gossip constants in config; tune against the headless harness, not the UI |
| Copyright | Crucible-*inspired* dynamics only; original names, town, and text; attribution in README |
