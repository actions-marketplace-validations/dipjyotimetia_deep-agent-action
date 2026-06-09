import { getOctokit } from "@actions/github";

/** The hydrated Octokit instance returned by @actions/github. */
export type Octokit = ReturnType<typeof getOctokit>;

/** Construct an Octokit client from a token. */
export function makeOctokit(token: string): Octokit {
  return getOctokit(token);
}

/** The GitHub server base URL (github.com, or a GHES host in self-hosted setups). */
export function githubServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || "https://github.com";
}
