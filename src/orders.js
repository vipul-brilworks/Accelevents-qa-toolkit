/**
 * Converts one API order record into the stable shape used by the popup.
 * @param {object} raw
 * @returns {{ id: string, orderNumber: string, buyerEmail: string, holderEmail: string, status: string, ticketType: string, amount: number, isFree: boolean, raw: object }}
 */
export function normalizeOrder(raw) {
  // Accelevents order payload names can vary across admin screens, so normalization is defensive.
  const id = pickFirst(raw, ["orderId", "id", "eventTicketingOrderId", "eventOrderId", "order_id"]);
  const buyerEmail = pickFirst(raw, [
    "buyerEmail",
    "email",
    "purchaserEmail",
    "orderBuyerEmail",
    "user.email",
    "buyer.email",
    "purchaser.email"
  ]);
  const holderEmail = pickHolderEmail(raw);
  const status = pickFirst(raw, ["status", "orderStatus", "paymentStatus", "registrationStatus"]) || "Unknown";
  const ticketType = pickTicketType(raw);
  const amount = normalizeAmount(pickFirst(raw, [
    "total",
    "amount",
    "amountPaid",
    "paidAmount",
    "grandTotal",
    "orderTotal",
    "totalAmount",
    "price"
  ]));
  const orderNumber = pickFirst(raw, ["orderNumber", "orderNo", "confirmationNumber", "ticketOrderNumber"]) || id;

  return {
    id: String(id || ""),
    orderNumber: String(orderNumber || ""),
    buyerEmail: String(buyerEmail || ""),
    holderEmail: String(holderEmail || ""),
    status: String(status || "Unknown"),
    ticketType: String(ticketType || "Unknown"),
    amount,
    isFree: amount <= 0,
    raw
  };
}

/**
 * Extracts an order array from supported API response shapes.
 * @param {unknown} payload
 * @returns {Array<object>}
 */
export function extractOrders(payload) {
  // Supports Spring-style pages, wrapped API responses, and plain arrays.
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidates = [
    payload.data,
    payload.orders,
    payload.content,
    payload.items,
    payload.results,
    payload.response,
    payload.response?.data,
    payload.response?.orders
  ];

  const array = candidates.find(Array.isArray);
  return array || [];
}

/**
 * Determines whether another orders page should be fetched.
 * @param {unknown} payload
 * @param {number} currentPage
 * @param {number} pageSize
 * @param {number} receivedCount
 * @returns {boolean}
 */
export function hasMorePages(payload, currentPage, pageSize, receivedCount) {
  if (!payload || typeof payload !== "object") return receivedCount === pageSize;

  if (typeof payload.last === "boolean") return !payload.last;
  if (typeof payload.hasNext === "boolean") return payload.hasNext;
  if (typeof payload.totalPages === "number") return currentPage + 1 < payload.totalPages;

  const totalElements = pickFirst(payload, ["totalElements", "total", "totalCount", "recordsTotal"]);
  if (typeof totalElements === "number") {
    return (currentPage + 1) * pageSize < totalElements;
  }

  return receivedCount === pageSize;
}

/**
 * Builds sorted unique select options from loaded orders.
 * @param {Array<object>} orders
 * @param {string} key
 * @returns {string[]}
 */
export function getUniqueOptions(orders, key) {
  return [...new Set(orders.map((order) => order[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * Filters loaded orders using the popup's current criteria.
 * @param {Array<{ buyerEmail: string, holderEmail: string, status: string, ticketType: string, isFree: boolean }>} orders
 * @param {{ buyerEmail: string, holderEmail: string, status: string, ticketType: string, price: string }} filters
 * @returns {Array<object>}
 */
export function filterOrders(orders, filters) {
  const buyer = filters.buyerEmail.toLowerCase();
  const holder = filters.holderEmail.toLowerCase();

  return orders.filter((order) => {
    if (buyer && !order.buyerEmail.toLowerCase().includes(buyer)) return false;
    if (holder && !order.holderEmail.toLowerCase().includes(holder)) return false;
    if (filters.status && order.status !== filters.status) return false;
    if (filters.ticketType && order.ticketType !== filters.ticketType) return false;
    if (filters.price === "free" && !order.isFree) return false;
    if (filters.price === "paid" && order.isFree) return false;
    return true;
  });
}

/**
 * Counts deletion result outcomes for the completion summary.
 * @param {Array<{ status: string }>} results
 * @param {number} elapsedMs
 * @returns {{ deleted: number, failed: number, skipped: number, elapsedMs: number }}
 */
export function summarizeReport(results, elapsedMs) {
  return {
    deleted: results.filter((result) => result.status === "deleted").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    elapsedMs
  };
}

/**
 * Finds holder email fields across known order payload variants.
 * @param {object} raw
 * @returns {string}
 */
function pickHolderEmail(raw) {
  const direct = pickFirst(raw, [
    "holderEmail",
    "attendeeEmail",
    "ticketHolderEmail",
    "registrantEmail",
    "holder.email",
    "attendee.email"
  ]);
  if (direct) return direct;

  const holders = raw?.holders || raw?.attendees || raw?.tickets || raw?.eventTickets || [];
  if (Array.isArray(holders)) {
    return holders.map((holder) => pickFirst(holder, ["email", "holderEmail", "attendeeEmail", "user.email"]))
      .filter(Boolean)
      .join("; ");
  }

  return "";
}

/**
 * Finds ticket names across known order payload variants.
 * @param {object} raw
 * @returns {string}
 */
function pickTicketType(raw) {
  const direct = pickFirst(raw, [
    "ticketType",
    "ticketName",
    "eventTicketName",
    "eventTicketType",
    "ticket.name",
    "eventTicket.name",
    "ticketType.name"
  ]);
  if (direct) return direct;

  const tickets = raw?.tickets || raw?.eventTickets || raw?.orderItems || raw?.items || [];
  if (Array.isArray(tickets)) {
    return [...new Set(tickets.map((ticket) => pickFirst(ticket, [
      "ticketName",
      "name",
      "eventTicketName",
      "ticket.name",
      "eventTicket.name"
    ])).filter(Boolean))].join("; ");
  }

  return "";
}

/**
 * Returns the first non-empty value at any path.
 * @param {object} source
 * @param {string[]} paths
 * @returns {unknown}
 */
function pickFirst(source, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((object, key) => object?.[key], source);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

/**
 * Normalizes string or numeric totals into a number.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeAmount(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
