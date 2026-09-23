import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Updates KEY=value lines in a dotenv-style config file: existing keys are
 * replaced in place, new ones appended, comments and other keys kept. An empty
 * value removes the key. The file is readable only by the user; it may hold API keys.
 */
export function writeSettings(path: string, settings: Record<string, string>): void {
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").split(/\r?\n/)
    : ["# morfeu settings (see `morfeu help config`)"];
  const pending = new Map(Object.entries(settings));
  const out: string[] = [];
  for (const line of lines) {
    const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key) as string;
      pending.delete(key);
      if (value !== "") out.push(`${key}=${quote(value)}`);
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out.at(-1) === "") out.pop();
  for (const [key, value] of pending) if (value !== "") out.push(`${key}=${quote(value)}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${out.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@+,-]*$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}
