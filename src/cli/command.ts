import type { ParseArgsConfig } from "node:util";
import { type App, closeApp, createApp } from "../app.js";
import type { Config } from "../config/config.js";

export type Options = NonNullable<ParseArgsConfig["options"]>;
export type Values = Record<string, string | boolean | string[] | undefined>;

export type CommandContext = {
  config: Config;
  args: string[];
  values: Values;
  out: (text: string) => void;
  /** Reads all of stdin (for hooks). */
  stdin: () => Promise<string>;
  now: () => Date;
};

export type Command = {
  name: string;
  /** One line for `morfeu help`. */
  summary: string;
  /** Usage after `morfeu `, e.g. `search <query> [--scope s]...`. */
  usage: string;
  options?: Options;
  run(ctx: CommandContext): Promise<number>;
};

export type CommandGroup = { title: string; commands: readonly Command[] };

/** Runs `fn` with an App built from the command's config, and always closes its pool. */
export async function withApp<T>(ctx: CommandContext, fn: (app: App) => Promise<T>): Promise<T> {
  const app = createApp({ config: ctx.config });
  try {
    return await fn(app);
  } finally {
    await closeApp(app);
  }
}

export const JSON_OPTION: Options = { json: { type: "boolean", short: "j" } };

export function print(ctx: CommandContext, value: unknown, human: () => string): void {
  ctx.out(ctx.values.json ? JSON.stringify(value, null, 2) : human());
}

export function stringValue(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function listValue(values: Values, key: string): string[] | undefined {
  const v = values[key];
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v : [String(v)])
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function dateValue(values: Values, key: string): Date | undefined {
  const raw = stringValue(values, key);
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`--${key} must be an ISO date, e.g. 2026-03-01`);
  return new Date(ms);
}

export function intValue(values: Values, key: string): number | undefined {
  const raw = stringValue(values, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`--${key} must be a whole number`);
  return n;
}

export function requireArg(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.args[index];
  if (!value) throw new Error(`missing <${name}>`);
  return value;
}
