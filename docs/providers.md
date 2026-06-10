# Models & providers

Deep Agent Action supports eight model providers. You choose one with the `model` input; credentials come from environment variables (usually GitHub secrets).

Source of truth: [`src/agent/model.ts`](../src/agent/model.ts) and [`src/config.ts`](../src/config.ts).

## How the `model` id is parsed

- **Bare name** → the provider is inferred from the prefix:
  - `claude…` → `anthropic`
  - `gpt…` / `o1…` / `o3…` → `openai`
  - `gemini…` → `google`
  - anything else → defaults to `anthropic`
- **`provider:name`** → the provider is explicit. Required for every provider except the three inferred above.

```yaml
model: "claude-sonnet-4-6"                 # inferred → anthropic
model: "openai:gpt-5"                       # explicit
model: "openrouter:openai/gpt-4o"          # explicit (name may itself contain a slash)
model: "openai-compatible:llama-3.1-70b"   # explicit; also set base_url
```

## Provider reference

### Anthropic (default)

```yaml
with:
  model: "claude-sonnet-4-6"   # or anthropic:claude-opus-4-5
env:
  PROVIDER_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Key resolves from `provider_api_key` / `PROVIDER_API_KEY` / `ANTHROPIC_API_KEY`.

### OpenAI

```yaml
with:
  model: "openai:gpt-5"
env:
  PROVIDER_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Key resolves from `provider_api_key` / `PROVIDER_API_KEY` / `OPENAI_API_KEY`.

### Azure OpenAI

```yaml
with:
  model: "azure:my-gpt4o-deployment"
env:
  AZURE_OPENAI_API_KEY: ${{ secrets.AZURE_OPENAI_API_KEY }}
  AZURE_OPENAI_API_INSTANCE_NAME: my-resource
  AZURE_OPENAI_API_DEPLOYMENT_NAME: my-gpt4o-deployment
  AZURE_OPENAI_API_VERSION: "2024-08-01-preview"
```

The deployment/instance/version come from the standard `AZURE_OPENAI_*` environment variables read by the underlying client. Accepts `azure` or `azure-openai` as the prefix.

### Google Gemini

```yaml
with:
  model: "google:gemini-2.5-pro"   # or gemini:… / google-genai:…
env:
  PROVIDER_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

Key resolves from `provider_api_key` / `PROVIDER_API_KEY` / `GOOGLE_API_KEY`.

### OpenRouter

```yaml
with:
  model: "openrouter:anthropic/claude-3.5-sonnet"
env:
  PROVIDER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Routed to `https://openrouter.ai/api/v1` automatically. Key resolves from `provider_api_key` / `PROVIDER_API_KEY` / `OPENROUTER_API_KEY`.

### OpenAI-compatible (Groq, xAI, DeepSeek, Together, Fireworks, Mistral, Ollama, vLLM, LM Studio…)

```yaml
with:
  model: "openai-compatible:llama-3.1-70b-versatile"
  base_url: "https://api.groq.com/openai/v1"
env:
  PROVIDER_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

`base_url` is **required** — the run fails fast without it. Accepts `openai-compatible`, `compatible`, or `custom` as the prefix.

### AWS Bedrock

```yaml
with:
  model: "bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0"
env:
  AWS_REGION: us-east-1
  AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

Credentials and region come from the standard AWS environment chain. Region is read from `AWS_REGION` or `AWS_DEFAULT_REGION`. For keyless auth, use OIDC with [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials) earlier in the job. Accepts `bedrock` or `aws`.

### GCP Vertex AI

```yaml
with:
  model: "vertexai:gemini-2.5-pro"   # or vertex:… / google-vertexai:…
env:
  GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.auth.outputs.credentials_file_path }}
  GOOGLE_CLOUD_LOCATION: us-central1
```

Auth via Application Default Credentials / `GOOGLE_APPLICATION_CREDENTIALS`; location from `GOOGLE_CLOUD_LOCATION` or `CLOUD_ML_REGION`. Use [`google-github-actions/auth`](https://github.com/google-github-actions/auth) (Workload Identity Federation) earlier in the job to populate ADC. Accepts `vertex`, `vertexai`, or `google-vertexai`.

## Cost estimates

After a run, token usage and an estimated USD cost are shown in the sticky comment, the job summary, and `result_json`.

Cost is a **rough estimate** computed by substring-matching the model name against a small price table in [`src/agent/cost.ts`](../src/agent/cost.ts) (e.g. Claude Opus/Sonnet/Haiku, GPT/o-series, Gemini). For a model name not in the table, the cost is omitted and only token counts are reported. Treat the figure as a ballpark, not a billing record — check `src/agent/cost.ts` for the current rates and your provider's dashboard for actuals.

See [multi-provider.yml](../examples/multi-provider.yml) for copy-paste workflows covering several providers.
