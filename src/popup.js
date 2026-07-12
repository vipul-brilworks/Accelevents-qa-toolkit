import { buildOrdersCsv, downloadCsv } from "./csv.js";
import { DeleteController } from "./deleter.js";
import { filterOrders, getUniqueOptions, summarizeReport } from "./orders.js";
import { loadSettings, saveSettings } from "./storage.js";
import { saveUIState, restoreUIState } from "./ui-state.js";
import { detectEnvironmentContext, getUrlDiagnostics } from "./url.js";

const state = {
  context: null,
  orders: [],
  visibleOrders: [],
  selectedIds: new Set(),
  deleteController: null,
  lastResults: [],
  sendRefundEmail: false,
  sort: { key: "orderNumber", dir: "asc" },
  lastClickedRowIndex: -1,
  failedOrders: []
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
  refundEmailToggle: $("refundEmailToggle"),
  deleteSelectedBtn: $("deleteSelectedBtn"),
  deleteSelectedCount: $("deleteSelectedCount"),
  deleteAllBtn: $("deleteAllBtn"),
  deleteAllCount: $("deleteAllCount"),
  cancelDeleteBtn: $("cancelDeleteBtn"),
  progressText: $("progressText"),
  progressEta: $("progressEta"),
  progressPercent: $("progressPercent"),
  deleteProgress: $("deleteProgress"),
  currentOrder: $("currentOrder"),
  deletedSummary: $("deletedSummary"),
  failedSummary: $("failedSummary"),
  skippedSummary: $("skippedSummary"),
  timeSummary: $("timeSummary"),
  retryFailedBtn: $("retryFailedBtn"),
  downloadReportBtn: $("downloadReportBtn"),
  logsList: $("logsList")
};

init();

// ─── Session state helpers ────────────────────────────────────────────────────

let _saveTimer = null;

/** Debounces state saves to avoid excessive writes during rapid filter changes. */
function scheduleSaveState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(persistState, 400);
}

async function persistState() {
  if (!state.context) return;
  try {
    await saveUIState({
      eventSlug:       state.context.eventSlug,
      orders:          state.orders,
      selectedIds:     [...state.selectedIds],
      sort:            state.sort,
      sendRefundEmail: state.sendRefundEmail,
      loadedPages:     elements.loadedPages.textContent,
      filters: {
        buyer:      elements.buyerFilter.value,
        holder:     elements.holderFilter.value,
        status:     elements.statusFilter.value,
        ticketType: elements.ticketTypeFilter.value,
        price:      elements.priceFilter.value
      },
      activeSection: document.querySelector(".nav-item.active")?.dataset.section ?? "orders",
      scrollTop:     document.querySelector(".content")?.scrollTop ?? 0
    });
  } catch {
    // Non-critical; swallow silently.
  }
}

/**
 * Initializes popup state from stored settings and the active tab URL.
 * @returns {Promise<void>}
 */
async function init() {
  wireNavigation();
  wireEvents();
  wireHoldButtons();
  wireSortHeaders();

  const settings = await loadSettings();
  elements.concurrencySelect.value = String(settings.concurrency);

  // Restore persisted session state before hitting the API.
  const saved = await restoreUIState();
  if (saved) applyRestoredState(saved);

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
        return window.sessionStorage.getItem("sessionToken") || 
               window.localStorage.getItem("sessionToken") || 
               window.sessionStorage.getItem("token") || 
               window.localStorage.getItem("token");
      }
    });

    if (!token) {
      throw new Error("No active session token found. Please log in to Accelevents.");
    }

    state.context.sessionToken = token;

    renderEnvironmentContext(state.context);
    setWorkflowEnabled(true);

    // If we restored orders for the same event, render them immediately
    // without an extra API round-trip.
    if (saved?.eventSlug === state.context.eventSlug && state.orders.length) {
      populateFilterOptions();
      applyFilters();
      log(`Restored ${state.orders.length} order(s) from previous session.`);
    }

    log(`Ready on ${state.context.pathname}.`);
  } catch (error) {
    showContextDetectionFailure(tab.url, getErrorMessage(error));
    setWorkflowEnabled(false);
  }
}

/**
 * Applies a persisted session snapshot to state and DOM before the API is called.
 * @param {object} saved
 * @returns {void}
 */
