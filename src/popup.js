import { buildOrdersCsv, downloadCsv } from "./csv.js";
import { DeleteController } from "./deleter.js";
import { filterOrders, getUniqueOptions, summarizeReport } from "./orders.js";
import { loadSettings, saveSettings } from "./storage.js";
import { detectEnvironmentContext, getUrlDiagnostics } from "./url.js";

const state = {
  context: null,
  orders: [],
  visibleOrders: [],
  selectedIds: new Set(),
  deleteController: null,
  lastResults: []
};

/** @param {string} id @returns {HTMLElement} */
const $ = (id) => document.getElementById(id);

const elements = {
  eventSlug: $("eventSlug"),
  contextEnvironment: $("contextEnvironment"),
  contextWebsite: $("contextWebsite"),
  contextApi: $("contextApi"),
  contextEvent: $("contextEvent"),
  unsupported: $("unsupported"),
  loadOrdersBtn: $("loadOrdersBtn"),
  refreshOrdersBtn: $("refreshOrdersBtn"),
  exportPreviewBtn: $("exportPreviewBtn"),
  selectVisibleBtn: $("selectVisibleBtn"),
  clearSelectionBtn: $("clearSelectionBtn"),
  concurrencySelect: $("concurrencySelect"),
  buyerFilter: $("buyerFilter"),
  holderFilter: $("holderFilter"),
  statusFilter: $("statusFilter"),
  ticketTypeFilter: $("ticketTypeFilter"),
  priceFilter: $("priceFilter"),
  totalCount: $("totalCount"),
  visibleCount: $("visibleCount"),
  selectedCount: $("selectedCount"),
  loadedPages: $("loadedPages"),
  ordersTable: $("ordersTable"),
  toggleVisibleSelection: $("toggleVisibleSelection"),
  deleteConfirm: $("deleteConfirm"),
  deleteSelectedBtn: $("deleteSelectedBtn"),
  deleteAllBtn: $("deleteAllBtn"),
  cancelDeleteBtn: $("cancelDeleteBtn"),
  progressText: $("progressText"),
  progressPercent: $("progressPercent"),
  deleteProgress: $("deleteProgress"),
  currentOrder: $("currentOrder"),
  deletedSummary: $("deletedSummary"),
  failedSummary: $("failedSummary"),
  skippedSummary: $("skippedSummary"),
  timeSummary: $("timeSummary"),
  downloadReportBtn: $("downloadReportBtn"),
  logsList: $("logsList")
};

init();

/**
 * Initializes popup state from stored settings and the active tab URL.
 * @returns {Promise<void>}
 */
async function init() {
  wireNavigation();
  wireEvents();

  const settings = await loadSettings();
  elements.concurrencySelect.value = String(settings.concurrency);

  const tab = await getActiveTab();

  if (!tab?.url) {
    showContextDetectionFailure("", "Unable to read the current tab URL.");
    setWorkflowEnabled(false);
    return;
  }

  try {
    state.context = detectEnvironmentContext(tab.url);

    const [{ result: token }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const tokenCookie = document.cookie
          .split("; ")
          .find((c) => c.startsWith("token="));
        return tokenCookie
          ? decodeURIComponent(tokenCookie.split("=")[1])
          : null;
      }
    });

    state.context.sessionToken = token;

    renderEnvironmentContext(state.context);
    setWorkflowEnabled(true);
    log(`Ready on ${state.context.pathname}.`);
  } catch (error) {
    showContextDetectionFailure(tab.url, getErrorMessage(error));
    setWorkflowEnabled(false);
  }
}

/**
 * Reads the active browser tab. Returns null if Chrome denies access.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (error) {
    log(`Unable to read active tab: ${getErrorMessage(error)}`, "error");
    return null;
  }
}

/**
 * Displays the detected environment before any order request is made.
 * @param {{ environment: string, webOrigin: string, apiOrigin: string, eventSlug: string, hostname: string }} context
 * @returns {void}
 */
