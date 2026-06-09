import * as core from "@actions/core";
import { createAppAuth } from "@octokit/auth-app";
import { getOctokit } from "@actions/github";

export interface TokenResult {
  token: string;
  source: "app" | "github_token";
  /** The GitHub App slug, when minted via an App (used for commit identity). */
  appSlug?: string;
}

/** Normalize a PEM private key that may arrive with escaped newlines. */
function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

/**
 * Resolve a token for the run.
 *
 * Preferred: mint a short-lived, least-privilege GitHub App installation token
 * (app JWT → repo installation lookup → scoped installation token). The token
 * is masked and discarded with the process.
 *
 * Fallback: a provided `github_token`/`GITHUB_TOKEN`. NOTE: PRs opened with the
 * default `GITHUB_TOKEN` do not trigger downstream workflow runs, so the App
 * path is required for the agent's PRs to run the repo's CI.
 */
export async function resolveToken(params: {
  owner: string;
  repo: string;
  appId?: string;
  privateKey?: string;
  githubToken?: string;
}): Promise<TokenResult> {
  const { owner, repo, appId, privateKey, githubToken } = params;

  if (appId && privateKey) {
    const auth = createAppAuth({ appId, privateKey: normalizePrivateKey(privateKey) });

    // 1) App JWT to discover the installation on this repo.
    const appJwt = await auth({ type: "app" });
    const appOctokit = getOctokit(appJwt.token);
    const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });

    let appSlug: string | undefined;
    try {
      const { data: app } = await appOctokit.rest.apps.getAuthenticated();
      appSlug = app?.slug;
    } catch {
      // Non-fatal; commit identity falls back to a generic bot name.
    }

    // 2) Installation token scoped to the minimum required permissions.
    const installationAuth = await auth({
      type: "installation",
      installationId: installation.id,
      permissions: { contents: "write", issues: "write", pull_requests: "write" },
    });

    core.setSecret(installationAuth.token);
    return { token: installationAuth.token, source: "app", appSlug };
  }

  if (githubToken) {
    core.setSecret(githubToken);
    return { token: githubToken, source: "github_token" };
  }

  throw new Error(
    "No credentials available. Provide a GitHub App (app_id + app_private_key) or a github_token input.",
  );
}
