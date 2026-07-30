import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("parses a command with its flags", () => {
    const { values, positionals } = parseCliArgs(["deploy", "--promote"]);
    expect(positionals[0]).toBe("deploy");
    expect(values.promote).toBe(true);
  });

  it("strips a leading `--` forwarded by `pnpm … helix -- <cmd>`", () => {
    const { values, positionals } = parseCliArgs(["--", "deploy", "--promote"]);
    expect(positionals[0]).toBe("deploy");
    expect(values.promote).toBe(true);
  });

  it("keeps string flags after a forwarded `--`", () => {
    const { values, positionals } = parseCliArgs(["--", "create", "--display-name", "Hello"]);
    expect(positionals[0]).toBe("create");
    expect(values["display-name"]).toBe("Hello");
  });

  it("only strips a single, leading `--`", () => {
    // A `--` that isn't first is a normal end-of-options marker, untouched.
    const { positionals } = parseCliArgs(["promote", "3"]);
    expect(positionals).toEqual(["promote", "3"]);
  });
});
