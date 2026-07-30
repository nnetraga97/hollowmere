# Hollowmere Hackathon Build Log

This file records implementation evidence for
`docs/hackathon-checklist.md`. It does not replace the checklist or claim that a
later deployment remains healthy without re-verification.

## 2026-07-30 — H-001 repository protection

- Worktree: `/Users/nicknetraganti/Desktop/Developer Stuff/CockRoachDb`
- Base commit: `036cf430ecc687943871a4e9840338e89414dfb2`
- Build branch: `codex/hollowmere-hackathon-build`
- Remote: `origin` at `https://github.com/nnetraga97/hollowmere.git`
- Pre-existing user-owned modification:
  `engine/agents/dialogue.ts`
- Initial planning artifacts:
  `docs/hackathon-prd.md`, `docs/hackathon-spec.md`, and
  `docs/hackathon-checklist.md`
- Preserved source-file SHA-256:
  `26f6a358e8f6dc40eecdc9e9cb8591bf665b7c1186a4f0c456dcb97e30dfd5f5`
- Preserved user-diff SHA-256:
  `e4770372328cdf3fc242f2d7e2423a7f4cbad2f43f9f4fa86ca89d9c8ab38807`
- `git diff --check`: passed before implementation.

Other worktrees were inspected before branch creation. None owns
`codex/hollowmere-hackathon-build`.

## 2026-07-30 — H-002 application baseline

Toolchain:

- Node.js `v26.0.0`
- npm `11.12.1`
- Docker `29.3.1`
- Docker Compose `v5.1.0`
- CockroachDB `v26.2.4`, three local nodes

Database target:

- Host: `localhost:26257`
- Database: `hollowmere`
- TLS mode: disabled for the local-only cluster
- Storage: Docker `tmpfs`; the stopped cluster contained no persistent data
- Migration: guarded local `npm run db:migrate -- --fresh`, then idempotent
  schema application

CockroachDB preflight passed:

- Three nodes live and available.
- Default isolation is serializable.
- Distributed vector indexing is enabled.
- `VECTOR(1024)` and the world-prefixed cosine index are supported.
- The canonical ANN query plan uses vector search with prefix spans.
- `AS OF SYSTEM TIME` and `cluster_logical_timestamp()` are available.

Baseline regression found and repaired:

- Cause: after engine tests moved into responsibility subdirectories, twelve
  scenario fixtures still resolved `../scenario/hollowmere-v2.json`, producing
  the nonexistent path `engine/scenario/hollowmere-v2.json`.
- Repair: each affected test now resolves `../../scenario/hollowmere-v2.json`.
- Focused scenario verification: 24 passed, 0 failed.

Normal release check:

- Engine: 229 passed, 0 failed, 3 intentional slow-test skips.
- Web: 13 passed, 0 failed.
- Root and web TypeScript checks passed.
- Next.js production build passed.
- `git diff --check` passed.

## 2026-07-30 — H-201 liveness and readiness

Implemented:

- `GET /api/health` reports only service name and build revision and has no
  database or inference dependency.
- `GET /api/ready` runs `SELECT 1` and returns a bounded generic 503 on timeout
  or database failure without returning connection details.
- Both responses disable caching.
- `SERVICE_NAME`, `BUILD_REVISION`, and `READINESS_TIMEOUT_MS` are documented in
  `.env.example`.

Verification:

- Five focused handler cases passed: liveness, ready success, dependency
  failure, timeout, and environment fallback.
- Web suite: 18 passed, 0 failed.
- Web TypeScript and production build passed.
- Production server without `DATABASE_URL`: health 200, readiness 503 with a
  generic body.
- Production server with the local database environment: health 200 and
  readiness 200.
- Example healthy payloads:
  `{"service":"hollowmere-web","revision":"036cf43"}` and
  `{"service":"hollowmere-web","revision":"036cf43","ready":true}`.

## 2026-07-30 — Bedrock access preflight

- AWS CLI `2.36.8`; selected region `us-east-1`.
- Read-only caller verification succeeded for account `536260290118`.
- The configured Claude Haiku 4.5 cross-region profile is active and currently
  targets `us-east-1`, `us-east-2`, and `us-west-2`.
