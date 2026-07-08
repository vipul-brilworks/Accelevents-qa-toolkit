import { ENVIRONMENT_BY_HOST } from "./constants.js";

/**
 * Detects the Accelevents environment and event from a host admin URL.
 * @param {string} rawUrl
 * @returns {{ environment: string, webOrigin: string, apiOrigin: string, eventSlug: string, currentUrl: string, hostname: string, pathname: string }}
 * @throws {Error} When the URL is unsupported or does not contain /host/{eventSlug}.
 */
export function detectEnvironmentContext(rawUrl) {
  const url = new URL(rawUrl);

  if (url.protocol !== "https:") {
    throw new Error("Unsupported protocol. Open an Accelevents HTTPS admin page.");
  }

  const environment = ENVIRONMENT_BY_HOST[url.hostname];
  if (!environment) {
    throw new Error("Unsupported Accelevents environment.");
  }

  const match = url.pathname.match(/^\/host\/([^/]+)/);
  if (!match) {
    throw new Error("Unable to determine event slug.");
  }

  return {
    ...environment,
    eventSlug: decodeURIComponent(match[1]),
    currentUrl: url.href,
    hostname: url.hostname,
    pathname: url.pathname
  };
}

/**
 * Extracts non-sensitive diagnostics from the current tab URL.
 * @param {string} rawUrl
 * @returns {{ currentUrl: string, hostname: string, pathname: string }}
 */
export function getUrlDiagnostics(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      currentUrl: url.href,
      hostname: url.hostname,
      pathname: url.pathname
    };
  } catch {
    return {
      currentUrl: rawUrl || "",
      hostname: "",
      pathname: ""
    };
  }
}
