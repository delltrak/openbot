import { isOpenBotCloudUrl } from "@openbot/contracts/local-network";
import { fetch as expoFetch } from "expo/fetch";
import { withRequestLog } from "./support-log";

const loggedFetch = withRequestLog(expoFetch);

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") return input.url;
  return "";
}

/** `expo/fetch` with a support log line for each request. Import it instead of `expo/fetch`. A cloud host is refused before the request. */
export const fetch: typeof loggedFetch = (input, init) => {
  if (isOpenBotCloudUrl(requestUrl(input))) {
    return Promise.reject(new TypeError("OpenBot does not contact this host."));
  }
  return loggedFetch(input, init);
};