- Titan Text Embeddings V2 is present in the `us-east-1` catalog.
- Live Titan embedding, Claude completion, and Claude streaming calls all fail
  with `ValidationException: Operation not allowed`.
- Model availability reports `NOT_AUTHORIZED`; Claude agreement availability
  is also not yet present in the inspected destination regions.

No subscription, agreement, model-access, IAM, or other account mutation was
performed. H-102 and the live portion of H-202 remain blocked on explicitly
enabling the required Bedrock models and profiles.

## 2026-07-30 — H-203 recalled-memory provenance

Implemented:

- Hybrid retrieval retains every matching `ann`, `importance`, and `recency`
  candidate path for each memory.
- A relationship memory loaded outside those draws is labeled
  `pinned_anchor`.
- Conversation checkpoints and final structured outcomes persist only recalled
  memory IDs and candidate paths, alongside the existing bounded result.
- Idempotent replay returns the recorded references without another provider
  call; the paid-result checkpoint contains the same references for crash
  recovery.
- The model continues to receive bounded memory text only. Raw embeddings,
  system prompts, and user prompts are not added to the outcome.

Verification:

- Focused conversation and retrieval suites: 38 passed, 0 failed.
- Covered zero, one, and multiple memories, overlapping hybrid paths, a forced
  separately pinned anchor, persisted outcome inspection, idempotent retry, and
  cross-world isolation.
- Repository-wide check after this slice: 232 engine tests passed, 0 failed,
  3 intentional slow-test skips; 18 web tests passed; both typechecks and the
  Next.js production build passed.

## 2026-07-30 — H-207 private-world inference choice

Implemented:

- The entry screen uses Azure Foundry with GPT-5.6 Terra while Bedrock access is
  pending. Amazon Bedrock with Claude Sonnet 5 appears only when the server is
  launched with `BEDROCK_ENABLED=true`.
- The browser sends only `azure_terra` or `bedrock_sonnet`; exact provider
  deployment/profile identifiers remain environment configuration.
- `worlds.inference_profile` is immutable through the product API and protected
  by a database check constraint. Successor worlds inherit it.
- Web conversations and scheduler ticks resolve the same world-owned profile.
- `INFERENCE_MODE=stub` remains the offline-safe default;
  `INFERENCE_MODE=world` explicitly enables live per-world routing.

Verification:

- Focused inference, instantiation, schema, and scheduler suites: 65 passed,
  0 failed.
- Web suite: 18 passed, 0 failed; web typecheck and production build passed.
- Runtime API rejected an arbitrary profile with 400.
- Runtime API created an `azure_terra` world with 201 and returned that stored
  profile in the world read model.
- The exact runtime test world was deleted after verification.

## 2026-07-30 — H-204 judge-facing memory trace

Implemented:

- The selected NPC read model returns at most five recent grounded memories,
  including formation and access ticks, kind, a 220-character excerpt, claim
  key, source kind, and copyable source and memory identifiers.
- The trace links a memory to the later completed conversation turn that
  recalled it and displays every recorded retrieval path using distinct
  `ANN / vector`, `importance`, `recency`, and `pinned anchor` labels.
- Only same-world memories with turn or event source edges are eligible.
  Plans, reflections, embeddings, prompts, and memories from another world are
  not exposed.
- The existing agent inspector now contains a compact, keyboard-readable
  `Memory trace` section; no decorative status indicators were added.

Verification:

- The real database-backed API test formed a conversation memory, recalled it
  in a later turn, and proved its source, retrieval paths, bounded excerpt, and
  world isolation: 7 passed, 0 failed.
- The rendered component test proves identifiers, accessible retrieval labels,
  and the absence of prompt or embedding fields.
- Web suite: 21 passed, 0 failed; web TypeScript and production build passed.
- Final repository-wide gate: 236 engine tests passed, 0 failed, 3 intentional
  slow-test skips; 21 web tests passed, 0 failed; both TypeScript checks and
  the Next.js production build passed; `git diff --check` passed.

## 2026-07-30 — H-202 dormant Bedrock implementation and Azure-only gate

Implemented:

