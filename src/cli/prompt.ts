import { createInterface, type Interface } from "node:readline/promises";

/** Minimal interactive prompts on stdin/stderr (stdout stays clean for results). */
export class Prompt {
  private rl: Interface;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stderr });
  }

  async text(question: string, fallback = ""): Promise<string> {
    const hint = fallback ? ` [${fallback}]` : "";
    const answer = (await this.rl.question(`${question}${hint}: `)).trim();
    return answer || fallback;
  }

  async secret(question: string): Promise<string> {
    // readline has no masked input; the key is read like any line and never echoed back afterwards.
    return (await this.rl.question(`${question}: `)).trim();
  }

  async choose<T extends string>(
    question: string,
    choices: readonly { value: T; label: string }[],
    fallback: T,
  ): Promise<T> {
    process.stderr.write(`${question}\n`);
    for (const [i, c] of choices.entries()) {
      process.stderr.write(`  ${i + 1}) ${c.label}${c.value === fallback ? " (default)" : ""}\n`);
    }
    for (;;) {
      const raw = (await this.rl.question("> ")).trim();
      if (!raw) return fallback;
      const picked = choices[Number(raw) - 1] ?? choices.find((c) => c.value === raw);
      if (picked) return picked.value;
      process.stderr.write(`  choose 1 to ${choices.length}\n`);
    }
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    const answer = (await this.rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer ? answer.startsWith("y") : fallback;
  }

  close(): void {
    this.rl.close();
  }
}
