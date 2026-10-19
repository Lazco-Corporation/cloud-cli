import { CliError } from "../core/errors";
import type { Io } from "./io";

/**
 * Asks on stderr and reads one line from a terminal with echo off, so a
 * pasted token never shows on the screen or in the scrollback.
 */
export async function readHidden(io: Io, question: string): Promise<string> {
  const stdin = io.stdin as NodeJS.ReadStream;
  // Echo goes off before the question shows, so a paste that follows it at once never echoes.
  stdin.setRawMode(true);
  io.stderr.write(question);
  stdin.setEncoding("utf8");
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: CliError): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      io.stderr.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new CliError("CLI_INVALID_INPUT", "The prompt was cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}
