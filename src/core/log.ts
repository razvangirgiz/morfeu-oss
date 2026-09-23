import type { LogLevel } from "../config/config.js";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type Logger = {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
};

/**
 * Diagnostics go to stderr so stdout stays clean for command output and for
 * the MCP stdio transport, which owns stdout entirely.
 */
export function createLogger(level: LogLevel, write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  const at = (msgLevel: LogLevel) => (message: string) => {
    if (ORDER[msgLevel] <= ORDER[level]) write(`morfeu ${msgLevel}: ${message}\n`);
  };
  return { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") };
}

export const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };
