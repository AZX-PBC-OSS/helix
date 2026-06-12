#!/usr/bin/env -S tsx
import { parseArgs } from "node:util";
import { CliError, PortalClient } from "./client.js";
import {
  createCommand,
  deployCommand,
  promoteCommand,
  rollbackCommand,
  versionsCommand,
} from "./commands.js";
import { resolveConfig } from "./config.js";

const USAGE = `azx — Helix deploy CLI

Usage:
  azx deploy   [--dir <dir>] [--bundle <zip>] [--promote]
  azx create   [--display-name <name>] [--visibility <v>]
  azx versions
  azx promote  <number>
  azx rollback [number]

Common flags: --slug <slug>  --portal-url <url>  --token <token>
Env:  AZX_PORTAL_URL, AZX_TOKEN.   Config file: azx.json { slug, portalUrl, dir }
Visibility: private | group:<id> | password | public
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      slug: { type: "string" },
      "portal-url": { type: "string" },
      dir: { type: "string" },
      bundle: { type: "string" },
      token: { type: "string" },
      promote: { type: "boolean" },
      "display-name": { type: "string" },
      visibility: { type: "string" },
      help: { type: "boolean" },
    },
  });

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
  const client = new PortalClient(config.portalUrl, config.token);

  switch (command) {
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
