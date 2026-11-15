import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { type AgentSummary, workspaceAccessEnforced } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import type { z } from "zod";
import {
  adbDevicesSchema,
  adbInstallSchema,
  adbLogcatSchema,
  adbPullSchema,
  adbPushSchema,
  adbScreencapSchema,
  adbShellSchema,
} from "./adb-tools";
import { isWithin, sharedPathFromInput, workspacePathFromInput } from "./workspace-paths";

const logger = createOpenBotLogger("adb-runner");

/** Text returned to the agent from one adb stream. */
const OUTPUT_CAP = 64 * 1024;
/** A screenshot above this size is not written. */
const SCREEN_CAP = 8_000_000;
/** An APK or a pushed file above this size is refused. */
const FILE_CAP = 512 * 1024 * 1024;

const DEFAULT_TIMEOUT = {
  devices: 15_000,
  shell: 30_000,
  install: 180_000,
  push: 120_000,
  pull: 120_000,
  screencap: 20_000,
  logcat: 20_000,
} as const;

export class AdbFailed extends Schema.TaggedError<AdbFailed>()("AdbFailed", {
  cause: Schema.Defect(),
}) {}

export interface AdbToolRequest {
  tool: string;
  arguments: unknown;
  agent: Pick<AgentSummary, "id" | "access" | "workspacePath" | "additionalFolders">;
  sharedRoot: string;
  /** `shared` is a channel or an external chat. adb stays in the owner's own chat. */
  audience: "local" | "shared";
  /** Set by a test. Absent uses the Android SDK or `adb` on PATH. */
  adbPath?: string | undefined;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
  timedOut: boolean;
}

interface ListedDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
}

const fail = (message: string) => Effect.fail(new AdbFailed({ cause: new Error(message) }));

const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new AdbFailed({ cause }) });

/**
 * Runs one built-in adb tool. The child is `adb` itself: no shell on this computer sees the arguments.
 * A file it reads or writes stays in the agent workspace, OpenBot Shared, or a folder the user added.
 */
export const runAdbTool = Effect.fn("AdbTool.run")(function* (request: AdbToolRequest) {
  if (request.audience === "shared") return yield* fail("adb works only in this computer's own OpenBot chat.");
  if (workspaceAccessEnforced(request.agent))
    return yield* fail("adb needs Full access. The user turns that on for this agent.");
  let command: string;
  try {
    command = adbCommand(request.adbPath);
  } catch (cause) {
    return yield* fail(cause instanceof Error ? cause.message : "adb was not found.");
  }
  switch (request.tool) {
    case "devices": {
      yield* readArgs(adbDevicesSchema, request.arguments);
      return yield* listDevices(command);
    }
    case "shell": {
      const args = yield* readArgs(adbShellSchema, request.arguments);
      const serial = yield* chooseSerial(command, args.serial);
      return yield* runShell(command, serial, args);
    }
    case "install": {
      const args = yield* readArgs(adbInstallSchema, request.arguments);
      // A path outside the workspace must not start adb.
      const path = yield* resolveFile(request, args.path);
      const serial = yield* chooseSerial(command, args.serial);
      return yield* runInstall(command, serial, path, args.timeoutMs);
    }
    case "push": {
      const args = yield* readArgs(adbPushSchema, request.arguments);
      const path = yield* resolveFile(request, args.path);
      const serial = yield* chooseSerial(command, args.serial);
      return yield* runPush(command, serial, path, args.remotePath, args.timeoutMs);
    }
    case "pull": {
      const args = yield* readArgs(adbPullSchema, request.arguments);
      const path = yield* resolveNewFile(request, args.path);
      const serial = yield* chooseSerial(command, args.serial);
      return yield* runPull(command, serial, path, args.remotePath, args.timeoutMs);
    }
    case "screencap": {
      const args = yield* readArgs(adbScreencapSchema, request.arguments);
      const path = yield* resolveNewFile(request, args.path ?? "adb-screen.png");
      const serial = yield* chooseSerial(command, args.serial);
      return yield* runScreencap(command, serial, path);
    }
    case "logcat": {
      const args = yield* readArgs(adbLogcatSchema, request.arguments);
      const serial = yield* chooseSerial(command, args.serial);
      return yield* runLogcat(command, serial, args.lines, args.filter);
    }
    default:
      return yield* fail("Unknown adb tool.");
  }
});

