import { AppLogo } from "@openbot/brand";
import { useText } from "../../text";

export function AppLoadingMark() {
  return (
    <div class="app-loading-stage" aria-hidden="true">
      <AppLogo variant="production" class="app-loading-logo" />
      <span class="app-loading-indicator" />
    </div>
  );
}

/** The startup screen rendered while the web client's code loads. */
export function AppLoadingShell() {
  const { t } = useText();
  return (
    <main class="app-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="sr-only">{t("webClient.loading")}</span>
      <AppLoadingMark />
    </main>
  );
}
