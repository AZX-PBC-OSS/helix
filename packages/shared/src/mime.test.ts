import { describe, expect, it } from "vitest";
import { SERVEABLE_EXTENSIONS, contentTypeFor } from "./mime.js";

describe("contentTypeFor", () => {
  it("keeps the types served before media was added", () => {
    expect(
      Object.fromEntries(
        [
          ".html",
          ".htm",
          ".css",
          ".js",
          ".mjs",
          ".json",
          ".map",
          ".svg",
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".webp",
          ".avif",
          ".ico",
          ".woff",
          ".woff2",
          ".ttf",
          ".otf",
          ".eot",
          ".txt",
          ".xml",
          ".webmanifest",
          ".wasm",
          ".pdf",
        ].map((ext) => [ext, contentTypeFor(`a/file${ext}`)]),
      ),
    ).toMatchInlineSnapshot(`
      {
        ".avif": "image/avif",
        ".css": "text/css; charset=utf-8",
        ".eot": "application/vnd.ms-fontobject",
        ".gif": "image/gif",
        ".htm": "text/html; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".map": "application/json; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".otf": "font/otf",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ttf": "font/ttf",
        ".txt": "text/plain; charset=utf-8",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".xml": "application/xml",
      }
    `);
  });

  it.each([
    ["clip.mp4", "video/mp4"],
    ["clip.m4v", "video/mp4"],
    ["clip.webm", "video/webm"],
    ["clip.ogv", "video/ogg"],
    ["clip.mov", "video/quicktime"],
    ["song.mp3", "audio/mpeg"],
    ["song.m4a", "audio/mp4"],
    ["song.aac", "audio/aac"],
    ["song.wav", "audio/wav"],
    ["song.flac", "audio/flac"],
    ["song.ogg", "audio/ogg"],
    ["song.oga", "audio/ogg"],
    ["song.opus", "audio/ogg"],
    ["song.weba", "audio/webm"],
    ["captions.vtt", "text/vtt; charset=utf-8"],
  ])("maps %s to %s", (path, type) => {
    expect(contentTypeFor(`media/${path}`)).toBe(type);
  });

  it("matches extensions case-insensitively", () => {
    expect(contentTypeFor("CLIP.MP4")).toBe("video/mp4");
    expect(contentTypeFor("Captions.VTT")).toBe("text/vtt; charset=utf-8");
  });

  it.each([
    "app.ts",
    "clip.mkv",
    "clip.avi",
    "subs.srt",
    "data.csv",
    "run.sh",
    "README",
    "a.b/file",
  ])("rejects %s", (path) => {
    expect(contentTypeFor(path)).toBeUndefined();
  });

  it("does not resolve inherited object keys as extensions", () => {
    expect(contentTypeFor("x.constructor")).toBeUndefined();
    expect(contentTypeFor("x.__proto__")).toBeUndefined();
  });
});

describe("SERVEABLE_EXTENSIONS", () => {
  it("is exactly the set of extensions contentTypeFor maps", () => {
    for (const ext of SERVEABLE_EXTENSIONS) expect(contentTypeFor(`f${ext}`)).toBeDefined();
    expect(SERVEABLE_EXTENSIONS.has(".mp4")).toBe(true);
    expect(SERVEABLE_EXTENSIONS.has(".ts")).toBe(false);
  });
});
