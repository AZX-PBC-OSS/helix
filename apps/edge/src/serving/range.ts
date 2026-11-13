/**
 * The byte ranges the edge forwards to Blob storage: one range, `bytes=a-b` or
 * `bytes=a-`. Anything else returns `undefined` and the caller serves the whole
 * file, which RFC 9110 §14.2 allows for any `Range` a server chooses to ignore.
 *
 * Suffix ranges (`bytes=-n`) and multi-range requests are ignored because Blob
 * storage does not serve them, and media players do not need them. The result
 * is rebuilt from the parsed numbers, so no other bytes of the client header
 * reach Blob storage.
 */
const SINGLE_RANGE = /^bytes=(\d{1,15})-(\d{1,15})?$/;

export function parseSingleByteRange(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = SINGLE_RANGE.exec(header);
  if (!match) return undefined;
  const start = Number(match[1]);
  if (match[2] === undefined) return `bytes=${start}-`;
  const end = Number(match[2]);
  if (end < start) return undefined;
  return `bytes=${start}-${end}`;
}
