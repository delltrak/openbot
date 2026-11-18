import { agentTemplateIdFromWebAppSearch, WEB_APP_AGENT_TEMPLATE_PARAM } from "@openbot/contracts/agent-template-links";
import { inviteUrlFromWebAppSearch, WEB_APP_INVITE_FIELDS } from "@openbot/contracts/invite-links";
import { type CentralAuthUser, isAvatarColor } from "@openbot/contracts/ipc";
import {
  type MarketplaceListingLink,
  marketplaceListingFromWebAppSearch,
  WEB_APP_MARKETPLACE_AGENT_PARAM,
  WEB_APP_MARKETPLACE_SKILL_PARAM,
} from "@openbot/contracts/marketplace-links";
import { pluginSlugFromWebAppSearch, WEB_APP_PLUGIN_PARAM } from "@openbot/contracts/plugin-links";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { formatLocale, resolveLocale } from "@openbot/i18n";
import { markRemoteSync } from "@openbot/team-client/sync-profile";
import { classifyFailure } from "@openbot/telemetry";
import { NotificationObserver, Toaster, toast } from "@openbot/ui";
import { AppLoadingScreen } from "@openbot/ui/features/account/AppLoadingScreen";
import { currentText } from "@openbot/ui/text";
import { Dynamic } from "@solidjs/web";
import { createEffect, createSignal, createStore, onSettled, Show } from "solid-js";
import type { DesktopAnalyticsProperties } from "../../analytics";
import { configureWebReports, reportNotification } from "../../error-reports";
import { StaticI18nProvider } from "../../i18n-context";
import { deleteRemoteWorkspaceFrames } from "../servers/remote-workspace-frame";
import { WindowBackdropBubbles } from "../window/backdrop-bubbles";
import { keepCachedWorkflows } from "../workflows/workflow-cache";
import { pageUsesOpenBotCloud, requestTargetsOpenBotCloud } from "./cloud-page";
import type { WebWorkspace } from "./WebWorkspace";
import { deleteSavedAgentPictures } from "./web-agent-pictures";
import { createWebAppearancePreference } from "./web-appearance-preference";
import { takeWebAppStart, WEB_APP_BILLING_PARAM, type WebAppStart } from "./web-billing";
import { syncWebChatBackground } from "./web-chat-background";
import type { WebRuntimeFactory } from "./web-client-context";
import { takeHostingReturn } from "./web-hosted-servers";
import { createWebLanguagePreference } from "./web-language-preference";

// The site loads this before it mounts `WebApp` (`apps/auth-api/src/routes/app.lazy.tsx`).
export { loadSavedLanguage } from "./web-language-preference";

/**
 * The workspace is its own chunk. Each session check starts it beside the session request.
 * A failed import is tried again on the next check.
 */
let workspaceImport: Promise<typeof WebWorkspace> | null = null;
function loadWorkspace(): Promise<typeof WebWorkspace> {
  if (!workspaceImport) {
    workspaceImport = import("./WebWorkspace").then((module) => module.WebWorkspace);
    workspaceImport.catch(() => {
      workspaceImport = null;
    });
  }
  return workspaceImport;
}

/** This browser, with no email and no cloud account. */
const LOCAL_WEB_ACCOUNT: CentralAuthUser = {
  id: "local",
  email: "",
  name: null,
  avatarUrl: null,
};

/**
 * The shared agent a `/app?agent=<id>` link names. The query is removed after it is read, so a reload
 * does not open the preview again.
 */
function takeAgentTemplateLink(): string | null {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(WEB_APP_AGENT_TEMPLATE_PARAM)) return null;
  const id = agentTemplateIdFromWebAppSearch(url.search);
  url.searchParams.delete(WEB_APP_AGENT_TEMPLATE_PARAM);
  window.history.replaceState(window.history.state, "", url);
  return id;
}

/**
 * The invitation a `/app?api=…&server=…&fingerprint=…&invite=…` link names, as the `/join` page
 * passes it on. The fields are removed after they are read, so the secret does not stay in the
 * address bar or the history, and a reload does not open the dialog again.
 */
