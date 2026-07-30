# Hollowmere Hackathon Build Checklist

- Status: Build in progress
- PRD: `docs/hackathon-prd.md`
- Specification: `docs/hackathon-spec.md`
- Submission deadline: August 18, 2026 at 5:00 PM Eastern Time

## How to use this checklist

- Work in phase order unless a task explicitly says it can run in parallel.
- A checked implementation box is not enough; each task also lists required
  evidence.
- Do not claim AWS, Bedrock, vector-index, MCP, performance, or deployment
  behavior until its evidence gate passes.
- Preserve unrelated user changes. In particular, do not overwrite or
  incidentally stage the existing change in `engine/agents/dialogue.ts`.
- Do not execute destructive cloud, database, Git, or Devpost actions without
  resolving the exact target and obtaining any approval named below.

## Critical path

```text
Baseline
  -> Bedrock and account preflight
  -> Memory trace and canonical demo test
  -> AWS container and CDK implementation
  -> CockroachDB role and migration verification
  -> AWS deployment
  -> Managed MCP proof
  -> Release evidence
  -> Video and Devpost submission
```

## Phase 0: Protect the current repository

### H-001 — Establish build branch and baseline

Dependencies: none

- [x] Re-read `git status`, current branch, worktrees, and remote state.
- [x] Record the owner and intent of every existing modified or untracked file.
- [x] Create a `codex/`-prefixed feature branch for the hackathon build unless
  the user explicitly chooses a different Git workflow.
- [x] Confirm `engine/agents/dialogue.ts` remains byte-for-byte untouched by
  this work unless its owner later authorizes overlap.
- [x] Run `git diff --check` before making implementation changes.

Evidence:

- Branch name and base commit.
- Baseline `git status --short`.
- Written list of preserved user-owned changes.

### H-002 — Verify the current application baseline

Dependencies: H-001

- [x] Check local Node.js, npm, Docker, and CockroachDB tooling.
- [x] Start or inspect the dedicated local CockroachDB test cluster without
  resetting a shared cluster.
- [x] Apply the schema to an isolated test database.
- [x] Run engine and web typechecks.
- [x] Run the normal engine and web test suites.
- [x] Run the production web build.

Evidence:

- `npm run check` output with pass/fail counts.
- Exact CockroachDB version and test-database target.
- Any pre-existing failure separated from new work.

## Phase 1: Resolve external build inputs

### H-101 — Verify AWS execution environment

Dependencies: H-001

- [x] Verify AWS CLI v2 is installed.
- [x] Verify Docker is available for `linux/amd64` builds.
- [x] Resolve the intended AWS CLI profile or SSO session.
- [x] Run `aws sts get-caller-identity` and record only the account ID and ARN;
  do not expose credentials or tokens.
- [x] Confirm `us-east-1` or document the selected replacement region.
- [x] Check whether the account/region is already CDK-bootstrapped.

Approval gate:

- CDK bootstrap creates account-level resources and requires elevated
  permissions. Show the exact account, region, qualifier, and command before
  executing it.

Evidence:

- AWS CLI version.
- Account ID, caller ARN, and selected region.
- Existing or required CDK bootstrap version.

### H-102 — Verify Bedrock access

Dependencies: H-101

- [ ] Discover current foundation models and inference profiles in the selected
  region.
- [ ] Confirm the reasoning profile and every destination region it can use.
- [ ] Confirm Titan Text Embeddings V2 access in the source region.
- [ ] Confirm the ECS task-role policy can be scoped to the required actions and
  model resources.
- [ ] Run `npm run check:bedrock` using a non-production credential path.
- [ ] Confirm embeddings are exactly 1024 dimensions.
- [ ] Record separately that the script checks only its configured region;
  inspect the chosen inference profile and verify every destination region by
  model discovery and IAM review.

Evidence:

- Reasoning profile ID and destination regions.
- Embedding model ID.
- Successful bounded completion and embedding preflight.
- No `AmazonBedrockFullAccess` policy in the final design.

