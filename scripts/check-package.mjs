// Packs morfeu the way npm publishes it, checks what goes in the tarball, then
// installs it into a scratch prefix and runs the installed binary.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const scratch = mkdtempSync(join(tmpdir(), "morfeu-pack-"));

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch]))[0];
  const files = packed.files.map((f) => f.path).sort();
  const required = [
    "dist/cli.js",
    "dist/mcp/server.js",
    "migrations/0001_initial.sql",
    "docker-compose.yml",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "package.json",
  ];
  const missing = required.filter((f) => !files.includes(f));
  const unexpected = files.filter(
    (f) => !(f.startsWith("dist/") && f.endsWith(".js")) && !f.startsWith("migrations/") && !required.includes(f),
  );
  if (missing.length || unexpected.length) {
    console.error(`missing: ${missing.join(", ") || "none"}\nunexpected: ${unexpected.join(", ") || "none"}`);
    process.exit(1);
  }
  const prefix = join(scratch, "prefix");
  run("npm", ["install", "--global", "--prefix", prefix, join(scratch, packed.filename)], { stdio: "pipe" });
  const bin = join(prefix, process.platform === "win32" ? "morfeu.cmd" : "bin/morfeu");
  const version = run(bin, ["--version"]).trim();
  if (version !== packed.version) throw new Error(`installed binary reports ${version}, expected ${packed.version}`);
  if (!/\bsetup\b/.test(run(bin, ["help"]))) throw new Error("help output is missing the setup command");
  console.log(`ok: ${packed.filename}, ${files.length} files, ${Math.round(packed.size / 1024)} KiB`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
