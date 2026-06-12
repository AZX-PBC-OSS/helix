import { ZipArchive } from "archiver";

/** Zip a directory's contents (entries at the archive root) into a Buffer. */
export function zipDirectory(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("data", (c: Buffer) => chunks.push(c));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.directory(dir, false);
    void archive.finalize();
  });
}
