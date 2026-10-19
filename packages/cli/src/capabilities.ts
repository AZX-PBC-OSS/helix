import { CapabilityCatalogueSchema, type CapabilityCatalogue } from "@azx-pbc/shared";

/** Plain-words labels for the approval triggers, in the catalogue's own order. */
const TRIGGER_LABELS: Record<CapabilityCatalogue["approval"]["elevationTriggers"][number], string> =
  {
    externalOrigins: "any externalOrigins entry",
    fetchOrigins: "any fetch.origins entry",
    mcp: "any mcp server",
    publicVisibility: "public visibility",
    budgetAboveBaseline: "any budget above its baseline",
    uncuratedLlmModel: "an LLM model not in the list above",
  };

const n = (value: number) => value.toLocaleString("en-US");

/**
 * Render the catalogue as text an agent or a person can read in a terminal:
 * one section per manifest key, in the order the manifest declares them.
 */
export function formatCapabilities(c: CapabilityCatalogue): string {
  const b = c.approval.baselines;
  const lines = [
    "Helix capabilities on this deployment",
    "",
    `Visibility modes:   ${c.visibility.modes.join(", ")}`,
    "",
    "LLM (capabilities.llm)",
    `  models:           ${c.llm.models.length ? c.llm.models.join(", ") : "(none servable)"}`,
    `  baseline:         $${n(b.dollarsPerDay)}/day`,
    "",
    "App data (capabilities.data)",
    `  available:        ${c.data.provisioned ? "yes" : "no"}`,
    `  baselines:        ${n(b.writesPerDay)} writes/day, ${n(b.bytesPerDay)} bytes/day`,
    "",
    "Outbound HTTP (capabilities.fetch, externalOrigins)",
    `  connections:      ${c.fetch.connections.length ? c.fetch.connections.map((x) => x.name).join(", ") : "(none)"}`,
    ...(c.fetch.providers.length
      ? [
          "  providers:",
          ...c.fetch.providers.map(
            (p) => `    ${p.ref} (${p.displayName}, ${p.env}) → ${p.apiOrigins.join(", ")}`,
          ),
        ]
      : ["  providers:        (none)"]),
    `  externalOrigins:  ${c.fetch.externalOriginsPermitted ? "may be requested" : "not permitted"}`,
    `  baseline:         ${n(b.fetchRequestsPerDay)} proxied requests/day`,
    "",
    `MCP:                ${c.mcp.enforced ? "enforced" : "carried in the manifest, not enforced"}`,
    `Offline:            ${c.offline.available ? `available — ${c.offline.scopeRule}` : "not available"}`,
    `Deploy limits:      ${n(c.deploy.maxFileMb)} MB per file, ${n(c.deploy.maxBundleMb)} MB per bundle`,
    `Dev gateway:        ${c.devApiBase ? `${c.devApiBase}/<slug>` : "not deployed"}`,
    "",
    "Needs admin approval:",
    ...c.approval.elevationTriggers.map((t) => `  - ${TRIGGER_LABELS[t]}`),
    "Everything else applies immediately.",
  ];
  return lines.join("\n");
}

/**
 * Format a raw catalogue response. A portal newer or older than this CLI may
 * send a shape the schema doesn't accept; the raw JSON is still useful, so it
 * is printed instead of failing.
 */
export function renderCapabilities(raw: unknown, opts: { json?: boolean }): string {
  if (opts.json) return JSON.stringify(raw, null, 2);
  const parsed = CapabilityCatalogueSchema.safeParse(raw);
  if (parsed.success) return formatCapabilities(parsed.data);
  return (
    "(this CLI could not format the portal's response; showing it as JSON)\n" +
    JSON.stringify(raw, null, 2)
  );
}
