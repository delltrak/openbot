import { z } from "zod";
import { advertisedJsonSchema } from "./agent/advertised-json-schema";

/** Dynamic-tool namespace for a phone that is plugged into this computer. */
export const OPENBOT_ADB_NAMESPACE = "openbot_adb";

const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/u;
const serial = z
  .string()
  .trim()
  .regex(SERIAL)
  .describe("The serial from openbot_adb.devices. Omit it when only one phone is authorized.")
  .optional();
const remotePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => value.startsWith("/") && !value.includes("\0") && !/[\r\n]/u.test(value))
  .describe("An absolute path on the phone, such as /sdcard/Download/app.apk.");
const localPath = z.string().trim().min(1).max(4096).describe("A file in this agent's workspace or in OpenBot Shared.");

const shellTimeout = z.number().int().min(1_000).max(120_000).optional();
const transferTimeout = z.number().int().min(1_000).max(300_000).optional();

function adbTool<const Name extends string, Schema extends z.ZodType>(definition: {
  name: Name;
  description: string;
  schema: Schema;
}) {
  return definition;
}

export const adbDevicesSchema = z.strictObject({});
export const adbShellSchema = z.strictObject({
  serial,
  args: z.array(z.string().min(1).max(2_000)).min(1).max(40),
  timeoutMs: shellTimeout.describe("How long to wait, in milliseconds. The default is 30 seconds."),
});
export const adbInstallSchema = z.strictObject({
  serial,
  path: localPath.describe("The APK in this agent's workspace or in OpenBot Shared."),
  timeoutMs: transferTimeout.describe("How long to wait, in milliseconds. The default is 3 minutes."),
});
export const adbPushSchema = z.strictObject({
  serial,
  path: localPath,
  remotePath,
  timeoutMs: transferTimeout.describe("How long to wait, in milliseconds. The default is 2 minutes."),
});
export const adbPullSchema = z.strictObject({
  serial,
  remotePath,
  path: localPath.describe("The destination file in this agent's workspace or in OpenBot Shared."),
  timeoutMs: transferTimeout.describe("How long to wait, in milliseconds. The default is 2 minutes."),
});
export const adbScreencapSchema = z.strictObject({
  serial,
  path: localPath.describe("The PNG to write. Omit it to write adb-screen.png in the workspace.").optional(),
});
export const adbLogcatSchema = z.strictObject({
  serial,
  lines: z.number().int().min(1).max(500).describe("How many recent lines to return. The default is 80.").optional(),
  filter: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n\0]/u.test(value))
    .describe("A logcat filter, such as ActivityManager:I *:S.")
    .optional(),
});

export const ADB_TOOL_DEFINITIONS = [
  adbTool({
    name: "devices",
    description:
      "List Android phones that adb sees on this computer. Each entry has a serial and a state: device means USB debugging is authorized. Call this before the other openbot_adb tools.",
    schema: adbDevicesSchema,
  }),
  adbTool({
    name: "shell",
    description:
      'Run one program on an authorized Android phone. args is the program and its arguments, such as ["pm", "list", "packages"]. The first argument is the program name. This does not run a shell on the computer. The phone must be plugged in, or already paired for wireless debugging by the user.',
    schema: adbShellSchema,
  }),
  adbTool({
    name: "install",
    description:
      "Install an APK from this agent's workspace or OpenBot Shared onto an authorized Android phone. Replaces an installed package with the same name.",
    schema: adbInstallSchema,
  }),
  adbTool({
    name: "push",
    description: "Copy a file from this agent's workspace or OpenBot Shared onto an authorized Android phone.",
    schema: adbPushSchema,
  }),
  adbTool({
    name: "pull",
    description:
      "Copy a file from an authorized Android phone into this agent's workspace or OpenBot Shared. The destination folder must already exist.",
    schema: adbPullSchema,
  }),
  adbTool({
    name: "screencap",
    description:
      "Save a PNG screenshot of an authorized Android phone into this agent's workspace. The result is the file path, not the image bytes.",
    schema: adbScreencapSchema,
  }),
  adbTool({
    name: "logcat",
    description:
      "Read the recent Android log from an authorized phone. The result is text, limited to the requested lines.",
    schema: adbLogcatSchema,
  }),
] as const;

export type AdbToolName = (typeof ADB_TOOL_DEFINITIONS)[number]["name"];

export const ADB_DYNAMIC_TOOLS = [
  {
    type: "namespace" as const,
    name: OPENBOT_ADB_NAMESPACE,
    description: "Control an Android phone that is plugged into this computer, through adb.",
    tools: ADB_TOOL_DEFINITIONS.map((definition) => ({
      type: "function" as const,
      name: definition.name,
      description: definition.description,
      inputSchema: advertisedJsonSchema(definition.schema),
    })),
  },
];
