/**
 * `owner/name` from a git remote URL, for `helix ci init`. Accepts the forms
 * `git remote get-url` prints for a GitHub repo: `https://host/owner/name(.git)`,
 * `git@host:owner/name(.git)` and `ssh://git@host/owner/name(.git)`. Returns
 * null for anything else, including a host other than `githubHost`.
 */
export function parseGithubRemote(remote: string, githubHost = "github.com"): string | null {
  const url = remote.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(url);
  let host: string;
  let path: string;
  if (scp && !url.includes("://")) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\/+/, "");
  }
  if (host.toLowerCase() !== githubHost.toLowerCase()) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+?)(\.git)?\/?$/.exec(path);
  return match ? `${match[1]}/${match[2]}` : null;
}