function readArgs<Schema extends z.ZodType>(schema: Schema, value: unknown) {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join(" ");
    return fail(`The arguments are not valid. ${detail}`);
  }
  return Effect.succeed(parsed.data);
}

function adbCommand(override: string | undefined): string {
  if (override) {
    if (!existsSync(override)) throw new Error("adb was not found. Install Android platform-tools.");
    return override;
  }
  const name = process.platform === "win32" ? "adb.exe" : "adb";
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter((root) => root !== undefined);
  const home = homedir();
  const candidates = [
    ...roots.map((root) => join(root, "platform-tools", name)),
    ...(process.platform === "darwin" ? [join(home, "Library/Android/sdk/platform-tools", name)] : []),
    ...(process.platform === "linux" ? [join(home, "Android/Sdk/platform-tools", name)] : []),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? name;
}

const listDevices = Effect.fn("AdbTool.listDevices")(function* (command: string) {
  const result = yield* checked(command, ["devices", "-l"], DEFAULT_TIMEOUT.devices, OUTPUT_CAP);
  return { devices: parseDevices(clip(result.stdout)) };
});

const chooseSerial = Effect.fn("AdbTool.chooseSerial")(function* (command: string, serial: string | undefined) {
  const listed = yield* listDevices(command);
  const devices = listed.devices;
  const ready = devices.filter((device) => device.state === "device");
  if (serial) {
    const found = devices.find((device) => device.serial === serial);
    if (!found) return yield* fail(`No Android phone has serial ${serial}.`);
    if (found.state !== "device")
      return yield* fail(
        `The phone ${serial} is ${found.state}. Accept the USB debugging prompt on the phone when the state is unauthorized.`,
      );
    return serial;
  }
  const only = ready[0];
  if (ready.length === 1 && only) return only.serial;
  if (ready.length === 0) {
    if (devices.some((device) => device.state === "unauthorized"))
      return yield* fail(
        "The phone is connected, but this computer is not authorized. Accept the USB debugging prompt on the phone.",
      );
    return yield* fail(
      "No Android phone is connected. Plug it in, turn on USB debugging, and accept this computer on the phone.",
    );
  }
  return yield* fail(
    `More than one phone is authorized. Pass serial: ${ready.map((device) => device.serial).join(", ")}.`,
  );
});

const runShell = Effect.fn("AdbTool.shell")(function* (
  command: string,
  serial: string,
  args: z.output<typeof adbShellSchema>,
) {
  const program = args.args[0];
  if (!program || program.startsWith("-"))
    return yield* fail("The first shell argument is the program on the phone, such as pm or ls.");
  const result = yield* spawnAdb(
    command,
    ["-s", serial, "shell", ...args.args],
    args.timeoutMs ?? DEFAULT_TIMEOUT.shell,
    OUTPUT_CAP,
  );
  if (result.timedOut) return yield* fail("adb shell timed out.");
  return { serial, ...streams(result) };
});

const runInstall = Effect.fn("AdbTool.install")(function* (
  command: string,
  serial: string,
  path: string,
  timeoutMs: number | undefined,
) {
  const result = yield* spawnAdb(
    command,
    ["-s", serial, "install", "-r", path],
    timeoutMs ?? DEFAULT_TIMEOUT.install,
    OUTPUT_CAP,
  );
  if (result.timedOut) return yield* fail("adb install timed out.");
  return { serial, path, ...streams(result) };
});

const runPush = Effect.fn("AdbTool.push")(function* (
  command: string,
  serial: string,
  path: string,
  remotePath: string,
  timeoutMs: number | undefined,
) {
  const result = yield* spawnAdb(
    command,
    ["-s", serial, "push", path, remotePath],
    timeoutMs ?? DEFAULT_TIMEOUT.push,
    OUTPUT_CAP,
  );
  if (result.timedOut) return yield* fail("adb push timed out.");
  return { serial, path, remotePath, ...streams(result) };
});

const runPull = Effect.fn("AdbTool.pull")(function* (
  command: string,
  serial: string,
  path: string,
  remotePath: string,
  timeoutMs: number | undefined,
) {
  const result = yield* spawnAdb(
    command,
    ["-s", serial, "pull", remotePath, path],
    timeoutMs ?? DEFAULT_TIMEOUT.pull,
    OUTPUT_CAP,
  );
  if (result.timedOut) return yield* fail("adb pull timed out.");
  return { serial, path, remotePath, ...streams(result) };
});

const runScreencap = Effect.fn("AdbTool.screencap")(function* (command: string, serial: string, path: string) {
  const result = yield* spawnAdb(
    command,
    ["-s", serial, "exec-out", "screencap", "-p"],
    DEFAULT_TIMEOUT.screencap,
    SCREEN_CAP,
  );
  if (result.timedOut) return yield* fail("adb screencap timed out.");
  if (result.truncated) return yield* fail("The screenshot was too large.");
  if (result.exitCode !== 0) return yield* fail(streams(result).stderr || "adb screencap failed.");
  yield* io(() => writeFile(path, result.stdout, { mode: 0o600 }));
  return { serial, path, bytes: result.stdout.length };
});

const runLogcat = Effect.fn("AdbTool.logcat")(function* (
  command: string,
  serial: string,
  lines: number | undefined,
  filter: string | undefined,
) {
  const count = lines ?? 80;
  const result = yield* spawnAdb(
    command,
    ["-s", serial, "logcat", "-d", "-t", String(count), "-v", "brief", ...(filter ? [filter] : [])],
    DEFAULT_TIMEOUT.logcat,
    OUTPUT_CAP,
  );
  if (result.timedOut) return yield* fail("adb logcat timed out.");
  return { serial, ...streams(result) };
});

function streams(result: SpawnResult) {
  return {
    exitCode: result.exitCode,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
    truncated: result.truncated,
  };
}

function clip(buffer: Uint8Array): string {
  const text = Buffer.from(buffer).toString("utf8");
  return text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) : text;
}

