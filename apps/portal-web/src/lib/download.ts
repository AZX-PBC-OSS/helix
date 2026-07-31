/**
 * Hand the browser a generated file. Everything the SPA offers for download is
 * composed client-side (the agent skill, rendered for this deployment), so there
 * is no URL to link to — a Blob and a synthetic anchor is the whole mechanism.
 *
 * Deliberately not a fetch of a static file: the portal serves the SPA with an
 * `index.html` fallback on a miss, so a mistyped asset path would download the
 * app shell with a 200 rather than failing visibly.
 */
export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
