import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./config/paths.js";

/** The installed package's version, read once from package.json. */
export const VERSION: string = (
  JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string }
).version;