### H-103 — Resolve submission infrastructure inputs

Dependencies: H-101

- [ ] Select the final AWS deployment domain.
- [ ] Confirm DNS ownership and ACM validation path.
- [x] Resolve the CockroachDB Cloud demo cluster ID.
- [ ] Confirm runtime and migrator database identities exist or will be created.
- [ ] Choose the MCP-compatible client used for the recorded Town Archivist
  workflow.
- [ ] Choose MIT or Apache 2.0 for the repository license.

User-input gate:

- Domain ownership and license choice require user confirmation before public
  deployment or licensing changes.

Evidence:

- Final HTTPS origin.
- Cluster ID stored outside the repository if sensitive.
- Recorded license decision.

## Phase 2: Implement the local memory proof

### H-201 — Add liveness and readiness endpoints

Dependencies: H-002

- [x] Add `GET /api/health` with no database/provider dependency.
- [x] Return service name and build revision without secrets.
- [x] Add `GET /api/ready` with a bounded CockroachDB `SELECT 1`.
- [x] Return non-200 on readiness timeout or database failure.
- [x] Add route tests for healthy and failing dependencies.

Evidence:

- Focused route tests.
- Local `curl` results for both endpoints.
- Response inspection proving no secret or infrastructure detail leaks.

### H-202 — Modernize the Bedrock text boundary

Dependencies: H-102

- [x] Replace Claude text `InvokeModelCommand` with `ConverseCommand`.
- [x] Replace Claude streaming with `ConverseStreamCommand`.
- [x] Keep Titan embeddings on `InvokeModelCommand`.
- [x] Set `maxTokens` explicitly on every text request.
- [x] Configure adaptive retry mode and five total attempts.
- [x] Preserve connection and inactive-request timeouts.
- [x] Map Bedrock usage and stop reasons into the existing inference contracts.
- [x] Preserve safe error classification and fallback behavior.
- [x] Add unit cases for retryable throttling/transient failures and
  non-retryable authorization, validation, and malformed-response failures.
- [x] Add or update provider unit tests without calling live Bedrock.

Evidence:

- Focused inference tests.
- Typecheck.
- Live Bedrock preflight after unit verification.
- Diff proving no static AWS credentials were introduced.

### H-203 — Persist recalled memory identifiers

Dependencies: H-002

- [x] Change hybrid retrieval to retain every candidate path for each memory:
  ANN/vector, importance, and recency.
- [x] Label the separately loaded conversation anchor as `pinned_anchor`.
- [x] Preserve all matching paths when one memory enters through multiple draws.
- [x] Capture the recalled memory IDs and candidate paths for a conversation
  turn.
- [x] Persist those IDs and paths in the structured turn outcome.
- [x] Preserve idempotent turn replay and process-crash checkpoint behavior.
- [x] Do not store raw embeddings or hidden prompts in the outcome.
- [x] Add tests for zero, one, and multiple recalled memories, overlapping draw
  membership, and a separately pinned anchor.
- [x] Add a regression test proving another world's memory cannot be attached.

Evidence:

- Conversation tests pass.
- Stored example outcome with IDs and no prompt/secret content.
- World-isolation regression test.

### H-204 — Expose the judge-facing memory trace

Dependencies: H-203

- [x] Extend the server read model with at most five relevant recent memories.
- [x] Include formation tick, last-accessed tick, kind, bounded excerpt, claim
  key, source kind, and source identifier.
- [x] Indicate which memory IDs were recalled by the demonstrated later turn.
- [x] Show every candidate path for a recalled memory and label ANN/vector
  distinctly from importance, recency, and pinned anchor.
- [x] Update client contracts.
- [x] Add a compact `Memory trace` section to the existing agent inspector.
- [x] Keep embeddings, private prompts, engine truth, and other worlds hidden.
- [x] Add server and component tests.

UI constraint:

