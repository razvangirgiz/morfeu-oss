// Keeps modules small enough to read in one sitting: no source file over 400 lines.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 400;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

const tooLong = [];
for (const file of walk("src")) {
  const lines = readFileSync(file, "utf8").split("\n").length;
  if (lines > LIMIT) tooLong.push(`${lines}\t${file}`);
}
if (tooLong.length > 0) {
  console.error(`Source files over ${LIMIT} lines:\n${tooLong.join("\n")}`);
  process.exit(1);
}
