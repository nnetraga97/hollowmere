# Hollowmere Hackathon Product Requirements

- Status: Draft for guided-build approval
- Hackathon: CockroachDB x AWS Hackathon - Build with Agentic Memory
- Submission deadline: August 18, 2026 at 5:00 PM Eastern Time

## Product statement

Hollowmere is a playable, observable multi-agent simulation where conversations,
rumors, and decisions persist in CockroachDB and causally change what AI agents
believe, say, and do.

The submission is not primarily a game demo. It is a visual proof that persistent
agent memory can remain transactional, semantically retrievable, attributable,
and useful under concurrent autonomous activity.

Proposed tagline:

> A living town where every AI memory can change the future.

## Problem

Agent applications often claim to have memory when they only append chat history
or retrieve context without proving that the retrieved information affected an
action. This makes memory correctness, misinformation, provenance, isolation,
and recovery difficult to evaluate.

Hollowmere makes those properties visible. Thirty autonomous townspeople live in
isolated simulated worlds. They remember conversations, retrieve relevant past
events, spread claims, revise beliefs, and make decisions while player and
scheduler writes contend on the same database state.

## Target users

### Primary: hackathon judge or evaluator

The evaluator needs to understand the product in under three minutes, access a
working deployment without assistance, and see one memory move through the full
write, retrieval, decision, and consequence chain.

### Secondary: agent-system developer or researcher

The technical user needs an inspectable environment for studying persistent
memory, misinformation propagation, provenance, deterministic replay, database
contention, and failure behavior.

### Product user: player-investigator

The player talks to townspeople, introduces or challenges claims, observes how
the town changes, and attempts to prevent a false narrative from producing war.

## Product goals

1. Prove that an agent stores, retrieves, and acts on persistent memory.
2. Make the causal path from source memory to agent behavior inspectable.
3. Demonstrate CockroachDB as both transactional system of record and vector
   memory store.
4. Demonstrate a meaningful, read-only agent workflow through CockroachDB Cloud
   Managed MCP.
5. Run the submitted application on AWS and use Amazon Bedrock for live agent
   inference.
6. Give judges a reliable, reproducible experience with no private setup.
7. Run new public worlds on Azure Foundry GPT-5.6 Terra while Bedrock access is
   pending. Once enabled, let each private world choose Azure or Amazon Bedrock
   Claude Sonnet 5 without changing the database-owned simulation rules.

## Required user journey

1. The evaluator opens the public Hollowmere deployment and starts or resumes a
   private Azure-backed world. Once Bedrock is enabled, new worlds expose the
   provider choice before creation.
2. The evaluator approaches a townsperson and discusses a specific claim.
3. Hollowmere persists the conversation, participants, embedding, provenance,
   and resulting relationship or belief effects in CockroachDB.
4. The conversation ends and simulation time resumes. A refresh or reconnect
   does not erase the interaction.
5. On a later turn, the townsperson retrieves the relevant memory and uses it as
   evidence for a response, plan, gossip action, or belief update.
6. The evaluator sees the resulting dialogue, belief change, chronicle event,
   or world consequence in the application.
7. A read-only Town Archivist agent uses CockroachDB Managed MCP to inspect the
   same world's memory trail and returns the source agent, claim, tick, and
   supporting memory or event identifiers.

## P0 functional requirements

### FR-1: Durable world and session state

- A user can start, resume, end, and start another isolated world.
- Refreshing the browser preserves access through the signed session boundary.
- No browser-supplied world identifier can grant access to another world.

### FR-2: Persistent conversation memory

- Each completed conversation turn is durably stored in CockroachDB.
- Stored memory identifies its world, agent, simulation tick, source, text,
  embedding provenance, and conversation provenance.
- Repeating an idempotent request cannot apply the same effects twice.

### FR-3: Distributed vector retrieval

- Agent retrieval uses CockroachDB distributed vector indexing rather than a
  separate vector database.
- Retrieval remains world- and agent-scoped.
- Every returned candidate records all paths by which it entered the hybrid
  candidate set: ANN/vector, importance, recency, or pinned conversation anchor.
  A memory may have more than one path.
- A canonical verification query demonstrates that the intended vector index is
  selected after statistics are current.
- The canonical demonstrated memory must be present in the ANN/vector draw; an
  importance, recency, or pinned-anchor match alone does not prove vector use.
