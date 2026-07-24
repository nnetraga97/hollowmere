# Hollowmere

**A visual stress test for persistent multi-agent memory, misinformation propagation, and transactional consistency — presented as a playable town.**

Built for the [CockroachDB AI hackathon](https://cockroachdb-ai.devpost.com/).

A prince is found dead at the chapel steps. Two royal houses, each anchored in a
rival trade guild, begin accusing one another. Forty AI townspeople hear things,
believe them to varying degrees, repeat them in their own words, and take sides.
Left alone, the town destroys itself. You are an outsider who can talk to anyone.

The town is the visualization. The substrate is the point.

## What this is actually testing

| Concern | How it shows up here |
|---|---|
| **Persistent multi-agent memory** | 40 agents × isolated worlds × vector retrieval over an append-only memory stream |
| **Misinformation propagation** | Ground truth is stored separately from belief, so a claim the engine *knows* is false can still take hold of the town — and be measured |
| **Transactional consistency** | Player writes and scheduler writes contend on the same rows under `SERIALIZABLE`, in two separate processes |
| **Intervention analysis** | Belief is reconstructible by simulation tick, so "did that conversation change the trajectory" is answerable |

## Status

Phase 1 (engine) — 8 of 12 milestones. **130 tests passing.**

Done: preflight gate · fixed-point + RNG conventions · schema + DB layer ·
scenario loader · inference (stub + Bedrock) · retrieval · gossip + beliefs.

Next: tension and escalation · `runTick` + scheduler · `converse` · harness ·
debug dashboard. Then the Phaser client, CockroachDB Cloud, and Managed MCP.

## Quick start

No AWS account is needed. The engine runs entirely on a deterministic stub.

```bash
npm install
npm run db:up          # 3-node CockroachDB cluster in Docker
npm run preflight      # verifies vector indexing, isolation, time travel
cp .env.example .env
npm run db:migrate -- --fresh
npm run seed -- --seed 42
npm run check          # typecheck + 130 tests
```

`npm run preflight` is a gate, not a formality: it verifies that vector indexing,
serializable isolation, and `AS OF SYSTEM TIME` behave as the engine assumes.
Re-run it against CockroachDB Cloud before deploying — Cloud defaults differ.

## Architecture

```
Browser ── Next.js ─┐
                    ├── engine (shared) ── CockroachDB
Scheduler ──────────┘                  └── Bedrock (Claude Haiku + Titan V2)
```

Two processes, one database. Player writes and scheduler writes genuinely
contend on shared per-world rows — the serializable-isolation demonstration is
the application working normally, not a staged one.

| Directory | Contents |
|---|---|
| `db/` | `schema.sql` — 32 tables, composite world-scoped keys |
| `scenario/` | Versioned immutable content + validating loader |
| `engine/` | Rules, retrieval, gossip, beliefs, inference |
| `scripts/` | Preflight, migrate, seed, Bedrock check |
| `infra/` | Local 3-node cluster |
| `docs/` | Preflight findings, AWS setup |

## Design constraints

These are enforced, not aspirational — see `engine/schema.test.ts`.

- **No floating point in any rule.** Every simulation value is a fixed-point
  integer on a scale of 10,000. Floats would make the simulation
  machine-dependent, which would break replay and the determinism tests. Decay
  tables are built by integer multiplication rather than `Math.exp`, which
  carries no cross-platform guarantee.
- **Every world is isolated by construction.** Composite foreign keys reference
  `(world_id, entity_id)`, so a cross-world reference cannot be expressed. The
  database rejects one in the test suite.
- **Append-only history, rebuildable projections.** `agent_beliefs` is derived
  from `belief_updates`; a test asserts a rebuild reproduces it exactly.
- **Simulation time is always a tick.** `TIMESTAMPTZ` is operational metadata.
  Product history survives garbage collection because it never depends on it —
  `AS OF SYSTEM TIME` is a separate database-resilience demonstration.
- **Scenario content is untrusted input.** The trigger DSL is a closed,
  allowlisted grammar; scenario JSON is never evaluated as code.

## Two findings worth knowing

**A correct query can silently stop using the vector index.** CockroachDB needs
table statistics before it will choose one, the opclass must match the operator
(`vector_cosine_ops` ↔ `<=>`), and the query vector must be a bound parameter —
a subquery defeats it entirely. In every failing case the *results stay correct*.
Retrieval tests therefore assert the query plan. See `docs/preflight-findings.md`.

**IAM permission and Bedrock model access are independent gates.**
`AmazonBedrockFullAccess` plus working credentials still yields
`Operation not allowed` if the model is not authorized for the account, and
`list-foundation-models` succeeding proves nothing about invoking them. See
`docs/aws-setup.md`.

## Attribution

The escalation dynamics — accusation, hysteria, factional hardening — are
inspired by Arthur Miller's *The Crucible*. The town, characters, and all text
are original; no part of Miller's work is reproduced.

Agent architecture (perceive → retrieve → reflect → plan) follows the pattern
established by Park et al., *Generative Agents* (2023).
