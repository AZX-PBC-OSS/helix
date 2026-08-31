import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import { FIXTURE_USERS, findFixtureUser } from "./fixtures.js";

/**
 * The one interaction the dev IdP ever renders: a fixture-user picker
 * (consent is auto-granted in provider.ts). `GET /interaction/:uid?user=
 * alice@azx.dev` completes the login non-interactively — the deterministic
 * hook integration tests and curl sessions use.
 */

function pickerHtml(): string {
  const rows = FIXTURE_USERS.map(
    (u) =>
      `<li><a href="?user=${encodeURIComponent(u.email)}">${u.name ?? u.email}</a>` +
      ` &mdash; ${u.email} [${u.groups.join(", ") || "no groups"}]</li>`,
  ).join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Helix dev IdP</title></head>
<body>
<h1>Helix dev IdP — pick a user</h1>
<p>This is the local development identity provider. It is never deployed.</p>
<ul>
${rows}
</ul>
</body></html>`;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

/** Handle `GET /interaction/:uid`; returns false if the path is not ours. */
export async function handleInteraction(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!/^\/interaction\/[^/]+$/.test(url.pathname)) {
    return false;
  }

  let prompt: string;
  try {
    const details = await provider.interactionDetails(req, res);
    prompt = details.prompt.name;
  } catch {
    send(res, 400, "<p>Unknown or expired interaction — restart sign-in.</p>");
    return true;
  }

  if (prompt !== "login") {
    // Consent is auto-granted via loadExistingGrant; anything else is a bug.
    send(res, 500, `<p>Unexpected interaction prompt: ${prompt}</p>`);
    return true;
  }

  const requested = url.searchParams.get("user");
  if (!requested) {
    send(res, 200, pickerHtml());
    return true;
  }

  const user = findFixtureUser(requested);
  if (!user) {
    send(res, 400, `<p>No fixture user: ${requested}</p>`);
    return true;
  }

  await provider.interactionFinished(
    req,
    res,
    { login: { accountId: user.sub } },
    { mergeWithLastSubmission: false },
  );
  return true;
}
