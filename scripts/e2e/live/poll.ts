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

const MARKER = "<!-- deep-agent:tracking -->";

export type TrackingState = "working" | "success" | "failed" | "refused" | "skipped";

/** Pure: classify a tracking-comment body by the exact strings `renderTrackingBody` emits. */
export function classifyTrackingBody(body: string): TrackingState | undefined {
  if (!body.includes(MARKER)) return undefined;
  if (body.includes("✅ Done.")) return "success";
  if (body.includes("❌ The run failed.")) return "failed";
  if (body.includes("⛔ Request not authorized.")) return "refused";
  if (body.includes("Nothing to do.")) return "skipped";
  if (body.includes("Working on it…")) return "working";
  return undefined;
}

export interface PolledComment {
  state: Exclude<TrackingState, "working">;
  body: string;
  updatedAt: string;
}

export interface PollOptions {
  owner: string;
  repo: string;
  issue: number;
  /** Only consider a tracking comment last updated after this ISO timestamp (a second turn on the same issue). */
  sinceUpdatedAt?: string;
  intervalMs?: number;
  timeoutMs?: number;
}

interface RawComment {
  id: number;
  body: string;
  updated_at: string;
}

async function ghJson<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed: ${err || out}`);
  return JSON.parse(out) as T;
}

/** Poll until the tracking comment reaches a terminal (non-"working") state, or time out. */
export async function pollTrackingComment(opts: PollOptions): Promise<PolledComment> {
  const interval = opts.intervalMs ?? 15_000;
  const timeout = opts.timeoutMs ?? 600_000;
  const since = opts.sinceUpdatedAt ? new Date(opts.sinceUpdatedAt).getTime() : undefined;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const comments = await ghJson<RawComment[]>([
      "api",
      `repos/${opts.owner}/${opts.repo}/issues/${opts.issue}/comments`,
      "--paginate",
    ]);
    const tracking = comments
      .filter((c) => typeof c.body === "string" && c.body.includes(MARKER))
      .filter((c) => since == null || new Date(c.updated_at).getTime() > since)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];

    if (tracking) {
      const state = classifyTrackingBody(tracking.body);
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
