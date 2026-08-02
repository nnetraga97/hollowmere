# Hollowmere AWS Pre-deployment Gate

Status: **prepared, not deployed**

Reviewed: 2026-07-30

Target account: `536260290118`

Target region: `us-east-1`

CDK qualifier: `hnb659fds`

This runbook is the stop point before any AWS bootstrap, resource creation,
image push, GitHub deployment, or destructive teardown action. Every command in
the deployment and teardown sections is documentation only; none was run while
preparing this gate.

## Read-only discovery

- AWS CLI `2.36.8` resolves to account `536260290118` in `us-east-1`.
- `CDKToolkit` does not exist, so the account and region are not bootstrapped.
- Route 53 has no hosted zone and ACM has no issued or pending certificate in
  `us-east-1`.
- No persistent CloudTrail trail is configured. Before deployment, choose
  whether the account's default 90-day Event History is sufficient for the
  time-bounded demo or whether a separately costed persistent trail is needed.
- The account-level ECS default log-driver mode is `non-blocking`; Hollowmere's
  task definitions explicitly override it with blocking `awslogs` mode.
- CockroachDB Cloud cluster `changing-tides` is active on the Basic plan. Its
  exact cluster ID is `16fd535b-deb6-4ba3-a32a-676e2a87f56b`; its primary
  region is `us-east-2`, with additional `us-east-1` and `us-west-2` regions.
- The local `.env` points to local CockroachDB. No deployable AWS runtime
  secret or cloud migrator credential was discovered or copied.
- Bedrock access remains pending the AWS support case. The synthesized runtime
  deliberately sets `INFERENCE_MODE=world` and `BEDROCK_ENABLED=false`, making
  Azure Foundry the only selectable production profile until the live Bedrock
  gate passes. The Azure deployment value remains server-owned so the current
  GPT-5.4 mini compatibility model can move to Terra after quota approval.

## Decisions and inputs still required

Deployment must not begin until all of these are resolved:

1. Choose a domain, prove DNS ownership, create or select its public Route 53
   hosted zone, and issue an ACM certificate in `us-east-1`.
2. Choose the CDK bootstrap permissions boundary. Do not bootstrap with an
   invented or broader boundary.
3. Create the CockroachDB `hollowmere_runtime` and migrator identities, then
   verify the runtime role's DML access and DDL denial against the cloud target.
4. Create one JSON Secrets Manager secret outside Git containing exactly:
   `DATABASE_URL`, `DATABASE_MIGRATOR_URL`, `DATABASE_CA_CERT_BASE64`,
   `SESSION_SECRET`, `AZURE_OPENAI_ENDPOINT`, and `AZURE_OPENAI_API_KEY`.
   Cloud database URLs must use `sslmode=verify-full`.
5. Supply every `HollowmereRuntimeStack` parameter:
   `AzureEmbeddingDeployment`, `AzureReasoningDeployment`,
   `AzureTerraDeployment`, `BedrockEmbeddingModelArn`,
   `BedrockReasoningModelArnUsEast1`, `BedrockReasoningModelArnUsEast2`,
   `BedrockReasoningModelArnUsWest2`, `BedrockReasoningProfileArn`,
   `BedrockSonnetProfileId`, `BuildRevision`, `CertificateArn`, `DomainName`,
   `HostedZoneId`, `HostedZoneName`, `MigrationImageTag`,
   `RuntimeConfigSecretArn`, `SchedulerImageTag`, and `WebImageTag`.
6. Decide whether to add a persistent CloudTrail trail. Hollowmere does not
   silently create or cost one in the current CDK application.
7. Choose MIT or Apache 2.0 and confirm the final public-demo retention date.

Bedrock parameters still scope the dormant task-role policy. They are not
permission to expose Bedrock: `BEDROCK_ENABLED` must stay `false` until the
support case closes and the deployment-equivalent Bedrock preflight passes.

## Current AWS cost estimate

The estimate uses the AWS Price List API values returned for `us-east-1` on
2026-07-30 and 730 hours per month. The steady state is one 0.5-vCPU/1-GB web
task and one 1-vCPU/2-GB scheduler task. Values are USD before taxes, credits,
or free-tier effects.

| Component | Assumption | Estimated monthly cost |
| --- | --- | ---: |
| Fargate vCPU | 1.5 vCPU continuously at $0.04048/vCPU-hour | $44.33 |
| Fargate memory | 3 GB continuously at $0.004445/GB-hour | $9.73 |
| Application Load Balancer | One ALB at $0.0225/hour | $16.42 |
| Public IPv4 | Four in-use addresses at $0.005/hour | $14.60 |
| Secrets Manager | One secret | $0.40 |
| CloudWatch alarms | Four standard-resolution alarm metrics | $0.40 |
| Route 53 | One hosted zone | $0.50 |
| ALB capacity | One average LCU at $0.008/hour | $5.84 |
| ECR | 2 GB stored | $0.20 |
| CloudWatch Logs | 1 GB ingested and 1 GB average stored | $0.53 |
| **Illustrative total** | Fixed baseline plus the stated usage assumptions | **$92.96** |