function takeInviteLink(): string | null {
  const url = new URL(window.location.href);
  if (!WEB_APP_INVITE_FIELDS.some((field) => url.searchParams.has(field))) return null;
  const inviteUrl = inviteUrlFromWebAppSearch(url.search, { allowLocalDevelopmentApiUrl: import.meta.env.DEV });
  for (const field of WEB_APP_INVITE_FIELDS) url.searchParams.delete(field);
  window.history.replaceState(window.history.state, "", url);
  return inviteUrl;
}

/** The plugin listing a `/app?plugin=<slug>` link names. The query is removed after it is read. */
function takePluginLink(): string | null {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(WEB_APP_PLUGIN_PARAM)) return null;
  const slug = pluginSlugFromWebAppSearch(url.search);
  url.searchParams.delete(WEB_APP_PLUGIN_PARAM);
  window.history.replaceState(window.history.state, "", url);
  return slug;
}

/**
 * The agent or skill a `/app?marketplaceAgent=<id>` or `/app?marketplaceSkill=<slug>` link names.
 * The query is removed after it is read.
 */
function takeMarketplaceLink(): MarketplaceListingLink | null {
  const url = new URL(window.location.href);
  const params = [WEB_APP_MARKETPLACE_AGENT_PARAM, WEB_APP_MARKETPLACE_SKILL_PARAM];
  if (!params.some((param) => url.searchParams.has(param))) return null;
  const link = marketplaceListingFromWebAppSearch(url.search);
  for (const param of params) url.searchParams.delete(param);
  window.history.replaceState(window.history.state, "", url);
  return link;
}

type BillingReturn = DesktopAnalyticsProperties<"billing_return_viewed">;

/**
 * A return from Stripe to Billing: `/app?billing=portal` from the Customer Portal, or
 * `/app?billing=license` from license Checkout, with `&cancelled=1` when the user went back. The
 * query is removed after it is read.
 */
function takeBillingReturn(): BillingReturn | null {
  const url = new URL(window.location.href);
  const kind = url.searchParams.get(WEB_APP_BILLING_PARAM);
  if (kind === null) return null;
  const outcome = url.searchParams.get("cancelled") === "1" ? "cancelled" : "completed";
  for (const name of [WEB_APP_BILLING_PARAM, "cancelled"]) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", url);
  return kind === "license" || kind === "portal" ? { outcome, kind } : { outcome };
}

/** What a `/app?start=<server|license>` link from the pricing page opens. The query is removed after it is read. */
function takeStartLink(): WebAppStart | null {
  const url = new URL(window.location.href);
  const start = takeWebAppStart(url);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  return start;
}

/** The browser client. Its chat bubbles take the colors of the backdrop page that shows. */
export function WebApp(props: { createRuntime?: WebRuntimeFactory } = {}) {
  return (
    <WindowBackdropBubbles>
      <WebAppContent {...props} />
    </WindowBackdropBubbles>
  );
}

