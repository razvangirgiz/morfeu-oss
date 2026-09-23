import type { App } from "../app.js";
import type { DreamAction, Memory } from "../core/types.js";
import type { PoolClient } from "../db/client.js";
import { activeHead, isUuid, loadMemory } from "../memory/chain.js";
import { entitiesOf } from "../memory/entities.js";
import { MEMORY_COLUMNS, mapMemory } from "../memory/row.js";
import { clampEnd } from "../memory/save.js";
import { settleChain } from "../memory/validity.js";
import { insertMemory, sourcesOf } from "../memory/write.js";
import type { DreamDecision } from "./schema.js";

/** One decision, applied inside its own transaction with the candidate locked. */
export type DecisionContext = {
  app: App;
  client: PoolClient;
  runId: string;
  candidate: Memory;
  decision: DreamDecision;
  /** Ids the model was shown for this candidate: its neighborhood and the batch. */
  allowed: ReadonlySet<string>;
  now: Date;
};

export async function applyDecision(ctx: DecisionContext): Promise<DreamAction> {
  switch (ctx.decision.action) {
    case "add":
      return add(ctx);
    case "reject":
      return reject(ctx);
    case "duplicate":
      return duplicate(ctx);
    case "supersede":
      return supersede(ctx);
    case "temporal_update":
      return temporalUpdate(ctx);
    case "expire":
      return expire(ctx);
  }
}

async function add(ctx: DecisionContext, note?: string): Promise<DreamAction> {
  await setStatus(ctx, ctx.candidate.id, "active");
  await record(ctx, "add", null, note);
  return "add";
}

async function reject(ctx: DecisionContext): Promise<DreamAction> {
  await setStatus(ctx, ctx.candidate.id, "invalidated");
  await record(ctx, "reject", null);
  return "reject";
}

async function duplicate(ctx: DecisionContext): Promise<DreamAction> {
  const { target, note } = await resolveTarget(ctx);
  if (!target) return add(ctx, note);
  await setStatus(ctx, ctx.candidate.id, "invalidated");
  // Hearing the same claim again raises confidence and brings it back from the archive.
  await ctx.client.query(
    "UPDATE memories SET confidence = GREATEST(confidence, LEAST(0.95, confidence + 0.05)), archived_at = NULL WHERE id = $1",
    [target.id],
  );
  await record(ctx, "duplicate", target.id);
  return "duplicate";
}

async function supersede(ctx: DecisionContext): Promise<DreamAction> {
  const { target, note } = await resolveTarget(ctx);
  if (!target) return add(ctx, note);
  const { candidate, client, now } = ctx;
  // The new claim starts when it was said, unless it says otherwise.
  const res = await client.query(
    `UPDATE memories SET status = 'active', supersedes_id = $2, valid_from = COALESCE(valid_from, $3)
     WHERE id = $1 AND status = 'candidate' RETURNING ${MEMORY_COLUMNS}`,
    [candidate.id, target.id, candidate.observed_at],
  );
  await settleChain(client, mapMemory(res.rows[0]), now);
  await record(ctx, "supersede", target.id);
  return "supersede";
}

async function temporalUpdate(ctx: DecisionContext): Promise<DreamAction> {
  const { candidate, decision, client, now } = ctx;
  const resolved = ctx.decision.target_id ? await resolveTarget(ctx) : { target: null };
  if (ctx.decision.target_id && !resolved.target) return add(ctx, resolved.note);
  const target = resolved.target;
  const validFrom = parseDate(decision.valid_from) ?? candidate.valid_from ?? candidate.observed_at;
  let validUntil = parseDate(decision.valid_until) ?? candidate.valid_until;
  if (validUntil && validUntil < validFrom) validUntil = null;
  const rewritten = await insertMemory(
    ctx.app,
    client,
    {
      content: decision.content?.trim() || candidate.content,
      type: candidate.type,
      scope: { type: candidate.scope_type, id: candidate.scope_id },
      origin: "extracted",
      status: "active",
      importance: candidate.importance,
      confidence: candidate.confidence,
      volatility: candidate.volatility,
      observed_at: candidate.observed_at,
      valid_from: validFrom,
      valid_until: validUntil,
      supersedes_id: target?.id ?? candidate.id,
      entities: await entitiesOf(client, candidate.id),
      sourceEventIds: await sourcesOf(client, candidate.id),
    },
    now,
  );
  // The candidate was never served: it is replaced by its rewrite, not ended.
  await client.query("UPDATE memories SET status = 'invalidated', superseded_by_id = $2 WHERE id = $1", [
    candidate.id,
    rewritten.id,
  ]);
  if (target) await settleChain(client, rewritten, now);
  await record(ctx, "temporal_update", rewritten.id);
  return "temporal_update";
}

