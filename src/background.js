import { PAGE_SIZE, RETRYABLE_STATUS_CODES } from "./constants.js";
import { extractOrders, hasMorePages, normalizeOrder } from "./orders.js";

/**
 * Handles popup-to-service-worker RPC requests.
 * @param {object} message
 * @param {chrome.runtime.MessageSender} _sender
 * @param {(response: object) => void} sendResponse
 * @returns {true}
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response = {}) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      console.error("QA Toolkit request failed.", error);
      sendResponse({ ok: false, error: getErrorMessage(error) });
    });
  return true;
});

/**
 * Routes extension messages to the matching privileged operation.
 * @param {{ type?: string, context?: object, orderId?: string }} message
 * @returns {Promise<object>}
 */
async function handleMessage(message) {
  switch (message?.type) {
    case "FETCH_ORDERS":
      return fetchAllOrders(message.context);
    case "DELETE_ORDER":
      return deleteOrder(message.context, message.orderId);
    case "REFRESH_ACTIVE_TAB":
      return refreshActiveTab();
    default:
      throw new Error(`Unknown message type: ${message?.type}`);
  }
}

/**
 * Fetches every order page for an event.
 * @param {{ apiOrigin: string, eventSlug: string }} context
 * @returns {Promise<{ orders: Array<object>, pagesLoaded: number }>}
 */
async function fetchAllOrders(context) {
  assertEnvironmentContext(context);

  const orders = [];
  let page = 0;
  let pagesLoaded = 0;

  while (true) {
    const requestUrl = `${context.apiOrigin}/rest/events/${encodeURIComponent(context.eventSlug)}/staff/orders?page=${page}&size=${PAGE_SIZE}`;
    logRequestDiagnostics(context, requestUrl);
    const payload = await requestJson(requestUrl, {
      method: "GET",
      headers: {
        Authorization: context.sessionToken
      }
    });
    const pageOrders = extractOrders(payload).map(normalizeOrder).filter((order) => order.id);

    console.info(`QA Toolkit loaded order page ${page + 1} with ${pageOrders.length} order(s).`);
    orders.push(...pageOrders);
    pagesLoaded += 1;

    if (!hasMorePages(payload, page, PAGE_SIZE, pageOrders.length)) break;
    page += 1;
  }

  return { orders, pagesLoaded };
}

/**
 * Deletes a single order using the Accelevents host endpoint.
 * @param {{ apiOrigin: string, eventSlug: string }} context
 * @param {string} orderId
 * @returns {Promise<{ httpStatus: number, message: string, attempts: number }>}
 */
async function deleteOrder(context, orderId) {
  assertEnvironmentContext(context);
  if (!orderId) throw new Error("Order id is required.");

  const sendRefundEmail = context.sendRefundEmail === true ? "true" : "false";
  const requestUrl = `${context.apiOrigin}/rest/host/event/${encodeURIComponent(context.eventSlug)}/ticketing/deleteEventTicket/order/${encodeURIComponent(orderId)}?eventTicketingId=0&isRefundEmailSend=${sendRefundEmail}`;
  logRequestDiagnostics(context, requestUrl);
  const { response, attempts } = await requestWithMeta(requestUrl, {
    method: "DELETE",
    headers: {
      Authorization: context.sessionToken
    }
  });
  return {
    httpStatus: response.status,
    message: response.statusText || "Deleted",
    attempts
  };
}

/**
 * Reloads the active tab after a deletion run completes.
 * @returns {Promise<object>}
 */
async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return {};

  try {
    await chrome.tabs.reload(tab.id);
  } catch (error) {
    console.warn("QA Toolkit could not refresh the active tab.", error);
  }

  return {};
}

/**
 * Performs a request and parses JSON if present.
 * @param {string} url
 * @param {RequestInit} options
 * @returns {Promise<object>}
 */
async function requestJson(url, options) {
  const { response } = await requestWithMeta(url, options);
  if (response.status === 204) return {};

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Request returned invalid JSON (${response.status}): ${getErrorMessage(error)}`);
  }
}

/**
 * Performs a credentialed API request with retry handling for transient failures.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} [attempt]
 * @returns {Promise<{ response: Response, attempts: number }>}
 */
async function requestWithMeta(url, options, attempt = 1) {
  // Uses the logged-in browser session through cookies; the extension never stores auth tokens.
  let response;

  try {
    response = await fetch(url, {
      ...options,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new Error(`Network request failed: ${getErrorMessage(error)}`);
  }

  if (!response.ok) {
    if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < 4) {
      console.warn(`QA Toolkit retrying ${options.method || "GET"} ${url} after ${response.status} (attempt ${attempt}).`);
      await wait(backoffMs(attempt, response));
      return requestWithMeta(url, options, attempt + 1);
    }

    const body = await readResponseText(response);
    throw new Error(`Request failed (${response.status}): ${body || response.statusText}`);
  }

  return { response, attempts: attempt };
}

/**
 * Validates the detected environment context before constructing API URLs.
 * @param {object} context
 * @returns {void}
 */
function assertEnvironmentContext(context) {
  if (!context || typeof context !== "object") {
    throw new Error("Unable to detect current event.");
  }

  if (!context.apiOrigin || !context.eventSlug) {
    throw new Error("Unable to detect current event.");
  }

  if (!context.sessionToken) {
    throw new Error("No active session token found. Please log in to Accelevents.");
  }
}

/**
 * Logs environment and final request diagnostics before every API request.
 * @param {{ currentUrl?: string, hostname?: string, pathname?: string, environment?: string, eventSlug?: string, apiOrigin?: string }} context
 * @param {string} requestUrl
 * @returns {void}
 */
function logRequestDiagnostics(context, requestUrl) {
  console.info([
    "Current URL:",
    context.currentUrl || "",
    "",
    "Hostname:",
    context.hostname || "",
    "",
    "Pathname:",
    context.pathname || "",
    "",
    "Environment:",
    context.environment || "",
    "",
    "Event:",
    context.eventSlug || "",
    "",
    "API:",
    context.apiOrigin || "",
    "",
    "Final Request:",
    requestUrl
  ].join("\n"));
}

/**
 * Calculates retry delay, respecting Retry-After when provided.
 * @param {number} attempt
 * @param {Response} response
 * @returns {number}
 */
function backoffMs(attempt, response) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 400 * (2 ** (attempt - 1));
}

/**
 * Delays execution for retry backoff.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Safely reads an error body without masking the original status.
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Converts thrown values into user-visible messages.
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
