import { isOpenBotCloudHostname } from "@openbot/contracts/local-network";

/** True when this page is served by openbot.run or one of its subdomains. */
export function pageUsesOpenBotCloud(): boolean {
  return isOpenBotCloudHostname(window.location.hostname);
}

/**
 * True when `input` would be sent to openbot.run. A relative URL uses this page's origin.
 * An unparseable value is not treated as a cloud URL.
 */
export function requestTargetsOpenBotCloud(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return isOpenBotCloudHostname(new URL(raw, window.location.href).hostname);
  } catch {
    return false;
  }
}
