import * as core from "@actions/core";
import type { Octokit } from "../client.js";

/**
 * Decide if a permission level is sufficient. `maintain` implies write access,
 * so it satisfies a `write` requirement.
 */
export function isPermitted(permission: string | undefined, allowed: string[]): boolean {
  if (!permission) return false;
  const p = permission.toLowerCase();
  if (allowed.includes(p)) return true;
  // GitHub returns "maintain" as a distinct level above "write".
  if (p === "maintain" && allowed.includes("write")) return true;
  return false;
}

/**
 * Check whether `username` has one of the allowed permission levels on the repo.
 * Returns a refusal reason string when not permitted, otherwise null.
 */
export async function checkActorPermission(
  octokit: Octokit,
  params: { owner: string; repo: string; username: string; allowed: string[] },
): Promise<{ ok: boolean; permission?: string; reason?: string }> {
  try {
    const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: params.owner,
      repo: params.repo,
      username: params.username,
    });
    const permission = res.data.permission;
    if (isPermitted(permission, params.allowed)) {
      return { ok: true, permission };
    }
    return {
      ok: false,
      permission,
      reason: `@${params.username} has \`${permission ?? "no"}\` access; this action requires ${params.allowed
        .map((p) => `\`${p}\``)
        .join(" or ")}.`,
    };
  } catch (err) {
    // Fail closed, but leave a diagnostic so a transient API failure is
    // distinguishable from a genuine permission refusal in the run log.
    core.warning(
      `Permission lookup for @${params.username} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      reason: `Could not verify repository permissions for @${params.username}.`,
    };
  }
}