The fixed subtotal is about **$86.39/month** before ALB capacity, ECR storage,
and log volume. Four public IPv4 addresses assumes two public Fargate tasks and
two ALB addresses across two Availability Zones; actual service-managed address
allocation must be checked on the first bill. ALB capacity, DNS queries,
Container Insights observations or metrics, log volume, image size, data
transfer, certificate or domain registration, deployment overlap, and one-off
migration time are usage-dependent. Azure Foundry and CockroachDB Cloud charges
are outside this AWS estimate. Bedrock contributes $0 while disabled.

Current unit prices used in the calculation:

- ALB: $0.0225/hour and $0.008/LCU-hour.
- In-use public IPv4: $0.005/address-hour.
- Secrets Manager: $0.40/secret-month plus $0.05 per 10,000 API requests.
- CloudWatch: $0.10/standard alarm metric-month, $0.50/GB log ingestion, and
  $0.03/GB-month standard log storage.
- ECR: $0.10/GB-month; Route 53: $0.50/month for the first hosted zone.
- Enhanced Container Insights pricing returned $0.21 per million observations
  for its first tier and $0.07 per metric-month for metric-priced usage; actual
  usage is intentionally not guessed in the total.

## Deployment sequence — do not run without approval

First, re-run identity and target discovery. Then show the resolved boundary,
domain, certificate, secret ARN, immutable image tags, commit, and exact CDK
diff for approval.

The bootstrap command shape is:

```sh
npm exec --prefix infra/aws -- cdk bootstrap \
  aws://536260290118/us-east-1 \
  --qualifier hnb659fds \
  --custom-permissions-boundary '<APPROVED_BOUNDARY_NAME>' \
  --termination-protection
```

After bootstrap approval, the release order is:

1. Deploy only `HollowmereRegistryStack`.
2. Build and push immutable Linux AMD64 web, scheduler, and migration images.
3. Deploy `HollowmereRuntimeStack` with the reviewed parameter file and
   immutable tags.
4. Run the one-off migration task using `DATABASE_MIGRATOR_URL`; never pass
   `--fresh`.
5. Apply the immutable scenario, verify both services, `/api/health`,
   `/api/ready`, TLS, and the canonical memory path.
6. Configure the GitHub `production` environment, deploy-role ARN, production
   URL, and approval protection. Set `AWS_DEPLOY_ENABLED=true` only after the
   first manual deployment is verified.

## Evidence to retain before teardown

- Final commit and container image digests, ECS task-definition revisions,
  CloudFormation templates and outputs, and the public URL.
- Redacted health/readiness output, service events, alarm state, and the log
  slices used in release verification; never retain prompts or credentials.
- Canonical world, turn, claim, memory, access, and consequence identifiers;
  and the final demo video. A Town Archivist response is optional local
  developer evidence, not deployment evidence.
- A logical CockroachDB export or other approved backup if the demonstrated
  world must survive teardown.
- The selected deployed image digests or an explicit decision that the public
  registry and repository history are sufficient evidence.

## Teardown sequence — destructive, approval required

Run a fresh read-only inventory immediately before teardown. Confirm the exact
resource identifiers, retention date, backup location, and whether
`changing-tides` is dedicated to Hollowmere. Never execute these targets from
an unresolved variable, wildcard, or stale runbook.

1. Disable new releases by setting `AWS_DEPLOY_ENABLED=false`; retain the final
   evidence listed above.
2. Scale down or stop the two ECS services only after the public-retention date.
3. For `HollowmereRuntimeStack`, explicitly approve disabling CloudFormation
   termination protection and the ALB's deletion-protection attribute, then
   destroy that stack.
4. Confirm the retained `/hollowmere/web`, `/hollowmere/scheduler`, and
   `/hollowmere/migration` log groups are no longer needed before deleting
   them individually.
5. Confirm retained images are captured, destroy `HollowmereRegistryStack`,
   then delete `hollowmere-web` and `hollowmere-scheduler` individually only if
   their retained contents are no longer required.
6. Delete the retained GitHub OIDC provider only after verifying no other IAM
   role or project uses `token.actions.githubusercontent.com` in this account.
7. Delete the external runtime secret only after verifying it is Hollowmere-
   specific and its recovery window is acceptable.
8. Treat CockroachDB separately. Cluster `changing-tides` predates the AWS
   stack and may be shared; `ccloud cluster delete changing-tides` is permitted
   only after a fresh database inventory and separate explicit approval.
9. Re-run read-only CloudFormation, ECS, ELB, ECR, Logs, IAM, Secrets Manager,
   Route 53, ACM, and CockroachDB inventories and record what was intentionally
   retained.

The ECR repositories, GitHub OIDC provider, and three log groups use `Retain`;
CDK stack destruction alone will not remove them. The runtime stack and ALB
also have deletion protection. This is intentional protection against an
accidental one-command teardown, not evidence that recurring charges stopped.
