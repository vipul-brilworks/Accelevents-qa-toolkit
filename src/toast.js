let container = null;

/**
 * Returns the singleton toast container, creating it on first call.
 * @returns {HTMLElement}
 */
function ensureContainer() {
  if (container && document.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-atomic", "false");
  document.body.appendChild(container);
  return container;
}

/**
 * Shows a dismissible toast notification that auto-dismisses after `duration` ms.
 * Clicking the toast dismisses it immediately.
 * @param {string} message
 * @param {"info"|"success"|"error"|"warn"} type
 * @param {number} [duration]
 */
function show(message, type = "info", duration = 4000) {
  const c = ensureContainer();
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  c.appendChild(el);

  // Trigger enter animation on next frame so the transition fires.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add("toast-show"));
  });

  const dismiss = () => {
    el.classList.remove("toast-show");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
  };

  const timer = setTimeout(dismiss, duration);
  el.addEventListener("click", () => { clearTimeout(timer); dismiss(); }, { once: true });
}

/**
 * Public notification API used by the popup.
 */
export const toast = {
  /** @param {string} msg @param {number} [ms] */
  success: (msg, ms) => show(msg, "success", ms),
  /** @param {string} msg @param {number} [ms] */
  error: (msg, ms) => show(msg, "error", ms),
  /** @param {string} msg @param {number} [ms] */
  info: (msg, ms) => show(msg, "info", ms),
  /** @param {string} msg @param {number} [ms] */
  warn: (msg, ms) => show(msg, "warn", ms),
};
