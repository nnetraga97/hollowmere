# Azure inference testing

Hollowmere can keep its database, scheduler, and Phaser client local while its
inference calls use Azure OpenAI. This isolates model behaviour and token spend
from deployment concerns.

## Test resources

- Resource group: `hollowmere-test-rg` (`eastus`)
- Azure OpenAI account: `hollowmere-ai-nnetraga97`
- Reasoning deployment: `hollowmere-gpt-5-4-mini` (`gpt-5.4-mini`, Data Zone Standard, 30K TPM)
- Rollback deployment: `hollowmere-gpt-5-mini` (`gpt-5-mini`, Global Standard, 10K TPM)
- Embedding deployment: `hollowmere-embedding-3-small` (`text-embedding-3-small`, Standard, 10K TPM)

The deployments are consumption-based. No always-on compute was created.

## Local testing with the Azure CLI

The repository has launchers that retrieve the account key from the currently
authenticated Azure CLI process and pass it only to the child process. They do
not print or persist the key.

```bash
npm run azure:check
npm run azure:scheduler
npm run azure:web
```

Use the latter two in separate terminals. The web and scheduler will both run
with `INFERENCE_MODE=azure` while the ordinary `npm run scheduler` and
`npm run web` commands continue to honor `.env` and default safely to the stub.

## Environment-based configuration

Copy the Azure variables from `.env.example` into `.env`, retrieve either
resource key from Azure, and keep `AZURE_OPENAI_EMBEDDING_DIM=1024` because the
CockroachDB vector column is `VECTOR(1024)`.

```bash
az cognitiveservices account keys list \
  --resource-group hollowmere-test-rg \
  --name hollowmere-ai-nnetraga97

npm run check:azure
```

Only after the preflight passes, set `INFERENCE_MODE=azure`. Reset the local
database before the first Azure-backed world so no stub vectors or cognition
records are mixed into the run.

## Cleanup

Deleting the resource group removes the account and both deployments:

```bash
az group delete --name hollowmere-test-rg
```