async function expire(ctx: DecisionContext): Promise<DreamAction> {
  const { candidate, decision, client, now } = ctx;
  const stated = parseDate(decision.valid_until);
  if (!decision.target_id || decision.target_id === candidate.id) {
    // A claim that had already ended when it was said is still history worth
    // keeping. Without a date, it ended no later than when it was said.
    const end = stated ?? candidate.valid_until ?? candidate.observed_at;
    await client.query("UPDATE memories SET status = 'expired', valid_until = $2 WHERE id = $1", [
      candidate.id,
      clampEnd(end, candidate.valid_from),
    ]);
    await record(ctx, "expire", candidate.id);
    return "expire";
  }
  const { target, note } = await resolveTarget(ctx);
  if (!target) return add(ctx, note);
  await setStatus(ctx, candidate.id, "invalidated");
  // Never extends a validity that already ends earlier.
  const end = clampEnd(stated ?? now, target.valid_from);
  await client.query(
    `UPDATE memories SET status = 'expired', valid_until = LEAST(COALESCE(valid_until, $2), $2)
     WHERE id = $1 AND status = 'active'`,
    [target.id, end],
  );
  await record(ctx, "expire", target.id);
  return "expire";
}

/**
 * The model's target is untrusted. It may only touch what it was shown, in
 * the candidate's own scope, through the chain's current head, and never a
 * memory the user stated themselves. Anything else degrades to "add".
 */
async function resolveTarget(ctx: DecisionContext): Promise<{ target: Memory | null; note?: string }> {
  const id = ctx.decision.target_id;
  if (!id) return { target: null, note: "no target given" };
  if (!isUuid(id) || !ctx.allowed.has(id))
    return { target: null, note: `target ${id.slice(0, 40)} was not in the neighborhood` };
  const start = await loadMemory(ctx.client, id, { lock: true });
  const head = start ? await activeHead(ctx.client, start, { lock: true }) : null;
  if (!head) return { target: null, note: `target ${id} is no longer active` };
  if (head.id === ctx.candidate.id) return { target: null, note: "target is the candidate itself" };
  if (head.scope_type !== ctx.candidate.scope_type || head.scope_id !== ctx.candidate.scope_id) {
    return { target: null, note: `target ${head.id} is in another scope` };
  }
  if (head.origin === "owner") return { target: null, note: `target ${head.id} was stated by the user` };
  return { target: head };
}

async function setStatus(ctx: DecisionContext, id: string, status: "active" | "invalidated"): Promise<void> {
  await ctx.client.query("UPDATE memories SET status = $2 WHERE id = $1 AND status = 'candidate'", [id, status]);
}

async function record(
  ctx: DecisionContext,
  action: DreamAction,
  targetId: string | null,
  note?: string,
): Promise<void> {
  const reason = ctx.decision.reason?.trim() || action;
  await ctx.client.query(
    "INSERT INTO dream_decisions (run_id, memory_id, action, target_id, reason) VALUES ($1, $2, $3, $4, $5)",
    [ctx.runId, ctx.candidate.id, action, targetId, note ? `${reason} (${note})` : reason],
  );
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
