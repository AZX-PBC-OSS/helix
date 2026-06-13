#!/usr/bin/env -S tsx
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

const USAGE = `azx — Helix deploy CLI

Usage:
  azx login                # sign in via the browser (OIDC device flow)
  azx logout
  azx whoami
  azx deploy   [--dir <dir>] [--bundle <zip>] [--promote]
  azx create   [--display-name <name>] [--visibility <v>]
  azx versions
  azx promote  <number>
  azx rollback [number]

Common flags: --slug <slug>  --portal-url <url>  --token <token>
Env:  AZX_PORTAL_URL, AZX_TOKEN (static token — skips login; CI/scripts).
Config file: azx.json { slug, portalUrl, dir }
Visibility: private | group:<id> | password | public
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
  // AZX_TOKEN/--token wins; otherwise tokens come from the `azx login` cache
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
      if (!Number.isInteger(number)) throw new CliError("usage: azx promote <number>");
      await promoteCommand(client, config, number);
      break;
    }
    case "rollback": {
      const number = positionals[1] !== undefined ? Number(positionals[1]) : undefined;
      if (number !== undefined && !Number.isInteger(number)) {
        throw new CliError("usage: azx rollback [number]");
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
