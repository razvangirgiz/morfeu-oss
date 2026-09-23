/**
 * Secret redaction, applied once at the ledger's front door: every event and
 * every memory passes through here before it is stored, so a key pasted into
 * a conversation never reaches the database, the LLM or an agent's context.
 *
 * The patterns follow common secret scanners (gitleaks, GitHub push
 * protection). They favour catching a secret over sparing a look-alike.
 */

type Pattern = { kind: string; regex: RegExp; replace?: (match: string, ...groups: string[]) => string };

const PATTERNS: readonly Pattern[] = [
  { kind: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "anthropic", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe", regex: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "github", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { kind: "gitlab", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "google", regex: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: "npm", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "huggingface", regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    // scheme://user:password@host, also with an empty user or a password containing / or #
    kind: "url-credentials",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]*):([^@\s]{1,256})@/gi,
    replace: (_m, prefix) => `${prefix}:[redacted:url-credentials]@`,
  },
  {
    kind: "bearer",
    regex: /\b(Authorization:\s*(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, prefix) => `${prefix}[redacted:bearer]`,
  },
  {
    // curl -u user:password, --user user:password
    kind: "basic-auth",
    regex: /(\s(?:-u|--user)\s+["']?[^\s:"']{1,64}:)[^\s"']{1,256}/g,
    replace: (_m, prefix) => `${prefix}[redacted:basic-auth]`,
  },
  {
    // NAME_KEY=value, "api_secret": "value", PASSWORD: value, password: "a few words"
    kind: "assignment",
    regex:
      /\b([A-Za-z0-9_-]{0,40}(?:api[_-]?key|secret|token|passw(?:or)?d|passphrase|credentials?|pwd)[A-Za-z0-9_-]{0,20})(["']?\s*[:=]\s*)(?:"([^"\n]{6,256})"|'([^'\n]{6,256})'|([^\s"',]{6,256}))/gi,
    replace: (match, key, separator, doubleQuoted, singleQuoted) => {
      // "tokenizer", "tokens", "secretary": the keyword must stand as its own word inside the name.
      if (
        !/(?:^|[_-])(?:api[_-]?key|secret|token|passw(?:or)?d|passphrase|credentials?|pwd)(?:$|[_-])|apikey|password/i.test(
          key,
        )
      ) {
        return match;
      }
      if (doubleQuoted !== undefined) return `${key}${separator}"[redacted:assignment]"`;
      if (singleQuoted !== undefined) return `${key}${separator}'[redacted:assignment]'`;
      return `${key}${separator}[redacted:assignment]`;
    },
  },
];

export type Redacted = { text: string; count: number };

export function redact(text: string): Redacted {
  let out = text;
  let count = 0;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern.regex, (match: string, ...rest: unknown[]) => {
      if (match.includes("[redacted:")) return match;
      count += 1;
      const groups = rest.slice(0, -2) as string[];
      return pattern.replace ? pattern.replace(match, ...groups) : `[redacted:${pattern.kind}]`;
    });
  }
  return { text: out, count };
}

/** Redacts every string inside a JSON value. */
export function redactJson<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return walk(value) as T;
}
