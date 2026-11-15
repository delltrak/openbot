import { isOpenBotCloudHostname } from "@openbot/contracts/local-network";

/** An image address this build may load. A cloud host is refused. `base` resolves a relative address. */
export function localImageUrl(value: string | null | undefined, base?: string): string | null {
  if (!value) return null;
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || isOpenBotCloudHostname(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
