import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneBackups } from "../../src/ops/backup.js";
import { cronLine, scheduleFiles } from "../../src/ops/schedule.js";

const s = {
  nodePath: "/usr/bin/node",
  cliPath: "/opt/morfeu/dist/cli.js",
  home: "/home/alex",
  path: "/home/alex/.orbstack/bin:/usr/bin",
};

describe("schedule", () => {
  it("writes a launchd agent on macOS", () => {
    const [plist] = scheduleFiles({ ...s, platform: "darwin" });
    expect(plist?.path).toBe("/home/alex/Library/LaunchAgents/io.github.morfeu.run.plist");
    expect(plist?.content).toContain("<string>/opt/morfeu/dist/cli.js</string><string>run</string>");
    expect(plist?.content).toContain("<key>Hour</key><integer>4</integer>");
    // launchd starts jobs with /usr/bin:/bin only; docker lives elsewhere.
    expect(plist?.content).toContain("<key>PATH</key><string>/home/alex/.orbstack/bin:/usr/bin:/opt/homebrew/bin");
  });

  it("writes a systemd user service and timer on Linux", () => {
    const files = scheduleFiles({ ...s, platform: "linux" });
    expect(files.map((f) => f.path.split("/").pop())).toEqual(["morfeu-run.service", "morfeu-run.timer"]);
    expect(files[0]?.content).toContain("ExecStart=/usr/bin/node /opt/morfeu/dist/cli.js run");
    expect(files[1]?.content).toContain("OnCalendar=*-*-* 04:30:00");
    expect(files[0]?.content).toContain('Environment="PATH=/home/alex/.orbstack/bin:/usr/bin:');
  });

  it("falls back to a crontab line elsewhere", () => {
    expect(scheduleFiles({ ...s, platform: "freebsd" })).toEqual([]);
    expect(cronLine({ ...s, platform: "freebsd" })).toBe('30 4 * * * "/usr/bin/node" "/opt/morfeu/dist/cli.js" run');
  });
});

describe("backup pruning", () => {
  it("keeps the newest dumps and never touches other files", () => {
    const dir = mkdtempSync(join(tmpdir(), "morfeu-backups-"));
    for (let day = 1; day <= 5; day++) writeFileSync(join(dir, `morfeu-2026-03-0${day}T00-00-00-000Z.dump`), "");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(pruneBackups(dir, 2)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([
      "morfeu-2026-03-04T00-00-00-000Z.dump",
      "morfeu-2026-03-05T00-00-00-000Z.dump",
      "notes.txt",
    ]);
  });
});
