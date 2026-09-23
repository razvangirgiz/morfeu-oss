import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platformDirs } from "../config/paths.js";

/**
 * Runs `morfeu run` (ingest, extract, dream, reindex, backup) once a day, with
 * the platform's own scheduler: a launchd agent on macOS, a systemd user timer
 * on Linux. Elsewhere, `morfeu schedule show` prints a crontab line instead.
 */

const LABEL = "io.github.morfeu.run";
const UNIT = "morfeu-run";

export type Schedule = {
  /** PATH for the job. Schedulers start jobs with a minimal PATH that misses docker and node. */
  path?: string;
  platform: NodeJS.Platform;
  nodePath: string;
  cliPath: string;
  home?: string;
  hour?: number;
  minute?: number;
};

export type ScheduleResult = { installed: boolean; files: string[]; detail: string };

export function scheduleFiles(s: Schedule): { path: string; content: string }[] {
  const home = s.home ?? homedir();
  const hour = s.hour ?? 4;
  const minute = s.minute ?? 30;
  const logs = platformDirs(process.env, s.platform, home).logs;
  const path = jobPath(s);
  if (s.platform === "darwin") {
    return [
      {
        path: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(s.nodePath)}</string><string>${xml(s.cliPath)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(join(logs, "run.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "run.log"))}</string>
</dict>
</plist>
`,
      },
    ];
  }
  if (s.platform === "linux") {
    const dir = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user");
    return [
      {
        path: join(dir, `${UNIT}.service`),
        content: `[Unit]
Description=morfeu: ingest, extract and consolidate memories

[Service]
Type=oneshot
Environment="PATH=${path}"
ExecStart=${systemdQuote(s.nodePath)} ${systemdQuote(s.cliPath)} run
`,
      },
      {
        path: join(dir, `${UNIT}.timer`),
        content: `[Unit]
Description=Run morfeu daily

[Timer]
OnCalendar=*-*-* ${pad(hour)}:${pad(minute)}:00
Persistent=true

[Install]
WantedBy=timers.target
`,
      },
    ];
  }
  return [];
}

export function cronLine(s: Schedule): string {
  return `${s.minute ?? 30} ${s.hour ?? 4} * * * "${s.nodePath}" "${s.cliPath}" run`;
}

export function installSchedule(s: Schedule): ScheduleResult {
  const files = scheduleFiles(s);
  if (files.length === 0)
    return { installed: false, files: [], detail: `add this line to your crontab:\n${cronLine(s)}` };
  mkdirSync(platformDirs(process.env, s.platform, s.home ?? homedir()).logs, { recursive: true });
  for (const f of files) {
    mkdirSync(join(f.path, ".."), { recursive: true });
    writeFileSync(f.path, f.content);
  }
  const activate =
    s.platform === "darwin"
      ? [
          ["launchctl", ["unload", files[0]!.path]],
          ["launchctl", ["load", "-w", files[0]!.path]],
        ]
      : [
          ["systemctl", ["--user", "daemon-reload"]],
          ["systemctl", ["--user", "enable", "--now", `${UNIT}.timer`]],
        ];
  for (const [cmd, args] of activate as [string, string[]][]) spawnSync(cmd, args, { stdio: "ignore" });
  return {
    installed: true,
    files: files.map((f) => f.path),
    detail: `morfeu runs daily at ${pad(s.hour ?? 4)}:${pad(s.minute ?? 30)}`,
  };
}

export function removeSchedule(s: Schedule): ScheduleResult {
  const files = scheduleFiles(s).filter((f) => existsSync(f.path));
  if (s.platform === "darwin" && files[0]) spawnSync("launchctl", ["unload", files[0].path], { stdio: "ignore" });
  if (s.platform === "linux" && files.length)
    spawnSync("systemctl", ["--user", "disable", "--now", `${UNIT}.timer`], { stdio: "ignore" });
  for (const f of files) rmSync(f.path);
  return {
    installed: false,
    files: files.map((f) => f.path),
    detail: files.length ? "schedule removed" : "no schedule was installed",
  };
}

export function scheduleInstalled(s: Schedule): boolean {
  const files = scheduleFiles(s);
  return files.length > 0 && files.every((f) => existsSync(f.path));
}

/**
 * The PATH the job runs with: the one `schedule install` ran under (where the
 * user's docker and pg_dump are found), plus common install locations.
 */
function jobPath(s: Schedule): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const parts = [...(s.path ?? process.env.PATH ?? "").split(":"), ...extra].filter(Boolean);
  return [...new Set(parts)].join(":");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function systemdQuote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
