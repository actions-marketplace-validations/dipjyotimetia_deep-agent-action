/**
 * Poll a synthetic issue/PR's sticky Deep Agent tracking comment (marker
 * `<!-- deep-agent:tracking -->`, see src/github/comments.ts) until it reaches
 * a terminal state.
 *
 * The agent run that produces this comment happens in a completely separate,
 * asynchronously-triggered Actions job (the reactive `e2e-live-events.yml`
 * workflow) — this script has zero visibility into that job's `steps.*.outputs`.
 * The tracking comment is the only observable signal, which is why the
 * synchronous `scripts/e2e/assert-result.ts` validator (built for
 * `workflow_dispatch` outputs) doesn't apply to this harness.
 *
 * CLI: bun run scripts/e2e/live/poll.ts <owner/repo> <issue-number> [sinceIso]
 */
import type { RunStatus } from "../../../src/types.js";
import { MARKER, parseTrackingStatus } from "../../../src/github/comments.js";
import { runCmd } from "./github.js";

export type TrackingState = RunStatus | "working";

export interface PolledComment {
  state: Exclude<TrackingState, "working">;
  body: string;
  updatedAt: string;
}

export interface PollOptions {
  owner: string;
  repo: string;
  issue: number;
  /** Only consider comments updated after this ISO timestamp (a second turn on the same issue). */
  sinceUpdatedAt?: string;
  intervalMs?: number;
  timeoutMs?: number;
}

interface RawComment {
  id: number;
  body: string;
  updated_at: string;
}

/** Poll until the tracking comment reaches a terminal (non-"working") state, or time out. */
export async function pollTrackingComment(opts: PollOptions): Promise<PolledComment> {
  const interval = opts.intervalMs ?? 15_000;
  const timeout = opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeout;
  // Server-side filter on the caller-supplied boundary only (not ratcheted
  // per-iteration by local clock, which would risk missing an update under
  // client/server clock skew) — still cuts payload substantially for the
  // resume scenario's second poll, which is the one case that supplies it.
  const query = opts.sinceUpdatedAt ? `?since=${encodeURIComponent(opts.sinceUpdatedAt)}` : "";

  while (Date.now() < deadline) {
    const out = await runCmd([
      "gh",
      "api",
      `repos/${opts.owner}/${opts.repo}/issues/${opts.issue}/comments${query}`,
      "--paginate",
    ]);
    const comments = JSON.parse(out) as RawComment[];
    const tracking = comments
      .filter((c) => typeof c.body === "string" && c.body.includes(MARKER))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];

    if (tracking) {
      const state = parseTrackingStatus(tracking.body);
      if (state && state !== "working") {
        return { state, body: tracking.body, updatedAt: tracking.updated_at };
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `Timed out after ${timeout}ms waiting for a terminal tracking comment on ${opts.owner}/${opts.repo}#${opts.issue}`,
  );
}

/** Throw a consistent, labeled error unless the poll result reached "success". */
export function expectSuccess(result: PolledComment, label: string): void {
  if (result.state !== "success") {
    throw new Error(`expected ${label} state=success, got ${result.state}\n${result.body}`);
  }
}

const PR_LINK_RE = /\*\*(?:Draft p|P)ull request(?: \(awaiting approval\))?:\*\* (\S+)/;

/** Extract the PR URL `renderTrackingBody` embeds once a change has landed. */
export function extractPrUrl(body: string): string {
  const url = body.match(PR_LINK_RE)?.[1];
  if (!url) throw new Error(`no PR link found in tracking comment:\n${body}`);
  return url;
}

if (import.meta.main) {
  const [ownerRepo, issueArg, since] = process.argv.slice(2);
  if (!ownerRepo || !issueArg) {
    console.error("usage: bun run scripts/e2e/live/poll.ts <owner/repo> <issue-number> [sinceIso]");
    process.exit(1);
  }
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    console.error(`invalid owner/repo: ${ownerRepo}`);
    process.exit(1);
  }
  pollTrackingComment({ owner, repo, issue: Number(issueArg), sinceUpdatedAt: since })
    .then((result) => {
      console.log(JSON.stringify(result));
      if (result.state !== "success") process.exit(1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
