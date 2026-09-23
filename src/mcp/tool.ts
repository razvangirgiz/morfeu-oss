import type { App } from "../app.js";
import type { Args } from "./args.js";

type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** One MCP tool: what the agent sees, and what runs when it is called. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  run(app: App, args: Args, now: Date): Promise<string>;
};

/** JSON replies are what agents parse most reliably; dates serialize as ISO strings. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export const SCOPE_HELP = 'Scopes are "type:id": user:me (the user), project:<name>, agent:<name>.';

export const scopesSchema = {
  type: "array",
  items: { type: "string" },
  description: `Limit to these scopes. Omit for all. ${SCOPE_HELP}`,
};
