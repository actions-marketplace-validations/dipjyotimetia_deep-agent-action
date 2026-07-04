import * as core from "@actions/core";
import { getOctokit } from "@actions/github";

/** The hydrated Octokit instance returned by @actions/github. */
export type Octokit = ReturnType<typeof getOctokit>;

const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;

/** Inputs to the pure retry policy for a single failed request. */
export interface RetryContext {
  /** 1-based index of the retry being considered. */
  attempt: number;
  maxRetries?: number;
  /** HTTP status of the failure, when known. */
  status?: number;
  /** Request method, e.g. "GET". */
  method?: string;
  /** Parsed `retry-after` header (seconds), when present. */
  retryAfterSeconds?: number;
  /** Error message (used to detect secondary-rate-limit responses). */
  message?: string;
}

/**
 * Pure retry policy: milliseconds to wait before retrying, or undefined for
 * "don't retry". Rate limits (429, and 403 with a retry-after header or a
 * secondary-rate-limit message) are retried for every method — a rate-limited
 * request was never executed server-side. 5xx responses are retried only for
 * GET/HEAD: a mutation that returned 500 may still have landed, and retrying
 * it risks duplicate comments/PRs. Everything else (401/404/422, plain 403
 * permission denials) fails immediately.
 */
export function retryDelayMs(ctx: RetryContext): number | undefined {
  if (ctx.attempt > (ctx.maxRetries ?? DEFAULT_MAX_RETRIES)) return undefined;
  const backoff = Math.min(1000 * 2 ** (ctx.attempt - 1), MAX_BACKOFF_MS);
  const rateLimited =
    ctx.status === 429 ||
    (ctx.status === 403 &&
      (ctx.retryAfterSeconds != null || /secondary rate limit/i.test(ctx.message ?? "")));
  if (rateLimited) return Math.max((ctx.retryAfterSeconds ?? 0) * 1000, backoff);
  const method = (ctx.method ?? "").toUpperCase();
  if (ctx.status != null && ctx.status >= 500 && (method === "GET" || method === "HEAD")) {
    return backoff;
  }
  return undefined;
}

/**
 * Install the retry policy on an Octokit instance via a request hook, so every
 * call — including `octokit.paginate`, which goes through the same hook —
 * survives transient failures. `sleep` is injectable so tests run instantly.
 */
export function installRetryHook(
  octokit: Octokit,
  opts: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): void {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  octokit.hook.wrap("request", async (request, options) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request(options);
      } catch (err) {
        const e = err as {
          status?: number;
          message?: string;
          response?: { headers?: Record<string, string | number | undefined> };
        };
        const rawRetryAfter = Number(e.response?.headers?.["retry-after"]);
        const delay = retryDelayMs({
          attempt,
          maxRetries: opts.maxRetries,
          status: e.status,
          method: options.method,
          retryAfterSeconds: Number.isFinite(rawRetryAfter) ? rawRetryAfter : undefined,
          message: e.message,
        });
        if (delay == null) throw err;
        core.info(
          `GitHub API ${options.method} ${options.url} failed with ${e.status}; retrying in ${delay}ms (attempt ${attempt}).`,
        );
        await sleep(delay);
      }
    }
  });
}

/** Construct an Octokit client from a token, with transient-failure retries installed. */
export function makeOctokit(token: string): Octokit {
  const octokit = getOctokit(token);
  installRetryHook(octokit);
  return octokit;
}

/** The GitHub server base URL (github.com, or a GHES host in self-hosted setups). */
export function githubServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || "https://github.com";
}
