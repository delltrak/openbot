import { MobileAnalytics } from "./analytics-core";

// This build does not send product events or failure reports.
export const mobileAnalytics = new MobileAnalytics(
  () => null,
  () => undefined,
);