- Retrieved memories retain identifiers and candidate-path provenance that can
  be attached to the resulting cognition record or action.

### FR-4: Memory must affect behavior

- At least one reproducible scenario proves a retrieved memory changes a later
  response, plan, gossip action, relationship value, or belief update.
- Unsupported model output cannot directly select database effects or arbitrary
  identifiers.
- The application exposes enough evidence to distinguish causal memory use from
  a plausible but ungrounded model response.

### FR-5: Judge-facing observability

- The existing agent inspector shows recent dialogue, strongest beliefs,
  relationships, and current action.
- The chronicle or evidence views show the downstream event produced by the
  demonstrated memory.
- The evaluator can connect the visible consequence to the originating memory
  without reading source code.

### FR-6: Town Archivist through Managed MCP

- CockroachDB Cloud Managed MCP connects over HTTPS to the dedicated Hollowmere
  demo cluster and is authorized for read access through its OAuth flow.
- The Archivist can answer a bounded investigation question about the current
  demo world using persisted memories, claims, cognition, and events.
- Its answer includes source keys or identifiers and simulation ticks.
- Attempts to grant or use write access are outside the demo workflow; the
  recorded MCP connection is explicitly authorized read-only.
- The existing `hollowmere_reader` SQL role remains the direct-database identity
  for first-party read models. It is not represented as the Cloud MCP identity.
- The workflow is documented and shown in the demo; merely configuring the MCP
  endpoint does not satisfy this requirement.

### FR-7: AWS-hosted application

- The public judge-facing build runs on AWS.
- The web process and continuously running scheduler are deployed as separate
  workloads on Amazon ECS/Fargate or an equivalently suitable AWS runtime.
- Live agent inference uses Amazon Bedrock for at least the demonstrated path.
- New worlds choose either the Azure Terra or Bedrock Sonnet profile. The
  canonical hackathon demonstration selects Bedrock so the qualifying AWS path
  remains explicit and verifiable.
- The browser submits only an allowlisted profile key. Exact deployment and
  inference-profile identifiers remain server configuration.
- Runtime secrets are injected from an AWS-managed secret store and are not
  committed to the repository or exposed to the browser.

### FR-8: Reproducible demonstration

- A documented canonical seed or prepared demo world reaches the memory proof
  without relying on a lucky model response.
- The demonstrated data is produced by the real application path, not a mocked
  screenshot or manually edited database row.
- Provider failure has a visible safe fallback and cannot corrupt world state.

## P0 submission requirements

- Public, open-source repository with a visible MIT or Apache 2.0 license.
- Public functional AWS deployment available through the end of judging.
- Clear installation, configuration, migration, seed, and run instructions.
- Architecture diagram showing the browser, AWS workloads, Bedrock,
  CockroachDB Cloud, vector retrieval, and Managed MCP Archivist.
- Public YouTube or Vimeo demonstration shorter than three minutes.
- Accurate disclosure that repository development began July 24, 2026.
- Accurate disclosure of frameworks, libraries, AI coding assistants, and any
  pre-existing material incorporated into the project.
- Explicit explanation of what the application does with both CockroachDB tools
  and the selected AWS services.

## Non-functional requirements

### Security

- Application traffic uses TLS to CockroachDB Cloud.
- Database identities are least-privileged by workload.
- Managed MCP uses an OAuth connection authorized for read access and scoped to
  the dedicated demo cluster.
- Signed session ownership is enforced server-side for every player operation.
- Engine truth and secrets are never included in public agent prompts.

### Reliability

- CockroachDB serialization retries are bounded and idempotent.
- No provider call occurs inside a retryable database transaction.
- Scheduler leases prevent overlapping ownership and are renewed during long
  ticks.
- Inference or embedding failure degrades safely without inventing grounded
  evidence.

### Observability

- Web and scheduler workloads emit structured logs for database retries,
  inference, mutations, scheduler activity, and failures.
- AWS health checks distinguish web readiness from scheduler readiness.
- The demo includes one concise view of provenance or operational evidence.

### Performance targets

- The public landing and world UI become usable within 10 seconds under normal
  judge conditions.
- A dialogue request completes or enters its documented fallback within 20
  seconds.
- The canonical three-minute flow completes without manual database access or
  service restarts.

These are launch targets and must not be presented as measured results until
verified against the AWS deployment.

## Acceptance scenarios

