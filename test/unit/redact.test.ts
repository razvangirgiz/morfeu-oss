import { describe, expect, it } from "vitest";
import { redact, redactJson } from "../../src/ledger/redact.js";

// Fake credentials assembled at runtime so no secret scanner flags this file.
const fake = (...parts: string[]) => parts.join("");

describe("redact", () => {
  it.each([
    ["openai", fake("sk-proj-", "a".repeat(24))],
    ["anthropic", fake("sk-ant-api03-", "b".repeat(24))],
    ["github", fake("ghp_", "c".repeat(36))],
    ["github", fake("github_pat_", "d".repeat(40))],
    ["gitlab", fake("glpat-", "e".repeat(20))],
    ["slack", fake("xoxb-", "123456789012-abc")],
    ["aws", fake("AKIA", "ABCDEFGHIJKLMNOP")],
    ["google", fake("AIza", "f".repeat(35))],
    ["stripe", fake("sk_live_", "g".repeat(24))],
    ["npm", fake("npm_", "h".repeat(36))],
    ["huggingface", fake("hf_", "i".repeat(34))],
    ["jwt", fake("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0In0", ".", "signature123")],
  ])("masks %s keys", (kind, secret) => {
    const r = redact(`use ${secret} here`);
    expect(r.text).toBe(`use [redacted:${kind}] here`);
    expect(r.count).toBe(1);
  });

  it("masks private keys, URL passwords, bearer tokens and secret assignments, keeping context", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
    expect(redact(key).text).toBe("[redacted:private-key]");
    expect(redact("postgres://app:hunter2@db:5432/x").text).toBe("postgres://app:[redacted:url-credentials]@db:5432/x");
    expect(redact("Authorization: Bearer abc.def-123456").text).toBe("Authorization: Bearer [redacted:bearer]");
    expect(redact("DB_PASSWORD=correcthorse").text).toBe("DB_PASSWORD=[redacted:assignment]");
    expect(redact('"api_key": "0123456789abcdef"').text).toBe('"api_key": "[redacted:assignment]"');
  });

  it("leaves ordinary text alone and is idempotent", () => {
    const text = "The token budget is 2000 and the password policy needs review.";
    expect(redact(text)).toEqual({ text, count: 0 });
    const once = redact(fake("key sk-proj-", "z".repeat(30))).text;
    expect(redact(once)).toEqual({ text: once, count: 0 });
  });

  it("walks JSON values", () => {
    expect(redactJson({ a: [fake("ghp_", "x".repeat(36))], n: 1 })).toEqual({ a: ["[redacted:github]"], n: 1 });
  });
});
