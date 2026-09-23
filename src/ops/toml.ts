/**
 * Just enough TOML to add, read and remove one `[mcp_servers.<name>]` table in
 * a Codex config without disturbing anything else in the file.
 */
export function extractTomlTable(text: string, header: string): { start: number; end: number; body: string } | null {
  const needle = `[${header}]`;
  const lines = splitKeep(text);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === needle) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? "";
    if (t.startsWith("[") && t.endsWith("]")) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .replace(/\n+$/, "");
  const startOff = lines.slice(0, start).join("").length;
  const endOff = lines.slice(0, end).join("").length;
  return { start: startOff, end: endOff, body };
}

export function upsertTomlTable(text: string, header: string, body: string): string {
  const block = `[${header}]\n${body.trim()}\n`;
  const existing = extractTomlTable(text, header);
  if (!existing) {
    const trimmed = text.replace(/\s+$/, "");
    return trimmed ? `${trimmed}\n\n${block}` : block;
  }
  return text.slice(0, existing.start) + block + text.slice(existing.end).replace(/^\n+/, "\n");
}

export function removeTomlTablesPrefixed(text: string, prefix: string): string {
  const lines = splitKeep(text);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("[") && t.endsWith("]")) {
      const name = t.slice(1, -1);
      skipping = name === prefix || name.startsWith(`${prefix}.`);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "\n");
}

export function parseTomlStdio(body: string): { command?: string; args?: string[] } {
  let command: string | undefined;
  let args: string[] | undefined;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "command") command = unquoteToml(value);
    if (key === "args") args = parseTomlArray(value);
  }
  return { command, args };
}

function parseTomlArray(value: string): string[] {
  const inner = value.trim();
  if (!inner.startsWith("[") || !inner.endsWith("]")) return [];
  const body = inner.slice(1, -1).trim();
  if (!body) return [];
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) {
      if (ch === "\\" && i + 1 < body.length) {
        cur += body[i + 1];
        i += 1;
        continue;
      }
      if (ch === q) {
        out.push(cur);
        cur = "";
        q = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
  }
  return out;
}

function unquoteToml(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function splitKeep(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
