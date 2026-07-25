# Hollowmere — implementation plan

---

## STATUS — 2026-07-25

**Phase 1 (engine): 12 of 12 milestones complete. 183 tests passing, typecheck clean.**

| # | Milestone | State | Evidence |
|---|---|---|---|
| 1 | Preflight gate | **done** | 9/9 checks, `./scripts/preflight.sh`, repeatable against Cloud |
| 2 | Conventions module | **done** | 47 tests — `fixedpoint` / `rng` / `decay` |
| 3 | Schema + DB layer | **done** | 32 tables, 8 conformance tests |
| 4 | Scenario + loader | **done** | 23 tests, 40 agents, allowlisted trigger DSL |
| 5 | Inference layer | **done** | 20 tests, stub + Bedrock behind one interface |
| 6 | Retrieval | **done** | 14 tests incl. query-plan assertion |
| 7 | Gossip + beliefs | **done** | 18 tests incl. polarization + misinformation |
| 8 | Tension / stages / peace / triggers | **done** | 20 tests — monotonic stages, rules-only peace, hard triggers |
| 9 | `runTick` + scheduler | **done** | 14 tests — canonical arc, split-brain, cross-world determinism |
| 10 | `converse` | **done** | 15 tests — idempotency incl. resume-after-failure, budget accounting, peace path, injection corpus, contention |
| 11 | Harness | **done** | `harness/sim.ts` headless runner, `harness/repl.ts` |
| 12 | Debug dashboard | **done** | `web/` read-only server + single-page instrument |

### The canonical arc, measured

An unattended stub run under seed 42 reaches `war` at **tick 240** (192–288 is
the window the plan fixes; seeds 7 and 1234 land at 240 and 238). It passes
through every stage in order — suspicion t36, accusations t85, trials t142,
first_blood t195, war t240 — and ends with a claim the engine *knows to be
false* believed by a quarter of the town.

### Verified against the real cluster (CockroachDB v26.2.4)

Everything from the previous milestones, plus:

- Two schedulers racing one world → **one commit per tick, no duplicated
  effects, no gaps**, both as a direct race and through two live scheduler loops.
- Eight concurrent conversations plus a tick on the same `world_state` row →
  **no lost update**, and a gapless command log.
- The same seed in two different worlds → **identical chronicle, identical
  belief table, identical tension curve** (a different seed diverges).
- A murder at `suspicion` → straight to `war`, with tension still far below the
  war threshold.
- A scripted reconciliation campaign reaches **peace**; the same words after
  `first_blood` do not, and the streak never even starts.
- An exhausted budget degrades to deterministic cognition and keeps ticking.
- A prompt-injection corpus moves no stage, ends no world, and grants nobody
  standing.

### Decisions changed during implementation

Items 1–8 are unchanged from the previous status. New in this phase:

9. **Rumors are re-heard, not heard once.** `world_rumor_spread` records first
   contact and is never rewritten, but a listener becomes eligible again after
   `GOSSIP.retellCooldown` ticks, measured from their last belief update. With
   single exposure, belief plateaus around 0.14 and *no agent in the town ever
   reaches actionable confidence* — the misinformation thesis fails outright.
   Belief hardens by repetition or not at all.
10. **Escalation is belief-driven, not gossip-driven.** Once everyone has heard
    a rumor there is nobody left to tell, so a purely gossip-driven town
    plateaus below war. `accusations.ts` closes the loop: agents who *believe* a
    cross-house claim say so publicly, with a probability that rises by stage.
    Accusations raise tension, tension advances the stage, and the stage makes
    everyone readier to speak.
11. **Tension is capped per tick** (`TENSION.maxRisePerTick`). Individual events
    are still priced by severity, but one hot rumor reaching forty people in a
    tick would otherwise take the town from calm to war inside a minute. The cap
    is what stretches the arc across the canonical window; it is the single knob
    that sets pacing.
12. **Ordering keys are scenario keys, never UUIDs.** Three separate
    determinism bugs came from ordering rule-feeding queries on random ids —
    rumors by `rumor_id`, agents by `agent_id`, and route adjacency by
    `location_id`. Each produced correct results and a different town. Ordering
    is now on `claim_key` / `agent_key` / `location_key` throughout.
13. **The RNG stream must never depend on an approximate result.** Reflection
    was gated on how many memories the ANN index returned; under load the index
    returned a different count, the generator was consumed differently, and two
    runs of one seed diverged. The draw is now unconditional and tested against
    an exact count.
