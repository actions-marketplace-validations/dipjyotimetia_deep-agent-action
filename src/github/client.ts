import { getOctokit } from "@actions/github";

/** The hydrated Octokit instance returned by @actions/github. */
export type Octokit = ReturnType<typeof getOctokit>;

/** Construct an Octokit client from a token. */
export function makeOctokit(token: string): Octokit {
  return getOctokit(token);
}