- Azure is always available. Bedrock remains in the closed server allowlist but
  is neither rendered nor accepted for new worlds unless
  `BEDROCK_ENABLED=true`.
- The home page reads provider availability at server runtime. Existing or
  browser-forged Bedrock profiles fail closed while the flag is disabled.
- Claude completion and streaming now use `ConverseCommand` and
  `ConverseStreamCommand`; Titan Text Embeddings V2 remains on
  `InvokeModelCommand`.
- Every text request sets `maxTokens`. The Bedrock runtime uses adaptive retry
  mode with five total attempts and retains bounded connection and inactivity
  timeouts.
- Completion and streaming usage plus stop reasons flow through the provider-
  neutral inference contracts and structured logs.

Verification:

- Offline provider tests verify command types and payloads, Titan dimensions,
  usage and stop-reason mapping, retry configuration, retryable transient error
  classification, non-retryable authorization and validation failures, and
  malformed model output.
- With `BEDROCK_ENABLED=false`, production HTML contained Azure only and a
  Bedrock session request returned HTTP 400. With `BEDROCK_ENABLED=true`, the
  same production build rendered both provider choices.
- Final repository-wide gate: 249 engine tests passed, 0 failed, 3 intentional
  slow-test skips; 21 web tests passed, 0 failed; both TypeScript checks and the
  Next.js production build passed.
- AWS CLI `2.36.8`, caller identity, and the `us-east-1` Bedrock catalog remain
  readable. Live model invocation was not retried because access is pending an
  AWS support case; that release gate remains open.

## 2026-07-30 — H-101 AWS execution environment

- AWS CLI v2 is available and the selected default region is `us-east-1`.
- The default shared-credentials path currently resolves to account
  `536260290118`, caller `arn:aws:iam::536260290118:user/root-replace`.
- Real `linux/amd64` web, scheduler, and migration images were built through
  Docker Buildx on the local arm64 workstation.
- A read-only CloudFormation lookup confirmed that `CDKToolkit` does not exist
  in `us-east-1`; the account is not yet bootstrapped there.
- No CDK bootstrap or AWS mutation was performed. The required approval gate
  remains before that account-level operation.

## 2026-07-30 — H-205 stable Archivist read views

Implemented:

- Added `archivist_memory_sources`, `archivist_memory_accesses`, and
  `archivist_cognition` as bounded read models with explicit `world_id`.
- Excluded embeddings, replay vectors, prompt hashes, raw decisions, structured
  outcomes, session identifiers, player identifiers, and connection data.
- Added `docs/town-archivist.md` with the canonical prompt and parameterized,
  world-scoped queries.
- Claim-linked conversations now persist the single referenced claim on their
  durable memory, allowing the Archivist to trace `physician_was_paid` without
  inferring the link from prose.

Verification:

- Schema assertions lock every view column and reject sensitive-field drift.
- The canonical integration test creates a second private world and proves an
  explicit world filter returns only the selected world's rows.
- The schema applied idempotently to local CockroachDB.
- A real Managed MCP query is still pending the selected CockroachDB Cloud demo
  cluster and H-601 OAuth setup, so H-205's first checklist item remains open.

## 2026-07-30 — H-206 canonical public demo test

- The focused test starts a fresh seeded world, reaches `tobias_reeve` through
  the same adjacent-movement command used by the web app, and states the
  `physician_was_paid` accusation through the multi-turn conversation API.
- It proves Tobias immediately holds the rumor, closing writes a claim-linked
  dialogue memory and turn source edge, and the same database-backed session
  resumes after the process pool is closed.
- A later conversation retrieves the exact durable memory and records `ann`
  among its candidate paths in both the turn outcome and judge-facing agent
  detail.
- The test verifies a memory-access row, the stable Archivist outcome, and a
  later tick carrying the same rumor ID to another agent.
- Focused result: 1 complete canonical chain passed with no direct database
  mutation of the demonstrated world.

## 2026-07-30 — H-301 least-privilege database identities

- Added idempotent `hollowmere_runtime` and refreshed
  `hollowmere_reader` role SQL, applied through `npm run db:roles` with a safely
  quoted database identifier.
- Runtime receives SELECT on the schema and explicit INSERT, UPDATE, and DELETE
  only on private-world tables. Scenario templates remain read-only. New tables
  do not become writable through default privileges.
