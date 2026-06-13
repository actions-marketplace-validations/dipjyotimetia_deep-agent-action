import type { Octokit } from "../client.js";

/** True when the login looks like a GitHub App / bot account (`name[bot]`). */
export function looksLikeBotLogin(login: string): boolean {
  return /\[bot\]$/i.test(login) || login.toLowerCase() === "github-actions[bot]";
}

/**
 * Verify the actor is a human user (account type "User") and not a bot.
 * Unresolvable or non-User accounts are treated as bots and rejected, which
 * prevents the action from triggering itself in a loop.
 */
export async function checkActorIsHuman(
  octokit: Octokit,
  username: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (looksLikeBotLogin(username)) {
    return { ok: false, reason: `@${username} is a bot account; ignoring to avoid trigger loops.` };
  }
  try {
    const res = await octokit.rest.users.getByUsername({ username });
    if (res.data.type === "User") return { ok: true };
    return {
      ok: false,
      reason: `@${username} is not a human user account (type: ${res.data.type}).`,
    };
  } catch {
    return { ok: false, reason: `Could not resolve account @${username}; treating as non-human.` };
  }
}
