import { describe, expect, it } from "vitest";
import { parseGithubRemote } from "./remote.js";

describe("parseGithubRemote", () => {
  it.each([
    ["https://github.com/octo-org/octo-app.git", "octo-org/octo-app"],
    ["https://github.com/octo-org/octo-app", "octo-org/octo-app"],
    ["https://user@github.com/octo-org/octo.app/", "octo-org/octo.app"],
    ["git@github.com:octo-org/octo-app.git", "octo-org/octo-app"],
    ["ssh://git@github.com/octo-org/octo-app.git", "octo-org/octo-app"],
    ["  git@github.com:Octo/App.git\n", "Octo/App"],
  ])("reads %j", (remote, expected) => {
    expect(parseGithubRemote(remote)).toBe(expected);
  });

  it.each([
    "",
    "https://gitlab.com/octo-org/octo-app.git",
    "git@gitlab.com:octo-org/octo-app.git",
    "https://github.com/octo-org",
    "https://github.com/octo-org/octo-app/tree/main",
    "file:///srv/repo.git",
    "/srv/repo.git",
  ])("refuses %j", (remote) => {
    expect(parseGithubRemote(remote)).toBeNull();
  });

  it("accepts the configured GitHub host", () => {
    expect(parseGithubRemote("https://ghe.example.com/a/b.git", "ghe.example.com")).toBe("a/b");
    expect(parseGithubRemote("https://github.com/a/b.git", "ghe.example.com")).toBeNull();
  });
});