- Do not add decorative or animated status dots. Use labels, identifiers, and
  timestamps because they convey actual evidence.

Evidence:

- API contract test.
- UI test or screenshot from the canonical world.
- Accessibility check for labels, copyable IDs, and keyboard use.

### H-205 — Add stable Archivist read views

Dependencies: H-203

- [ ] Decide from a real MCP query whether raw joins are sufficiently reliable.
- [x] If needed, add `archivist_memory_sources`,
  `archivist_memory_accesses`, and `archivist_cognition` views.
- [x] Require explicit `world_id` filtering in documented queries.
- [x] Exclude cookies, session secrets, connection data, hidden prompts, and raw
  embeddings.
- [x] Add schema assertions for view columns and cross-world filtering.

Evidence:

- Schema tests.
- Example read query for one world.
- Column review proving sensitive fields are absent.

### H-206 — Implement the canonical public demo test

Dependencies: H-203, H-204

- [x] Start with candidate agent `tobias_reeve` and claim
  `physician_was_paid`.
- [x] Exercise the same movement and conversation APIs used by the web app.
- [x] Prove the first conversation applies a visible belief or rumor effect.
- [x] Close the conversation and prove its durable summary memory and source
  edge exist.
- [x] Simulate reconnect/resume of the same signed world.
- [x] Perform a later conversation that retrieves the prior memory.
- [x] Assert the later structured outcome names the recalled memory ID and that
  its candidate paths include ANN/vector; importance, recency, or pinned-anchor
  membership alone does not pass.
- [x] Advance ticks and assert a downstream rumor, belief, dialogue, or action.
- [x] If a different agent/claim produces a clearer deterministic proof, update
  PRD, spec, test, Archivist prompt, and video script together.

Evidence:

- One focused integration test for the complete chain.
- Captured world, agent, claim, turn, memory, and consequence identifiers.
- No direct manual database mutation in the demonstrated path.

### H-207 — Add a private-world inference choice

Dependencies: H-002

- [x] Present Azure Foundry with GPT-5.6 Terra as the active profile; expose the
  Amazon Bedrock Claude Sonnet 5 choice only when `BEDROCK_ENABLED=true`.
- [x] Reject Bedrock world creation server-side while the environment switch is
  disabled, rather than relying only on a hidden UI card.
- [x] Keep provider profile keys server-allowlisted; never accept a browser-
  supplied deployment name or model ID.
- [x] Persist the immutable profile on the world and enforce the allowlist with
  a CockroachDB check constraint.
- [x] Route both web conversation calls and scheduler cognition through the
  world-owned profile.
- [x] Carry the profile into successor worlds.
- [x] Keep local/test execution on the deterministic stub unless deployment
  explicitly enables per-world routing.
- [x] Expose only the profile key in the ordinary world read model; do not send
  credentials or provider configuration to the browser.
- [x] Add routing, persistence, constraint, and production-build verification.

Evidence:

- Runtime session request rejects an arbitrary model key with 400.
- Runtime session request creates an Azure-profile world with 201 and the
  persisted `azure_terra` read model.
- Focused engine, schema, scheduler, web, and production-build checks pass.
- Exact cloud deployment/profile IDs remain environment-owned release inputs.

## Phase 3: Database identities and container targets

### H-301 — Add the runtime SQL role

Dependencies: H-002

- [x] Add idempotent SQL for `hollowmere_runtime`.
- [x] Grant only the DML and sequence privileges required by web and scheduler.
- [x] Deny database/schema/table/role/cluster-setting DDL.
- [x] Keep the DDL-capable migrator identity separate.
- [x] Retain `hollowmere_reader` for direct first-party read models without
  claiming it authenticates Managed MCP.
- [x] Test representative reads/writes and rejected DDL.

Evidence:

- SQL role test results.
- Successful application smoke using the runtime role.
- Expected permission-denied result for DDL.

### H-302 — Add the migration image target

Dependencies: H-301

