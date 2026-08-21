// No shebang here on purpose: the published entrypoint is the bundled
// `dist/helix.js`, which `scripts/build.mjs` stamps with `#!/usr/bin/env node`.
// A shebang in this file would be hoisted above that banner and send the
// installed binary looking for tsx. In dev, run it via `pnpm helix`.
import { parseCliArgs } from "./args.js";
import { CliError, PortalClient } from "./client.js";
import {
  createCommand,
  deployCommand,
  loginCommand,
  logoutCommand,
  promoteCommand,
  rollbackCommand,
  versionsCommand,
  whoamiCommand,
} from "./commands.js";
import { makeTokenProvider } from "./auth/session.js";
import { resolveConfig } from "./config.js";

const USAGE = `helix — Helix deploy CLI

Usage:
  helix login                # sign in via the browser (OIDC device flow)
  helix logout
  helix whoami
  helix deploy   [--dir <dir>] [--bundle <zip>] [--promote]
  helix create   [--display-name <name>] [--visibility <v>]
  helix versions
  helix promote  <number>
  helix rollback [number]

Common flags: --slug <slug>  --portal-url <url>  --token <token>
Env:  HELIX_PORTAL_URL, HELIX_TOKEN (static token — skips login; CI/scripts).
Config file: helix.json { slug, portalUrl, dir }
Visibility: internal | group:<id>[,<id>...] | password | public
`;

async function main(): Promise<void> {
  const { values, positionals } = parseCliArgs(process.argv.slice(2));

  const command = positionals[0];
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  const config = await resolveConfig({
    slug: values.slug,
    portalUrl: values["portal-url"],
    dir: values.dir,
    bundle: values.bundle,
    token: values.token,
  });
  // HELIX_TOKEN/--token wins; otherwise tokens come from the `helix login` cache
  // (with silent refresh) via the provider.
  const client = new PortalClient(
    config.portalUrl,
    makeTokenProvider({ portalUrl: config.portalUrl, staticToken: config.token }),
  );

  switch (command) {
    case "login":
      await loginCommand(client, config);
      break;
    case "logout":
      await logoutCommand(config);
      break;
    case "whoami":
      await whoamiCommand(client);
      break;
    case "deploy":
      await deployCommand(client, config, { promote: values.promote });
      break;
    case "create":
      await createCommand(client, config, {
        displayName: values["display-name"],
        visibility: values.visibility,
      });
      break;
    case "versions":
      await versionsCommand(client, config);
      break;
    case "promote": {
      const number = Number(positionals[1]);
      if (!Number.isInteger(number)) throw new CliError("usage: helix promote <number>");
      await promoteCommand(client, config, number);
      break;
    }
    case "rollback": {
      const number = positionals[1] !== undefined ? Number(positionals[1]) : undefined;
      if (number !== undefined && !Number.isInteger(number)) {
        throw new CliError("usage: helix rollback [number]");
      }
      await rollbackCommand(client, config, number);
      break;
    }
    default:
      throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}${err.code ? ` (${err.code})` : ""}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