14. **Player writes use a disjoint sequence band.** A tick and a conversation
    both write `world_events` at the same tick, and `(world_id, tick, seq)` is
    unique. Rather than share a counter across two services, conversations
    allocate from `PLAYER_SEQ_BASE` upward, strided per command.
15. **The stub classifier reads cue words instead of picking at random.** A
    random classifier makes every scripted transcript untestable — a
    reconciliation is read as an accusation a third of the time — and the
    escalation bias it existed to provide now comes from belief instead.
16. **Reconciling with a leader cools the whole town's rumors.** Peace requires
    no hostile rumor above a heat threshold, and nothing else a player can do
    cools one. A leader's public call for calm carries; a fisherman's does not.
17. **The dashboard is a dependency-free Node server, not Next.js.** Phase 1's
    milestone is a read-only instrument, and every read model it needs lives in
    `engine/api.ts`. The player-facing Next.js service in Phase 2/3 sits on the
    same functions, so nothing was pre-built here that has to be rebuilt there.
    *(This is a deliberate deviation from §9 of the plan below.)*

### Blocked / waiting

- **Bedrock model access.** Credentials and IAM verify clean
  (`AmazonBedrockFullAccess`), and entitlement is `AVAILABLE` for both models;
  only `authorizationStatus` is `NOT_AUTHORIZED`. This is *not* propagation —
  it is two console steps that cannot be done from the CLI, now written up in
  `docs/aws-setup.md`. Haiku needs the use-case form in **all three regions the
  `us.` inference profile routes to** (us-east-1, us-east-2, us-west-2); Titan
  needs one Playground invocation. Phase 1 is complete on `INFERENCE_MODE=stub`,
  which is why this still blocks nothing.

### Cloud integration audit — 2026-07-24

Reviewed before starting Phase 2, on the grounds that Phase 2 is entirely built
on the conversation path. Four defects found and fixed; all were invisible under
`INFERENCE_MODE=stub` and would have surfaced only once Bedrock was live.

18. **A failed reply used to re-apply the whole conversation.** `converse` wrote
    the command's outcome payload only *after* the reply streamed, so any failure
    between the effects committing and the reply landing — a throttle, a dropped
    socket, an unauthorised model — left a command row that still looked
    unprocessed. The retry re-seeded the rumor, re-raised tension, and re-moved
    belief, while reporting itself as one accusation. The payload is now stamped
    with the act inside the same transaction that applies the effects, so the
    idempotency guard sees them together. The retry-after-failure path also
    resumed under `commandSeq: -1, tick: 0`, writing history below
    `PLAYER_SEQ_BASE` at tick zero where two such retries collided; it now
    resumes on the command's own sequence at the world's real tick.
19. **Conversation was not charged to the budget.** `recordUsage` was called only
    from cognition. The per-world cap — the thing that makes a public deployment
    safe — was metering the scheduler's calls, which are already bounded by
    spotlight size, and ignoring the one path a player can drive at will. Both
    the classification and the reply are now counted, each inside the transaction
    it belongs to (safe under `40001` retry, since a rollback undoes the
    increment). An exhausted budget degrades conversation to the stub rather than
    refusing it, matching how cognition already behaves.
20. **`stream` reported no token counts.** It yielded text and dropped Bedrock's
    `amazon-bedrock-invocationMetrics` closing chunk, so dialogue spend was not
    merely uncharged but unmeasurable. `stream` now returns a `StreamUsage` as
    the generator's return value; `streamWithUsage` is the helper that keeps
    callers from silently discarding it with a bare `for await`.
21. **The Bedrock client had no timeouts.** `NodeHttpHandler` defaults to waiting
    forever, so a hung call inside `runTick` step 4 would stall the tick while the
    scheduler still held that world's lease — on Fargate, a task stuck with no
    error to show for it. Connect/request timeouts and `maxAttempts` are now set
    explicitly and are env-overridable.

### Cloud items still open

