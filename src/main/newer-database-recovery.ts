// A newer OpenBot migrated the database, and then an older copy started, for example from an old
// shortcut or a second install (#4969). The older copy cannot read the data, and it must not change
// it. It shows a download dialog and quits. It does not contact a release host.
import type { AppTranslate } from "@openbot/i18n";
import { app, type BrowserWindow, dialog } from "electron";
import { DOWNLOAD_URL } from "./download-url";
import { openExternal } from "./open-external";

const GUIDE_URL =
  "https://github.com/nightly-labs/openbot/blob/main/docs/TROUBLESHOOTING.md#openbot-says-a-newer-version-saved-your-data";

interface NewerDatabaseRecoveryOptions {
  window: BrowserWindow | null;
  translate: AppTranslate;
  /** The start path passes the same shutdown preparation as an in-app update. This copy does not install. */
  beforeInstall: (deadlineMs: number) => Promise<void>;
}

/**
 * Shows the download dialog and quits. The install of a release is off, so this returns after the
 * dialog. `beforeInstall` stays so the start path can pass it.
 */
export async function recoverFromNewerDatabase(options: NewerDatabaseRecoveryOptions): Promise<void> {
  await showUpdateRequired(options.translate);
  app.quit();
}

async function showUpdateRequired(translate: AppTranslate): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: translate("startup.newerDataTitle"),
    detail: translate("startup.newerDataBody", { version: app.getVersion() }),
    buttons: [
      translate("startup.newerDataDownload"),
      translate("startup.newerDataGuide"),
      translate("startup.newerDataQuit"),
    ],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) await openExternal(DOWNLOAD_URL);
  if (response === 1) await openExternal(GUIDE_URL);
}