- The schema currently has no sequences, so no sequence privilege is required.
- Public-schema CREATE is removed from `PUBLIC`; administrators and the
  DDL-capable migrator keep their separately held privileges.
- `npm run check:db-roles` uses an isolated local database. Runtime world
  reads/writes pass; scenario publication, database/schema/table/role creation,
  cluster-setting changes, and reader writes fail with SQLSTATE `42501`.
- The isolated verification database is dropped in `finally`; the reusable
  cluster-level roles remain.

## 2026-07-30 — H-302 migration image

- Added a non-root `migration` Docker target whose default command is exactly
  `npm run db:migrate`; it has no `--fresh` path in the image definition.
- Built and inspected all three targets as Linux AMD64 images:
  web `29a988724baea6f83ad9728d85074df7d6b3dfc7586715c98d4ddfb98031b1ec`,
  scheduler `35bacd7f540adfaa6dfe63cefe2b4530da480729fea0cfe7749a2ccccc1fb05e`,
  migration `886fc791fbd83fe09f279e902c0aa413ed874881058c62e861a5465edbac7214`.
- The migration image runs as UID 1000 and contains only package manifests,
  installed dependencies, `db/`, and `scripts/migrate.ts`; no `.env`, AWS
  directory, or certificate directory is present.
- Ran the image twice against an isolated database. A sentinel row written
  after the first migration survived the second, proving the default is
  idempotent and non-destructive. The isolated database was then dropped.
- Docker initially failed with `ENOSPC`; 30.08 GB of disposable BuildKit cache
  was pruned. Running CockroachDB containers and volumes were not removed.

## 2026-07-30 — H-401 isolated CDK application

- Added `infra/aws` as an isolated strict-TypeScript CDK v2 project with its
  own package and lockfile. The CLI is pinned exactly to `2.1134.0` and every
  invocation uses the package-local binary through `npx --no-install cdk`.
- The app runs TypeScript through `tsx`; stack and construct inputs use readonly
  props. Unit tests use CDK assertions plus the Node test runner.
- Reviewed `cdk.context.json`. It contains only the selected account, region,
  and public availability-zone names; it contains no credentials, secret ARNs,
  certificate identifiers, application configuration, or other sensitive
  values.
- `npm run check --prefix infra/aws` passes strict typecheck, 12 assertions,
  `cdk list`, and `cdk synth --strict`.
- Tooling note: `npm audit` currently reports the published
  `aws-cdk-lib@2.262.2` bundle's `brace-expansion@5.0.7` advisory. It is in the
  local infrastructure synthesis dependency graph, not either application
  image, and the current CDK release does not expose an installable nested fix.

## 2026-07-30 — H-402 registry and GitHub identity stack

- Added retained `hollowmere-web` and `hollowmere-scheduler` ECR repositories
  with immutable tags, scan-on-push, and ECR's service-default AES-256
  encryption.
- Lifecycle rules retain the 20 latest `sha-*` commit images. A higher-priority
  `deployed-*` rule prevents deployed digests from being selected by that
  cleanup rule. The scheduler repository can also retain 20
  `migration-sha-*` images, and untagged upload remnants expire after seven
  days.
- Added the native CloudFormation GitHub OIDC provider, avoiding the legacy
  Lambda-backed custom resource. The provider is retained on stack removal.
- The deploy-role trust requires audience `sts.amazonaws.com`, immutable owner
  ID `101073419`, immutable repository ID `1311493425`, `refs/heads/main`, and
  the `production` environment. The repository was read-only verified as
  `nnetraga97/hollowmere`, created 2026-07-24 with `main` as its default branch.
- ECR authorization is the sole registry-level `Resource: *` action. Upload and
  digest-inspection actions are limited to the two exact repository ARNs.

## 2026-07-30 — H-403 ECS and ALB runtime stack

- Added a two-AZ public-subnet VPC without NAT, a Container Insights ECS
  cluster, separate ALB/web/scheduler security groups, and public-IP Fargate
  networking with no task-level public ingress.
