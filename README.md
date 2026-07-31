# Hollowmere

**A visual stress test for persistent multi-agent memory, misinformation propagation, and transactional consistency — presented as a playable town.**

Built for the [CockroachDB AI hackathon](https://cockroachdb-ai.devpost.com/).

[![Validate and deploy production](https://github.com/nnetraga97/hollowmere/actions/workflows/deploy-production.yml/badge.svg)](https://github.com/nnetraga97/hollowmere/actions/workflows/deploy-production.yml)
[Play the production build](https://hollowmere-web.victorioussand-d8121435.eastus.azurecontainerapps.io/)

A prince is found dead at the chapel steps. Two royal houses, each anchored in a
rival trade guild, begin accusing one another. Thirty AI townspeople hear things,
believe them to varying degrees, repeat them in their own words, and take sides.
Left alone, the town destroys itself. You are an outsider who can talk to anyone.

The town is the visualization. The substrate is the point.

## What this is actually testing

| Concern | How it shows up here |
|---|---|
| **Persistent multi-agent memory** | 30 agents × isolated worlds × vector retrieval over an append-only memory stream |
| **Misinformation propagation** | Ground truth is stored separately from belief, so a claim the engine *knows* is false can still take hold of the town — and be measured |
| **Transactional consistency** | Player writes and scheduler writes contend on the same rows under `SERIALIZABLE`, in two separate processes |
| **Intervention analysis** | Belief is reconstructible by simulation tick, so "did that conversation change the trajectory" is answerable |

## Status

**The engine, playable web client, and cloud deployment are live.**

The current build includes the preflight gate; fixed-point and seeded-RNG
conventions; a 54-table CockroachDB schema; immutable scenario publishing;
stub, replay, Bedrock, and Azure inference modes; hybrid memory retrieval;
gossip, belief, tension, escalation, peace, and trigger systems; the scheduler;
durable player/NPC conversation; branching romance routes; a headless harness;
an interactive REPL; and structured operational logging.

The Next.js + Phaser client provides a playable town map, session-isolated APIs,
durable multi-turn walk-up dialogue, location scenes, simulation controls,
evidence and hearing gameplay, relationship and romance interactions, and
diagnostic views. Conversation holds simulation time, remembers who heard it,
changes the NPC's long-term impression of the player, and charges 1–3 ticks
when it ends.

Production runs the public web process and private scheduler as separate Azure
Container Apps against CockroachDB Cloud, with Azure-hosted inference. GitHub
Actions validates, builds, deploys, waits for both revisions, and smoke-tests
the public endpoint.

Next: implement the Instigator design and add CockroachDB Managed MCP as a
read-only investigation surface.

### The town, left alone

Under the canonical seed, an unattended run reaches war at **tick 239** — inside
the 192–288 window the plan fixes, passing through every stage in order:

```
suspicion t36 · accusations t83 · trials t141 · first_blood t194 · war t239
```

It gets there with **no model calls required** (the deterministic stub is a
first-class runtime mode), and it ends with `millers_poison_grain` — a claim the
engine *knows* is false — believed by a quarter of the town. That gap between
`truth` and belief is the whole point, and it is a column in the dashboard.

Talking to both House leaders, persistently and early, reaches peace instead.
The same words after first blood do not: the streak never even starts.

## Quick start

No cloud account is needed for local development. The engine defaults to a
deterministic stub.

```bash
npm ci
npm run db:up          # 3-node CockroachDB cluster in Docker
cp .env.example .env
npm run preflight      # verifies vector indexing, isolation, time travel
npm run db:migrate -- --fresh
npm run seed -- --seed 42
npm run check          # engine + web typechecks, tests, and production web build
```

Then watch a town destroy itself:

```bash
npm run sim -- --ticks 360 --seed 42    # headless: tension curve, chronicle, belief
npm run repl                            # interactive: tick, talk, belief, graph
npm run scheduler                       # the service that advances worlds
npm run web                             # playable Phaser instrument on :3000
```

`npm run preflight` is a gate, not a formality: it verifies that vector indexing,
serializable isolation, and `AS OF SYSTEM TIME` behave as the engine assumes.
Run it against every new CockroachDB Cloud cluster before deploying because
Cloud defaults can differ from the local cluster.

## Architecture

```
Browser ── Next.js ─┐
                    ├── engine (shared) ── CockroachDB
Scheduler ──────────┘                  └── inference provider
                                            ├── deterministic stub / replay
                                            ├── Azure OpenAI (production)
                                            └── Amazon Bedrock
```

Two processes, one database. Player writes and scheduler writes genuinely
contend on shared per-world rows — the serializable-isolation demonstration is
the application working normally, not a staged one.

| Directory | Contents |
|---|---|
| `db/` | `schema.sql` — 54 tables, composite world-scoped keys, and read-only role SQL |
| `scenario/` | Versioned immutable content + validating loader |
| `engine/` | Rules, retrieval, gossip, beliefs, tension, triggers, cognition, `runTick`, `converse`, read models |
| `scheduler/` | Lease-guarded non-overlapping loop + service entrypoint |
| `harness/` | `sim.ts` headless runner, `repl.ts` interactive shell |
| `web/` | Next.js + Phaser playable debug client, session APIs, and React instruments |
| `scripts/` | Preflight, migrate, seed, provider checks, and local launchers |
| `infra/` | Local 3-node CockroachDB cluster |
| `.github/workflows/` | Pull-request validation and production deployment |
| `docs/` | Design history, preflight findings, provider setup, and observability |

Server processes emit structured JSON logs for inference, database retries,
scheduler activity, API mutations, and failures. See
[`docs/observability.md`](docs/observability.md) for event names and log levels.

## Production deployment

| Component | Production service |
|---|---|
| Web application | Public Azure Container App |
| Scheduler | Private, continuously running Azure Container App |
| Database | CockroachDB Cloud with `verify-full` TLS |
| Inference | Azure-hosted reasoning and embedding deployments |
| Container images | Azure Container Registry |
| Runtime secrets | Azure Key Vault references through managed identity |
| Continuous delivery | GitHub Actions authenticated to Azure with OIDC |

[`deploy-production.yml`](.github/workflows/deploy-production.yml) runs validation
for pull requests and relevant pushes. A push to `main` builds the explicit
`web` and `scheduler` Docker targets for `linux/amd64`, tags both images with the
Git commit, and pushes them to ACR. It deploys the scheduler first, waits until
its newest revision is ready, then deploys the web app and performs a public
HTTP smoke test. Production deployments are serialized so two releases cannot
race each other.

The deployment identity has only `Container Apps Contributor` and `AcrPush`.
ACR's admin account is disabled; GitHub stores only the Azure client, tenant,
and subscription identifiers needed for OIDC. Application credentials remain
in Key Vault and are not copied into GitHub.

Production deployment builds a dedicated migration image and runs it with the
DDL-capable migrator identity before either application service is updated. A
failed migration blocks the rollout. The web and scheduler containers continue
to use the restricted runtime database role and never receive migration credentials.

To start the same production workflow manually:

```bash
gh workflow run deploy-production.yml --ref main
gh run watch
```

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
- **Model output never selects an effect.** A plan is a choice from an
  engine-built allowlist; a speech act is one of ten known values; the claim a
  player is talking about is resolved by the engine from its own data rather
  than by asking a model for an identifier. An injection corpus is part of the
  test suite.
- **Peace is decided by rules, never announced by a model.** Conversation moves
  the inputs — willingness, tension, rumor heat — and the tick decides what they
  add up to. Escalation stages advance in exactly one place, which is what makes
  "never reverses" a property of the code rather than a convention.
- **No inference inside a transaction.** A serialization retry would re-bill the
  model call and could duplicate streamed output, so a tick thinks first with
  nothing open and then commits what it decided.

## Three findings worth knowing

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

**Ordering a rule query on a random UUID is a determinism bug that passes every
result assertion.** Three separate ones surfaced here — rumors ordered by
`rumor_id`, agents by `agent_id`, route adjacency by `location_id`. Each gave
correct results, and each produced a *different town* from the same seed,
because the seeded generator is consumed in iteration order. Rule-feeding
queries order on scenario keys, never on ids. The same class of bug bit the RNG
itself: a draw conditioned on how many rows the approximate vector index
returned made two runs of one seed diverge under load. See the status section of
`docs/plan.md`.

## Attribution

The escalation dynamics — accusation, hysteria, factional hardening — are
inspired by Arthur Miller's *The Crucible*. The town, characters, and all text
are original; no part of Miller's work is reproduced.

Agent architecture (perceive → retrieve → reflect → plan) follows the pattern
established by Park et al., *Generative Agents* (2023).
