/** Bundle validation limits (architecture §5: size/type sanity checks). */

/** Max uncompressed bytes for any single file. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Max total uncompressed bytes across the whole bundle. */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Max number of files in a bundle. */
export const MAX_ENTRIES = 5_000;

/**
 * Max uncompressed:compressed ratio for any file. Above this we treat the
 * entry as a decompression bomb and reject the bundle.
 */
export const MAX_COMPRESSION_RATIO = 200;

/** Max bytes of a lintable file we buffer for the CSP courtesy lint. */
export const MAX_LINT_BYTES = 512 * 1024;
