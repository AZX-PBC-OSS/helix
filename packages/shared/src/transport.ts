export const EVENT_TRANSPORT_POLICY = "transport.policy";
export const EVENT_TRANSPORT_TELEMETRY_DISABLED = "transport.telemetry_disabled";
/** Validate operator-supplied internal destinations before opening connections. */
export function assertInternalTransport(raw: string, key: string, env: NodeJS.ProcessEnv): void {
  const mode = env.HELIX_INTERNAL_TRANSPORT_MODE ?? "https";
  if (mode !== "https" && mode !== "mesh") throw new Error("Invalid HELIX_INTERNAL_TRANSPORT_MODE");
  let origins: unknown;
  try {
    origins = JSON.parse(env.HELIX_MESH_HTTP_ORIGINS ?? "[]");
  } catch {
    throw new Error("Invalid HELIX_MESH_HTTP_ORIGINS");
  }
  if (
    !Array.isArray(origins) ||
    origins.some((value: unknown) => {
      if (typeof value !== "string") return true;
      try {
        const url = new URL(value);
        return (
          url.protocol !== "http:" ||
          url.username !== "" ||
          url.password !== "" ||
          url.pathname !== "/" ||
          url.search !== "" ||
          url.hash !== "" ||
          url.hostname.includes("*")
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error("Invalid HELIX_MESH_HTTP_ORIGINS");
  if (mode === "https" && origins.length)
    throw new Error("Mesh origins require mesh transport mode");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key}: invalid destination`);
  }
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol))
    throw new Error(`${key}: invalid destination`);
  if (env.NODE_ENV !== "production" || url.protocol === "https:") return;
  if (mode === "mesh" && origins.some((origin: string) => new URL(origin).origin === url.origin))
    return;
  throw new Error(`${key}: HTTPS required unless explicitly covered by mesh policy`);
}

/** Boot guard; errors deliberately contain configuration names, never values. */
export function assertPlatformTransport(
  env: NodeJS.ProcessEnv,
  service?: "edge" | "portal" | "egress" | "jobs",
): void {
  if (service) {
    const prefixes = {
      edge: ["EDGE_", "AZURE_STORAGE_"],
      portal: ["PORTAL_", "AZURE_"],
      egress: ["EGRESS_", "AZURE_"],
      jobs: ["JOBS_"],
    }[service];
    env = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          key.startsWith("HELIX_") ||
          key.startsWith("NODE_") ||
          prefixes.some((prefix) => key.startsWith(prefix)),
      ),
    );
  }
  assertInternalTransport("https://configuration.invalid", "transport", env);
  if (env.NODE_ENV === "production" && env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS verification cannot be disabled in production");
  for (const key of [
    "EDGE_EGRESS_URL",
    "EDGE_PORTAL_URL",
    "PORTAL_EGRESS_URL",
    "JOBS_EDGE_PROD_URL",
    "JOBS_EDGE_DEV_URL",
  ]) {
    if (env[key]) assertInternalTransport(env[key], key, env);
  }
  for (const key of ["EDGE_JOBS_CONFIG", "PORTAL_JOBS_CONFIG"]) {
    if (!env[key]) continue;
    let value: unknown;
    try {
      value = JSON.parse(env[key]);
    } catch {
      throw new Error(`${key}: invalid JSON`);
    }
    const visit = (item: unknown): void => {
      if (!item || typeof item !== "object") return;
      for (const [name, child] of Object.entries(item)) {
        if (name === "endpoint" && typeof child === "string")
          assertInternalTransport(child, key, env);
        else visit(child);
      }
    };
    visit(value);
  }
  if (env.NODE_ENV === "production") {
    for (const key of [
      "EDGE_DATABASE_URL",
      "EDGE_DEV_DATABASE_URL",
      "EGRESS_DATABASE_URL",
      "PORTAL_DATABASE_URL",
      "JOBS_DATABASE_URL",
      "JOBS_MIGRATE_DATABASE_URL",
    ]) {
      const raw = env[key];
      if (!raw) continue;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error(`${key}: invalid database URL`);
      }
      if (
        url.searchParams.getAll("sslmode").length !== 1 ||
        url.searchParams.get("sslmode") !== "verify-full" ||
        url.searchParams.has("ssl") ||
        url.searchParams.has("uselibpqcompat")
      )
        throw new Error(`${key}: sslmode=verify-full required`);
    }
    for (const key of [
      "AZURE_STORAGE_BLOB_ENDPOINT",
      "AZURE_KEY_VAULT_URL",
      "AZURE_DELEGATED_KEY_VAULT_URL",
      "PLATFORM_VAULT_URL",
    ]) {
      if (env[key])
        assertInternalTransport(env[key], key, {
          ...env,
          HELIX_INTERNAL_TRANSPORT_MODE: "https",
          HELIX_MESH_HTTP_ORIGINS: "[]",
        });
    }
  }
}

/** Record the selected policy without disclosing destinations or credentials. */
export function initializePlatformTransport(
  env: NodeJS.ProcessEnv,
  service: "edge" | "portal" | "egress" | "jobs",
): void {
  try {
    assertPlatformTransport(env, service);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        event: EVENT_TRANSPORT_POLICY,
        service,
        outcome: "refused",
      }) + "\n",
    );
    throw error;
  }
  if (env.NODE_ENV === "production")
    process.stdout.write(
      JSON.stringify({
        level: "info",
        event: EVENT_TRANSPORT_POLICY,
        service,
        outcome: "accepted",
        mode: env.HELIX_INTERNAL_TRANSPORT_MODE ?? "https",
        meshExceptions:
          env.HELIX_MESH_HTTP_ORIGINS !== undefined && env.HELIX_MESH_HTTP_ORIGINS !== "[]",
      }) + "\n",
    );
}
