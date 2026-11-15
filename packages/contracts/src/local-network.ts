import { isMobileConnectDevelopmentHost } from "./mobile-connect";

/**
 * Whether this hostname belongs to OpenBot's public site.
 * `openbot.run` and every subdomain are cloud. A local install never contacts them.
 */
export function isOpenBotCloudHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "openbot.run" || host.endsWith(".openbot.run");
}

/** Whether a URL names `openbot.run` or one of its subdomains. An unparseable value is not a cloud URL. */
export function isOpenBotCloudUrl(value: string): boolean {
  try {
    return isOpenBotCloudHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether this hostname is on the machine or on a private network.
 * Loopback, RFC1918, link-local, Tailscale (100.64.0.0/10), IPv6 ULA, and `.local`.
 */
export function isLocalNetworkHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host || isOpenBotCloudHostname(host)) return false;
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isMobileConnectDevelopmentHost(host)) return true;
  if (isIpv4(host)) {
    const [first, second] = host.split(".").map(Number);
    if (first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 100 && second !== undefined && second >= 64 && second <= 127) return true;
    return false;
  }
  if (!host.includes(":")) return false;
  const head = Number.parseInt(host.split(":")[0] || "0", 16);
  if (!Number.isFinite(head)) return false;
  // fc00::/7 and fe80::/10.
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80;
}

/**
 * An account or Signal URL this build may use.
 * It must be a local or private origin, and it must not be an OpenBot cloud host.
 */
export function isLocalOpenBotServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "wss:" && url.protocol !== "ws:") {
      return false;
    }
    return isLocalNetworkHostname(url.hostname);
  } catch {
    return false;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/u, "");
}

function isIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) return false;
  return octets.map(Number).every((value) => value >= 0 && value <= 255);
}
