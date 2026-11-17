import "./style.css";

type Route = "browser" | "proxy";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

function readIp(value: unknown): string {
  if (typeof value !== "object" || value === null || !("ip" in value)) {
    throw new Error("The API did not return an IP address.");
  }
  const ip = value.ip;
  if (
    typeof ip !== "string" ||
    !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ||
    ip.split(".").some((part) => Number(part) > 255)
  ) {
    throw new Error("The API did not return a valid IPv4 address.");
  }
  return ip;
}

for (const route of ["browser", "proxy"] as const) {
  const button = element<HTMLButtonElement>(`${route}-button`);
  const result = element(`${route}-ip`);
  const status = element(`${route}-status`);
  button.addEventListener("click", () => void check(route));

  async function check(path: Route): Promise<void> {
    button.disabled = true;
    result.textContent = "—";
    status.textContent = "Checking…";
    status.classList.remove("error");
    const started = performance.now();
    try {
      // The platform shim would silently turn the browser control into another proxy call.
      if (path === "browser" && "__helixShim" in window && window.__helixShim) {
        throw new Error(
          "Turn off the transparent fetch shim in Capabilities, then reload this app.",
        );
      }
      const target = new URL("https://api.ipify.org");
      target.searchParams.set("format", "json");
      target.searchParams.set("probe", crypto.randomUUID());
      const response = await fetch(path === "proxy" ? `/_api/fetch/${target.href}` : target.href, {
        cache: "no-store",
        credentials: path === "proxy" ? "same-origin" : "omit",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      result.textContent = readIp(await response.json());
      status.textContent = `Checked at ${new Date().toLocaleTimeString()} · ${Math.round(performance.now() - started)} ms`;
    } catch (error) {
      const hint =
        path === "browser"
          ? " Check the direct-origin grant, your network, and browser blockers."
          : " Check the fetch-origin grant, approval, session, and egress health.";
      status.textContent = (error instanceof Error ? error.message : String(error)) + hint;
      status.classList.add("error");
    } finally {
      button.disabled = false;
    }
  }
}
