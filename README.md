# Hollowmere

**A playable investigation into agentic memory: what happens when an AI town can
remember a conversation, retrieve it later, and let it change the future?**

[Play the current public demo](https://hollowmere-web.victorioussand-d8121435.eastus.azurecontainerapps.io/) · [Read the hackathon requirements](https://cockroachdb-ai.devpost.com/) · [Architecture diagram](hollowmere-architecture.excalidraw)

Hollowmere is being prepared for the **CockroachDB × AWS Hackathon — Build with
Agentic Memory**. A prince dies on the chapel steps. Thirty autonomous
townspeople form beliefs, repeat rumors, choose sides, and can drive the town
to war. The player enters as an outsider, speaks to the town, introduces or
challenges evidence, and tries to change that outcome.

The game is the interface. The project is a concrete test of durable agent
memory: a memory is stored in CockroachDB, retrieved later through vector and
rule-based recall, recorded as evidence for an agent's action, and visible to
the player as a changed belief, response, relationship, or chronicle event.

## Why this matters

An agent that merely stores chat history is not necessarily using memory. In a
multi-agent system, useful memory must be durable, attributable, retrievable,
safe under concurrent writes, and inspectable after it changes an outcome.

Hollowmere makes that chain visible:

```text
player conversation / world event
        ↓
durable, world-scoped memory in CockroachDB
        ↓
hybrid recall: ANN/vector + importance + recency + conversation anchor
        ↓
bounded agent cognition and dialogue
        ↓
belief, relationship, rumor, action, or town-level consequence
```

The project deliberately keeps ground truth separate from what an agent
believes. A claim the engine knows is false can still spread, gain credibility,
and change behavior—exactly the failure mode a persistent-memory system needs
to make observable.

## What you can do

- Start an isolated private world, choose a player identity and portrait, and
  resume it after a browser refresh.
- Walk the town map, meet illustrated characters, and hold durable multi-turn
  conversations with them.
- Inspect beliefs, relationships, evidence, hearings, romance routes, the
  world chronicle, and simulation state.
- Watch a town evolve on its own, or intervene before a false narrative turns
  suspicion into accusations, trials, violence, and war.
- Use the agent inspector's **Memory trace** to see bounded excerpts of the
  memories available to an agent and how recalled memories entered the result
  set: `ANN / vector`, `importance`, `recency`, or `pinned anchor`.

Under the canonical deterministic seed, an unattended town reaches war at tick
239, following this sequence:

```text
suspicion t36 · accusations t83 · trials t141 · first_blood t194 · war t239
```

Early, sustained intervention with both house leaders can reach peace instead.
The deterministic stub makes that scenario reproducible without requiring a
model call.

## The memory model

| Requirement | Hollowmere implementation |
| --- | --- |
| Durable memory | Conversations, events, beliefs, evidence, cognition outcomes, and retrieval accesses are persisted in CockroachDB. |
| Semantic recall | Memories use `VECTOR(1024)` embeddings and a world-prefixed cosine vector index; retrieval also considers importance, recency, and a pinned conversation anchor. |
| Causal provenance | A later turn records the recalled memory identifiers and every candidate path that supplied them, without exposing raw embeddings or hidden prompts. |
| Transactional behavior | The browser-facing web process and independent scheduler write the same per-world state under `SERIALIZABLE` isolation. |
| Isolation | Composite world-scoped keys and server-side session ownership prevent one world's data from being read as another's. |
| Safe actions | Models choose only from engine-built allowlists; model output cannot name arbitrary database effects or identifiers. |
| Reproducibility | Fixed-point rules, seeded randomness, append-only history, and replay tests make a world trajectory inspectable. |

The engine distinguishes *retrieval* from merely finding a plausible answer.
The canonical test requires the demonstrated memory to appear through the
`ANN / vector` path; an importance, recency, or pinned-anchor match by itself
does not count as vector-retrieval evidence.

## Architecture

```text
Browser
  │
  ▼
Next.js + React + Phaser web client ──┐
                                      ├── shared Hollowmere engine ── CockroachDB Cloud
Lease-guarded scheduler ──────────────┘              │
                                                     ├── durable world state
                                                     ├── memories and cognition trail
                                                     └── distributed vector index
                                                            │
                                                            ├── deterministic stub / replay
                                                            ├── Azure-hosted inference (current public demo)
                                                            └── Amazon Bedrock adapter (gated; see status)
```

There are two application processes and one source of truth. The scheduler
acquires a database lease before advancing a world; player requests and ticks
therefore contend on real shared rows rather than a demonstration-only mock.

| Area | Contents |
| --- | --- |
| `db/` | Schema, migrations, world-scoped constraints, runtime roles, and stable archivist read views. |
| `scenario/` | Versioned town content, validation, instantiation, and publishing. |
| `engine/` | Retrieval, beliefs, gossip, cognition, dialogue, evidence, escalation, replay, and fixed-point rules. |
| `scheduler/` | Lease-guarded non-overlapping tick loop. |
| `web/` | Next.js client, Phaser town map, session APIs, evidence and memory-trace views. |
| `harness/` | Headless simulation runner and interactive REPL. |
| `infra/` | Local three-node CockroachDB cluster and an AWS CDK deployment definition. |
| `scripts/` | Preflight, migration, seeding, role provisioning, provider checks, and local launchers. |
| `docs/` | Hackathon scope, Town Archivist guide, operational evidence, deployment runbooks, and design history. |

## Current status and hackathon readiness

The local engine, web client, CockroachDB schema, vector retrieval path,
memory-trace UI, and Azure-hosted public demo are implemented. The table below
separates those verified facts from work that is designed or coded but not yet
proven in the submitted environment.

| Hackathon requirement | Status | Evidence / limitation |
| --- | --- | --- |
| Persistent CockroachDB agent memory | Implemented | Durable world, conversation, cognition, belief, and event records drive live application behavior. |
| CockroachDB Distributed Vector Indexing | Implemented and tested locally | `world_memories_embedding_idx`, retrieval-plan tests, and `npm run preflight` verify the required vector behavior on the target cluster. |
| Second CockroachDB tool: Managed MCP | Planned, not yet submission-verified | The read-only **Town Archivist** workflow and scoped SQL views are documented, but a real Cloud Managed MCP OAuth investigation has not yet been recorded. |
| AWS service | Designed, not yet deployed | CDK and GitHub Actions define an ECS/Fargate, ECR, ALB, Secrets Manager, and CloudWatch path; the current public demo is not running there. |
| Amazon Bedrock inference | Adapter implemented, release-gated | The Bedrock provider and checks are present, but current production runs `BEDROCK_ENABLED=false` while access/preflight remain unresolved. |
| Public functional demo | Available now | The linked demo is Azure Container Apps with CockroachDB Cloud and Azure-hosted inference. |
| Open-source license | Not yet present | Add a root MIT or Apache-2.0 license before submitting; this is a Devpost requirement. |

This is intentionally candid: the repository should not be described as a
complete CockroachDB × AWS Hackathon submission until the AWS deployment,
Bedrock demonstration, Managed MCP workflow, and root license are complete.
The current production architecture is Azure-based; the AWS architecture is a
prepared deployment target, not a claim about the live demo.

## Run locally

### Prerequisites

- Node.js and npm
- Docker Desktop
- A local `.env`, copied from `.env.example`

No cloud account is needed for the default local path. It uses deterministic
stub inference.

```bash
npm ci
npm run db:up
cp .env.example .env
npm run preflight
npm run db:migrate -- --fresh
npm run seed -- --seed 42
npm run check
```

Then choose one of the following:

```bash
npm run web                         # playable client on http://localhost:3000
npm run scheduler                   # advances owned worlds
npm run sim -- --ticks 360 --seed 42 # headless town run
npm run repl                        # interactive simulation shell
```

`npm run preflight` is a compatibility gate, not a cosmetic check. It validates
vector indexing, serializable isolation, and `AS OF SYSTEM TIME` behavior on
the database you intend to use. Run it against every new CockroachDB Cloud
cluster before deploying.

For a fuller validation pass:

```bash
npm run check:full
```

Provider-specific checks are intentionally separate because they require
credentials and/or enabled provider access:

```bash
npm run check:azure
npm run check:bedrock
```

See [`docs/aws-setup.md`](docs/aws-setup.md) for Bedrock configuration and
access troubleshooting. A failed provider check must not be represented as a
working inference deployment.

## Production deployments

### Current public deployment

The public demo runs the web process and scheduler as separate **Azure Container
Apps**, with CockroachDB Cloud as the database and Azure-hosted inference. The
production workflow builds dedicated web, scheduler, and migration images;
runs migrations before service rollout; deploys the scheduler before the web
service; and performs a public HTTP smoke test.

Secrets are supplied through Azure Key Vault references and managed identity.
The runtime database role is restricted; migrations use a separate DDL-capable
identity.

### Prepared AWS path — not live yet

[`infra/aws/`](infra/aws/) contains the CDK definition for a public ALB, ECR
repositories, ECS/Fargate web and scheduler services, a migration task,
Secrets Manager injection, least-privilege task roles, CloudWatch logs and
alarms, and GitHub OIDC delivery. The associated
[`deploy-aws.yml`](.github/workflows/deploy-aws.yml) validates the application
and infrastructure, then—only when deployment is explicitly enabled—would
publish immutable images, run the migration, roll out the scheduler and web
services, and check `/api/health`, `/api/ready`, and the landing page.

It has not been deployed as the live hackathon environment. Do not use the AWS
diagram or CDK source to imply that ECS, Bedrock, or Managed MCP are operating
in the current public demo.

## Town Archivist: the planned second CockroachDB tool

The Town Archivist is a deliberately read-only investigation workflow for one
explicitly selected world. It is designed to trace a single claim through:

```text
originating conversation or event
  → durable memory
  → retrieval/access record
  → later cognition or dialogue outcome
```

The workflow uses world-scoped stable views and must retain the selected
`world_id` in every query. It never exposes embeddings, hidden prompts, provider
configuration, or cross-world data. The intended Cloud Managed MCP connection
uses HTTPS and OAuth with `mcp:read` only; the repository's SQL
`hollowmere_reader` role is not an MCP credential.

Read the exact query and prompt contract in
[`docs/town-archivist.md`](docs/town-archivist.md). Until that Cloud MCP flow is
performed against the demo cluster, it remains a documented workflow rather
than completed submission evidence.

## Engineering constraints

These are enforced in the codebase and test suite rather than left as
conventions:

- **No floating-point simulation rules.** Values are fixed-point integers on a
  10,000 scale so runs are reproducible across machines.
- **World isolation by construction.** Composite foreign keys bind records to
  `(world_id, entity_id)` and reject cross-world references.
- **Append-only history, rebuildable projections.** Beliefs derive from
  updates, and tests check that rebuilding matches the live projection.
- **Model output cannot select arbitrary effects.** The engine owns identifiers,
  actions, and rule consequences; the model operates within an allowlist.
- **No inference in a retryable transaction.** Thinking happens before the
  database transaction, preventing duplicate model calls during serialization
  retries.
- **Safe degraded behavior.** Stub and replay modes are first-class paths, and
  provider failures do not fabricate grounded evidence.

## Two operational lessons this project surfaced

**Correct retrieval results do not prove indexed retrieval.** CockroachDB needs
current statistics, a matching `vector_cosine_ops` operator class, and a bound
query vector to choose the intended vector index. A query can return the right
rows while silently doing the wrong work. Hollowmere's preflight and retrieval
tests therefore inspect the query plan.

**Determinism requires ordered inputs, not only a seeded RNG.** Rules that
iterate over random UUID ordering can consume seeded randomness differently and
produce a different town from the same seed. Rule-feeding queries in the engine
use scenario keys rather than generated IDs.

More findings and their evidence are in
[`docs/preflight-findings.md`](docs/preflight-findings.md) and
[`docs/observability.md`](docs/observability.md).

## Further reading

- [Hackathon product requirements](docs/hackathon-prd.md)
- [Hackathon specification](docs/hackathon-spec.md)
- [Hackathon build checklist](docs/hackathon-checklist.md)
- [AWS pre-deployment gate](docs/aws-predeployment-runbook.md)
- [Town Archivist query guide](docs/town-archivist.md)
- [CockroachDB and Bedrock setup](docs/aws-setup.md)
- [Operational logging](docs/observability.md)

## Attribution

The escalation dynamics—accusation, hysteria, and factional hardening—are
inspired by Arthur Miller's *The Crucible*. The town, characters, story, and
text are original; no part of Miller's work is reproduced.

The agent loop (perceive → retrieve → reflect → plan) follows the pattern
described by Park et al., *Generative Agents* (2023).
