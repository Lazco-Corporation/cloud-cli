import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SiteFile } from "../../src/uploads/pages/directory";
import type { SignedUpload } from "../../src/uploads/pages/uploadEngine";

export type StoragePut = {
  path: string;
  url: string;
  headers: Record<string, string>;
  bytes: number;
  attempt: number;
};

export type StorageHandler = (put: StoragePut) => Response | Promise<Response>;

/**
 * A storage endpoint on 127.0.0.1 that records every PUT, the order PUTs
 * start and end in, and the most PUTs that ran at once.
 */
export class FakeStorage {
  readonly puts: StoragePut[] = [];
  readonly events: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  handler: StorageHandler;
  private readonly attempts = new Map<string, number>();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(handler: StorageHandler = () => new Response(null, { status: 200 })) {
    this.handler = handler;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const filePath = decodeURIComponent(url.pathname.slice(1));
        const bytes = (await request.arrayBuffer()).byteLength;
        const attempt = (this.attempts.get(filePath) ?? 0) + 1;
        this.attempts.set(filePath, attempt);
        const put: StoragePut = {
          path: filePath,
          url: request.url,
          headers: Object.fromEntries(request.headers.entries()),
          bytes,
          attempt,
        };
        this.puts.push(put);
        this.events.push(`start ${filePath}`);
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          return await this.handler(put);
        } finally {
          this.inFlight -= 1;
          this.events.push(`end ${filePath}`);
        }
      },
    });
  }

  /** The signed URL of a path, with a marker the test can read back. */
  url(filePath: string, generation = 0): string {
    return `http://127.0.0.1:${this.server.port}/${encodeURIComponent(filePath)}?generation=${generation}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

/** Writes files into a directory, and answers them as the engine takes them. */
export async function siteFiles(
  root: string,
  contents: Record<string, string | Uint8Array>,
): Promise<Map<string, { file: SiteFile; sha256: string }>> {
  const files = new Map<string, { file: SiteFile; sha256: string }>();
  for (const [name, content] of Object.entries(contents)) {
    const absolutePath = path.join(root, name);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    files.set(name, {
      file: { path: name, absolutePath, size: bytes.length },
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return files;
}

/** The signed uploads of these files, as a deploy start answers them. */
export function signedUploads(
  storage: FakeStorage,
  files: Map<string, { file: SiteFile; sha256: string }>,
  generation = 0,
): SignedUpload[] {
  return [...files.values()].map(({ file, sha256 }) => ({
    path: file.path,
    url: storage.url(file.path, generation),
    headers: {
      "content-type": "application/octet-stream",
      "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
    },
  }));
}
