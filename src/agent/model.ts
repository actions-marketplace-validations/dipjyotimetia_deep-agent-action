import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI, AzureChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { ChatBedrockConverse } from "@langchain/aws";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Instantiate a chat model from a provider + model name.
 *
 * We construct the model *instance* with static imports rather than passing a
 * `"provider:model"` string to `createDeepAgent`. String-based model init goes
 * through LangChain's dynamic `import()`, which a bundler cannot statically
 * resolve — the bundled action would throw "Cannot find package" at runtime.
 * Static imports bundle deterministically.
 *
 * Supported providers (use a `provider:model` id for the non-default ones):
 *  - anthropic / openai / google (Gemini) — API key via provider_api_key.
 *  - azure — Azure OpenAI; config via the standard AZURE_OPENAI_* env vars.
 *  - openrouter — OpenAI-compatible endpoint; API key via provider_api_key.
 *  - openai-compatible — any OpenAI-compatible API via `base_url`
 *    (Groq, xAI, DeepSeek, Together, Fireworks, Mistral, Ollama, vLLM, LM Studio…).
 *  - bedrock (AWS) — credentials/region from the standard AWS env chain.
 *  - vertexai (GCP) — Application Default Credentials / GOOGLE_APPLICATION_CREDENTIALS.
 */
export function createModel(params: {
  provider: string;
  model: string;
  apiKey?: string;
  /** Base URL for the `openai-compatible` provider. */
  baseUrl?: string;
}): BaseChatModel {
  const { provider, model, apiKey, baseUrl } = params;
  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({ model, apiKey });
    case "openai":
      return new ChatOpenAI({ model, apiKey });
    case "azure":
    case "azure-openai":
      // Deployment / instance / api-version come from AZURE_OPENAI_* env vars;
      // the key is the Azure-specific field (also reads AZURE_OPENAI_API_KEY).
      return new AzureChatOpenAI({ model, azureOpenAIApiKey: apiKey });
    case "google":
    case "google-genai":
    case "gemini":
      return new ChatGoogleGenerativeAI({ model, apiKey });
    case "openrouter":
      // OpenRouter is OpenAI-API-compatible — route ChatOpenAI at its endpoint.
      return new ChatOpenAI({ model, apiKey, configuration: { baseURL: OPENROUTER_BASE_URL } });
    case "openai-compatible":
    case "compatible":
    case "custom":
      if (!baseUrl) {
        throw new Error(
          `Provider "${provider}" requires a base_url input (the OpenAI-compatible endpoint).`,
        );
      }
      return new ChatOpenAI({ model, apiKey, configuration: { baseURL: baseUrl } });
    case "bedrock":
    case "aws":
      // Credentials + region come from the standard AWS env chain.
      return new ChatBedrockConverse({
        model,
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
      });
    case "vertex":
    case "vertexai":
    case "google-vertexai":
      // Auth via ADC / GOOGLE_APPLICATION_CREDENTIALS; project/location from env.
      return new ChatVertexAI({
        model,
        location: process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION,
      });
    default:
      throw new Error(
        `Unsupported model provider "${provider}". Supported: anthropic, openai, azure, google, ` +
          `openrouter, openai-compatible, bedrock, vertexai. Use a provider-prefixed model id, e.g. ` +
          `"anthropic:claude-sonnet-4-5", "openrouter:openai/gpt-4o", "openai-compatible:llama-3.1-70b" (+ base_url).`,
      );
  }
}
