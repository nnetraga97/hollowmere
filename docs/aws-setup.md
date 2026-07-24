# AWS setup

The engine runs completely without AWS on `INFERENCE_MODE=stub`. Everything in
Phase 1 — gossip, beliefs, tension, escalation to war, retrieval ordering — is
built and tested against the stub. Bedrock is only needed when you want NPCs to
speak in real language.

Do this when you want real inference, not before.

## What you need

| Requirement | Why |
|---|---|
| An AWS account | Bedrock is not available anonymously |
| Credentials on this machine | The SDK resolves them; this repo never stores a key |
| Model access for **Claude Haiku** | Reasoning, planning, dialogue |
| Model access for **Titan Text Embeddings V2** | Memory vectors |
| A region where both are available | `us-east-1` is the safe default |

## Steps

### 1. Enable model access

Model access is per-account **and per-region**, and it is off by default. In the
AWS console:

1. Go to **Amazon Bedrock** → **Model access** (left sidebar, under Configure).
2. Choose **Modify model access**.
3. Enable **Anthropic → Claude Haiku** and **Amazon → Titan Text Embeddings V2**.
4. Submit. Anthropic models ask for a short use-case description; approval is
   usually immediate.

Confirm the region selector in the console matches the region you will use.
Access granted in `us-east-1` does nothing for `eu-west-1`.

### 2. Provide credentials

Any method the AWS SDK understands works. Two straightforward options:

**Environment variables** — put them in `.env` (already gitignored):

```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

**Shared credentials file** — install the AWS CLI and run `aws configure`,
which writes `~/.aws/credentials`. The SDK picks it up with no further config.

An IAM user needs only `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream`. Do not use account root credentials.

### 3. Verify

```bash
node --env-file-if-exists=.env scripts/check-bedrock.ts
```

This makes one tiny embedding call and one ~10-token completion — a fraction of
a cent — and reports exactly which capability is missing rather than a generic
AWS error.

### 4. Switch the engine over

```
INFERENCE_MODE=bedrock
```

## Model identifiers

Defaults live in `.env.example` and can be overridden:

```
BEDROCK_REASONING_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0
BEDROCK_EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
BEDROCK_EMBEDDING_DIM=1024
```

Two things that commonly go wrong here:

- **The `us.` prefix is an inference profile, not a typo.** Newer Anthropic
  models on Bedrock must be invoked through a cross-region inference profile. A
  bare `anthropic.claude-...` id returns `ValidationException`. If you see that
  error, this is almost certainly why.
- **`BEDROCK_EMBEDDING_DIM` must stay 1024**, because the schema declares
  `embedding VECTOR(1024)` and the vector index is built on it. Titan V2 also
  supports 512 and 256; choosing one of those means changing the column and
  rebuilding the index. `check-bedrock.ts` asserts the two agree.

## Cost

At demo scale this is cents, not dollars. Cognition is capped at ~2 agents per
30s with a burst to 6, and each world carries an inference budget that falls
back to deterministic cognition when exhausted — so a runaway loop cannot
quietly drain credits. Per-world usage accumulates in `world_budget`.

Claude Haiku is roughly $1/$5 per million input/output tokens; Titan V2
embeddings are a rounding error beside that. If credits run short, the
`BEDROCK_REASONING_MODEL` variable will accept a cheaper model such as
`amazon.nova-lite-v1:0` without any code change.

## If it fails

Bedrock reports several unrelated problems with near-identical wording, so
diagnose before changing anything. This one command distinguishes all of them:

```bash
aws bedrock get-foundation-model-availability \
  --model-id amazon.titan-embed-text-v2:0 --region us-east-1
```

| Field | Meaning if wrong |
|---|---|
| `regionAvailability` | The model does not exist in this region — change region |
| `entitlementAvailability` | Your account cannot use this model at all |
| `authorizationStatus` | **`NOT_AUTHORIZED` means model access is not granted** — the usual cause |
| `agreementAvailability` | The terms are offered but not yet accepted |

### Brand-new AWS account

Check this first, because it looks exactly like a misconfiguration and is not
one:

```bash
aws account get-account-information   # AccountCreatedDate
```

The Bedrock **Model access page has been retired**. Serverless foundation models
now enable themselves automatically on first invocation. On an account created
minutes or hours ago that auto-enable has usually not propagated yet, so every
invocation returns `Operation not allowed` while `authorizationStatus` stays
`NOT_AUTHORIZED`.

If all of the following hold, nothing is wrong and the fix is to wait and retry:

- `AccountState` is `ACTIVE`
- the account is not in an Organization (so no SCP is blocking it)
- `aws iam simulate-principal-policy` allows `bedrock:InvokeModel` **and**
  `aws-marketplace:Subscribe`
- `entitlementAvailability` and `regionAvailability` are `AVAILABLE`
- the same call fails identically in a second region

Resist reconfiguring at this point. Every setting is already correct, and
changing one adds a real fault on top of a transient one.

Anthropic models additionally ask first-time users for use-case details, which
is submitted once from the Model catalog in the console.

### `Operation not allowed` (ValidationException)

Despite the wording, this is the **not-authorized** case, not an
inference-profile problem. `authorizationStatus` will read `NOT_AUTHORIZED`.
Grant access in the console (step 1). Note that `list-foundation-models`
succeeding proves nothing here — listing models is a different permission from
invoking them.

There is no CLI path for Amazon's own models: `list-foundation-model-agreement-offers`
returns *"Agreement not supported for this model"* for Titan, because only
third-party models (Anthropic among them) use the agreement flow. Use the
console.

### `AccessDeniedException`

Either model access is not enabled **in that region**, or the caller lacks
`bedrock:InvokeModel`. Check the region first; it is the more common of the two.

### `ValidationException` naming an unknown model

The model id needs the `us.` cross-region inference profile prefix.

---

Whatever the cause, the engine keeps working on `INFERENCE_MODE=stub`, so a
Bedrock problem never blocks Phase 1.