const checked = Effect.fn("AdbTool.checked")(function* (
  command: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number,
) {
  const result = yield* spawnAdb(command, args, timeoutMs, maxBytes);
  if (result.timedOut) return yield* fail("adb timed out.");
  if (result.exitCode !== 0) return yield* fail(clip(result.stderr) || clip(result.stdout) || "adb failed.");
  return result;
});

function parseDevices(text: string): ListedDevice[] {
  const devices: ListedDevice[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices") || trimmed.startsWith("*")) continue;
    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(trimmed);
    if (!match?.[1] || !match[2] || !/^[A-Za-z0-9._:-]{1,128}$/u.test(match[1])) continue;
    const details = match[3] ?? "";
    const model = /(?:^|\s)model:(\S+)/u.exec(details)?.[1];
    const product = /(?:^|\s)product:(\S+)/u.exec(details)?.[1];
    devices.push({
      serial: match[1],
      state: match[2],
      ...(model ? { model } : {}),
      ...(product ? { product } : {}),
    });
    if (devices.length >= 32) break;
  }
  return devices;
}

const resolveFile = Effect.fn("AdbTool.resolveFile")(function* (request: AdbToolRequest, inputPath: string) {
  const roots = yield* readableRoots(request);
  for (const candidate of candidatePaths(request, inputPath)) {
    const linked = yield* Effect.result(io(() => lstat(candidate)));
    if (Result.isFailure(linked)) continue;
    if (linked.success.isSymbolicLink()) return yield* fail("The path is a symbolic link.");
    const resolved = yield* Effect.result(io(() => realpath(candidate)));
    if (Result.isFailure(resolved) || !roots.some((root) => isWithin(root, resolved.success))) continue;
    const metadata = yield* io(() => lstat(resolved.success));
    if (!metadata.isFile()) return yield* fail("The path is not a file.");
    if (metadata.size > FILE_CAP) return yield* fail("The file is too large.");
    return resolved.success;
  }
  return yield* fail("The file is not in this agent's workspace or OpenBot Shared.");
});

