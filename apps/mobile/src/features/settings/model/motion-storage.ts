import * as SecureStore from "expo-secure-store";
import {
  decodeMotionPreferences,
  MOTION_PREFERENCE_NAMES,
  type MotionPreference,
  useMotionPreferences,
} from "./motion";

const key = "openbot.mobile.motion.v1";
// The compact field used to be the default, and a saved copy of that default kept the small bar.
// One read turns it off. A later change in Settings stays.
const composerSizeKey = "openbot.mobile.motion.composer-size.v2";

function storedValue(): string {
  const state = useMotionPreferences.getState();
  return JSON.stringify(Object.fromEntries(MOTION_PREFERENCE_NAMES.map((name) => [name, state[name]])));
}

export async function loadMotionPreferences(): Promise<void> {
  if (useMotionPreferences.getState().ready) return;
  try {
    const stored = await SecureStore.getItemAsync(key);
    const composerSize = await SecureStore.getItemAsync(composerSizeKey);
    let preferences = decodeMotionPreferences(stored);
    if (composerSize !== "full") preferences = { ...preferences, composerResize: false };
    // A second startup read must not overwrite a change made in Settings.
    if (!useMotionPreferences.getState().ready) useMotionPreferences.setState(preferences);
    if (composerSize !== "full") {
      const payload = JSON.stringify(
        Object.fromEntries(MOTION_PREFERENCE_NAMES.map((name) => [name, preferences[name]])),
      );
      await SecureStore.setItemAsync(key, payload);
      await SecureStore.setItemAsync(composerSizeKey, "full");
    }
  } finally {
    useMotionPreferences.setState({ ready: true });
  }
}

// Writes run in order, so the last change is the one that stays stored.
let writes: Promise<void> = Promise.resolve();

export function saveMotionPreference(name: MotionPreference, enabled: boolean): Promise<void> {
  if (!useMotionPreferences.getState().ready) return Promise.resolve();
  // Apply immediately, including when storage fails. Settings shows the failure.
  useMotionPreferences.setState({ [name]: enabled });
  const write = writes.then(() => SecureStore.setItemAsync(key, storedValue()));
  writes = write.catch(() => undefined);
  return write;
}
