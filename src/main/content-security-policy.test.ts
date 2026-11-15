import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, readSelfHostedSignalOrigin } from "./content-security-policy";

const PACKAGED_CONNECT =
  "connect-src 'self' openbot-attachment: openbot-remote-attachment: ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:* https://127.0.0.1:* ws://[::1]:* wss://[::1]:* http://[::1]:* https://[::1]:* ws://*.local:* wss://*.local:* http://*.local:* https://*.local:*";

const FRAME_SRC =
  "frame-src 'self' openbot-attachment: openbot-remote-attachment: openbot-visual: openbot-remote-visual: http://127.0.0.1:* https://127.0.0.1:* http://[::1]:* https://[::1]:* http://*.local:* https://*.local:* http://localhost:* https://localhost:*";

describe("buildContentSecurityPolicy", () => {
  it("allows loopback and private DNS, and no OpenBot cloud host", () => {
    const policy = buildContentSecurityPolicy(true);
    const connect = policy.split("; ").find((directive) => directive.startsWith("connect-src "));

    expect(connect).toBe(PACKAGED_CONNECT);
    expect(connect).not.toContain("localhost");
    expect(policy).not.toContain("openbot.run");
    expect(policy).not.toContain("https://analytics.openbot.run");
    expect(policy).not.toContain("wss://*.openbot.run");
  });

  it.each([true, false])("allows loopback viewer frames when packaged=%s", (packaged) => {
    const directives = buildContentSecurityPolicy(packaged).split("; ");
    expect(directives.find((directive) => directive.startsWith("frame-src "))).toBe(FRAME_SRC);
    expect(directives.find((directive) => directive.startsWith("script-src "))).toBe("script-src 'self'");
  });

  it("lets the renderer play an attachment recording, but only from the attachment schemes", () => {
    const policy = buildContentSecurityPolicy(true);

    expect(policy).toContain("media-src 'self' blob: openbot-attachment: openbot-remote-attachment:");
    expect(policy).not.toContain("media-src 'self' blob: openbot-attachment: openbot-remote-attachment: https:");
  });

  it("keeps local development sources", () => {
    const policy = buildContentSecurityPolicy(false, "ws://192.168.1.143:3101/v1/signal");

    expect(policy).toContain("http://localhost:*");
    expect(policy).toContain("ws://localhost:*");
    expect(policy).toContain("ws://192.168.1.143:3101");
    expect(policy).toContain("wss://192.168.1.143:*");
  });

  it("does not add public or production Signal origins through the development option", () => {
    expect(buildContentSecurityPolicy(false, "ws://signal.example.com/v1/signal")).not.toContain(
      "ws://signal.example.com",
    );
    expect(buildContentSecurityPolicy(true, "ws://192.168.1.143:3101/v1/signal")).not.toContain(
      "ws://192.168.1.143:3101",
    );
  });

  it("allows a configured private-network host and drops a cloud account host", () => {
    const connect = buildContentSecurityPolicy(true, undefined, null, "http://192.168.1.143:3100")
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "));

    expect(connect).toContain("ws://192.168.1.143:*");
    expect(connect).toContain("https://192.168.1.143:*");
    expect(connect).not.toContain("localhost");
    expect(buildContentSecurityPolicy(true, undefined, null, "https://api.openbot.run")).not.toContain("openbot.run");
  });

  it("adds only the origin of a self-hosted Signal to connect-src", () => {
    const origin = readSelfHostedSignalOrigin("https://api.example.com", "wss://signal.example.com:8443/v1/signal");
    const connect = buildContentSecurityPolicy(true, undefined, origin)
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "));

    expect(origin).toBe("wss://signal.example.com:8443");
    expect(connect).toContain(" wss://signal.example.com:8443");
    expect(connect).not.toContain("openbot.run");
    expect(readSelfHostedSignalOrigin(undefined, undefined)).toBeNull();
    expect(readSelfHostedSignalOrigin("http://192.168.1.143:3100", "ws://192.168.1.143:3101/v1/signal")).toBe(
      "ws://192.168.1.143:3101",
    );
  });

  it.each([
    [undefined, "wss://signal.example.com/v1/signal", "OPENBOT_REMOTE_SIGNAL_URL needs OPENBOT_AUTH_API_URL."],
    ["https://api.example.com", "ws://signal.example.com/v1/signal", "must be a wss: URL"],
    ["https://api.example.com", "https://signal.example.com/v1/signal", "must be a wss: URL"],
    ["https://api.example.com", "wss://user:pass@signal.example.com/v1/signal", "must be a wss: URL"],
    ["https://api.example.com", "wss://signal.openbot.run/v1/signal", "must not name an OpenBot cloud host."],
  ])("refuses a self-hosted Signal URL with auth API %s and Signal %s", (authApiUrl, signalUrl, message) => {
    expect(() => readSelfHostedSignalOrigin(authApiUrl, signalUrl)).toThrow(message);
  });
});