- [x] Add an explicit `migration` Docker target.
- [x] Copy only the files required to run the idempotent schema migration.
- [x] Default to `npm run db:migrate`, never `--fresh`.
- [x] Run as a non-root container user where compatible.
- [x] Build `linux/amd64` web, scheduler, and migration images.
- [x] Run the migration image against an isolated database.

Evidence:

- Three successful Docker builds.
- Idempotent migration run twice without dropping data.
- Image inspection proving no `.env`, credentials, or local certificates were
  copied.

## Phase 4: Build AWS infrastructure as code

### H-401 — Scaffold the isolated CDK project

Dependencies: H-101

- [x] Create `infra/aws` with its own package and lockfile.
- [x] Pin the CDK CLI exactly and invoke it through `npx`.
- [x] Use `tsx`, strict TypeScript, and readonly construct props.
- [x] Commit `cdk.context.json` only after reviewing it for sensitive values.
- [x] Add CDK unit assertions and `cdk-nag` checks with justified suppressions
  only.

Evidence:

- CDK typecheck and tests.
- `npx cdk list`.
- `npx cdk synth --strict`.

### H-402 — Implement the registry stack

Dependencies: H-401

- [x] Create immutable, scan-on-push ECR repositories for web and scheduler.
- [x] Add a reviewed lifecycle policy retaining recent commit images.
- [x] Create or reference the GitHub OIDC provider.
- [x] Trust only the Hollowmere repository, main branch, and production
  environment.
- [x] Scope image-push permissions to the two repositories.

Evidence:

- CDK assertions for encryption, immutability, scanning, and trust conditions.
- Synthesized IAM policy review.
- Clean `cdk-nag` result or documented narrow suppressions.

### H-403 — Implement the runtime stack

Dependencies: H-401, H-402, H-103

- [x] Create the two-AZ VPC and ECS cluster with Container Insights.
- [x] Create the ALB, HTTPS listener, ACM certificate reference, and HTTP
  redirect.
- [x] Create separate web and scheduler security groups.
- [x] Set Fargate networking to `awsvpc` and platform `LATEST`.
- [x] Use valid task sizes: web `512/1024`, scheduler `1024/2048`.
- [x] Create separate execution and task roles.
- [x] Scope Bedrock task permissions to required actions and resources.
- [x] Inject secrets from Secrets Manager at task launch.
- [x] Configure blocking `awslogs`, 30-day retention, health grace, deployment
  circuit breakers, and rollback.
- [x] Use 100/200 rolling percentages for web and 0/100 for the singleton
  scheduler to avoid overlapping workers.
- [x] Set `INFERENCE_MODE=world` explicitly in both task definitions and keep
  `BEDROCK_ENABLED=false` until the live access gate passes.
- [x] Configure the ALB target group as `ip`, health path `/api/health`, and
  30-second deregistration delay.
- [x] Add CloudWatch alarms and runtime-stack termination protection.

Evidence:

- CDK assertions for networking, task sizes, roles, secrets, health checks, and
  rollback.
- Reviewed `cdk synth --strict` and `cdk diff`.
- No wildcard application permissions except actions that technically require
  them, with those exceptions documented.

### H-404 — Add AWS delivery workflow

Dependencies: H-402, H-403

- [x] Add `.github/workflows/deploy-aws.yml` without deleting the working Azure
  workflow.
- [x] Authenticate through GitHub OIDC; use no static AWS keys.
- [x] Reuse the application validation job or make AWS deploy depend on the same
  checks.
- [x] Build explicit `web` and `scheduler` Docker targets for `linux/amd64`.
- [x] Push commit-SHA tags and record image digests.
- [x] Register and deploy the scheduler revision first.
- [x] Wait for scheduler stability and inspect failure events.
- [x] Register and deploy the web revision second.
- [x] Wait for healthy targets and call health, readiness, and landing URLs.
- [x] Serialize deployments and publish a structured job summary.

Evidence:

