import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Instantiate a chat model from a provider + model name.
 *
 * We construct the model *instance* with static imports rather than passing a
 * `"provider:model"` string to `createDeepAgent`. String-based model init goes
 * through LangChain's dynamic `import()`, which a bundler cannot statically
 * resolve — the bundled action would throw "Cannot find package" at runtime.
 * Static imports bundle deterministically.
 *
 * v1 validates Anthropic and OpenAI end-to-end. Other providers throw a clear
 * error rather than failing deep inside the harness.
 */
export function createModel(params: {
  provider: string;
  model: string;
  apiKey?: string;
}): BaseChatModel {
  const { provider, model, apiKey } = params;
  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({ model, apiKey });
    case "openai":
      return new ChatOpenAI({ model, apiKey });
    default:
      throw new Error(
        `Unsupported model provider "${provider}". Supported in v1: anthropic, openai. ` +
          `Use a provider-prefixed model id, e.g. "anthropic:claude-sonnet-4-5" or "openai:gpt-5".`,
      );
  }
}
