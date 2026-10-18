export type OutputStream = { write(text: string): unknown; isTTY?: boolean };

/** The process as the shell sees it, so tests can run it in memory. */
export type Io = {
  stdout: OutputStream;
  stderr: OutputStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
};

export function processIo(): Io {
  return { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env };
}

/** True when both stdin and stderr are terminals, so a question can be asked and answered. */
export function canPrompt(io: Io): boolean {
  return Boolean(io.stdin.isTTY && io.stderr.isTTY);
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}