const resolveNewFile = Effect.fn("AdbTool.resolveNewFile")(function* (request: AdbToolRequest, inputPath: string) {
  const roots = yield* readableRoots(request);
  const candidate = candidatePaths(request, inputPath)[0];
  if (!candidate) return yield* fail("The file is not in this agent's workspace or OpenBot Shared.");
  const name = basename(candidate);
  if (!name || name === "." || name === ".." || name !== basename(name))
    return yield* fail("The file name is not valid.");
  const parent = yield* Effect.result(io(() => realpath(dirname(candidate))));
  if (Result.isFailure(parent)) return yield* fail("Create the folder in the workspace first.");
  const root = roots.find((item) => item === parent.success || isWithin(item, parent.success));
  if (!root) return yield* fail("The file is not in this agent's workspace or OpenBot Shared.");
  const target = join(parent.success, name);
  if (!isWithin(root, target)) return yield* fail("The file is not in this agent's workspace or OpenBot Shared.");
  const existing = yield* Effect.result(io(() => lstat(target)));
  if (Result.isSuccess(existing) && (existing.success.isSymbolicLink() || !existing.success.isFile()))
    return yield* fail("The destination is not a regular file.");
  return target;
});

const readableRoots = Effect.fn("AdbTool.readableRoots")(function* (request: AdbToolRequest) {
  const workspace = yield* Effect.result(io(() => realpath(request.agent.workspacePath)));
  if (Result.isFailure(workspace)) return yield* fail("The agent workspace is not available.");
  const shared = yield* Effect.result(io(() => realpath(request.sharedRoot)));
  if (Result.isFailure(shared)) return yield* fail("OpenBot Shared is not available.");
  const folders = yield* io(async () =>
    (await Promise.allSettled((request.agent.additionalFolders ?? []).map((folder) => realpath(folder)))).flatMap(
      (result) => (result.status === "fulfilled" ? [result.value] : []),
    ),
  );
  return [workspace.success, shared.success, ...folders];
});

function candidatePaths(request: AdbToolRequest, inputPath: string): string[] {
  const value = inputPath.trim();
  const normalized = value.replaceAll("\\", "/");
  const sharedReference = ["~/OpenBot/Shared/", "OpenBot/Shared/", "Shared/"].some((prefix) =>
    normalized.startsWith(prefix),
  );
  if (isAbsolute(value)) return [value];
  if (sharedReference) return [sharedPathFromInput(request.sharedRoot, value)];
  return [
    workspacePathFromInput(request.agent.workspacePath, request.agent.id, value),
    sharedPathFromInput(request.sharedRoot, value),
  ];
}

function spawnAdb(command: string, args: string[], timeoutMs: number, maxBytes: number) {
  return Effect.callback<SpawnResult, AdbFailed>((resume, signal) => {
    let stdout: Uint8Array = Buffer.alloc(0);
    let stderr: Uint8Array = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process can already be gone.
      }
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const take = (current: Uint8Array, chunk: Uint8Array): Uint8Array => {
      if (current.length >= maxBytes) {
        truncated = true;
        stop();
        return current;
      }
      const room = maxBytes - current.length;
      const next = Buffer.concat([current, chunk.subarray(0, room)]);
      if (chunk.length > room) truncated = true;
      return next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = take(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (missing) logger.warn("adb is not installed");
      resume(
        Effect.fail(
          new AdbFailed({
            cause: missing
              ? new Error("adb is not installed. Install Android platform-tools, or set ANDROID_HOME.")
              : error,
          }),
        ),
      );
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal.aborted) return;
      resume(Effect.succeed({ exitCode, stdout, stderr, truncated, timedOut }));
    });
    return Effect.sync(stop);
  });
}
