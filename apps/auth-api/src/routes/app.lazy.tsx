import { AppLoadingShell } from "@openbot/ui/features/account/AppLoadingShell";
import { createLazyFileRoute } from "@tanstack/solid-router";
import { createSignal, Loading, lazy, onSettled, Show } from "solid-js";
import { showSavedAppearance } from "../../../../src/renderer/src/features/web-client/web-appearance-preference";

const loadWebApp = () => import("@openbot/renderer-web");
// The saved language loads with the code, so the first screen is not English for a moment. If it
// fails, the web client starts in English and tries again when it shows the language.
const WebApp = lazy(() =>
  loadWebApp().then((module) =>
    module
      .loadSavedLanguage()
      .catch(() => undefined)
      .then(() => ({ default: module.WebApp })),
  ),
);

export const Route = createLazyFileRoute("/app")({ component: BrowserAppPage });
function BrowserAppPage() {
  const [mounted, setMounted] = createSignal(false);
  // Start loading the browser client after hydration and apply the saved theme to the fallback.
  onSettled(() => {
    showSavedAppearance();
    setMounted(true);
  });
  const fallback = () => (
    <div class="web-app">
      <AppLoadingShell />
    </div>
  );
  return (
    <div id="root">
      <Show when={mounted()} fallback={fallback()}>
        <Loading fallback={fallback()}>
          <WebApp />
        </Loading>
      </Show>
    </div>
  );
}