- Workflow syntax review.
- OIDC subject and least-privilege policy review.
- Successful end-to-end workflow run after infrastructure exists.

## Phase 5: Provision and deploy AWS

### H-501 — Bootstrap and deploy registry resources

Dependencies: H-401, H-402, H-101

- [ ] Show exact AWS account, region, CDK qualifier, permissions boundary, and
  synthesized changes.
- [ ] Obtain explicit approval for CDK bootstrap if it is not already present.
- [ ] Bootstrap without deleting or replacing an existing toolkit stack.
- [ ] Run a fresh `cdk diff`.
- [ ] Obtain approval for the registry-stack resource creation.
- [ ] Deploy the registry stack.
- [ ] Confirm both repositories and the OIDC role match the synth.

Evidence:

- CDK bootstrap version.
- CloudFormation stack status.
- Repository ARNs and OIDC role ARN.

### H-502 — Push bootstrap images and deploy runtime resources

Dependencies: H-302, H-403, H-501

- [ ] Build and push reviewed bootstrap images.
- [ ] Re-run `cdk diff` with exact image references and domain values.
- [ ] Obtain approval for runtime-stack creation and forecasted recurring cost.
- [ ] Deploy the runtime stack.
- [ ] Validate ALB, certificate, DNS, ECS cluster, services, roles, log groups,
  secrets references, and alarms.

Evidence:

- Image digests.
- Runtime CloudFormation stack status.
- Public HTTPS endpoint and certificate validation.
- Exact created resources and estimated ongoing cost.

### H-503 — Migrate and seed CockroachDB Cloud

Dependencies: H-301, H-302, H-502

- [ ] Resolve the exact target cluster and database with a read-only query.
- [ ] Confirm the command does not contain `--fresh`.
- [ ] Obtain approval before running the DDL-capable migration task.
- [ ] Run and wait for the one-off migration task.
- [ ] Apply runtime and reader roles.
- [ ] Seed or publish the immutable scenario through the supported script.
- [ ] Refresh statistics after seeding.
- [ ] Verify schema, scenario version, roles, and vector index.

Evidence:

- Migration task exit code and logs.
- Table/view/index counts tied to the deployed commit.
- Role permission checks.
- `ANALYZE` completion and vector plan evidence.

### H-504 — Deploy and smoke-test the application

Dependencies: H-503, H-404

- [ ] Run the AWS delivery workflow for an exact commit.
- [ ] Confirm scheduler deployment reaches stable state first.
- [ ] Confirm web targets are healthy.
- [ ] Verify `/api/health`, `/api/ready`, and the public landing page.
- [ ] Start a new signed world, move, converse, close, refresh, and resume.
- [ ] Run the canonical memory trace.
- [ ] Confirm `inference_client_created` reports `mode=bedrock` and capture the
  expected reasoning model ID from served-turn metadata.
- [ ] Confirm CloudWatch contains structured metadata but no prompts or secrets.
- [ ] Observe the deployment for repeated lease, database, or inference failures.

Evidence:

- GitHub Actions run URL.
- ECS task-definition revisions and image digests.
- Public URL and HTTP results.
- Canonical world evidence and clean observation window.

### H-505 — Prove the canonical path under deployed Bedrock

Dependencies: H-504, H-206

- [ ] Run the prepared public multi-turn flow on three fresh deployed worlds.
- [ ] Confirm every run binds the intended claim through the real web
  conversation path.
- [ ] Confirm every run stores the durable memory and source edge.
- [ ] Confirm every run later recalls that memory with ANN/vector among its
  candidate paths.
- [ ] Confirm every run records the expected Bedrock model and produces the
  visible downstream consequence.
- [ ] If any run fails, fix the prepared interaction or deterministic engine
  boundary and restart the three-run gate; do not manually alter database rows.

Evidence:

- Three world, turn, memory, claim, model, and consequence identifier sets.
- Bedrock-mode log evidence without prompts or credentials.
- Pass/fail record for every attempt, including failures before the final streak.