- Added separate web, scheduler, and migration task definitions and execution/
  task roles. The application tasks are Linux X86_64, use the required CPU and
  memory pairs, inject sensitive values from one JSON Secrets Manager ARN, and
  keep `INFERENCE_MODE=world` with `BEDROCK_ENABLED=false`.
- Bedrock policies use deployment-time parameters for the exact profile,
  embedding model, and three underlying regional model ARNs. No application
  role receives broad Bedrock, ECR push, or Secrets Manager permissions.
- Added blocking `awslogs`, retained 30-day service log groups, circuit breakers
  with rollback, 100/200 web and 0/100 scheduler rollouts, TLS termination,
  HTTP redirect, Route 53 alias, `/api/health` IP targets, and a 30-second
  deregistration delay.
- Added alarms for unhealthy web targets, missing web/scheduler tasks, and
  repeated application failures. The runtime stack and ALB both have deletion
  protection.
- The CDK validation report concludes `success` with zero unsuppressed findings.
  It records four narrow acknowledgements: public ALB ports 80/443, deferred
  paid VPC flow-log storage, non-secret ECS environment settings, and deferred
  ALB access-log storage for the judged deployment.
- Read-only `cdk diff --no-change-set` shows two new stacks and the expected IAM,
  security-group, parameter, and resource changes. The missing bootstrap lookup
  role was not assumed; CDK used the already selected read-only caller for the
  comparison. No AWS mutation occurred.

## 2026-07-30 — H-404 dormant AWS delivery workflow

- Added `.github/workflows/deploy-aws.yml` without changing the existing Azure
  delivery workflow. Pull requests and pushes validate the application against
  isolated CockroachDB and run the complete CDK check.
- The deploy job is serialized and remains disabled until the repository
  variable `AWS_DEPLOY_ENABLED` is exactly `true`. It also requires `main`, the
  protected `production` environment, and GitHub OIDC; no static AWS keys are
  referenced.
- The workflow builds explicit Linux AMD64 web and scheduler targets, pushes
  immutable `sha-<commit>` and protected `deployed-<commit>` tags, detects safe
  reruns, and records both image digests.
- It registers and stabilizes the scheduler revision before registering the web
  revision, prints recent ECS service events, then checks `/api/health`,
  `/api/ready`, and the landing page.
- The final job summary contains the commit, region, image digests, task
  definition ARNs, public URL, and result. Official `actionlint` v1.7.12 reports
  no workflow errors.
- The first end-to-end workflow run remains pending H-501/H-502 provisioning,
  repository variable setup, and the explicit bootstrap/deploy approvals.

## 2026-07-30 — Final pre-deployment gate

- Committed the completed local hackathon build as `65c2c17` while preserving
  the pre-existing unstaged `engine/agents/dialogue.ts` change byte-for-byte.
- Reconfirmed account `536260290118`, region `us-east-1`, the absent
  `CDKToolkit` stack, and the absence of Route 53 hosted zones, ACM
  certificates, and a persistent CloudTrail trail using read-only AWS calls.
- Resolved CockroachDB Cloud cluster `changing-tides` to
  `16fd535b-deb6-4ba3-a32a-676e2a87f56b`; no database identity, credential, or
  cluster mutation was performed.
- Added `docs/aws-predeployment-runbook.md` with the exact unresolved inputs,
  live Price List API unit prices, a deterministic $92.96/month illustrative
  AWS estimate, deployment stop point, retained evidence, and protected
  teardown order.
- Kept Bedrock dormant with `BEDROCK_ENABLED=false`; support-case resolution
  and a successful deployment-equivalent preflight remain release gates.
- Database role verification passed against an isolated database. The CDK
  strict typecheck, 12 assertions, stack listing, strict synthesis, official
  `actionlint` check, and web typecheck all passed; 21 web tests and the Next.js
  production build passed.
- The canonical root check passed 250 engine tests with three intentional slow
  skips, but its deterministic twin-town test exceeded the 120-second per-test
  cap under the full parallel database load. The exact test then passed alone
  with a 240-second cap in 187.3 seconds. This is recorded as a release-check
  timeout limitation, not represented as a completely green canonical run.
- No CDK bootstrap, AWS resource mutation, image push, workflow run, Git push,
  deployment, or destructive command occurred.
