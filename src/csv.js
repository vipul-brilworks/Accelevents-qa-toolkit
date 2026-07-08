const HEADERS = [
  "orderId",
  "orderNumber",
  "buyerEmail",
  "holderEmail",
  "status",
  "ticketType",
  "amount",
  "result",
  "httpStatus",
  "message",
  "attempts",
  "completedAt"
];

/**
 * Builds a CSV export for the current order preview or deletion report.
 * @param {Array<object>} orders
 * @param {Array<{ order: { id: string }, status: string, httpStatus: string|number, message: string, attempts: number, completedAt: string }>} [results]
 * @returns {string}
 */
export function buildOrdersCsv(orders, results = []) {
  const resultById = new Map(results.map((result) => [result.order.id, result]));
  const rows = orders.map((order) => {
    const result = resultById.get(order.id);
    return [
      order.id,
      order.orderNumber,
      order.buyerEmail,
      order.holderEmail,
      order.status,
      order.ticketType,
      order.amount,
      result?.status || "preview",
      result?.httpStatus || "",
      result?.message || "",
      result?.attempts || "",
      result?.completedAt || ""
    ];
  });

  return [HEADERS, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

/**
 * Downloads CSV content from the extension popup.
 * @param {string} filename
 * @param {string} csv
 * @param {{ saveAs?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function downloadCsv(filename, csv, options = {}) {
  const objectUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));

  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: options.saveAs ?? true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

function escapeCsvCell(value) {
  const cell = String(value ?? "");
  if (/[",\n\r]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}