function WebAppContent(props: { createRuntime?: WebRuntimeFactory }) {
  // This component renders the text provider, so it reads the text of the last provider that rendered.
  const text = currentText();
  const [state, setState] = createStore<{
    account: CentralAuthUser | null;
    loaded: boolean;
  }>({
    account: null,
    loaded: false,
  });
  createEffect(
    () => ({ account: state.account, loaded: state.loaded }),
    ({ account, loaded }) => {
      if (!loaded) return;
      configureWebReports(account);
      // Analytics is optional. A failed import changes nothing in the app.
      import("./web-analytics")
        .then((module) => {
          module.configureWebAnalytics(account);
          if (!account || !billingReturnEvent) return;
          module.trackBillingReturn(billingReturnEvent);
          billingReturnEvent = null;
        })
        .catch(() => undefined);
    },
  );
  const [agentTemplateId, setAgentTemplateId] = createSignal(takeAgentTemplateLink());
  const [inviteUrl, setInviteUrl] = createSignal(takeInviteLink());
  const [pluginSlug, setPluginSlug] = createSignal(takePluginLink());
  const [marketplaceListing, setMarketplaceListing] = createSignal(takeMarketplaceLink());
  const [startLink, setStartLink] = createSignal(takeStartLink());
  const initialBillingReturn = takeBillingReturn();
  const initialHostingReturn = takeHostingReturn();
  const [billingReturn, setBillingReturn] = createSignal(initialBillingReturn !== null);
  const [hostingReturn, setHostingReturn] = createSignal(initialHostingReturn);
  /** Sent once, when analytics has the account. */
  let billingReturnEvent: BillingReturn | null =
    initialBillingReturn ??
    (initialHostingReturn ? { outcome: initialHostingReturn.paid ? "completed" : "cancelled", kind: "plan" } : null);
  const [workspace, setWorkspace] = createSignal<typeof WebWorkspace>();
  /** Sets the account when the workspace code is ready to show it. */
  async function showAccount(account: CentralAuthUser) {
    const view = await loadWorkspace();
    setWorkspace(() => view);
    return account;
  }
  // The loading screen stays over the app until its exit ends.
  const [loadingShown, setLoadingShown] = createSignal(true);
  let channel: BroadcastChannel | null = null;
  let disposed = false;
  let sessionGeneration = 0;
  /**
   * The cookie's account session has ended. The server ended its remote sessions in the same write
   * (`endAccountSession`), so the closing workspace does not end them again.
   */
  let sessionEnded = false;
  function clearSession(ended = true) {
    sessionEnded = ended;
    // The saved workspace frames name the agents of the account's servers.
    if (ended) {
      deleteRemoteWorkspaceFrames(null);
      void deleteSavedAgentPictures(null);
      keepCachedWorkflows(null);
    }
    sessionGeneration += 1;
    setState((draft) => {
      draft.account = null;
    });
  }
  /** Shows this computer. A cloud page never reads the account service first. */
  async function showLocal(generation: number): Promise<void> {
    const account = await showAccount(LOCAL_WEB_ACCOUNT);
    if (disposed || generation !== sessionGeneration) return;
    sessionEnded = true;
    setState((draft) => {
      draft.account = account;
    });
  }
  const accountFetch: typeof fetch = async (input, init) => {
    if (requestTargetsOpenBotCloud(input)) throw new TypeError("Failed to fetch");
    const generation = sessionGeneration;
    const response = await fetch(input, init);
    if (!disposed && generation === sessionGeneration && response.status === 401) {
      const signedIn = state.account !== null && state.account.id !== LOCAL_WEB_ACCOUNT.id;
      if (signedIn) channel?.postMessage("session-changed");
      if (state.account?.id !== LOCAL_WEB_ACCOUNT.id) {
        clearSession();
        void showLocal(sessionGeneration);
      }
    }
    return response;
  };
  async function request(path: string, body?: Record<string, never>) {
    const response = await accountFetch(`/api/browser/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json", "X-OpenBot-Browser": "1" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) {
      throw new Error(
        isDynamicRecord(value) && isDynamicRecord(value.error) && isString(value.error.message)
          ? value.error.message
          : text.t("webClient.login.requestFailed"),
      );
    }
    return value;
  }
  function accountFrom(value: unknown): CentralAuthUser {
    if (
      !isDynamicRecord(value) ||
      !isDynamicRecord(value.user) ||
      !isString(value.user.id) ||
      !isString(value.user.email)
    )
      throw new Error(text.t("webClient.login.accountInvalid"));
    return {
      id: value.user.id,
      email: value.user.email,
      name: isString(value.user.name) ? value.user.name : null,
      avatarUrl: isString(value.user.avatarUrl) ? value.user.avatarUrl : null,
      analyticsEnabled: isBoolean(value.user.analyticsEnabled) ? value.user.analyticsEnabled : null,
      chatColor: isAvatarColor(value.user.chatColor) ? value.user.chatColor : null,
    };
  }
  async function checkSession() {
    const generation = sessionGeneration;
    // The workspace code loads beside the session check, not after it.
    void loadWorkspace().catch(() => undefined);
    try {
      if (pageUsesOpenBotCloud()) {
        await showLocal(generation);
        return;
      }
      const session = await request("session");
      markRemoteSync("session");
      const account = await showAccount(accountFrom(session));
      markRemoteSync("workspace-code");
      if (!disposed && generation === sessionGeneration) {
        sessionEnded = false;
        setState((draft) => {
          draft.account = account;
        });
      }
    } catch (error) {
      if (!disposed && generation === sessionGeneration) {
        // A real session that fails stays up and reports the failure. No session uses this computer.
        if (state.account && state.account.id !== LOCAL_WEB_ACCOUNT.id)
          toast.error(
            text.sourceText(error instanceof Error ? error.message : text.t("webClient.login.sessionFailed")),
            { report: { operation: "other", source: "system", cause_code: classifyFailure(error) } },
          );
        else await showLocal(generation);
      }
    } finally {
      if (!disposed)
        setState((draft) => {
          draft.loaded = true;
        });
    }
  }
  async function logout() {
    if (!state.account || state.account.id === LOCAL_WEB_ACCOUNT.id || pageUsesOpenBotCloud()) return;
    await request("logout", {});
    clearSession();
    channel?.postMessage("session-changed");
    await showLocal(sessionGeneration);
  }
  onSettled(() => {
    channel = new BroadcastChannel("openbot.web.session");
    channel.onmessage = () => {
      clearSession();
      void checkSession();
    };
    void checkSession();
    // A page restored from the back-forward cache still has its session; its connection ends normally.
    // A browser also sends `pageshow` after a normal load, which can come after the session check.
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      clearSession(false);
      void checkSession();
    };
    window.addEventListener("pageshow", restore);
    return () => {
      disposed = true;
      channel?.close();
      window.removeEventListener("pageshow", restore);
    };
  });
  const languagePreference = createWebLanguagePreference();
  const appearancePreference = createWebAppearancePreference();
  // The chat background of each scheme; leaving `/app` removes it.
  onSettled(() => syncWebChatBackground());
  // The sign-in starts in the browser language; its language button opens the wheel to change it.
  return (
    <StaticI18nProvider
      locale={resolveLocale(languagePreference.language(), navigator.language)}
      formatLocale={formatLocale(languagePreference.language(), navigator.language)}
    >
      <NotificationObserver onShown={reportNotification}>
        <div class="web-app">
          <Toaster onToastShown={reportNotification} />
          <Show when={state.loaded}>
            <Show keyed when={state.account?.id}>
              {(accountId) => (
                <Dynamic
                  component={workspace()}
                  accountId={accountId}
                  accountEmail={state.account?.email ?? ""}
                  accountName={state.account?.name ?? null}
                  accountAvatarUrl={state.account?.avatarUrl ?? null}
                  accountChatColor={state.account?.chatColor ?? null}
                  accountFetch={accountFetch}
                  onSessionCheck={checkSession}
                  accountSessionEnded={() => sessionEnded}
                  onLogout={logout}
                  createRuntime={props.createRuntime}
                  agentTemplateId={agentTemplateId()}
                  onAgentTemplateClose={() => setAgentTemplateId(null)}
                  inviteUrl={inviteUrl()}
                  onInviteClose={() => setInviteUrl(null)}
                  pluginSlug={pluginSlug()}
                  onPluginSlugConsumed={() => setPluginSlug(null)}
                  marketplaceListing={marketplaceListing()}
                  onMarketplaceListingConsumed={() => setMarketplaceListing(null)}
                  start={startLink()}
                  onStartConsumed={() => setStartLink(null)}
                  billingReturn={billingReturn()}
                  onBillingReturnConsumed={() => setBillingReturn(false)}
                  hostingReturn={hostingReturn()}
                  onHostingReturnConsumed={() => setHostingReturn(null)}
                  language={languagePreference.language()}
                  onChangeLanguage={languagePreference.setLanguage}
                  appearance={appearancePreference.appearance()}
                  onChangeAppearance={appearancePreference.setAppearance}
                />
              )}
            </Show>
          </Show>
          <Show when={loadingShown()}>
            <AppLoadingScreen
              immediate
              ready={state.loaded}
              onExited={() => {
                setLoadingShown(false);
                void loadWorkspace().catch(() => undefined);
              }}
            />
          </Show>
        </div>
      </NotificationObserver>
    </StaticI18nProvider>
  );
}
