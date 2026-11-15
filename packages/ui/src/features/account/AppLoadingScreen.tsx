import type { AppTextKey } from "@openbot/i18n";
import { createEffect, createSignal, For, onCleanup, onSettled } from "solid-js";
import { PlushLoader } from "../../plush-loader";
import { useText } from "../../text";
import { AppLoadingMark } from "./AppLoadingShell";

const STATUS_INTERVAL_MS = 2400;
const EXIT_LIMIT_MS = 500;
const EXIT_ANIMATION = "app-loading-exit";
const THINKING_SIZE = 132;

const STATUS_LINES = [
  "webClient.loadingLine.wake",
  "webClient.loadingLine.coffee",
  "webClient.loadingLine.tokens",
  "webClient.loadingLine.prompts",
  "webClient.loadingLine.sleepy",
  "webClient.loadingLine.almost",
] as const satisfies readonly AppTextKey[];

export interface AppLoadingScreenProps {
  ready?: boolean | undefined;
  onExited?: (() => void) | undefined;
  /** Mount the underlying views as the overlay begins to fade. */
  onMountViews?: (() => void) | undefined;
  scene?: "thinking";
  /** Accessible description of what is loading. */
  label?: string;
  /** Fixed status for the thinking scene. */
  title?: string;
  /** Skip the entrance delay when taking over from another loading screen. */
  immediate?: boolean;
}

export function AppLoadingScreen(props: AppLoadingScreenProps) {
  const { t } = useText();
  const [statusIndex, setStatusIndex] = createSignal(0);
  const [exiting, setExiting] = createSignal(false);
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let root: HTMLElement | undefined;
  let exited = false;
  let viewsMounted = false;

  function mountViews(): void {
    if (viewsMounted) return;
    viewsMounted = true;
    props.onMountViews?.();
  }

  function finishExit(): void {
    if (exited) return;
    exited = true;
    clearTimeout(exitTimer);
    mountViews();
    props.onExited?.();
  }

  createEffect(
    () => props.ready,
    (ready) => {
      if (!ready) return;
      clearInterval(statusTimer);
      setExiting(true);
      exitTimer ??= setTimeout(finishExit, EXIT_LIMIT_MS);
    },
  );

  // Without an exit animation, reveal the app as soon as its views are ready.
  createEffect(exiting, (isExiting) => {
    if (isExiting && root && !getComputedStyle(root).animationName.includes(EXIT_ANIMATION)) {
      queueMicrotask(finishExit);
    }
  });

  onSettled(() => {
    if (!props.ready && props.scene === "thinking" && !props.title) {
      statusTimer = setInterval(() => setStatusIndex((index) => (index + 1) % STATUS_LINES.length), STATUS_INTERVAL_MS);
    }
  });
  onCleanup(() => {
    exited = true;
    clearInterval(statusTimer);
    clearTimeout(exitTimer);
  });

  function handleAnimationStart(event: AnimationEvent): void {
    if (event.animationName === EXIT_ANIMATION && event.target === event.currentTarget) mountViews();
  }

  function handleAnimationEnd(event: AnimationEvent): void {
    if (event.animationName === EXIT_ANIMATION && event.target === event.currentTarget) finishExit();
  }

  return (
    <main
      ref={(element) => {
        root = element;
      }}
      class="app-loading"
      data-scene={props.scene}
      data-phase={exiting() ? "fade" : "loading"}
      data-immediate={props.immediate ? "" : undefined}
      role="status"
      aria-live="polite"
      aria-busy={props.ready ? "false" : "true"}
      onAnimationStart={handleAnimationStart}
      onAnimationEnd={handleAnimationEnd}
    >
      <span class="sr-only">{props.label ?? t("webClient.loading")}</span>
      {props.scene === "thinking" ? (
        <div class="app-loading-stage">
          <PlushLoader layout="stack" size={THINKING_SIZE} />
          <p class="app-loading-status">
            {props.title ?? (
              <For each={[STATUS_LINES[statusIndex()] ?? STATUS_LINES[0]]}>
                {(line) => <span class="app-loading-line">{t(line)}</span>}
              </For>
            )}
          </p>
        </div>
      ) : (
        <AppLoadingMark />
      )}
    </main>
  );
}
