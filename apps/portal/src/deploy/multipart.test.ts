import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// A parser regression can block the event loop, so Vitest's own timeout cannot
// stop it. Exercise the upload plugin in a child with an external kill timeout.
const parseUpload = `
import Fastify from "fastify";
import multipart from "@fastify/multipart";
const { boundary, header } = JSON.parse(process.argv[1]);
const app = Fastify();
app.register(multipart, { limits: { files: 1, fileSize: 1024 } });
app.post("/upload", async (req) => {
  const file = await req.file();
  return { field: file.fieldname, body: (await file.toBuffer()).toString() };
});
try {
  const response = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": "multipart/form-data; boundary=" + boundary },
    payload: "--" + boundary + "\\r\\n" +
      'Content-Disposition: form-data; name="bundle"; filename="bundle.zip"\\r\\n' +
      header + "Content-Type: application/zip\\r\\n\\r\\nhello\\r\\n--" + boundary + "--\\r\\n",
  });
  console.log(JSON.stringify({ status: response.statusCode, body: response.json() }));
} finally {
  await app.close();
}
`;

describe("multipart parser security regressions", () => {
  it.each([
    { name: "ordinary upload", boundary: "helix-boundary", header: "" },
    { name: "252-byte boundary (GHSA-xjh9-v7x6-24jw)", boundary: "a".repeat(252), header: "" },
    {
      name: "prototype header (GHSA-x8mw-p69m-v3mx)",
      boundary: "helix-boundary",
      header: "__proto__: value\r\n",
    },
    {
      name: "constructor header (GHSA-x8mw-p69m-v3mx)",
      boundary: "helix-boundary",
      header: "constructor: value\r\n",
    },
  ])(
    "parses $name without crashing or hanging",
    async ({ boundary, header }) => {
      const { stdout } = await run(
        process.execPath,
        ["--input-type=module", "--eval", parseUpload, JSON.stringify({ boundary, header })],
        { cwd: new URL("../../", import.meta.url), timeout: 5000, killSignal: "SIGKILL" },
      );
      expect(JSON.parse(stdout)).toEqual({
        status: 200,
        body: { field: "bundle", body: "hello" },
      });
    },
    10000,
  );
});
