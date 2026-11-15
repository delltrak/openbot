import { isLocalNetworkHostname, isOpenBotCloudHostname } from "@openbot/contracts/local-network";

const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function remembered(sources: string[], source: string): void {
  if (!sources.includes(source)) sources.push(source);
}

function addSources(target: string[], extra: readonly string[]): void {
  for (const source of extra) remembered(target, source);
}

function loopbackSources(schemes: readonly string[]): string[] {
  const hosts = ["127.0.0.1", "[::1]", "*.local"];
  return hosts.flatMap((host) => schemes.map((scheme) => `${scheme}://${host}:*`));
}

function bracketHost(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function staticPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host.endsWith(".local");
}

/** The origin and port wildcards of one local-network URL. A cloud host or a public host adds nothing. */
function localServiceSources(value: string | undefined): string[] {
  if (!value) return [];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  if (url.username !== "" || url.password !== "") return [];
  if (!WEB_PROTOCOLS.has(url.protocol)) return [];
  if (isOpenBotCloudHostname(url.hostname) || !isLocalNetworkHostname(url.hostname)) return [];
  const sources = [url.origin];
  if (!staticPrivateHost(url.hostname)) {
    const host = bracketHost(url.hostname);
    for (const scheme of ["ws", "wss", "http", "https"]) remembered(sources, `${scheme}://${host}:*`);
  }
  return sources;
}

/** A public `wss:` origin. Local and cloud hosts are handled apart from this. */
function publicSignalOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol !== "wss:" || isOpenBotCloudHostname(url.hostname) || isLocalNetworkHostname(url.hostname)) {
    return null;
  }
  return url.origin;
}

export function buildContentSecurityPolicy(
  packaged: boolean,
  developmentSignalUrl?: string,
  selfHostedSignalOrigin?: string | null,
  accountApiUrl?: string,
): string {
  // Loopback, `.local`, and a configured private-network host. No `openbot.run` host.
  const connect = [
    "'self'",
    "openbot-attachment:",
    "openbot-remote-attachment:",
    ...loopbackSources(["ws", "wss", "http", "https"]),
  ];
  const signalOrigin = publicSignalOrigin(selfHostedSignalOrigin);
  if (signalOrigin) remembered(connect, signalOrigin);
  addSources(connect, localServiceSources(selfHostedSignalOrigin ?? undefined));
  addSources(connect, localServiceSources(accountApiUrl));
  if (!packaged) {
    addSources(connect, ["http://localhost:*", "https://localhost:*", "ws://localhost:*", "wss://localhost:*"]);
    addSources(connect, localServiceSources(developmentSignalUrl));
  }

  const frames = [
    "'self'",
    "openbot-attachment:",
    "openbot-remote-attachment:",
    "openbot-visual:",
    "openbot-remote-visual:",
    ...loopbackSources(["http", "https"]),
    "http://localhost:*",
    "https://localhost:*",
  ];
  for (const source of [
    ...localServiceSources(accountApiUrl),
    ...localServiceSources(selfHostedSignalOrigin ?? undefined),
  ]) {
    if (source.startsWith("http://") || source.startsWith("https://")) remembered(frames, source);
  }

  const developmentImageSources = packaged ? "" : " http://127.0.0.1:* http://localhost:*";

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: openbot-attachment: openbot-remote-attachment: openbot-avatar: openbot-remote-avatar: openbot-server-logo: openbot-remote-server-logo: https:${developmentImageSources}`,
    "font-src 'self' data:",
    // The lightbox plays a recording from the attachment scheme, and the preview panel plays one
    // from an object URL of the bytes that the main process sent. Neither matches `default-src`.
    "media-src 'self' blob: openbot-attachment: openbot-remote-attachment:",
    `connect-src ${connect.join(" ")}`,
    "object-src 'none'",
    // The remote desktop viewer uses a loopback proxy in packaged apps too.
    `frame-src ${frames.join(" ")}`,
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The Signal origin of a self-hosted account service. The account service still chooses the URL in
 * each ticket; this only lets the peer window open it. It needs `OPENBOT_AUTH_API_URL`, because a
 * cloud account service is not used. An OpenBot cloud host is refused.
 */
export function readSelfHostedSignalOrigin(
  authApiUrl: string | undefined,
  signalUrl: string | undefined,
): string | null {
  if (!signalUrl) return null;
  if (!authApiUrl?.trim()) throw new Error("OPENBOT_REMOTE_SIGNAL_URL needs OPENBOT_AUTH_API_URL.");
  let url: URL;
  try {
    url = new URL(signalUrl);
  } catch {
    throw new Error("OPENBOT_REMOTE_SIGNAL_URL must be a wss: URL without credentials.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("OPENBOT_REMOTE_SIGNAL_URL must be a wss: URL without credentials.");
  }
  if (isOpenBotCloudHostname(url.hostname)) {
    throw new Error("OPENBOT_REMOTE_SIGNAL_URL must not name an OpenBot cloud host.");
  }
  const local = isLocalNetworkHostname(url.hostname);
  const portable =
    url.protocol === "ws:" || url.protocol === "wss:" || url.protocol === "http:" || url.protocol === "https:";
  if (local && portable) return url.origin;
  if (url.protocol === "wss:") return url.origin;
  throw new Error("OPENBOT_REMOTE_SIGNAL_URL must be a wss: URL without credentials.");
}
