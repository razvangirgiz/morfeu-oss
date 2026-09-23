import { describe, expect, it } from "vitest";
import { isCommandNoise, parseLine, projectOf } from "../../src/ingest/claude-code.js";

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ uuid: "u1", sessionId: "s1", timestamp: "2026-03-01T00:00:00Z", ...o });

describe("Claude Code transcript parsing", () => {
  it("keeps user and assistant text only", () => {
    expect(parseLine(line({ type: "user", message: { content: "hello" } }), "f")).toMatchObject({
      type: "user_message",
      text: "hello",
      sessionId: "s1",
    });
    const mixed = line({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "answer" }, { type: "tool_use" }],
      },
    });
    expect(parseLine(mixed, "f")?.text).toBe("answer");
    expect(
      parseLine(line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }), "f"),
    ).toBeNull();
    expect(parseLine(line({ type: "summary" }), "f")).toBeNull();
    expect(parseLine(line({ type: "user", isMeta: true, message: { content: "meta" } }), "f")).toBeNull();
    expect(parseLine("{not json", "f")).toBeNull();
    expect(parseLine(line({ type: "user", timestamp: "never", message: { content: "x" } }), "f")).toBeNull();
  });

  it("falls back to the file name for the session", () => {
    expect(
      parseLine(line({ type: "user", sessionId: undefined, message: { content: "x" } }), "file-session")?.sessionId,
    ).toBe("file-session");
  });

  it("treats slash commands and their wrappers as noise, not prose that starts with a slash", () => {
    expect(isCommandNoise("/clear")).toBe(true);
    expect(isCommandNoise("/model opus")).toBe(true);
    expect(isCommandNoise("<command-name>/review</command-name>")).toBe(true);
    expect(isCommandNoise("/etc/hosts is where I map local domains")).toBe(false);
  });

  it("derives the project from the last directory, and none for the home directory", () => {
    expect(projectOf("/home/alex/code/Acme-API/", "/home/alex")).toBe("acme-api");
    expect(projectOf("/home/alex", "/home/alex")).toBe("");
    expect(projectOf(undefined)).toBe("");
  });
});
