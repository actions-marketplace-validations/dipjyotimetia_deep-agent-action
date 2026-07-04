import { describe, expect, test } from "bun:test";
import { retryDelayMs, installRetryHook, type Octokit } from "../src/github/client.js";

describe("retryDelayMs", () => {
  test("retries 5xx on GET with doubling backoff, capped at 30s", () => {
    expect(retryDelayMs({ attempt: 1, status: 500, method: "GET" })).toBe(1000);
    expect(retryDelayMs({ attempt: 2, status: 502, method: "GET" })).toBe(2000);
    expect(retryDelayMs({ attempt: 3, status: 503, method: "get" })).toBe(4000);
    expect(retryDelayMs({ attempt: 6, status: 500, method: "HEAD", maxRetries: 10 })).toBe(30_000);
  });

  test("never retries 5xx on mutations (a 500 POST may have landed server-side)", () => {
    expect(retryDelayMs({ attempt: 1, status: 500, method: "POST" })).toBeUndefined();
    expect(retryDelayMs({ attempt: 1, status: 502, method: "PATCH" })).toBeUndefined();
    expect(retryDelayMs({ attempt: 1, status: 500, method: "DELETE" })).toBeUndefined();
  });

  test("retries 429 for any method, honoring the larger of retry-after and backoff", () => {
    expect(retryDelayMs({ attempt: 1, status: 429, method: "POST" })).toBe(1000);
    expect(retryDelayMs({ attempt: 1, status: 429, method: "POST", retryAfterSeconds: 7 })).toBe(
      7000,
    );
  });

  test("retries 403 only when it is a rate limit, not a permission denial", () => {
    expect(retryDelayMs({ attempt: 1, status: 403, method: "POST", retryAfterSeconds: 2 })).toBe(
      2000,
    );
    expect(
      retryDelayMs({
        attempt: 1,
        status: 403,
        method: "GET",
        message: "You have exceeded a secondary rate limit.",
      }),
    ).toBe(1000);
    expect(retryDelayMs({ attempt: 1, status: 403, method: "GET" })).toBeUndefined();
  });

  test("never retries client errors", () => {
    for (const status of [400, 401, 404, 422]) {
      expect(retryDelayMs({ attempt: 1, status, method: "GET" })).toBeUndefined();
    }
    expect(retryDelayMs({ attempt: 1, method: "GET" })).toBeUndefined(); // no status (network layer)
  });

  test("stops after maxRetries", () => {
    expect(retryDelayMs({ attempt: 3, status: 500, method: "GET" })).toBe(4000);
    expect(retryDelayMs({ attempt: 4, status: 500, method: "GET" })).toBeUndefined();
    expect(retryDelayMs({ attempt: 2, status: 429, method: "GET", maxRetries: 1 })).toBeUndefined();
  });
});

describe("installRetryHook", () => {
  /** A minimal fake exposing the hook surface installRetryHook uses. */
  function fakeOctokit(handler: (options: unknown) => Promise<unknown>) {
    let wrapped: ((req: typeof handler, options: unknown) => Promise<unknown>) | undefined;
    const octokit = {
      hook: {
        wrap: (_name: string, fn: typeof wrapped) => {
          wrapped = fn;
        },
      },
    } as unknown as Octokit;
    return { octokit, call: (options: unknown) => wrapped!(handler, options) };
  }

  test("retries a transient 500 GET and returns the eventual success", async () => {
    let calls = 0;
    const slept: number[] = [];
    const { octokit, call } = fakeOctokit(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("boom"), { status: 500 });
      return "ok";
    });
    installRetryHook(octokit, { sleep: async (ms) => void slept.push(ms) });

    await expect(call({ method: "GET", url: "/x" })).resolves.toBe("ok");
    expect(calls).toBe(3);
    expect(slept).toEqual([1000, 2000]);
  });

  test("does not retry a 404 and rethrows the original error", async () => {
    let calls = 0;
    const { octokit, call } = fakeOctokit(async () => {
      calls++;
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    installRetryHook(octokit, { sleep: async () => {} });

    await expect(call({ method: "GET", url: "/x" })).rejects.toThrow("not found");
    expect(calls).toBe(1);
  });

  test("gives up after the retry budget and rethrows", async () => {
    let calls = 0;
    const { octokit, call } = fakeOctokit(async () => {
      calls++;
      throw Object.assign(new Error("flaky"), { status: 500 });
    });
    installRetryHook(octokit, { sleep: async () => {} });

    await expect(call({ method: "GET", url: "/x" })).rejects.toThrow("flaky");
    expect(calls).toBe(4); // initial call + 3 retries (default policy)
  });

  test("honors the retry-after header on a rate-limited mutation", async () => {
    let calls = 0;
    const slept: number[] = [];
    const { octokit, call } = fakeOctokit(async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("rate limited"), {
          status: 429,
          response: { headers: { "retry-after": "5" } },
        });
      }
      return "ok";
    });
    installRetryHook(octokit, { sleep: async (ms) => void slept.push(ms) });

    await expect(call({ method: "POST", url: "/x" })).resolves.toBe("ok");
    expect(slept).toEqual([5000]);
  });
});