function applyRestoredState(saved) {
  if (Array.isArray(saved.orders))      state.orders = saved.orders;
  if (Array.isArray(saved.selectedIds)) state.selectedIds = new Set(saved.selectedIds);
  if (saved.sort?.key)                  state.sort = saved.sort;

  if (typeof saved.sendRefundEmail === "boolean") {
    state.sendRefundEmail = saved.sendRefundEmail;
    elements.refundEmailToggle.checked = state.sendRefundEmail;
  }

  if (saved.loadedPages) elements.loadedPages.textContent = saved.loadedPages;

  if (saved.filters) {
    elements.buyerFilter.value      = saved.filters.buyer      ?? "";
    elements.holderFilter.value     = saved.filters.holder     ?? "";
    elements.priceFilter.value      = saved.filters.price      ?? "";
    // status and ticketType are restored after populateFilterOptions() runs.
  }

  if (saved.activeSection) {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.section === saved.activeSection);
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === saved.activeSection);
    });
  }

  if (typeof saved.scrollTop === "number") {
    requestAnimationFrame(() => {
      const content = document.querySelector(".content");
      if (content) content.scrollTop = saved.scrollTop;
    });
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
  elements.eventSlug.textContent = context.eventSlug;

  elements.contextEnvironment.textContent = context.environment;
  elements.contextEnvironment.dataset.env = context.environment;

  const webHost = new URL(context.webOrigin).hostname;
  const apiHost = new URL(context.apiOrigin).hostname;

  elements.contextWebsite.textContent    = webHost;
  elements.contextWebsite.title          = webHost;
  elements.contextWebsite.dataset.label  = "Web";

  elements.contextApi.textContent   = apiHost;
  elements.contextApi.title         = apiHost;
  elements.contextApi.dataset.label = "API";

  elements.contextEvent.textContent = context.eventSlug;
  elements.contextEvent.title       = context.eventSlug;
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
      scheduleSaveState();
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
    scheduleSaveState();
  });
  elements.clearSelectionBtn.addEventListener("click", () => {
    state.selectedIds.clear();
    renderOrders();
    scheduleSaveState();
  });
  elements.toggleVisibleSelection.addEventListener("change", () => {
    if (elements.toggleVisibleSelection.checked) {
      state.visibleOrders.forEach((order) => state.selectedIds.add(order.id));
    } else {
      state.visibleOrders.forEach((order) => state.selectedIds.delete(order.id));
    }
    renderOrders();
    scheduleSaveState();
  });

  [elements.buyerFilter, elements.holderFilter, elements.statusFilter, elements.ticketTypeFilter, elements.priceFilter]
    .forEach((input) => input.addEventListener("input", () => {
      applyFilters();
      scheduleSaveState();
    }));

  elements.concurrencySelect.addEventListener("change", async () => {
    try {
      await saveSettings({ concurrency: Number(elements.concurrencySelect.value) });
      log(`Concurrency set to ${elements.concurrencySelect.value}.`);
      scheduleSaveState();
    } catch (error) {
      log(`Unable to save concurrency: ${getErrorMessage(error)}`, "error");
    }
  });

  elements.deleteSelectedBtn.addEventListener("hold-confirmed", () => startDelete(getSelectedOrders()));
  elements.deleteAllBtn.addEventListener("hold-confirmed", () => startDelete(state.orders));
  elements.cancelDeleteBtn.addEventListener("click", () => {
    state.deleteController?.cancel();
    elements.cancelDeleteBtn.disabled = true;
    log("Cancellation requested.");
  });
  elements.retryFailedBtn.addEventListener("click", () => {
    if (state.failedOrders.length) startDelete(state.failedOrders);
  });
  elements.downloadReportBtn.addEventListener("click", downloadReport);

  elements.refundEmailToggle.addEventListener("change", () => {
    state.sendRefundEmail = elements.refundEmailToggle.checked;
    log(`Send Refund Email: ${state.sendRefundEmail ? "ON" : "OFF"}.`);
    scheduleSaveState();
  });
}

/**
 * Attaches hold-to-confirm behaviour to every .hold-btn.
 * Fires a 'hold-confirmed' CustomEvent after a 2-second sustained press.
 * @returns {void}
 */
function wireHoldButtons() {
  const HOLD_MS = 2000;
  document.querySelectorAll(".hold-btn").forEach((btn) => {
    btn.style.setProperty("--hold-duration", `${HOLD_MS}ms`);
    let timer = null;

    const start = () => {
      if (btn.disabled) return;
      btn.classList.add("holding");
      timer = setTimeout(() => {
        btn.classList.remove("holding");
        btn.dispatchEvent(new CustomEvent("hold-confirmed", { bubbles: true }));
      }, HOLD_MS);
    };
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      btn.classList.remove("holding");
    };

    btn.addEventListener("mousedown",   start);
    btn.addEventListener("mouseup",     cancel);
    btn.addEventListener("mouseleave",  cancel);
    btn.addEventListener("touchstart",  (e) => { e.preventDefault(); start(); }, { passive: false });
    btn.addEventListener("touchend",    cancel);
    btn.addEventListener("touchcancel", cancel);
  });
}

