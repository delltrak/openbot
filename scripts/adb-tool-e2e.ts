// Drives the real adb runner against a fake adb program. It checks the device list, a shell argv
// that is not a host shell, a refused path, a pull that stays in the workspace, a screenshot file,
// a missing adb, a workspace-only agent, and a shared chat. No phone and no provider are used.
// `bun scripts/adb-tool-e2e.ts`. Writes .openbot-build/adb-tool-e2e/report.json.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { runAdbTool } from "../src/backend/adb-runner";

const OUT = resolve(import.meta.dirname, "../.openbot-build/adb-tool-e2e");
const checks: string[] = [];

const root = await mkdtemp(join(tmpdir(), "openbot-adb-e2e-"));
const workspace = join(root, "workspace");
const shared = join(root, "shared");
const adbLog = join(root, "argv.log");
const adbPath = join(root, "adb");
await mkdir(workspace, { recursive: true });
await mkdir(shared, { recursive: true });
await writeFile(
  adbPath,
  `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const log = process.env.ADB_ARGV_LOG;
const args = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + "\\n");
const mode = process.env.ADB_FAKE ?? "";
if (args[0] === "devices") {
  if (mode === "unauthorized") {
    process.stdout.write("List of devices attached\\nR3CT1234           unauthorized\\n");
  } else {
    process.stdout.write("List of devices attached\\nemulator-5554          device product:sdk model:Test_Phone device:emu transport_id:1\\n");
  }
  process.exit(0);
}
if (args[0] === "-s" && args[1] === "emulator-5554" && args[2] === "shell") {
  process.stdout.write(args.slice(3).join(" ") + "\\n");
  process.exit(mode === "exit1" ? 1 : 0);
}
if (args[0] === "-s" && args[2] === "pull") {
  writeFileSync(args[4], "from-device\\n");
  process.stdout.write("pull ok\\n");
  process.exit(0);
}
if (args[0] === "-s" && args[2] === "exec-out") {
  process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  process.exit(0);
}
if (args[0] === "-s" && (args[2] === "install" || args[2] === "push" || args[2] === "logcat")) {
  process.stdout.write(args[2] + " ok\\n");
  process.exit(0);
}
process.stderr.write("unexpected\\n");
process.exit(2);
`,
  "utf8",
);
await chmod(adbPath, 0o755);

const agent = {
  id: "agent-1",
  access: "full" as const,
  workspacePath: workspace,
  additionalFolders: [],
};

async function run(tool: string, args: unknown, patch: Partial<Parameters<typeof runAdbTool>[0]> = {}) {
  return Effect.runPromise(
    Effect.result(
      runAdbTool({
        tool,
        arguments: args,
        agent,
        sharedRoot: shared,
        audience: "local",
        adbPath,
        ...patch,
      }),
    ),
  );
}

function value(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(Result.isSuccess(result), true);
  if (Result.isFailure(result)) throw new Error("unreachable");
  return result.success;
}

function message(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(Result.isFailure(result), true);
  if (Result.isSuccess(result)) throw new Error("unreachable");
  const cause = result.failure.cause;
  assert.ok(cause instanceof Error);
  return cause.message;
}

process.env.ADB_ARGV_LOG = adbLog;
delete process.env.ADB_FAKE;

const devices = value(await run("devices", {}));
if (!("devices" in devices)) throw new Error("expected a device list");
assert.equal(devices.devices[0]?.serial, "emulator-5554");
assert.equal(devices.devices[0]?.state, "device");
assert.equal(devices.devices[0]?.model, "Test_Phone");
checks.push("devices");

const pwned = join(root, "pwned");
const shell = value(await run("shell", { args: ["echo", `$(touch ${pwned})`] }));
if (!("stdout" in shell)) throw new Error("expected shell output");
assert.equal(shell.exitCode, 0);
assert.match(shell.stdout, /\$\(touch /u);
assert.equal(
  await stat(pwned).then(
    () => true,
    () => false,
  ),
  false,
);
const logged = await readFile(adbLog, "utf8");
assert.match(logged, /\$\(touch /u);
assert.equal(logged.includes("sh -c"), false);
checks.push("shell-argv");

process.env.ADB_FAKE = "exit1";
const failed = value(await run("shell", { args: ["grep", "missing"] }));
if (!("exitCode" in failed)) throw new Error("expected an exit code");
assert.equal(failed.exitCode, 1);
delete process.env.ADB_FAKE;
checks.push("shell-exit");

const outside = join(root, "outside.apk");
await writeFile(outside, "not-an-apk");
const refused = message(await run("install", { path: outside }));
assert.match(refused, /workspace/u);
const afterRefuse = await readFile(adbLog, "utf8");
assert.equal(afterRefuse.includes("install"), false);
checks.push("install-outside");

const pulled = value(await run("pull", { remotePath: "/sdcard/from-device.txt", path: "from-device.txt" }));
if (!("path" in pulled)) throw new Error("expected a pulled file");
assert.equal(await readFile(pulled.path, "utf8"), "from-device\n");
assert.equal(pulled.path.startsWith(await realpath(workspace)), true);
const escaped = message(await run("pull", { remotePath: "/sdcard/x", path: "../escaped.txt" }));
assert.match(escaped, /workspace|folder/u);
assert.equal(
  await stat(join(root, "escaped.txt")).then(
    () => true,
    () => false,
  ),
  false,
);
checks.push("pull");

const shot = value(await run("screencap", {}));
if (!("bytes" in shot)) throw new Error("expected a screenshot");
const png = await readFile(shot.path);
assert.equal(png[0], 0x89);
assert.equal(png.length, shot.bytes);
assert.equal(shot.path.endsWith("adb-screen.png"), true);
checks.push("screencap");

process.env.ADB_FAKE = "unauthorized";
const unauthorized = message(await run("shell", { args: ["ls"] }));
assert.match(unauthorized, /not authorized/u);
delete process.env.ADB_FAKE;
checks.push("unauthorized");

const workspaceOnly = message(await run("devices", {}, { agent: { ...agent, access: "workspace" } }));
assert.match(workspaceOnly, /Full access/u);
checks.push("workspace-access");

const sharedChat = message(await run("devices", {}, { audience: "shared" }));
assert.match(sharedChat, /own OpenBot chat/u);
checks.push("shared-chat");

const missing = message(await run("devices", {}, { adbPath: join(root, "missing-adb") }));
assert.match(missing, /not found/u);
checks.push("missing-adb");

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
await rm(root, { recursive: true, force: true });