## Phase 6: Prove Managed MCP usage

### H-601 — Configure the Town Archivist

Dependencies: H-103, H-205, H-503

- [ ] Use the official HTTPS endpoint and the exact demo cluster ID.
- [ ] Authenticate through OAuth.
- [ ] Refresh the official documentation and confirm the OAuth consent screen
  still exposes independent read and write permission choices.
- [ ] Grant `mcp:read` only and leave write permission unchecked.
- [ ] Confirm write tools such as `create_database`, `create_table`, and
  `insert_rows` are absent or blocked without invoking a mutation.
- [ ] Keep tokens and client-local configuration out of Git and logs.
- [ ] Document setup without embedding credentials.

Evidence:

- Redacted connection configuration.
- Selected cluster and `mcp:read` authorization confirmation.
- Available MCP tool list.

### H-602 — Run and verify the canonical Archivist prompt

Dependencies: H-601, H-505

- [ ] Use the world, agent, and claim from the public demo.
- [ ] Ask for originating turn, memory, retrieval/access, later outcome, and
  ticks.
- [ ] Require explicit identifiers and disclosure of inferred links.
- [ ] Independently verify every returned identifier in CockroachDB.
- [ ] Confirm all returned rows belong to the selected world.
- [ ] Capture audit evidence without credentials or unrelated player data.

Evidence:

- Final prompt.
- Redacted grounded response.
- Identifier verification table.
- Audit evidence suitable for the submission video or README.

## Phase 7: Release verification and repository readiness

### H-701 — Run the complete release gate

Dependencies: H-505, H-602, H-703

- [ ] Run `npm run check` from a clean dependency install.
- [ ] Run CDK checks, tests, synth, and drift inspection.
- [ ] Rebuild all three Docker targets.
- [ ] Re-run Bedrock preflight using deployment-equivalent permissions.
- [ ] Verify both ECS task definitions set `INFERENCE_MODE=world` and
  `BEDROCK_ENABLED=true`, and the canonical served-turn evidence names the
  expected Bedrock model.
- [ ] Re-run CockroachDB preflight and vector-plan assertion; confirm the
  canonical memory also carries ANN/vector candidate provenance.
- [ ] Verify runtime role DML and DDL denial.
- [ ] Run public health, readiness, session, conversation, reconnect, and
  canonical memory smokes.
- [ ] Re-run the three-fresh-world deployed Bedrock reliability gate.
- [ ] Confirm both ECS services and ALB targets remain healthy.
- [ ] Confirm the Azure deployment was not altered accidentally.
- [ ] Run `git diff --check` and inspect the full intended diff.

Evidence:

- One dated release-evidence document containing commands, results, commit,
  task revisions, and known limitations.

### H-702 — Complete public repository materials

Dependencies: H-701, H-103

- [ ] Add the selected license and make it visible through GitHub repository
  metadata.
- [ ] Update README architecture and production URL from verified facts.
- [ ] Replace or contextualize the top Azure deployment badge and Azure play
  link so the verified AWS URL is the submission's primary path.
- [ ] Update the README production-deployment table to lead with the AWS
  submission while preserving accurate Azure support documentation.
- [ ] Explain the memory-to-action chain.
- [ ] Explain Distributed Vector Indexing and Managed MCP usage separately.
- [ ] Explain ECS/Fargate and Bedrock usage.
- [ ] Add local and AWS setup instructions, example configuration, migration,
  seed, run, and test commands.
- [ ] Add the architecture diagram.
- [ ] Add testing instructions and any judge credentials without exposing
  privileged secrets.
- [ ] Disclose development start date and incorporated frameworks/tools.
- [ ] Remove stale claims that the public submission deployment is Azure-only.
- [ ] Correct `db/read-only-role.sql` so it describes only the direct SQL reader
  and does not claim that role authenticates Managed MCP.
- [ ] Mark `docs/plan.md` as historical/superseded for the submission build and
  point readers to the PRD, specification, and checklist.
