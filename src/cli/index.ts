import { parseArgs } from "node:util";
import { type Config, loadConfig } from "../config/config.js";
import { errorMessage } from "../db/client.js";
import { VERSION } from "../version.js";
import type { Command, CommandContext, CommandGroup, Values } from "./command.js";
import { adminCommands } from "./commands/admin.js";
import { memoryCommands } from "./commands/memory.js";
import { pipelineCommands } from "./commands/pipeline.js";

const GROUPS: readonly CommandGroup[] = [memoryCommands, pipelineCommands, adminCommands];

const COMMANDS = new Map<string, Command>(GROUPS.flatMap((g) => g.commands.map((c) => [c.name, c] as const)));

function help(): string {
  const lines = [
    `morfeu ${VERSION}: long-term memory for AI agents`,
    "",
    "Usage: morfeu <command> [arguments] [options]",
  ];
  for (const group of GROUPS) {
    lines.push("", `${group.title}:`);
    for (const c of group.commands) lines.push(`  ${c.name.padEnd(11)} ${c.summary}`);
  }
  lines.push(
    "",
    "Run `morfeu help <command>` for a command's options.",
    "Settings live in the file `morfeu doctor` shows; see docs/configuration.md.",
  );
  return lines.join("\n");
}

function commandHelp(c: Command): string {
  return `${c.summary}\n\nUsage: morfeu ${c.usage}`;
}

export type MainIo = {
  out?: (text: string) => void;
  err?: (text: string) => void;
  stdin?: () => Promise<string>;
  now?: () => Date;
  config?: Config;
};

/** Runs one CLI invocation and returns its exit code. */
export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const out = io.out ?? ((t: string) => process.stdout.write(`${t}\n`));
  const err = io.err ?? ((t: string) => process.stderr.write(`${t}\n`));
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const target = rest[0] ? COMMANDS.get(rest[0]) : undefined;
    out(target ? commandHelp(target) : help());
    return 0;
  }
  if (name === "--version" || name === "-v") {
    out(VERSION);
    return 0;
  }
  const command = COMMANDS.get(name);
  if (!command) {
    err(`unknown command "${name}"\n\n${help()}`);
    return 2;
  }
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...command.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] };
  } catch (e) {
    err(`${errorMessage(e)}\n\n${commandHelp(command)}`);
    return 2;
  }
  if (parsed.values.help) {
    out(commandHelp(command));
    return 0;
  }
  try {
    const ctx: CommandContext = {
      config: io.config ?? loadConfig(),
      args: parsed.positionals,
      values: parsed.values,
      out,
      stdin: io.stdin ?? readStdin,
      now: io.now ?? (() => new Date()),
    };
    return await command.run(ctx);
  } catch (e) {
    err(`morfeu ${name}: ${errorMessage(e)}`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