function renderEnvironmentContext(context) {
  elements.unsupported.classList.add("hidden");
  elements.eventSlug.textContent = `Event: ${context.eventSlug}`;
  elements.contextEnvironment.textContent = context.environment;
  elements.contextWebsite.textContent = new URL(context.webOrigin).hostname;
  elements.contextApi.textContent = new URL(context.apiOrigin).hostname;
  elements.contextEvent.textContent = context.eventSlug;
}

/**
 * Shows event detection diagnostics and prevents API requests.
 * @param {string} rawUrl
 * @param {string} reason
 * @returns {void}
 */
function showContextDetectionFailure(rawUrl, reason) {
  const diagnostics = getUrlDiagnostics(rawUrl);
  const message = [
    "Unable to detect current event.",
    "",
    "Current URL",
    diagnostics.currentUrl,
    "",
    "Detected Hostname",
    diagnostics.hostname,
    "",
    "Detected Path",
    diagnostics.pathname
  ].join("\n");

  state.context = null;
  elements.unsupported.classList.remove("hidden");
  elements.unsupported.textContent = message;
  elements.eventSlug.textContent = "Event not detected";
  elements.contextEnvironment.textContent = "Not detected";
  elements.contextWebsite.textContent = diagnostics.hostname || "Not detected";
  elements.contextApi.textContent = "Not detected";
  elements.contextEvent.textContent = "Not detected";
  log(`${message}\n\nReason\n${reason}`, "error");
}

/**
 * Wires sidebar navigation to the existing panels.
 * @returns {void}
 */
function wireNavigation() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      const panel = $(button.dataset.section);
      panel.classList.add("active");
    });
  });
}

/**
 * Registers popup control event handlers.
 * @returns {void}
 */
function wireEvents() {
  elements.loadOrdersBtn.addEventListener("click", loadOrders);
  elements.refreshOrdersBtn.addEventListener("click", loadOrders);
  elements.exportPreviewBtn.addEventListener("click", exportPreview);
  elements.selectVisibleBtn.addEventListener("click", () => {
    state.visibleOrders.forEach((order) => state.selectedIds.add(order.id));
    renderOrders();
  });
  elements.clearSelectionBtn.addEventListener("click", () => {
    state.selectedIds.clear();
    renderOrders();
  });
  elements.toggleVisibleSelection.addEventListener("change", () => {
    if (elements.toggleVisibleSelection.checked) {
      state.visibleOrders.forEach((order) => state.selectedIds.add(order.id));
    } else {
      state.visibleOrders.forEach((order) => state.selectedIds.delete(order.id));
    }
    renderOrders();
  });

  [elements.buyerFilter, elements.holderFilter, elements.statusFilter, elements.ticketTypeFilter, elements.priceFilter]
    .forEach((input) => input.addEventListener("input", applyFilters));

  elements.concurrencySelect.addEventListener("change", async () => {
    try {
      await saveSettings({ concurrency: Number(elements.concurrencySelect.value) });
      log(`Concurrency set to ${elements.concurrencySelect.value}.`);
    } catch (error) {
      log(`Unable to save concurrency: ${getErrorMessage(error)}`, "error");
    }
  });

  elements.deleteConfirm.addEventListener("input", updateDeleteButtons);
  elements.deleteSelectedBtn.addEventListener("click", () => startDelete(getSelectedOrders()));
  elements.deleteAllBtn.addEventListener("click", () => startDelete(state.orders));
  elements.cancelDeleteBtn.addEventListener("click", () => {
    state.deleteController?.cancel();
    elements.cancelDeleteBtn.disabled = true;
    log("Cancellation requested.");
  });
  elements.downloadReportBtn.addEventListener("click", downloadReport);
}

/**
 * Fetches every order page and refreshes the preview table.
 * @returns {Promise<void>}
 */
