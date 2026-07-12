/**
 * Coordinates concurrent order deletion from the popup.
 */
export class DeleteController {
  /**
   * @param {{ context: object, concurrency: number, onProgress?: Function, onCurrent?: Function, onLog?: Function }} options
   */
  constructor({ context, concurrency, onProgress, onCurrent, onDeleted, onLog }) {
    this.context = context;
    this.concurrency = concurrency;
    this.onProgress = onProgress;
    this.onCurrent = onCurrent;
    this.onDeleted = onDeleted;
    this.onLog = onLog;
    this.cancelled = false;
    this.results = [];
  }

  /**
   * Requests cancellation for queued work.
   * @returns {void}
   */
  cancel() {
    this.cancelled = true;
  }

  /**
   * Deletes orders with the configured concurrency.
   * @param {Array<object>} orders
   * @returns {Promise<{ results: Array<object>, elapsedMs: number }>}
   */
  async run(orders) {
    const startedAt = performance.now();
    let nextIndex = 0;
    let completed = 0;

    const worker = async () => {
      while (nextIndex < orders.length) {
        const order = orders[nextIndex];
        nextIndex += 1;

        if (this.cancelled) {
          this.results.push(buildResult(order, "skipped", "", "Cancelled before deletion", 0));
          completed += 1;
          this.emitProgress(completed, orders.length);
          continue;
        }

        this.onCurrent?.(order);
        const result = await this.deleteOrder(order);
        this.results.push(result);
        completed += 1;
        this.emitProgress(completed, orders.length);
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, orders.length) }, worker);
    await Promise.all(workers);

    return {
      results: this.results,
      elapsedMs: performance.now() - startedAt
    };
  }

  /**
   * Deletes a single order through the background service worker.
   * @param {{ id: string, orderNumber?: string }} order
   * @returns {Promise<object>}
   */
  async deleteOrder(order) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "DELETE_ORDER",
        context: this.context,
        orderId: order.id
      });

      if (!response.ok) throw new Error(response.error || "Delete failed.");

      this.onLog?.(`Deleted order ${order.orderNumber || order.id}.`);
      const result = buildResult(order, "deleted", response.httpStatus, response.message, response.attempts || 1);
      this.onDeleted?.(order);
      return result;
    } catch (error) {
      const message = error.message || String(error);
      this.onLog?.(`Failed order ${order.orderNumber || order.id}: ${message}`);
      return buildResult(order, "failed", extractStatus(message), message, estimateAttempts(message));
    }
  }

  /**
   * Emits queue progress to the popup.
   * @param {number} completed
   * @param {number} total
   * @returns {void}
   */
  emitProgress(completed, total) {
    this.onProgress?.({
      completed,
      total,
      percent: total ? Math.round((completed / total) * 100) : 0
    });
  }
}

/**
 * Builds a deletion result row for reporting.
 * @param {object} order
 * @param {string} status
 * @param {string|number} httpStatus
 * @param {string} message
 * @param {number} attempts
 * @returns {object}
 */
function buildResult(order, status, httpStatus, message, attempts) {
  return {
    order,
    status,
    httpStatus,
    message,
    attempts,
    completedAt: new Date().toISOString()
  };
}

/**
 * Extracts an HTTP status code embedded in an error message.
 * @param {string} message
 * @returns {string}
 */
function extractStatus(message) {
  const match = message.match(/\((\d{3})\)/);
  return match ? match[1] : "";
}

/**
 * Estimates attempt count when the final failed response came back through an error.
 * @param {string} message
 * @returns {number}
 */
function estimateAttempts(message) {
  return /Request failed \((429|500|503)\)/.test(message) ? 4 : 1;
}