- **Nova Lite fallback** (§2, and §13's throttling mitigation) does not exist.
  Cognition degrades on budget exhaustion but not on throttling, and `converse`
  simply throws. Worth having before the video is recorded against live Bedrock.
- **TLS to CockroachDB Cloud.** `engine/db.ts` builds the pool from
  `DATABASE_URL` with no `ssl` config, and `pg-connection-string` maps
  `sslmode=require` to `rejectUnauthorized: false` — unverified TLS that looks
  secure. Use `verify-full` with the Cloud CA explicitly in Phase 3.
- **`db/read-only-role.sql` creates a passwordless `LOGIN` role.** Cloud requires
  password auth, so the dashboard and the MCP Town Investigator cannot connect as
  written.
- **`scripts/migrate.ts` applies all of `schema.sql` in one `client.query()`** —
  a single implicit transaction over 32 tables plus vector indexes. Fine locally;
  worth splitting before meeting Cloud's schema-change limits on the day.

### Replay, made real — 2026-07-25

Narrowing the input hash to exact inputs (decision 22) was meant to be small
hardening. It surfaced that replay had never worked and could not have: the old
hash covered ANN-derived memory ids, so a mismatch could only ever be a warning,
and a warning is what it produced instead of the failures underneath. There were
also no end-to-end replay tests — §11 lists the acceptance test, nothing
implemented it.

`engine/replay.test.ts` now records a world, rewinds it, and replays it against a
client that throws on **every** call, asserting the same stage, tension, and
memories come back. §11's "zero Bedrock calls" is true as of this change, having
been false since it was written.

Getting there needed `engine/rewind.ts` plus three determinism fixes (23–25).
The rewind was the easy half; the three bugs were only visible once something
actually compared a run against its own recording.

22. **The input hash covers exact inputs only.** Recalled memory ids are out of
    it; a mismatch on `(agentKey, tick, stage, situationText, destinations,
    beliefs)` or on `prompt_version` is now refused with a message naming which,
    rather than warned about. Replay no longer retrieves at all, so there is no
    "current" recall set to compare against — the recorded ids are used directly.
23. **Cognition's RNG draws are unconditional, including the model seeds.** The
    plan and reflect seeds were drawn *inside* the branch that calls the model,
    so a replayed round — which skips the call — consumed the generator
    differently and shifted every later draw in the tick. This is (13)'s failure
    mode reached by a different route: the rule was already written down for the
    reflection draw and simply not applied to the seeds. Both are now taken in
    both modes, gated on conditions a replay reproduces exactly.
24. **Memory ids are derived from position, not drawn at random.** `memory_id`
    defaulted to `gen_random_uuid()`, so a replayed run minted different ids than
    the recording and every recorded reference dangled — surfacing as a foreign
    key violation on `memory_accesses`, and quietly as a recording naming
    memories nobody can find. The id is now a hash of `(world_id, tick, seq)`,
    which the table already declares UNIQUE: a memory's identity *is* its
    position. This is not the sequential id convention 1 forbids — that rule is
    about range hotspots, and a hash is as uniformly distributed as
    `gen_random_uuid()`, just reproducible.
25. **The last query ordering on a UUID.** `loadSituation` tie-broke an agent's
    recent rumors on `rumor_id`, so two heard on the same tick entered the prompt
    in an order that changed whenever the rumor rows were recreated. Now ordered
    on `claim_key`. Worth noting this was never only a replay bug: it meant the
    prompt an agent saw was not in fact deterministic across two worlds built
    from one seed, which is a property the determinism contract claims. (12)'s
    rule, applied to the query that had escaped it.

### Known gaps to address next

- `loadListeners` still runs one query per rumor-holder per tick, now bounded by
  `GOSSIP.maxTellersPerRumor`. A tick costs ~500 ms locally at 40 agents; this
  is the first thing to batch if that matters.
- Distortion is capped by `GOSSIP.distortionChance` and skippable, but still not
  wired to the per-world budget — only cognition checks it. It is forced off
  during replay, since distortions are recorded nowhere.
- `retrieval.ts` breaks score ties on `memory_id`. Now that memory ids are
  derived from `(world_id, tick, seq)` this is deterministic within a world *and*
  stable across a rewind, but it is still not comparable across two worlds built
  from the same seed, because `world_id` is in the hash.

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

**Implemented on `codex/phase-2-phaser`:** Next.js 16 + Phaser 3.90 workspace,
signed session-scoped worlds, route-validated movement, colocated SSE dialogue,
the playable Hollowmere map, agent inspection, graph/chronicle/claim/tension
instruments, safe pause/speed/restart controls, and opt-in Engine Truth. Evidence
and hearing views follow the instigator spec and remain capability-gated until
the parallel engine implementation is committed and merged.

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