async function loadOrders() {
  if (!state.context) {
    log("Load blocked: unable to detect current event.", "error");
    return;
  }

  setBusy(true, "Loading orders...");
  resetDeletionUi();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "FETCH_ORDERS",
      context: state.context
    });

    assertResponseOk(response, "Unable to load orders.");

    state.orders = Array.isArray(response.orders) ? response.orders : [];
    state.selectedIds.clear();
    elements.loadedPages.textContent = String(response.pagesLoaded || 0);
    populateFilterOptions();
    applyFilters();
    log(`Loaded ${state.orders.length} orders across ${response.pagesLoaded} page(s).`);
  } catch (error) {
    showEmpty(getErrorMessage(error));
    log(`Load failed: ${getErrorMessage(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

/**
 * Rebuilds status and ticket type filter options from loaded orders.
 * @returns {void}
 */
function populateFilterOptions() {
  fillSelect(elements.statusFilter, "Any status", getUniqueOptions(state.orders, "status"));
  fillSelect(elements.ticketTypeFilter, "Any ticket", getUniqueOptions(state.orders, "ticketType"));
}

/**
 * Replaces a select element's option list while preserving valid selections.
 * @param {HTMLSelectElement} select
 * @param {string} label
 * @param {string[]} values
 * @returns {void}
 */
function fillSelect(select, label, values) {
  const current = select.value;
  select.replaceChildren(new Option(label, ""), ...values.map((value) => new Option(value, value)));
  select.value = values.includes(current) ? current : "";
}

/**
 * Applies current filters to the loaded order list.
 * @returns {void}
 */
function applyFilters() {
  state.visibleOrders = filterOrders(state.orders, {
    buyerEmail: elements.buyerFilter.value.trim(),
    holderEmail: elements.holderFilter.value.trim(),
    status: elements.statusFilter.value,
    ticketType: elements.ticketTypeFilter.value,
    price: elements.priceFilter.value
  });
  renderOrders();
}

/**
 * Renders the order preview table and selection counters.
 * @returns {void}
 */
function renderOrders() {
  elements.totalCount.textContent = String(state.orders.length);
  elements.visibleCount.textContent = String(state.visibleOrders.length);
  elements.selectedCount.textContent = String(state.selectedIds.size);
  elements.toggleVisibleSelection.checked = state.visibleOrders.length > 0 && state.visibleOrders.every((order) => state.selectedIds.has(order.id));
  elements.toggleVisibleSelection.indeterminate = state.visibleOrders.some((order) => state.selectedIds.has(order.id)) && !elements.toggleVisibleSelection.checked;

  if (!state.visibleOrders.length) {
    showEmpty(state.orders.length ? "No orders match the current filters." : "Load orders to preview them before deletion.");
    updateDeleteButtons();
    return;
  }

  const fragment = document.createDocumentFragment();
  state.visibleOrders.forEach((order) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-order-id="${escapeHtml(order.id)}" aria-label="Select order ${escapeHtml(order.orderNumber || order.id)}"></td>
      <td><strong>${escapeHtml(order.orderNumber || order.id)}</strong><small>${escapeHtml(order.id)}</small></td>
      <td>${escapeHtml(order.buyerEmail || "-")}</td>
      <td>${escapeHtml(order.holderEmail || "-")}</td>
      <td>${escapeHtml(order.status)}</td>
      <td>${escapeHtml(order.ticketType)}</td>
      <td>${order.isFree ? "Free" : escapeHtml(formatMoney(order.amount))}</td>
    `;
    const checkbox = row.querySelector("input");
    checkbox.checked = state.selectedIds.has(order.id);
    checkbox.addEventListener("change", (event) => {
      if (event.target.checked) state.selectedIds.add(order.id);
      else state.selectedIds.delete(order.id);
      renderOrders();
    });
    fragment.append(row);
  });

  elements.ordersTable.replaceChildren(fragment);
  updateDeleteButtons();
}

/**
 * Runs the confirmed bulk delete queue.
 * @param {Array<object>} orders
 * @returns {Promise<void>}
 */
