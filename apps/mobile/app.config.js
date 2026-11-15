const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { withEntitlementsPlist } = require("expo/config-plugins");

// Android notifications come through Firebase Cloud Messaging, which needs the Firebase file of the
// app. The file is optional, so the app builds before the Firebase project exists, and such a build
// gets no notifications on Android. The file has public identifiers only; the account service has the
// key that sends.
const GOOGLE_SERVICES_FILE = "./google-services.json";

// A local device build can sign with another Apple team. The store identifier stays in app.json.
// Set both variables together. The bundle identifier must belong to that team.
const DEV_BUNDLE_ID = process.env.OPENBOT_IOS_BUNDLE_ID;
const DEV_TEAM_ID = process.env.OPENBOT_IOS_APPLE_TEAM_ID;

// A personal team cannot create a profile that includes these capabilities. This mod is registered
// first so it runs after the other plugins and removes the keys they add.
const withoutPersonalTeamCapabilities = (config) =>
  withEntitlementsPlist(config, (mod) => {
    delete mod.modResults["aps-environment"];
    delete mod.modResults["com.apple.developer.associated-domains"];
    delete mod.modResults["com.apple.developer.usernotifications.communication"];
    return mod;
  });

/** @param {import('expo/config').ExpoConfig} config */
function withLocalIosSigning(config) {
  if (!DEV_BUNDLE_ID && !DEV_TEAM_ID) return config;
  const bundleIdentifier = DEV_BUNDLE_ID || config.ios?.bundleIdentifier;
  if (!bundleIdentifier) return config;
  const groupIdentifier = `group.${bundleIdentifier}`;
  const ios = { ...config.ios };
  delete ios.associatedDomains;
  const plugins = [withoutPersonalTeamCapabilities, ...(config.plugins ?? [])].map((plugin) => {
    if (!Array.isArray(plugin)) return plugin;
    const [name, props] = plugin;
    if (!props || typeof props !== "object") return plugin;
    if (name === "./plugins/with-share-target" && props.ios) {
      return [
        name,
        {
          ...props,
          ios: {
            ...props.ios,
            appGroupId: groupIdentifier,
            extensionBundleIdentifier: `${bundleIdentifier}.ShareExtension`,
          },
        },
      ];
    }
    if (name === "expo-widgets") {
      return [
        name,
        {
          ...props,
          bundleIdentifier: `${bundleIdentifier}.ExpoWidgetsTarget`,
          groupIdentifier,
          enablePushNotifications: false,
        },
      ];
    }
    if (name === "./plugins/with-notification-service") {
      return [
        name,
        {
          ...props,
          bundleIdentifier: `${bundleIdentifier}.NotificationService`,
          groupIdentifier,
        },
      ];
    }
    return plugin;
  });
  return {
    ...config,
    plugins,
    extra: { ...config.extra, iosAppGroup: groupIdentifier },
    ios: {
      ...ios,
      bundleIdentifier,
      ...(DEV_TEAM_ID ? { appleTeamId: DEV_TEAM_ID } : {}),
    },
  };
}

/** @param {{ config: import('expo/config').ExpoConfig }} context */
module.exports = ({ config }) => {
  const withServices = existsSync(join(__dirname, GOOGLE_SERVICES_FILE))
    ? { ...config, android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE } }
    : config;
  return withLocalIosSigning(withServices);
};
