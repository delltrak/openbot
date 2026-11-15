import { isOpenBotCloudUrl } from "@openbot/contracts/local-network";
import { createOpenBotLogger } from "@openbot/logging";
import { shell } from "electron";

const logger = createOpenBotLogger("open-external");

/**
 * Opens a page in the system browser.
 * A host on `openbot.run` is refused, so a menu or a chat link cannot reach that site.
 */
export function openExternal(url: string): Promise<void> {
  if (isOpenBotCloudUrl(url)) {
    logger.warn("Refused a page on an OpenBot cloud host.");
    return Promise.resolve();
  }
  return shell.openExternal(url);
}