async function startDelete(orders) {
  if (!state.context || !orders.length || elements.deleteConfirm.value !== "DELETE") return;

  const concurrency = Number(elements.concurrencySelect.value);
  // Cancellation stops queued work; in-flight API requests are allowed to finish cleanly.
  state.deleteController = new DeleteController({
    context: state.context,
    concurrency,
    onProgress: updateProgress,
    onCurrent: (order) => {
      elements.currentOrder.textContent = `Deleting ${order.orderNumber || order.id}`;
    },
    onLog: log
  });

  setDeleteRunning(true);
  const targetIds = new Set(orders.map((order) => order.id));
  const skippedOrders = state.orders.filter((order) => !targetIds.has(order.id));

  try {
    const { results, elapsedMs } = await state.deleteController.run(orders);
    state.lastResults = [
      ...results,
      ...skippedOrders.map((order) => ({
        order,
        status: "skipped",
        httpStatus: "",
        message: "Not selected for deletion",
        attempts: 0,
        completedAt: new Date().toISOString()
      }))
    ];
    const summary = summarizeReport(state.lastResults, elapsedMs);
    renderSummary(summary);
    elements.downloadReportBtn.disabled = false;
    await downloadReportSilently();
    log(`Deletion finished in ${formatElapsed(elapsedMs)}.`);
    await refreshActiveTab();
  } catch (error) {
    log(`Deletion stopped: ${getErrorMessage(error)}`, "error");
  } finally {
    setDeleteRunning(false);
    elements.currentOrder.textContent = "Finished.";
  }
}

/**
 * Gets selected orders in original loaded order sequence.
 * @returns {Array<object>}
 */
function getSelectedOrders() {
  return state.orders.filter((order) => state.selectedIds.has(order.id));
}

/**
 * Updates progress UI from the deletion controller.
 * @param {{ completed: number, total: number, percent: number }} progress
 * @returns {void}
 */
function updateProgress(progress) {
  elements.deleteProgress.value = progress.percent;
  elements.progressPercent.textContent = `${progress.percent}%`;
  elements.progressText.textContent = `${progress.completed} of ${progress.total} processed`;
}

/**
 * Renders completion totals.
 * @param {{ deleted: number, failed: number, skipped: number, elapsedMs: number }} summary
 * @returns {void}
 */
function renderSummary(summary) {
  elements.deletedSummary.textContent = String(summary.deleted);
  elements.failedSummary.textContent = String(summary.failed);
  elements.skippedSummary.textContent = String(summary.skipped);
  elements.timeSummary.textContent = formatElapsed(summary.elapsedMs);
}

/**
 * Exports the current filtered preview.
 * @returns {Promise<void>}
 */
async function exportPreview() {
  if (!state.orders.length) return;
  try {
    await downloadCsv(buildFilename("orders-preview"), buildOrdersCsv(state.visibleOrders));
  } catch (error) {
    log(`Preview export failed: ${getErrorMessage(error)}`, "error");
  }
}

/**
 * Exports the latest deletion report on demand.
 * @returns {Promise<void>}
 */
async function downloadReport() {
  if (!state.lastResults.length) return;
  try {
    await downloadCsv(buildFilename("delete-report"), buildOrdersCsv(state.orders, state.lastResults));
  } catch (error) {
    log(`Report download failed: ${getErrorMessage(error)}`, "error");
  }
}

/**
 * Attempts automatic report download without failing the completed delete run.
 * @returns {Promise<void>}
 */
async function downloadReportSilently() {
  try {
    await downloadCsv(buildFilename("delete-report"), buildOrdersCsv(state.orders, state.lastResults), { saveAs: false });
  } catch (error) {
    log(`Automatic report download failed: ${getErrorMessage(error)}`, "error");
  }
}

/**
 * Refreshes the active tab through the service worker.
 * @returns {Promise<void>}
 */
async function refreshActiveTab() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "REFRESH_ACTIVE_TAB" });
    assertResponseOk(response, "Unable to refresh active tab.");
  } catch (error) {
    log(`Refresh failed: ${getErrorMessage(error)}`, "error");
  }
}

/**
 * Builds a stable CSV filename under a toolkit download folder.
 * @param {string} kind
 * @returns {string}
 */
