#!/usr/bin/env node
import { main } from "./cli/index.js";

main(process.argv.slice(2)).then(
  (code) => {
    // `morfeu mcp` never resolves; every other command ends here.
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