### A-1: Memory survives reconnect

Given a player completes a conversation, when the browser refreshes and the
signed session is restored, then the conversation record and NPC impression are
still visible.

### A-2: Retrieved memory produces a consequence

Given a stored conversation memory about a known claim, when the relevant agent
later reasons or speaks, then the memory is present in the ANN/vector candidate
draw, its identifier and candidate paths are attached to the cognition outcome,
and a visible response, action, belief, or gossip event reflects it.

### A-3: Vector index is genuinely used

Given the canonical seeded dataset with current statistics, when the retrieval
query plan is inspected, then it selects the expected world/agent-prefixed
vector index rather than silently falling back to a full scan; when the
canonical interaction runs, the demonstrated memory is also marked as supplied
by that ANN/vector draw.

### A-4: World isolation holds

Given two player worlds, when either application session reads or mutates data,
then records from the other world cannot appear in the result.

### A-5: MCP is read-only and useful

Given the Town Archivist MCP configuration, when it investigates the demo claim,
then it returns source-backed world history from the selected cluster and its
connection remains authorized for read access only.

### A-6: AWS path is operational

Given the submitted public URL, when a judge starts a world and completes the
canonical interaction, then the AWS-hosted web and scheduler remain healthy and
the demonstrated inference request is verifiably handled by Bedrock. A tested
safe fallback remains required for failures but cannot satisfy this acceptance
scenario or the submission's Bedrock-use claim.

## Three-minute demo contract

| Time | Proof |
|---|---|
| 0:00-0:20 | State the problem: most agent memory demos do not prove memory changed behavior. |
| 0:20-0:50 | Open the AWS deployment, show the living town, and select the canonical NPC. |
| 0:50-1:20 | Complete the prepared conversation that writes a durable, attributable memory. |
| 1:20-1:45 | Refresh or advance the world, then show the memory returning in later dialogue or cognition. |
| 1:45-2:10 | Show the changed belief, gossip/action, or chronicle consequence. |
| 2:10-2:35 | Ask the Managed MCP Town Archivist for the source trail and show its identifiers/ticks. |
| 2:35-2:55 | Show the architecture diagram and identify vector indexing, MCP, ECS/Fargate, and Bedrock. |
| 2:55-3:00 | Close with the product claim and public repository. |

The recording should target 2:45 so transitions do not push it over three
minutes.

## Out of scope before submission

- Additional romance, combat, map, or cosmetic systems.
- Supporting all four eligible CockroachDB tools.
- A general-purpose natural-language database administration interface.
- Multi-region load testing presented as a production benchmark.
- Replacing CockroachDB with a second vector or transactional store.
- A broad redesign of the existing playable client.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| AWS deployment takes longer than expected | Reuse the existing explicit web and scheduler container targets; establish the AWS smoke path before feature polish. |
| Bedrock model access is unavailable | Run the existing provider preflight early and preserve the deterministic fallback, while resolving account/model authorization before recording. |
| Managed MCP appears bolted on | Make the Archivist answer a product-relevant investigation using the exact memory demonstrated in the application. |
| Vector results are correct but the demonstrated memory came from importance, recency, or the pinned anchor | Record all candidate paths, seed and analyze the database, assert the query plan, and require the canonical memory to appear in the ANN/vector draw. |
| Three-minute flow depends on nondeterminism | Use a fixed seed and prepared interaction, then require repeated successful runs through the deployed Bedrock-backed conversation path before recording. |
| Existing features distract from the memory proof | Keep the demo entirely on the required user journey and move secondary features to written documentation. |

## Delivery milestones

| Target date | Milestone |
|---|---|
| July 31 | Technical specification approved; AWS and MCP preflights started. |
| August 5 | Devpost draft created; public deployment foundation running. |
| August 8 | Complete memory-to-action demo path verified on AWS. |
| August 12 | Feature freeze; README, license, diagram, and testing instructions complete. |
| August 14 | Record and publish the demonstration video. |
| August 16 | Complete and review the Devpost submission. |
| August 18 | Buffer only; final deadline at 5:00 PM Eastern. |

## Success definition

The submission succeeds when a judge can say, from the product demonstration
alone: Hollowmere persisted a specific memory in CockroachDB, retrieved it using
distributed vector search, used it to change an agent's behavior, exposed the
causal trail through a read-only MCP agent, and ran the experience on AWS.