function buildFilename(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `accelevents-qa-toolkit/${state.context.eventSlug}-${kind}-${stamp}.csv`;
}

/**
 * Enables delete buttons only when the destructive confirmation is valid.
 * @returns {void}
 */
function updateDeleteButtons() {
  const confirmed = elements.deleteConfirm.value === "DELETE";
  elements.deleteSelectedBtn.disabled = !confirmed || state.selectedIds.size === 0 || Boolean(state.deleteController);
  elements.deleteAllBtn.disabled = !confirmed || state.orders.length === 0 || Boolean(state.deleteController);
}

/**
 * Toggles controls while deletion is active.
 * @param {boolean} isRunning
 * @returns {void}
 */
function setDeleteRunning(isRunning) {
  elements.cancelDeleteBtn.disabled = !isRunning;
  elements.deleteConfirm.disabled = isRunning;
  elements.deleteSelectedBtn.disabled = isRunning;
  elements.deleteAllBtn.disabled = isRunning;
  elements.loadOrdersBtn.disabled = isRunning;
  elements.refreshOrdersBtn.disabled = isRunning;
  if (!isRunning) state.deleteController = null;
  updateDeleteButtons();
}

/**
 * Toggles load controls during order fetches.
 * @param {boolean} isBusy
 * @param {string} [label]
 * @returns {void}
 */
function setBusy(isBusy, label = "") {
  elements.loadOrdersBtn.disabled = isBusy;
  elements.refreshOrdersBtn.disabled = isBusy;
  elements.progressText.textContent = isBusy ? label : "Idle";
}

/**
 * Enables or disables the order workflow when the page is unsupported.
 * @param {boolean} enabled
 * @returns {void}
 */
function setWorkflowEnabled(enabled) {
  [
    elements.loadOrdersBtn,
    elements.refreshOrdersBtn,
    elements.exportPreviewBtn,
    elements.selectVisibleBtn,
    elements.clearSelectionBtn,
    elements.deleteConfirm
  ].forEach((element) => {
    element.disabled = !enabled;
  });
  updateDeleteButtons();
}

/**
 * Clears previous delete progress and report state.
 * @returns {void}
 */
function resetDeletionUi() {
  state.lastResults = [];
  elements.downloadReportBtn.disabled = true;
  elements.deleteProgress.value = 0;
  elements.progressPercent.textContent = "0%";
  elements.currentOrder.textContent = "No active deletion.";
  renderSummary({ deleted: 0, failed: 0, skipped: 0, elapsedMs: 0 });
}

/**
 * Renders a single empty-state table row.
 * @param {string} message
 * @returns {void}
 */
function showEmpty(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 7;
  cell.className = "empty";
  cell.textContent = message;
  row.append(cell);
  elements.ordersTable.replaceChildren(row);
}

/**
 * Adds a timestamped log entry to the Logs panel and console.
 * @param {string} message
 * @param {"info"|"warn"|"error"} [level]
 * @returns {void}
 */
function log(message, level = "info") {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  item.dataset.level = level;
  elements.logsList.prepend(item);
  console[level === "error" ? "error" : level === "warn" ? "warn" : "info"](`QA Toolkit: ${message}`);
}

/**
 * Escapes interpolated table text before assigning row markup.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

/**
 * Formats order totals for preview display.
 * @param {number} amount
 * @returns {string}
 */
function formatMoney(amount) {
  return Number(amount).toLocaleString(undefined, {
    style: "currency",
    currency: "USD"
  });
}

/**
 * Formats elapsed milliseconds into compact UI text.
 * @param {number} ms
 * @returns {string}
 */
function formatElapsed(ms) {
  if (!ms) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Throws a consistent error when a service worker response failed.
 * @param {{ ok?: boolean, error?: string }} response
 * @param {string} fallback
 * @returns {void}
 */
function assertResponseOk(response, fallback) {
  if (!response?.ok) throw new Error(response?.error || fallback);
}

/**
 * Converts unknown thrown values into readable log messages.
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
