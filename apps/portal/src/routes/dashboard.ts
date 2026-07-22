import type { FastifyInstance } from "fastify";

/**
 * Barebones demo dashboard: an open, unstyled HTML index of every registered
 * app with a link to its live site. The real portal dashboard is deferred
 * past M5 (project plan §4) — this is a stopgap for demos.
 *
 * Links target `<slug>.` prepended to `APP_PUBLIC_BASE`, which carries the
 * scheme, base domain, and port of the edge as reachable by the user
 * (architecture §4.1). Defaults to `http://local.helix.azxlabs.io:8080`, the local dev
 * edge; set `https://azx.helix.azxlabs.io` for prod.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_req, reply) => {
    const base = new URL(process.env.APP_PUBLIC_BASE ?? "http://local.helix.azxlabs.io:8080");
    const apps = await app.prisma.app.findMany({
      orderBy: { createdAt: "asc" },
      include: { currentVersion: true },
    });

    const items = apps.map((a) => {
      const name = escapeHtml(a.displayName);
      const href = `${base.protocol}//${a.slug}.${base.host}`;
      if (a.currentVersion) {
        return `<li><a href="${href}">${name}</a> — live · v${a.currentVersion.number}</li>`;
      }
      return `<li>${name} — <em>not deployed yet</em></li>`;
    });

    const list = items.length
      ? `<ul>\n${items.join("\n")}\n</ul>`
      : "<p>No apps registered yet.</p>";

    reply.type("text/html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>AZX apps</title></head>
<body>
<h1>AZX apps</h1>
${list}
<p><small>Apps are served at <code>${escapeHtml(base.protocol)}//&lt;slug&gt;.${escapeHtml(base.host)}</code>.</small></p>
</body>
</html>
`);
  });
}

/** Escape the five HTML-significant characters for safe text interpolation. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