/**
 * Wires click handlers on sortable column headers.
 * @returns {void}
 */
function wireSortHeaders() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.dir = "asc";
      }
      renderOrders();
      scheduleSaveState();
    });
  });
}

/**
 * Returns a sorted copy of orders by the current sort state.
 * @param {Array<object>} orders
 * @returns {Array<object>}
 */
function sortOrders(orders) {
  const { key, dir } = state.sort;
  return [...orders].sort((a, b) => {
    const av = a[key] ?? "";
    const bv = b[key] ?? "";
    const cmp = key === "amount"
      ? Number(av) - Number(bv)
      : String(av).localeCompare(String(bv), undefined, { numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
}

/**
 * Updates sort-direction CSS classes on header cells.
 * @returns {void}
 */
function updateSortIndicators() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === state.sort.key) {
      th.classList.add(state.sort.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
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
    scheduleSaveState();
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
 * Applies current sort, row-selected highlighting, shift-click, and keyboard nav.
 * @returns {void}
 */
function renderOrders() {
  elements.totalCount.textContent = String(state.orders.length);
  elements.visibleCount.textContent = String(state.visibleOrders.length);
  elements.selectedCount.textContent = String(state.selectedIds.size);
  elements.toggleVisibleSelection.checked = state.visibleOrders.length > 0 && state.visibleOrders.every((order) => state.selectedIds.has(order.id));
  elements.toggleVisibleSelection.indeterminate = state.visibleOrders.some((order) => state.selectedIds.has(order.id)) && !elements.toggleVisibleSelection.checked;

  updateSortIndicators();
  updateDeleteButtons();

  if (!state.visibleOrders.length) {
    showEmpty(state.orders.length ? "No orders match the current filters." : "Load orders to preview them before deletion.");
    return;
  }

  const sorted = sortOrders(state.visibleOrders);
  const fragment = document.createDocumentFragment();

  sorted.forEach((order, rowIndex) => {
    const row = document.createElement("tr");
    row.dataset.orderId = order.id;
    row.tabIndex = 0;
    if (state.selectedIds.has(order.id)) row.classList.add("row-selected");

    row.innerHTML = `
      <td><input type="checkbox" data-order-id="${escapeHtml(order.id)}" aria-label="Select order ${escapeHtml(order.orderNumber || order.id)}" ${state.selectedIds.has(order.id) ? "checked" : ""}></td>
      <td><strong>${escapeHtml(order.orderNumber || order.id)}</strong><small>${escapeHtml(order.id)}</small></td>
      <td>${escapeHtml(order.buyerEmail || "-")}</td>
      <td>${escapeHtml(order.holderEmail || "-")}</td>
      <td>${escapeHtml(order.status)}</td>
      <td>${escapeHtml(order.ticketType)}</td>
      <td>${order.isFree ? "Free" : escapeHtml(formatMoney(order.amount))}</td>
    `;

    const checkbox = row.querySelector("input[type='checkbox']");

    // Checkbox change — single row toggle.
    checkbox.addEventListener("change", (event) => {
      if (event.target.checked) state.selectedIds.add(order.id);
      else state.selectedIds.delete(order.id);
      state.lastClickedRowIndex = rowIndex;
      renderOrders();
      scheduleSaveState();
    });

    // Row click — shift-click range selection; plain click toggles.
    row.addEventListener("click", (event) => {
      if (event.target === checkbox) return; // handled above
      if (event.shiftKey && state.lastClickedRowIndex >= 0) {
        const lo = Math.min(state.lastClickedRowIndex, rowIndex);
        const hi = Math.max(state.lastClickedRowIndex, rowIndex);
        const select = state.selectedIds.has(sorted[state.lastClickedRowIndex].id);
        for (let i = lo; i <= hi; i++) {
          if (select) state.selectedIds.add(sorted[i].id);
          else        state.selectedIds.delete(sorted[i].id);
        }
      } else {
        if (state.selectedIds.has(order.id)) state.selectedIds.delete(order.id);
        else state.selectedIds.add(order.id);
        state.lastClickedRowIndex = rowIndex;
      }
      renderOrders();
      scheduleSaveState();
    });

    // Keyboard — Space toggles; ArrowUp/Down moves focus.
    row.addEventListener("keydown", (event) => {
      if (event.key === " ") {
        event.preventDefault();
        if (state.selectedIds.has(order.id)) state.selectedIds.delete(order.id);
        else state.selectedIds.add(order.id);
        state.lastClickedRowIndex = rowIndex;
        renderOrders();
        scheduleSaveState();
        // Restore focus to the same logical row after re-render.
        requestAnimationFrame(() => {
          const rows = elements.ordersTable.querySelectorAll("tr[data-order-id]");
          if (rows[rowIndex]) rows[rowIndex].focus();
        });
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const rows = elements.ordersTable.querySelectorAll("tr[data-order-id]");
        if (rows[rowIndex + 1]) rows[rowIndex + 1].focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const rows = elements.ordersTable.querySelectorAll("tr[data-order-id]");
        if (rows[rowIndex - 1]) rows[rowIndex - 1].focus();
      }
    });

    fragment.append(row);
  });

  elements.ordersTable.replaceChildren(fragment);
}

/**
 * Runs the confirmed bulk delete queue.
 * @param {Array<object>} orders
 * @returns {Promise<void>}
 */
async function startDelete(orders) {
  if (!state.context || !orders.length) return;

  // Pass the current toggle value so background.js builds the correct URL.
  state.context.sendRefundEmail = state.sendRefundEmail;

  const concurrency = Number(elements.concurrencySelect.value);
  const startedAt = Date.now();

  // Cancellation stops queued work; in-flight API requests are allowed to finish cleanly.
  state.deleteController = new DeleteController({
    context: state.context,
    concurrency,
    onProgress: (progress) => updateProgress(progress, startedAt),
    onCurrent: (order) => {
      elements.currentOrder.textContent = `Deleting ${order.orderNumber || order.id}`;
    },
    onDeleted: (order) => removeRowLocally(order.id),
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
    state.failedOrders = results.filter((r) => r.status === "failed").map((r) => r.order);
    elements.retryFailedBtn.disabled = state.failedOrders.length === 0;
    elements.downloadReportBtn.disabled = false;
    log(`Deletion finished in ${formatElapsed(elapsedMs)}.`);
    await refreshActiveTab();
    scheduleSaveState();
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
 * Removes a single order from state and the DOM immediately after deletion.
 * Updates counters inline — no full re-render needed.
 * @param {string} orderId
 * @returns {void}
 */
function removeRowLocally(orderId) {
  state.orders        = state.orders.filter((o) => o.id !== orderId);
  state.visibleOrders = state.visibleOrders.filter((o) => o.id !== orderId);
  state.selectedIds.delete(orderId);

  const row = elements.ordersTable.querySelector(`tr[data-order-id="${orderId}"]`);
  if (row) row.remove();

  elements.totalCount.textContent    = String(state.orders.length);
  elements.visibleCount.textContent  = String(state.visibleOrders.length);
  elements.selectedCount.textContent = String(state.selectedIds.size);
  elements.deleteSelectedCount.textContent = String(state.selectedIds.size);
  elements.deleteAllCount.textContent      = String(state.orders.length);
}

/**
 * Updates progress UI from the deletion controller.
 * @param {{ completed: number, total: number, percent: number }} progress
 * @param {number} startedAt  — Date.now() when the run began
 * @returns {void}
 */
function updateProgress(progress, startedAt) {
  elements.deleteProgress.value = progress.percent;
  elements.progressPercent.textContent = `${progress.percent}%`;
  elements.progressText.textContent = `${progress.completed} / ${progress.total}`;

  if (progress.completed > 0 && progress.completed < progress.total) {
    const elapsed = Date.now() - startedAt;
    const perItem = elapsed / progress.completed;
    const remainingMs = (progress.total - progress.completed) * perItem;
    elements.progressEta.textContent = `ETA ${formatElapsed(remainingMs)}`;
  } else {
    elements.progressEta.textContent = "";
  }
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
  const busy = Boolean(state.deleteController);
  elements.deleteSelectedBtn.disabled = busy || state.selectedIds.size === 0;
  elements.deleteAllBtn.disabled = busy || state.orders.length === 0;
  elements.deleteSelectedCount.textContent = String(state.selectedIds.size);
  elements.deleteAllCount.textContent = String(state.orders.length);
}

/**
 * Toggles controls while deletion is active.
 * @param {boolean} isRunning
 * @returns {void}
 */
function setDeleteRunning(isRunning) {
  elements.cancelDeleteBtn.disabled = !isRunning;
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
    elements.clearSelectionBtn
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
  state.failedOrders = [];
  elements.retryFailedBtn.disabled = true;
  elements.downloadReportBtn.disabled = true;
  elements.deleteProgress.value = 0;
  elements.progressPercent.textContent = "0%";
  elements.progressEta.textContent = "";
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
