import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../../src/config/atomicFile";

/** Writes one file again and again, as a second `lazco` process would. */
const [path, contentPath, count] = process.argv.slice(2);
if (!path || !contentPath || !count) {
  throw new Error("usage: writeCacheLoop <path> <content file> <count>");
}
const content = readFileSync(contentPath, "utf8");
for (let index = 0; index < Number(count); index += 1) {
  await writeFileAtomic(path, content);
}