- [ ] Use `Town Archivist` consistently for the Managed MCP workflow; explain
  any retained historical `Town Investigator` wording.

Evidence:

- Public GitHub rendering review.
- Repository/license URLs.
- Link and command audit.

### H-703 — Establish cost controls and post-judging teardown

Dependencies: H-103, H-502

- [ ] Record the recurring-cost estimate and the latest date the public demo
  must remain available.
- [x] Tag all submission resources consistently for cost attribution.
- [x] Document the exact teardown order and CDK/database targets without running
  destructive commands during judging.
- [x] Record which persistent evidence, images, logs, or database backups should
  be retained before teardown.
- [x] Require a fresh target review and explicit user approval before any
  post-judging deletion.

Evidence:

- Dated cost and retention decision.
- Resource inventory and tags.
- Reviewed teardown runbook with no execution claim.

## Phase 8: Video and Devpost

### H-801 — Prepare and record the demonstration

Dependencies: H-701, H-702

- [ ] Convert the PRD demo contract into a spoken script targeting 2:45.
- [ ] Rehearse with the exact production world path and Archivist prompt.
- [ ] Record the AWS URL, memory write, reconnect, recall, consequence, MCP
  trace, and architecture.
- [ ] Avoid copyrighted music or unlicensed third-party material.
- [ ] Upload publicly to YouTube or Vimeo.
- [ ] Verify playback, audio, resolution, and duration while signed out.

Evidence:

- Public video URL.
- Final duration under three minutes.
- Timestamp map for each required proof.

### H-802 — Create the Hollowmere Devpost project

Dependencies: H-702

- [ ] Finalize project name, tagline, description, built-with technologies,
  public repository, license, demo, and video URLs.
- [ ] Show the exact project fields to the user.
- [ ] Obtain approval before creating the external Devpost project.
- [ ] Create the project through the Devpost plugin.
- [ ] Add or upload the final project thumbnail separately.

Evidence:

- Devpost project ID, slug, and public/edit URL.
- Saved field review.

### H-803 — Complete submission answers

Dependencies: H-801, H-802

- [ ] Refresh the live submission requirements before answering.
- [ ] Provide the functional AWS demo URL.
- [ ] Provide public repository and license URLs.
- [ ] Select Distributed Vector Indexing and Cloud Managed MCP Server.
- [ ] Select Amazon ECS and Amazon Bedrock.
- [ ] Explain what each selected component actually does.
- [ ] Enter the verified project start date in the required format.
- [ ] Truthfully disclose pre-existing work and AI tools used.
- [ ] Provide submitter type, country, learning/value answers, and required
  eligibility attestations from the user.
- [ ] Add testing instructions and the architecture diagram.
- [ ] Review every answer against repository and release evidence.

Evidence:

- Complete answer sheet mapped to live Devpost field IDs.
- Zero unsupported or future-tense implementation claims.

### H-804 — Submit

Dependencies: H-803

- [ ] Show the complete final submission and all selected fields to the user.
- [ ] Confirm registration and submission window are still valid.
- [ ] Obtain explicit approval to submit.
- [ ] Submit through the Devpost plugin.
- [ ] Open the returned submission URL and verify Submitted status.
- [ ] Record the submission ID, timestamp, URL, and final project version.

Final evidence:

- Devpost status: `Submitted`.
- Submission ID and URL.
- Final public repository commit.
- Final AWS deployment revision and video URL.

## Definition of done

The guided build is complete only when the public AWS application, repository,
video, and Devpost submission all point to the same verified implementation and
a judge can independently observe this chain:

```text
conversation turn
  -> CockroachDB durable memory and provenance
  -> distributed vector retrieval with ANN candidate provenance
  -> recalled memory ID and candidate paths in a later Bedrock-backed outcome
  -> visible belief, dialogue, rumor, or action consequence
  -> OAuth mcp:read Managed MCP trace of the same evidence
```
