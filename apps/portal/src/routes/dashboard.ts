import type { FastifyInstance } from "fastify";

/**
 * Barebones demo dashboard: an open, unstyled HTML index of every registered
 * app with a link to its (eventual) live site. The real portal dashboard is
 * deferred past M5 (project plan §4) — this is a stopgap for demos.
 *
 * Note: the edge that serves apps is stubbed until M2, so the links below
 * won't resolve yet. They become reachable once edge serving lands, with no
 * change here. Links target `<slug>.<APP_BASE_DOMAIN>` (default `localtest.me`,
 * the local dev scheme; set `azx-labs.com` for prod — architecture §4.1).
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_req, reply) => {
    const base = process.env.APP_BASE_DOMAIN ?? "localtest.me";
    const apps = await app.prisma.app.findMany({
      orderBy: { createdAt: "asc" },
      include: { currentVersion: true },
    });

    const items = apps.map((a) => {
      const name = escapeHtml(a.displayName);
      const href = `https://${a.slug}.${base}`;
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
<p><small>Links point to <code>&lt;slug&gt;.${escapeHtml(base)}</code> and
become reachable once edge serving (M2) is deployed.</small></p>
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
